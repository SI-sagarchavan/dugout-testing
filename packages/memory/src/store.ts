import { type Client, type Pool, toVector, withTenant } from "@dugout/db";
import type { EmbeddingClient } from "./embeddings.ts";

export type MemoryKind = "episodic" | "semantic";
export type MemoryStatus = "proposed" | "active" | "retired";
/** A record of one run, or a lesson from a reviewer's feedback. */
export type EpisodeType = "run" | "lesson";

export interface MemoryItem {
  id: string;
  /** Null for shared memory (ADR 0014). */
  tenantId: string | null;
  /**
   * The agent whose run produced the item, or null (seeded facts). Every agent of the tenant reads
   * every item (ADR 0013); this only records where it came from and ranks an agent's own lessons.
   */
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
  /** For shared memory: `global` (every tenant) or `sport:<sport>` (every tenant of a sport). */
  sharedScope: string | null;
  /** For shared memory: the tenant items it was promoted from. */
  sources: string[];
}

export interface SearchQuery {
  tenantId: string;
  /** The shared scopes the tenant reads too, e.g. `["global", "sport:cricket"]` (`memoryGroups`). */
  groups?: string[];
  query: string;
  kinds?: MemoryKind[];
  episodeType?: EpisodeType;
  limit?: number;
}

/**
 * What agents and the context builder get: active, unexpired items of one tenant, plus approved
 * shared items of the groups it belongs to.
 */
export interface MemoryReader {
  activeFacts(tenantId: string, groups?: string[]): Promise<MemoryItem[]>;
  /** Ranked by text and vector relevance alone. */
  search(q: SearchQuery): Promise<Array<MemoryItem & { score: number }>>;
  /**
   * Episodes of one type for the prompt, nearest by the cosine similarity of the stored embedding.
   * `agentId` records who is reading; it does not change the order. Items below
   * {@link MIN_EPISODE_SIMILARITY} are left out, and `limit` is only how many may fit.
   */
  recallEpisodes(
    q: Omit<SearchQuery, "kinds"> & { episodeType: EpisodeType; agentId: string },
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
    /**
     * The run input this episode was learned on. It is part of the embedding, so a later run with
     * a similar input can find the lesson, and it is not part of the stored text.
     */
    situation?: string;
    confidence: number;
    sourceRunId: string;
    ttlDays: number;
  }): Promise<MemoryItem & { reinforced: boolean }>;
  proposeFact(f: {
    tenantId: string;
    /** The agent that proposed it; null when seeded. */
    agentId: string | null;
    key: string;
    content: string;
    confidence: number;
    sourceRunId: string | null;
  }): Promise<MemoryItem>;
  listProposals(tenantId: string): Promise<MemoryItem[]>;
  /** Makes a proposal the active version of its key and retires the previous one. */
  activateFact(tenantId: string, id: string, reviewer: string): Promise<MemoryItem>;
  rejectProposal(tenantId: string, id: string, reviewer: string): Promise<MemoryItem>;
  /** Every version of one of the tenant's fact keys. */
  history(tenantId: string, key: string): Promise<MemoryItem[]>;
  /** Removes what one run wrote; used by evals to undo their own episodes. */
  deleteBySourceRun(tenantId: string, runId: string): Promise<number>;
}

export type MemoryStore = MemoryReader & MemoryWriter;

export const COLUMNS = `id, tenant_id, agent_id, kind, key, episode_type, version, content, status,
  confidence, strength, source_run_id, reviewed_by, created_at, last_seen_at, expires_at,
  shared_scope, sources`;

export const LIVE = `status = 'active' and (expires_at is null or expires_at > now())`;

/** Cosine similarity above which a new lesson counts as one already remembered. */
export const REINFORCE_SIMILARITY = 0.9;

type Row = Record<string, unknown>;
export const toItem = (r: Row): MemoryItem => ({
  id: r.id as string,
  tenantId: (r.tenant_id as string | null) ?? null,
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
  sharedScope: (r.shared_scope as string | null) ?? null,
  sources: (r.sources as string[] | null) ?? [],
});

