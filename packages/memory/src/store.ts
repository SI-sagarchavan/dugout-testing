import type { BuildRecord } from "@dugout/contracts";
import { type Client, type Pool, toVector, withTenant } from "@dugout/db";
import type { EmbeddingClient } from "./embeddings.ts";

export type MemoryKind = "episodic" | "semantic";
export type MemoryStatus = "proposed" | "active" | "retired";
/**
 * A record of one run, a lesson from a reviewer's feedback, an example (the input of a write call
 * an editor approved in a completed run), or a decision: what a person answered to a question
 * about one section (ADR 0033).
 */
export type EpisodeType = "run" | "lesson" | "example" | "decision" | "build";

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
  /** For shared memory: the tenant items it was promoted from. For a fact from decisions: them. */
  sources: string[];
  /**
   * The typed answer, for a decision and a fact made from answers (ADR 0033): what a question is
   * proposed, or answered, with. Null for everything else.
   */
  value: unknown;
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
  /**
   * Ranked by text and vector relevance. An item is returned only if it matched the text or its
   * cosine similarity is at least {@link MIN_EPISODE_SIMILARITY}. Examples are never returned.
   */
  search(q: SearchQuery): Promise<Array<MemoryItem & { score: number }>>;
  /**
   * Episodes of one type for the prompt, nearest by the cosine similarity of the stored embedding;
   * items below {@link MIN_EPISODE_SIMILARITY} are left out, and `limit` is only how many may fit.
   * Lessons are reranked by {@link lessonScore}: strength, recency and the reading `agentId` count
   * too, and a lesson seen {@link STRONG_LESSON} times is a candidate at any similarity.
   */
  recallEpisodes(
    q: Omit<SearchQuery, "kinds"> & { episodeType: EpisodeType; agentId: string },
  ): Promise<Array<MemoryItem & { score: number }>>;
  /**
   * The live build records of these sections (ADR 0034), newest first; one agent's when named.
   * With no sections, every section's.
   */
  builds(
    tenantId: string,
    q?: { sections?: string[]; agentId?: string; limit?: number },
  ): Promise<MemoryItem[]>;
  /**
   * The build records whose links name this id as a path segment: the run that made it
   * (`run.previewUrl`), or a correction a person's comments made from it (`run.edited`).
   */
  buildsNaming(tenantId: string, id: string): Promise<MemoryItem[]>;
  /** @deprecated `buildsNaming`, under the name ui-editor's tools still call it by. */
  buildsOfPreview(tenantId: string, id: string): Promise<MemoryItem[]>;
  /** The live lessons about these sections (ADR 0034), the strongest and newest first. */
  lessonsOn(tenantId: string, sections: string[], limit?: number): Promise<MemoryItem[]>;
  /** One live build record of the tenant, by its item id (ADR 0034). */
  build(tenantId: string, id: string): Promise<MemoryItem | undefined>;
  /** The latest live decision for a key (`decisionKey`), whoever made it. */
  decision(tenantId: string, key: string): Promise<MemoryItem | undefined>;
  /** The latest live decision for each question about one section, newest first. */
  decisionsOn(tenantId: string, section: string, limit?: number): Promise<MemoryItem[]>;
  /** How many sections' latest decision on this agent's question is this answer. */
  sectionsAnswered(
    tenantId: string,
    agentId: string,
    questionId: string,
    value: unknown,
  ): Promise<MemoryItem[]>;
  /** The tenant's fact for a key in this status: the active one, or the latest proposal. */
  fact(
    tenantId: string,
    key: string,
    status: "active" | "proposed",
  ): Promise<MemoryItem | undefined>;
}

/** The key a decision is kept under: the asking agent, the question's id, the section. */
export const decisionKey = (agentId: string, questionId: string, section: string) =>
  `${agentId}:${questionId}@${section}`;

/** The key of an agent's build records for one section (ADR 0034). */
/** The key of a lesson about one section (ADR 0034). */
export const lessonKey = (section: string) => `lesson@${section}`;

