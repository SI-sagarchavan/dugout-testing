import { type Client, type Pool, toVector, withTenant } from "@dugout/db";
import type { EmbeddingClient } from "./embeddings.ts";

export type MemoryKind = "episodic" | "semantic";
export type MemoryStatus = "proposed" | "active" | "retired";
/** A record of one run, or a lesson from a reviewer's feedback. */
export type EpisodeType = "run" | "lesson";

export interface MemoryItem {
  id: string;
  tenantId: string;
  /** Null for a fact that holds for every agent of the tenant (ADR 0013). */
  agentId: string | null;
  kind: MemoryKind;
  key: string | null;
  /** Episodes only. */
  episodeType: EpisodeType | null;
  version: number;
  content: string;
  status: MemoryStatus;
  confidence: number;
  /** How many times an episode has been seen; repeats raise it instead of adding copies. */
  strength: number;
  sourceRunId: string | null;
  reviewedBy: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
}

export interface SearchQuery {
  tenantId: string;
  agentId: string;
  query: string;
  kinds?: MemoryKind[];
  episodeType?: EpisodeType;
  limit?: number;
}

/** What agents and the context builder get: active, unexpired items only. */
export interface MemoryReader {
  /**
   * The tenant's facts plus the agent's own, its own winning on the same key. With a null agent,
   * the tenant-wide facts only.
   */
  activeFacts(tenantId: string, agentId: string | null): Promise<MemoryItem[]>;
  /** Ranked by text and vector relevance alone. */
  search(q: SearchQuery): Promise<Array<MemoryItem & { score: number }>>;
  /** Episodes of one type for the prompt, ranked by relevance, recency and strength. */
  recallEpisodes(
    q: Omit<SearchQuery, "kinds"> & { episodeType: EpisodeType },
  ): Promise<Array<MemoryItem & { score: number }>>;
}

/** Only the consolidation step and the review command hold a writer. */
export interface MemoryWriter {
  /**
   * Adds an episode. A lesson nearly the same as an active one strengthens that one instead, and
   * pushes back its expiry; run records are always added.
   */
  addEpisode(e: {
    tenantId: string;
    agentId: string;
    episodeType: EpisodeType;
    content: string;
    confidence: number;
    sourceRunId: string;
    ttlDays: number;
  }): Promise<MemoryItem & { reinforced: boolean }>;
  proposeFact(f: {
    tenantId: string;
    /** Null proposes a tenant-wide fact. */
    agentId: string | null;
    key: string;
    content: string;
    confidence: number;
    sourceRunId: string | null;
  }): Promise<MemoryItem>;
  listProposals(tenantId: string, agentId?: string): Promise<MemoryItem[]>;
  /** Makes a proposal the active version of its key and retires the previous one. */
  activateFact(tenantId: string, id: string, reviewer: string): Promise<MemoryItem>;
  rejectProposal(tenantId: string, id: string, reviewer: string): Promise<MemoryItem>;
  /** Every version of one key in one scope (a null agent for tenant-wide). */
  history(tenantId: string, agentId: string | null, key: string): Promise<MemoryItem[]>;
  /** Removes what one run wrote; used by evals to undo their own episodes. */
  deleteBySourceRun(tenantId: string, runId: string): Promise<number>;
}

export type MemoryStore = MemoryReader & MemoryWriter;

const COLUMNS = `id, tenant_id, agent_id, kind, key, episode_type, version, content, status,
  confidence, strength, source_run_id, reviewed_by, created_at, last_seen_at, expires_at`;

const LIVE = `status = 'active' and (expires_at is null or expires_at > now())`;

/** Cosine similarity above which a new lesson counts as one already remembered. */
export const REINFORCE_SIMILARITY = 0.9;

type Row = Record<string, unknown>;
const toItem = (r: Row): MemoryItem => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  agentId: (r.agent_id as string | null) ?? null,
  kind: r.kind as MemoryKind,
  key: (r.key as string | null) ?? null,
  episodeType: (r.episode_type as EpisodeType | null) ?? null,
  version: r.version as number,
  content: r.content as string,
  status: r.status as MemoryStatus,
  confidence: r.confidence as number,
  strength: r.strength as number,
  sourceRunId: (r.source_run_id as string | null) ?? null,
  reviewedBy: (r.reviewed_by as string | null) ?? null,
  createdAt: new Date(r.created_at as string).toISOString(),
  lastSeenAt: new Date(r.last_seen_at as string).toISOString(),
  expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : null,
});