/**
 * Cosine similarity below this is a different subject, so the episode stays out of the prompt.
 * The closest item in a small set is not treated as a perfect match.
 */
export const MIN_EPISODE_SIMILARITY = 0.2;

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
    groups = [],
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
           where (tenant_id = $1 or (tenant_id is null and shared_scope = any($7::text[])))
             and kind = any($2) and ($6::text is null or episode_type = $6) and ${LIVE}
         ),
         text_rank as (
           select id, row_number() over (order by ts_rank_cd(tsv, q) desc) as r
           from candidates, to_tsquery('english', $3) q
           where $3 <> '' and tsv @@ q
         ),
         vec_rank as (
           select id, row_number() over (order by embedding <=> $4::vector) as r
           from candidates
         )
         select ${COLUMNS},
           coalesce(1.0 / (60 + t.r), 0) + coalesce(1.0 / (60 + v.r), 0) as score
         from candidates c
         left join text_rank t using (id)
         left join vec_rank v using (id)
         order by score desc, created_at desc
         limit $5`,
        [tenantId, kinds, orQuery(query), vector, limit, episodeType ?? null, groups],
      );
      return rows.map((r) => ({ ...toItem(r), score: Number(r.score) }));
    });
  };

  return {
    activeFacts: (tenantId, groups = []) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where (tenant_id = $1 or (tenant_id is null and shared_scope = any($2::text[])))
             and kind = 'semantic' and ${LIVE}
           order by key`,
          [tenantId, groups],
        );
        return rows.map(toItem);
      }),

    search,

    recallEpisodes: async ({ limit = 5, ...q }) => {
      const vector = await embedOne(q.query);
      return tx(q.tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS}, 1 - (embedding <=> $4::vector) as score
           from memory_items
           where (tenant_id = $1 or (tenant_id is null and shared_scope = any($2::text[])))
             and kind = 'episodic' and episode_type = $3 and ${LIVE}
             and 1 - (embedding <=> $4::vector) >= $5
           order by embedding <=> $4::vector, created_at desc
           limit $6`,
          [q.tenantId, q.groups ?? [], q.episodeType, vector, MIN_EPISODE_SIMILARITY, limit],
        );
        return rows.map((r) => ({ ...toItem(r), score: Number(r.score) }));
      });
    },

    async addEpisode(e) {
      // A lesson's words rarely repeat the next run's input, so the embedding also carries the
      // input it was learned on. The stored text stays the lesson.
      const vector = await embedOne(e.situation ? `${e.situation}\n${e.content}` : e.content);
      return tx(e.tenantId, async (db) => {
        // the same lesson from any agent of the tenant strengthens the one already there
        if (e.episodeType === "lesson") {
          const { rows } = await db.query(
            `select id, 1 - (embedding <=> $2::vector) as similarity from memory_items
             where tenant_id = $1 and kind = 'episodic' and episode_type = 'lesson' and ${LIVE}
             order by embedding <=> $2::vector limit 1`,
            [e.tenantId, vector],
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
              where tenant_id = $1 and kind = 'semantic' and key = $3),
             $4, $5, 'proposed', $6, $7)
           returning ${COLUMNS}`,
          [f.tenantId, f.agentId, f.key, f.content, vector, f.confidence, f.sourceRunId],
        ),
      );
    },

    listProposals: (tenantId) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and status = 'proposed' order by created_at`,
          [tenantId],
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
        // two activations of one key (two reviewers, two seeders) take turns, so the later one
        // retires the earlier one's version instead of breaking the one-active-fact index
        await db.query("select pg_advisory_xact_lock(hashtext($1 || '/' || $2))", [
          tenantId,
          proposal.key,
        ]);
        await db.query(
          `update memory_items set status = 'retired'
           where tenant_id = $1 and key = $2 and kind = 'semantic' and status = 'active'`,
          [tenantId, proposal.key],
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

    history: (tenantId, key) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and kind = 'semantic' and key = $2 order by version`,
          [tenantId, key],
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