export const buildKey = (agentId: string, section: string) => `${agentId}:build@${section}`;

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
    /**
     * The section a lesson is about (ADR 0034): it is kept under the section, found by it, and
     * strengthened only by a lesson about the same section. Its words, not the run input, are what
     * the lesson is embedded with.
     */
    section?: { signature: string; name?: string; kind?: string; layout?: string };
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
    /** The typed answer, when the fact comes from what a person answered (ADR 0033). */
    value?: unknown;
    /** The decisions it was promoted from. */
    sources?: string[];
  }): Promise<MemoryItem>;
  /**
   * Records what a person answered to a question about one section (ADR 0033). The same answer
   * again strengthens the decision and pushes back its expiry; a different one is a new decision,
   * so the earlier stays as history and the latest is the one read.
   */
  recordDecision(d: {
    tenantId: string;
    /** The agent that asked. */
    agentId: string;
    key: string;
    value: unknown;
    content: string;
    sourceRunId: string;
    ttlDays: number;
  }): Promise<MemoryItem & { reinforced: boolean }>;
  /**
   * Records how a run built a section (ADR 0034). The same work with the same verdict again
   * strengthens the record and pushes back its expiry; different work is a new record, so the
   * earlier stays as history and the latest is the one read. Of the records that were not good,
   * only the latest per key stays live.
   */
  recordBuild(b: {
    tenantId: string;
    agentId: string;
    record: BuildRecord;
    content: string;
    ttlDays: number;
  }): Promise<MemoryItem & { reinforced: boolean }>;
  /**
   * Adds what a person changed after a build to its record (ADR 0034), and the preview that came
   * of it, so the next comment on that preview finds the record too.
   */
  correctBuild(
    tenantId: string,
    id: string,
    change: {
      corrected: NonNullable<BuildRecord["corrected"]>;
      edited?: string;
    },
  ): Promise<MemoryItem | undefined>;
  /** Edits a proposal before a person approves it: its sentence and its value. */
  reviseProposal(
    tenantId: string,
    id: string,
    change: { content?: string; value?: unknown },
  ): Promise<MemoryItem>;
  /** Removes one episode, such as a decision a person takes back. */
  forgetEpisode(tenantId: string, id: string): Promise<boolean>;
  /** The tenant's live decisions, the latest per question and section, newest first. */
  listDecisions(tenantId: string): Promise<MemoryItem[]>;
  listProposals(tenantId: string): Promise<MemoryItem[]>;
  /** Makes a proposal the active version of its key and retires the previous one. */
  activateFact(tenantId: string, id: string, reviewer: string): Promise<MemoryItem>;
  rejectProposal(tenantId: string, id: string, reviewer: string): Promise<MemoryItem>;
  /** Every version of one of the tenant's fact keys. */
  history(tenantId: string, key: string): Promise<MemoryItem[]>;
  /** Removes what one run wrote; used by evals to undo their own episodes. */
  deleteBySourceRun(tenantId: string, runId: string): Promise<number>;
}

/** Facts and episodes, decisions among them (ADR 0033): the one store a run reads and writes. */
export type MemoryStore = MemoryReader & MemoryWriter;

export const COLUMNS = `id, tenant_id, agent_id, kind, key, episode_type, version, content, status,
  confidence, strength, source_run_id, reviewed_by, created_at, last_seen_at, expires_at,
  shared_scope, sources, value`;

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
  value: r.value ?? null,
});

/**
 * Cosine similarity below this is a different subject, so the episode stays out of the prompt.
 * The closest item in a small set is not treated as a perfect match.
 */
export const MIN_EPISODE_SIMILARITY = 0.2;

