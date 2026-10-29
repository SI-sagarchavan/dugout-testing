import { type Client, type Pool, toVector, withTenant } from "@dugout/db";
import type { EmbeddingClient } from "./embeddings.ts";

export type MemoryKind = "episodic" | "semantic";
export type MemoryStatus = "proposed" | "active" | "retired";

export interface MemoryItem {
  id: string;
  tenantId: string;
  agentId: string;
  kind: MemoryKind;
  key: string | null;
  version: number;
  content: string;
  status: MemoryStatus;
  confidence: number;
  sourceRunId: string | null;
  reviewedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface SearchQuery {
  tenantId: string;
  agentId: string;
  query: string;
  kinds?: MemoryKind[];
  limit?: number;
}

/** What agents and the context builder get: active, unexpired items only. */
export interface MemoryReader {
  activeFacts(tenantId: string, agentId: string): Promise<MemoryItem[]>;
  search(q: SearchQuery): Promise<Array<MemoryItem & { score: number }>>;
}

/** Only the consolidation step and the review command hold a writer. */
export interface MemoryWriter {
  addEpisode(e: {
    tenantId: string;
    agentId: string;
    content: string;
    confidence: number;
    sourceRunId: string;
    ttlDays: number;
  }): Promise<MemoryItem>;
  proposeFact(f: {
    tenantId: string;
    agentId: string;
    key: string;
    content: string;
    confidence: number;
    sourceRunId: string | null;
  }): Promise<MemoryItem>;
  listProposals(tenantId: string, agentId?: string): Promise<MemoryItem[]>;
  /** Makes a proposal the active version of its key and retires the previous one. */
  activateFact(tenantId: string, id: string, reviewer: string): Promise<MemoryItem>;
  rejectProposal(tenantId: string, id: string, reviewer: string): Promise<MemoryItem>;
  history(tenantId: string, agentId: string, key: string): Promise<MemoryItem[]>;
  /** Removes what one run wrote; used by evals to undo their own episodes. */
  deleteBySourceRun(tenantId: string, runId: string): Promise<number>;
}

export type MemoryStore = MemoryReader & MemoryWriter;

const COLUMNS = `id, tenant_id, agent_id, kind, key, version, content, status, confidence,
  source_run_id, reviewed_by, created_at, expires_at`;

const LIVE = `status = 'active' and (expires_at is null or expires_at > now())`;

type Row = Record<string, unknown>;
const toItem = (r: Row): MemoryItem => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  agentId: r.agent_id as string,
  kind: r.kind as MemoryKind,
  key: (r.key as string | null) ?? null,
  version: r.version as number,
  content: r.content as string,
  status: r.status as MemoryStatus,
  confidence: r.confidence as number,
  sourceRunId: (r.source_run_id as string | null) ?? null,
  reviewedBy: (r.reviewed_by as string | null) ?? null,
  createdAt: new Date(r.created_at as string).toISOString(),
  expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : null,
});

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

  return {
    activeFacts: (tenantId, agentId) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and agent_id = $2 and kind = 'semantic' and ${LIVE}
           order by key`,
          [tenantId, agentId],
        );
        return rows.map(toItem);
      }),

    async search({ tenantId, agentId, query, kinds = ["semantic", "episodic"], limit = 5 }) {
      const vector = await embedOne(query);
      return tx(tenantId, async (db) => {
        // Reciprocal rank fusion of full-text and vector rankings over the tenant's live items.
        // The explicit tenant filter backs up row-level security.
        const { rows } = await db.query(
          `with candidates as (
             select * from memory_items
             where tenant_id = $1 and agent_id = $2 and kind = any($3) and ${LIVE}
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
          [tenantId, agentId, kinds, orQuery(query), vector, limit],
        );
        return rows.map((r) => ({ ...toItem(r), score: Number(r.score) }));
      });
    },

    async addEpisode(e) {
      const vector = await embedOne(e.content);
      return tx(e.tenantId, (db) =>
        one(
          db,
          `insert into memory_items
             (tenant_id, agent_id, kind, content, embedding, status, confidence, source_run_id, expires_at)
           values ($1, $2, 'episodic', $3, $4, 'active', $5, $6, now() + make_interval(days => $7))
           returning ${COLUMNS}`,
          [e.tenantId, e.agentId, e.content, vector, e.confidence, e.sourceRunId, e.ttlDays],
        ),
      );
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
              where tenant_id = $1 and agent_id = $2 and key = $3),
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
           where tenant_id = $1 and agent_id = $2 and key = $3 and kind = 'semantic' and status = 'active'`,
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
           where tenant_id = $1 and agent_id = $2 and key = $3 order by version`,
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