/** Days for a memory's recency weight to halve. */
const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Orders episodes the way Generative Agents does: relevance (scaled to the best match), recency
 * since last seen, and strength. Each is 0..1; relevance counts most.
 */
export function rankEpisodes<T extends Pick<MemoryItem, "lastSeenAt" | "strength">>(
  items: Array<T & { score: number }>,
  now: Date = new Date(),
): Array<T & { score: number }> {
  const best = Math.max(...items.map((i) => i.score), Number.EPSILON);
  return items
    .map((item) => {
      const days = (now.getTime() - new Date(item.lastSeenAt).getTime()) / 86_400_000;
      const recency = 0.5 ** (Math.max(days, 0) / RECENCY_HALF_LIFE_DAYS);
      const strength = 1 - 1 / item.strength;
      return { ...item, score: 0.6 * (item.score / best) + 0.25 * recency + 0.15 * strength };
    })
    .sort((x, y) => y.score - x.score);
}

/** Words OR-ed into a tsquery; anything that isn't a word is dropped, so input can't break it. */
const orQuery = (text: string) =>
  [...new Set(text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].slice(0, 32).join(" | ");

export function createMemoryStore(opts: { pool: Pool; embeddings: EmbeddingClient }): MemoryStore {
  const { pool, embeddings } = opts;
  const tx = <T>(tenantId: string, fn: (db: Client) => Promise<T>) =>
    withTenant(pool, tenantId, fn);
  const embedOne = async (text: string) => toVector((await embeddings.embed([text]))[0] ?? []);

  const one = async (db: Client, sql: string, params: unknown[]) => {
    const { rows } = await db.query(sql, params);
    if (!rows[0]) throw new Error("memory item not found");
    return toItem(rows[0]);
  };

  const search: MemoryReader["search"] = async ({
    tenantId,
    agentId,
    query,
    kinds = ["semantic", "episodic"],
    episodeType,
    limit = 5,
  }) => {
    const vector = await embedOne(query);
    return tx(tenantId, async (db) => {
      // Reciprocal rank fusion of full-text and vector rankings over the tenant's live items.
      // The explicit tenant filter backs up row-level security.
      const { rows } = await db.query(
        `with candidates as (
           select * from memory_items
           where tenant_id = $1 and (agent_id = $2 or (agent_id is null and kind = 'semantic'))
             and kind = any($3) and ($7::text is null or episode_type = $7) and ${LIVE}
         ),
         text_rank as (
           select id, row_number() over (order by ts_rank_cd(tsv, q) desc) as r
           from candidates, to_tsquery('english', $4) q
           where $4 <> '' and tsv @@ q
         ),
         vec_rank as (
           select id, row_number() over (order by embedding <=> $5::vector) as r
           from candidates
         )
         select ${COLUMNS},
           coalesce(1.0 / (60 + t.r), 0) + coalesce(1.0 / (60 + v.r), 0) as score
         from candidates c
         left join text_rank t using (id)
         left join vec_rank v using (id)
         order by score desc, created_at desc
         limit $6`,
        [tenantId, agentId, kinds, orQuery(query), vector, limit, episodeType ?? null],
      );
      return rows.map((r) => ({ ...toItem(r), score: Number(r.score) }));
    });
  };

  return {
    activeFacts: (tenantId, agentId) =>
      tx(tenantId, async (db) => {
        // one row per key: the agent's own fact if it has one, else the tenant-wide one
        const { rows } = await db.query(
          `select distinct on (key) ${COLUMNS} from memory_items
           where tenant_id = $1 and (agent_id = $2::text or agent_id is null)
             and kind = 'semantic' and ${LIVE}
           order by key, agent_id nulls last`,
          [tenantId, agentId],
        );
        return rows.map(toItem);
      }),

    search,

    // a wider pool by relevance, then re-ranked with recency and strength
    recallEpisodes: async ({ limit = 5, ...q }) =>
      rankEpisodes(await search({ ...q, kinds: ["episodic"], limit: limit * 4 })).slice(0, limit),

    async addEpisode(e) {
      const vector = await embedOne(e.content);
      return tx(e.tenantId, async (db) => {
        if (e.episodeType === "lesson") {
          const { rows } = await db.query(
            `select id, 1 - (embedding <=> $3::vector) as similarity from memory_items
             where tenant_id = $1 and agent_id = $2 and kind = 'episodic'
               and episode_type = 'lesson' and ${LIVE}
             order by embedding <=> $3::vector limit 1`,
            [e.tenantId, e.agentId, vector],
          );
          const nearest = rows[0];
          if (nearest && Number(nearest.similarity) >= REINFORCE_SIMILARITY) {
            const item = await one(
              db,
              // a repeat only ever extends the expiry
              `update memory_items set strength = strength + 1, last_seen_at = now(),
                 expires_at = greatest(expires_at, now() + make_interval(days => $2))
               where id = $1 returning ${COLUMNS}`,
              [nearest.id, e.ttlDays],
            );
            return { ...item, reinforced: true };
          }
        }
        const item = await one(
          db,
          `insert into memory_items
             (tenant_id, agent_id, kind, episode_type, content, embedding, status, confidence,
              source_run_id, expires_at)
           values ($1, $2, 'episodic', $3, $4, $5, 'active', $6, $7, now() + make_interval(days => $8))
           returning ${COLUMNS}`,
          [
            e.tenantId,
            e.agentId,
            e.episodeType,
            e.content,
            vector,
            e.confidence,
            e.sourceRunId,
            e.ttlDays,
          ],
        );
        return { ...item, reinforced: false };
      });
    },

    async proposeFact(f) {
      const vector = await embedOne(f.content);
      return tx(f.tenantId, (db) =>
        one(
          db,
          `insert into memory_items
             (tenant_id, agent_id, kind, key, version, content, embedding, status, confidence, source_run_id)
           values ($1, $2, 'semantic', $3,
             (select coalesce(max(version), 0) + 1 from memory_items
              where tenant_id = $1 and agent_id is not distinct from $2::text and key = $3),
             $4, $5, 'proposed', $6, $7)
           returning ${COLUMNS}`,
          [f.tenantId, f.agentId, f.key, f.content, vector, f.confidence, f.sourceRunId],
        ),
      );
    },

    listProposals: (tenantId, agentId) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and status = 'proposed' and ($2::text is null or agent_id = $2)
           order by created_at`,
          [tenantId, agentId ?? null],
        );
        return rows.map(toItem);
      }),

    activateFact: (tenantId, id, reviewer) =>
      tx(tenantId, async (db) => {
        const proposal = await one(
          db,
          `select ${COLUMNS} from memory_items where id = $1 and status = 'proposed' for update`,
          [id],
        );
        await db.query(
          `update memory_items set status = 'retired'
           where tenant_id = $1 and agent_id is not distinct from $2::text and key = $3
             and kind = 'semantic' and status = 'active'`,
          [tenantId, proposal.agentId, proposal.key],
        );
        return one(
          db,
          `update memory_items set status = 'active', reviewed_by = $2 where id = $1
           returning ${COLUMNS}`,
          [id, reviewer],
        );
      }),

    rejectProposal: (tenantId, id, reviewer) =>
      tx(tenantId, (db) =>
        one(
          db,
          `update memory_items set status = 'retired', reviewed_by = $2
           where id = $1 and status = 'proposed' returning ${COLUMNS}`,
          [id, reviewer],
        ),
      ),

    history: (tenantId, agentId, key) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and agent_id is not distinct from $2::text and key = $3
           order by version`,
          [tenantId, agentId, key],
        );
        return rows.map(toItem);
      }),

    deleteBySourceRun: (tenantId, runId) =>
      tx(tenantId, async (db) => {
        const { rowCount } = await db.query(
          "delete from memory_items where tenant_id = $1 and source_run_id = $2",
          [tenantId, runId],
        );
        return rowCount ?? 0;
      }),
  };
}