/** Lesson candidates taken by similarity before they are reranked. */
export const LESSON_CANDIDATES = 20;
/** A lesson seen this many times is a candidate however little it resembles the input. */
export const STRONG_LESSON = 3;
/** Weights of {@link lessonScore}, added to the cosine similarity. */
export const STRENGTH_WEIGHT = 0.05;
/** Repeats beyond the first that still count. */
export const STRENGTH_CAP = 4;
export const RECENCY_WEIGHT = 0.05;
/** Days over which the recency bonus falls to 1/e. */
export const RECENCY_DAYS = 60;
export const SAME_AGENT_WEIGHT = 0.05;

/** What ranks a lesson for a run: how alike it is, how often it came up, how fresh, whose it is. */
export function lessonScore(
  lesson: Pick<MemoryItem, "strength" | "lastSeenAt" | "agentId">,
  similarity: number,
  agentId: string,
  now = Date.now(),
): number {
  const ageDays = Math.max(0, (now - Date.parse(lesson.lastSeenAt)) / 86_400_000);
  return (
    similarity +
    STRENGTH_WEIGHT * Math.min(lesson.strength - 1, STRENGTH_CAP) +
    RECENCY_WEIGHT * Math.exp(-ageDays / RECENCY_DAYS) +
    (lesson.agentId === agentId ? SAME_AGENT_WEIGHT : 0)
  );
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
             and episode_type is distinct from 'example'
             -- a build record is read by its section, from the load tools (ADR 0034)
             and ($6::text is not null or episode_type is distinct from 'build')
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
         where t.r is not null or 1 - (c.embedding <=> $4::vector) >= $8
         order by score desc, created_at desc
         limit $5`,
        [
          tenantId,
          kinds,
          orQuery(query),
          vector,
          limit,
          episodeType ?? null,
          groups,
          MIN_EPISODE_SIMILARITY,
        ],
      );
      return rows.map((r) => ({ ...toItem(r), score: Number(r.score) }));
    });
  };

  const buildsNaming: MemoryStore["buildsNaming"] = (tenantId, id) =>
    tx(tenantId, async (db) => {
      // an id is one path segment; anything else matches nothing
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return [];
      const at = `/${id}([/?#]|$)`;
      const { rows } = await db.query(
        `select ${COLUMNS} from memory_items
         where tenant_id = $1 and episode_type = 'build' and ${LIVE}
           and (value->'run'->>'previewUrl' ~ $2
             or exists (select 1 from jsonb_array_elements_text(
                  coalesce(value->'run'->'edited', '[]'::jsonb)) e where e ~ $2))
         order by last_seen_at desc`,
        [tenantId, at],
      );
      return rows.map(toItem);
    });

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
        const live = `(tenant_id = $1 or (tenant_id is null and shared_scope = any($2::text[])))
             and kind = 'episodic' and episode_type = $3 and ${LIVE}`;
        const score = "1 - (embedding <=> $4::vector)";
        if (q.episodeType !== "lesson") {
          // an approved example shows one agent's output shape, so only that agent is shown it
          const own = q.episodeType === "example" ? "and agent_id = $7" : "and $7::text is null";
          const { rows } = await db.query(
            `select ${COLUMNS}, ${score} as score from memory_items
             where ${live} and ${score} >= $5 ${own}
             order by embedding <=> $4::vector, created_at desc
             limit $6`,
            [
              q.tenantId,
              q.groups ?? [],
              q.episodeType,
              vector,
              MIN_EPISODE_SIMILARITY,
              limit,
              q.episodeType === "example" ? q.agentId : null,
            ],
          );
          return rows.map((r) => ({ ...toItem(r), score: Number(r.score) }));
        }
        // The nearest lessons, plus those seen often enough that the input needn't resemble them;
        // both are reranked below. `union` drops a lesson found by both.
        const { rows } = await db.query(
          `(select ${COLUMNS}, ${score} as score from memory_items
            where ${live} and ${score} >= $5
            order by embedding <=> $4::vector, created_at desc limit $6)
           union
           (select ${COLUMNS}, ${score} as score from memory_items
            where ${live} and strength >= $7
            order by embedding <=> $4::vector, created_at desc limit $6)`,
          [
            q.tenantId,
            q.groups ?? [],
            q.episodeType,
            vector,
            MIN_EPISODE_SIMILARITY,
            LESSON_CANDIDATES,
            STRONG_LESSON,
          ],
        );
        const now = Date.now();
        return rows
          .map((r) => {
            const item = toItem(r);
            return { ...item, score: lessonScore(item, Number(r.score), q.agentId, now) };
          })
          .sort((x, y) => y.score - x.score || y.createdAt.localeCompare(x.createdAt))
          .slice(0, limit);
      });
    },

    async addEpisode(e) {
      // A lesson's words rarely repeat the next run's input, so the embedding also carries the
      // input it was learned on. The stored text stays the lesson.
      // a lesson about a section is embedded with the section's words, not the run input (ADR 0034)
      const situation = e.section
        ? [e.section.name, e.section.kind, e.section.layout].filter(Boolean).join(" ")
        : e.situation;
      const vector = await embedOne(situation ? `${situation}\n${e.content}` : e.content);
      const key = e.section ? lessonKey(e.section.signature) : null;
      return tx(e.tenantId, async (db) => {
        // the same lesson from any agent of the tenant strengthens the one already there; one
        // about a section only the same section's
        if (e.episodeType === "lesson") {
          const { rows } = await db.query(
            `select id, 1 - (embedding <=> $2::vector) as similarity from memory_items
             where tenant_id = $1 and kind = 'episodic' and episode_type = 'lesson' and ${LIVE}
               and key is not distinct from $3::text
             order by embedding <=> $2::vector limit 1`,
            [e.tenantId, vector, key],
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
              source_run_id, expires_at, embedding_model, key, value)
           values ($1, $2, 'episodic', $3, $4, $5, 'active', $6, $7,
             now() + make_interval(days => $8), $9, $10, $11::jsonb)
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
            embeddings.model,
            key,
            e.section ? JSON.stringify(e.section) : null,
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
             (tenant_id, agent_id, kind, key, version, content, embedding, status, confidence,
              source_run_id, value, sources, embedding_model)
           values ($1, $2, 'semantic', $3,
             (select coalesce(max(version), 0) + 1 from memory_items
              where tenant_id = $1 and kind = 'semantic' and key = $3),
             $4, $5, 'proposed', $6, $7, $8::jsonb, $9::uuid[], $10)
           returning ${COLUMNS}`,
          [
            f.tenantId,
            f.agentId,
            f.key,
            f.content,
            vector,
            f.confidence,
            f.sourceRunId,
            f.value === undefined ? null : JSON.stringify(f.value),
            f.sources ?? [],
            embeddings.model,
          ],
        ),
      );
    },

    async recordDecision(d) {
      const vector = await embedOne(d.content);
      return tx(d.tenantId, async (db) => {
        const { rows } = await db.query(
          `select id, value from memory_items
           where tenant_id = $1 and episode_type = 'decision' and key = $2 and ${LIVE}
           order by last_seen_at desc limit 1`,
          [d.tenantId, d.key],
        );
        const latest = rows[0];
        if (latest && sameValue(latest.value, d.value)) {
          const item = await one(
            db,
            `update memory_items set strength = strength + 1, last_seen_at = now(),
               source_run_id = $3, expires_at = greatest(expires_at, now() + make_interval(days => $2))
             where id = $1 returning ${COLUMNS}`,
            [latest.id, d.ttlDays, d.sourceRunId],
          );
          return { ...item, reinforced: true };
        }
        const item = await one(
          db,
          `insert into memory_items
             (tenant_id, agent_id, kind, key, episode_type, content, embedding, status, confidence,
              source_run_id, expires_at, value, embedding_model)
           values ($1, $2, 'episodic', $3, 'decision', $4, $5, 'active', 1, $6,
             now() + make_interval(days => $7), $8::jsonb, $9)
           returning ${COLUMNS}`,
          [
            d.tenantId,
            d.agentId,
            d.key,
            d.content,
            vector,
            d.sourceRunId,
            d.ttlDays,
            JSON.stringify(d.value),
            embeddings.model,
          ],
        );
        return { ...item, reinforced: false };
      });
    },

    async recordBuild(b) {
      const { record } = b;
      const key = buildKey(b.agentId, record.section.signature);
      // the section's words and the sentence, never the JSON: an embedder ranks JSON by its ids
      const words = [record.section.kind, record.section.layout, record.section.name, b.content];
      const vector = await embedOne(words.filter(Boolean).join(" "));
      return tx(b.tenantId, async (db) => {
        const { rows } = await db.query(
          `select id, value from memory_items
           where tenant_id = $1 and episode_type = 'build' and key = $2 and ${LIVE}
           order by last_seen_at desc limit 1`,
          [b.tenantId, key],
        );
        const latest = rows[0] as { id: string; value: BuildRecord } | undefined;
        if (
          latest &&
          sameValue(latest.value.did, record.did) &&
          latest.value.outcome.good === record.outcome.good
        ) {
          // what a person corrected since stays on the record
          const value = {
            ...record,
            ...(latest.value.corrected ? { corrected: latest.value.corrected } : {}),
          };
          const item = await one(
            db,
            `update memory_items set strength = strength + 1, last_seen_at = now(), content = $4,
               source_run_id = $3, value = $5::jsonb, embedding = $6, embedding_model = $7,
               expires_at = greatest(expires_at, now() + make_interval(days => $2))
             where id = $1 returning ${COLUMNS}`,
            [
              latest.id,
              b.ttlDays,
              record.run.runId,
              b.content,
              JSON.stringify(value),
              vector,
              embeddings.model,
            ],
          );
          return { ...item, reinforced: true };
        }
        if (!record.outcome.good) {
          await db.query(
            `update memory_items set expires_at = now()
             where tenant_id = $1 and episode_type = 'build' and key = $2 and ${LIVE}
               and (value->'outcome'->>'good')::boolean = false`,
            [b.tenantId, key],
          );
        }
        const item = await one(
          db,
          `insert into memory_items
             (tenant_id, agent_id, kind, key, episode_type, content, embedding, status, confidence,
              source_run_id, expires_at, value, embedding_model)
           values ($1, $2, 'episodic', $3, 'build', $4, $5, 'active', 1, $6,
             now() + make_interval(days => $7), $8::jsonb, $9)
           returning ${COLUMNS}`,
          [
            b.tenantId,
            b.agentId,
            key,
            b.content,
            vector,
            record.run.runId,
            b.ttlDays,
            JSON.stringify(record),
            embeddings.model,
          ],
        );
        return { ...item, reinforced: false };
      });
    },

    builds: (tenantId, q = {}) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and episode_type = 'build' and ${LIVE}
             and ($2::text[] is null or value->'section'->>'signature' = any($2))
             and ($3::text is null or agent_id = $3)
           order by last_seen_at desc limit $4`,
          [tenantId, q.sections ?? null, q.agentId ?? null, q.limit ?? 200],
        );
        return rows.map(toItem);
      }),

    buildsNaming,
    buildsOfPreview: buildsNaming,

    lessonsOn: (tenantId, sections, limit = 5) =>
      tx(tenantId, async (db) => {
        if (sections.length === 0) return [];
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and episode_type = 'lesson' and key = any($2) and ${LIVE}
           order by strength desc, last_seen_at desc limit $3`,
          [tenantId, sections.map(lessonKey), limit],
        );
        return rows.map(toItem);
      }),

    async correctBuild(tenantId, id, change) {
      return tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select value from memory_items
           where tenant_id = $1 and id = $2 and episode_type = 'build' and ${LIVE} for update`,
          [tenantId, id],
        );
        const value = rows[0]?.value as BuildRecord | undefined;
        if (!value) return undefined;
        const next: BuildRecord = {
          ...value,
          run: {
            ...value.run,
            ...(change.edited
              ? { edited: [...new Set([...(value.run.edited ?? []), change.edited])] }
              : {}),
          },
          corrected: [...(value.corrected ?? []), ...change.corrected],
        };
        return one(
          db,
          `update memory_items set value = $2::jsonb where id = $1 returning ${COLUMNS}`,
          [id, JSON.stringify(next)],
        );
      });
    },

    build: (tenantId, id) =>
      tx(tenantId, async (db) => {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and id = $2 and episode_type = 'build' and ${LIVE}`,
          [tenantId, id],
        );
        return rows[0] ? toItem(rows[0]) : undefined;
      }),

    decision: (tenantId, key) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and episode_type = 'decision' and key = $2 and ${LIVE}
           order by last_seen_at desc limit 1`,
          [tenantId, key],
        );
        return rows[0] ? toItem(rows[0]) : undefined;
      }),

    decisionsOn: (tenantId, section, limit = 10) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select * from (
             select distinct on (key) ${COLUMNS} from memory_items
             where tenant_id = $1 and episode_type = 'decision' and ${LIVE}
               and right(key, length($2::text) + 1) = '@' || $2::text
             order by key, last_seen_at desc
           ) latest order by last_seen_at desc limit $3`,
          [tenantId, section, limit],
        );
        return rows.map(toItem);
      }),

    sectionsAnswered: (tenantId, agentId, questionId, value) =>
      tx(tenantId, async (db) => {
        const prefix = `${agentId}:${questionId}@`;
        const { rows } = await db.query(
          `select * from (
             select distinct on (key) ${COLUMNS} from memory_items
             where tenant_id = $1 and episode_type = 'decision' and ${LIVE}
               and left(key, length($2::text)) = $2::text
             order by key, last_seen_at desc
           ) latest where value = $3::jsonb`,
          [tenantId, prefix, JSON.stringify(value)],
        );
        return rows.map(toItem);
      }),

    fact: (tenantId, key, status) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from memory_items
           where tenant_id = $1 and kind = 'semantic' and key = $2 and status = $3
             and (expires_at is null or expires_at > now())
           order by version desc limit 1`,
          [tenantId, key, status],
        );
        return rows[0] ? toItem(rows[0]) : undefined;
      }),

    reviseProposal: (tenantId, id, change) =>
      tx(tenantId, async (db) => {
        const current = await one(
          db,
          `select ${COLUMNS} from memory_items where id = $1 and status = 'proposed' for update`,
          [id],
        );
        const content = change.content ?? current.content;
        const vector =
          change.content === undefined
            ? undefined
            : toVector((await embeddings.embed([content]))[0] ?? []);
        return one(
          db,
          `update memory_items set content = $2,
             value = case when $3::boolean then $4::jsonb else value end,
             embedding = coalesce($5::vector, embedding),
             embedding_model = case when $5::vector is null then embedding_model else $6 end
           where id = $1 returning ${COLUMNS}`,
          [
            id,
            content,
            change.value !== undefined,
            change.value === undefined ? null : JSON.stringify(change.value),
            vector ?? null,
            embeddings.model,
          ],
        );
      }),

    listDecisions: (tenantId) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select * from (
             select distinct on (key) ${COLUMNS} from memory_items
             where tenant_id = $1 and episode_type = 'decision' and ${LIVE}
             order by key, last_seen_at desc
           ) latest order by last_seen_at desc`,
          [tenantId],
        );
        return rows.map(toItem);
      }),

    forgetEpisode: (tenantId, id) =>
      tx(tenantId, async (db) => {
        const { rowCount } = await db.query(
          "delete from memory_items where id = $1 and tenant_id = $2 and kind = 'episodic'",
          [id, tenantId],
        );
        return rowCount === 1;
      }),

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

/** Two answers are the same answer: jsonb from Postgres and a value from a run compare alike. */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
