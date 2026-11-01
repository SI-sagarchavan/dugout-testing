import type { ModelClient } from "@dugout/contracts";
import { type Pool, toVector } from "@dugout/db";
import type { EmbeddingClient } from "./embeddings.ts";
import { COLUMNS, LIVE, type MemoryItem, type MemoryKind, toItem } from "./store.ts";

/** A sport as a scope name: lower case, dashes for anything else. */
export const sportKey = (sport: string) =>
  sport
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");

/**
 * The shared scopes a run reads besides its tenant's memory (ADR 0014): everything for every
 * tenant, and everything for each sport the run is about. That is `only` when the run's input names
 * sports (the sitemap's `sports`), otherwise every sport the tenant covers.
 */
export function memoryGroups(tenant: { sports?: string[] } | undefined, only?: string[]): string[] {
  const sports = only?.length ? only : (tenant?.sports ?? []);
  return ["global", ...new Set(sports.map((s) => `sport:${sportKey(s)}`))];
}

/** How a shared scope reads in a prompt: "every client" or "every cricket client". */
export const groupLabel = (scope: string) =>
  scope === "global" ? "every client" : `every ${scope.replace(/^sport:/, "")} client`;

/**
 * Shared memory as the admin role sees it. Promotion reads across tenants and only the admin role
 * writes shared rows, so this takes the admin pool, never the app's.
 */
export function createSharedMemory(opts: { pool: Pool; embeddings: EmbeddingClient }) {
  const { pool, embeddings } = opts;
  const embedOne = async (text: string) => toVector((await embeddings.embed([text]))[0] ?? []);

  return {
    /** Pairs of similar facts, or of similar lessons from one agent, held by different tenants. */
    async similarPairs(tenantIds: string[], similarity: number) {
      const { rows } = await pool.query(
        `with items as (
           select * from memory_items
           where tenant_id = any($1) and ${LIVE}
             and (kind = 'semantic' or episode_type = 'lesson')
         )
         select a.id as a, b.id as b from items a join items b
           on a.tenant_id < b.tenant_id and a.kind = b.kind
          and (a.kind = 'semantic' or a.agent_id = b.agent_id)
         where 1 - (a.embedding <=> b.embedding) >= $2`,
        [tenantIds, similarity],
      );
      return rows as Array<{ a: string; b: string }>;
    },

    async items(ids: string[]): Promise<MemoryItem[]> {
      const { rows } = await pool.query(`select ${COLUMNS} from memory_items where id = any($1)`, [
        ids,
      ]);
      return rows.map(toItem);
    },

    /** Shared items, proposed or active, already promoted from any of these tenant items. */
    async promotedFrom(ids: string[]): Promise<MemoryItem[]> {
      const { rows } = await pool.query(
        `select ${COLUMNS} from memory_items
         where tenant_id is null and status in ('proposed', 'active') and sources && $1::uuid[]`,
        [ids],
      );
      return rows.map(toItem);
    },

    async propose(p: {
      scope: string;
      kind: MemoryKind;
      key: string | null;
      agentId: string | null;
      content: string;
      sources: string[];
      support: number;
    }): Promise<MemoryItem> {
      const vector = await embedOne(p.content);
      const { rows } = await pool.query(
        `insert into memory_items
           (tenant_id, shared_scope, agent_id, kind, key, episode_type, version, content, embedding,
            status, confidence, strength, sources)
         values (null, $1, $2, $3, $4, $5,
           (select coalesce(max(version), 0) + 1 from memory_items
            where tenant_id is null and shared_scope = $1 and kind = $3 and key = $4),
           $6, $7, 'proposed', 0.8, $8, $9)
         returning ${COLUMNS}`,
        [
          p.scope,
          p.agentId,
          p.kind,
          p.key,
          p.kind === "episodic" ? "lesson" : null,
          p.content,
          vector,
          p.support,
          p.sources,
        ],
      );
      return toItem(rows[0]);
    },

    async proposals(): Promise<MemoryItem[]> {
      const { rows } = await pool.query(
        `select ${COLUMNS} from memory_items
         where tenant_id is null and status = 'proposed' order by created_at`,
      );
      return rows.map(toItem);
    },

    /** Activates a shared proposal; for a fact, retires the active version of its scope and key. */
    async activate(id: string, reviewer: string): Promise<MemoryItem> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const { rows } = await client.query(
          `select ${COLUMNS} from memory_items
           where id = $1 and tenant_id is null and status = 'proposed' for update`,
          [id],
        );
        const proposal = rows[0] ? toItem(rows[0]) : undefined;
        if (!proposal) throw new Error("shared proposal not found");
        if (proposal.kind === "semantic") {
          await client.query("select pg_advisory_xact_lock(hashtext($1 || '/' || $2))", [
            proposal.sharedScope,
            proposal.key,
          ]);
          await client.query(
            `update memory_items set status = 'retired'
             where tenant_id is null and shared_scope = $1 and key = $2
               and kind = 'semantic' and status = 'active'`,
            [proposal.sharedScope, proposal.key],
          );
        }
        const updated = await client.query(
          `update memory_items set status = 'active', reviewed_by = $2, last_seen_at = now()
           where id = $1 returning ${COLUMNS}`,
          [id, reviewer],
        );
        await client.query("commit");
        return toItem(updated.rows[0]);
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },

    async reject(id: string, reviewer: string): Promise<MemoryItem> {
      const { rows } = await pool.query(
        `update memory_items set status = 'retired', reviewed_by = $2
         where id = $1 and tenant_id is null and status = 'proposed' returning ${COLUMNS}`,
        [id, reviewer],
      );
      if (!rows[0]) throw new Error("shared proposal not found");
      return toItem(rows[0]);
    },
  };
}

export type SharedMemory = ReturnType<typeof createSharedMemory>;

/**
 * Rewrites what several tenants' items say as one statement that names none of them, or returns
 * null when it only makes sense for those tenants.
 */
export type Generalizer = (group: {
  kind: MemoryKind;
  contents: string[];
  /** Who will read it; for several `sports`, the generalizer says which one. */
  scope: string;
  /** The sports the tenants share, when they share more than one. */
  sports: string[];
  avoid: string[];
}) => Promise<{ content: string; key?: string; sport?: string } | null>;

export interface PromoteOptions {
  shared: SharedMemory;
  generalize: Generalizer;
  /** Every tenant to look across, with the sports that group it. */
  tenants: Array<{ id: string; name: string; sports: string[] }>;
  /** Distinct tenants that must hold the same point before it is proposed. Defaults to 2. */
  minTenants?: number;
  /** Cosine similarity for two tenants' items to count as the same point. Defaults to 0.85. */
  similarity?: number;
}

/**
 * Finds the same fact, or the same lesson of one agent, in several tenants and proposes it as
 * shared memory: for the sport it is about when the tenants have sports in common (when several,
 * the generalizer names the one), and for every tenant when they have none in common. A
 * person approves each proposal (`pnpm agent memory review --shared`) before any run reads it. Items
 * already promoted are skipped, so running it again proposes only what is new.
 */
export async function promoteSharedMemory(opts: PromoteOptions) {
  const minTenants = opts.minTenants ?? 2;
  const sportsOf = new Map(opts.tenants.map((t) => [t.id, t.sports.map(sportKey)]));
  const pairs = await opts.shared.similarPairs(
    opts.tenants.map((t) => t.id),
    opts.similarity ?? 0.85,
  );

  // groups of items linked by similarity (connected components)
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  for (const { a, b } of pairs) parent.set(find(a), find(b));
  const groups = new Map<string, string[]>();
  for (const id of new Set(pairs.flatMap((p) => [p.a, p.b]))) {
    groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  }

  // what a generalisation must never contain: tenant ids and names
  const avoid = opts.tenants.flatMap((t) => [t.id, t.name]);
  const proposed: MemoryItem[] = [];
  let skipped = 0;
  for (const ids of groups.values()) {
    const items = await opts.shared.items(ids);
    const tenants = new Set(items.map((i) => i.tenantId ?? ""));
    if (tenants.size < minTenants) continue;
    if ((await opts.shared.promotedFrom(ids)).length > 0) continue;
    // the sports every one of these tenants covers
    const common = [...tenants]
      .map((t) => sportsOf.get(t) ?? [])
      .reduce((a, b) => a.filter((s) => b.includes(s)));
    const kind = items[0]?.kind ?? "semantic";

    const general = await opts.generalize({
      kind,
      contents: items.map((i) => i.content),
      scope: common.length === 1 ? `sport:${common[0]}` : "global",
      sports: common.length > 1 ? common : [],
      avoid,
    });
    const named =
      general && avoid.some((a) => general.content.toLowerCase().includes(a.toLowerCase()));
    if (!general || named) {
      skipped++;
      continue;
    }
    const chosen = general.sport ? sportKey(general.sport) : undefined;
    const scope =
      common.length === 1
        ? `sport:${common[0]}`
        : chosen && common.includes(chosen)
          ? `sport:${chosen}`
          : "global";
    const keys = new Set(items.map((i) => i.key));
    const key =
      kind === "semantic"
        ? keys.size === 1 && [...keys][0]
          ? ([...keys][0] as string)
          : (general.key ?? `shared.${ids[0]?.slice(0, 8)}`)
        : null;
    proposed.push(
      await opts.shared.propose({
        scope,
        kind,
        key,
        agentId: kind === "episodic" ? (items[0]?.agentId ?? null) : null,
        content: general.content,
        sources: ids,
        support: tenants.size,
      }),
    );
  }
  return { proposed, skipped };
}

/**
 * A `Generalizer` that asks a model for one sentence naming no tenant, or NONE. With several sports
 * to choose from, the model starts with the sport it is about, or "any".
 */
export function createModelGeneralizer(client: ModelClient, model: string): Generalizer {
  return async ({ kind, contents, scope, sports, avoid }) => {
    const audience =
      sports.length > 0 ? `clients covering ${sports.join(", ")}` : groupLabel(scope);
    const turn = await client.complete({
      model,
      tools: [],
      messages: [
        {
          role: "system",
          content: [
            `Several clients of a sports publishing platform each hold the ${kind === "semantic" ? "rule" : "lesson"} below. Write ONE sentence that states what they share, so it can be given to ${audience}.`,
            "Name no club, team, person, competition or date, and no figure that belongs to one client. Keep the instruction as specific as the items allow.",
            `Never mention any of: ${avoid.join(", ")}.`,
            "An instruction about how to do the work (what to include, leave out, order or word) usually holds for other clients too: state it as an instruction.",
            "Reply with exactly NONE when the items describe each client itself (its ground, players or fans), merely share a topic, or set different values for the same thing (a limit, an order, a name), since then each client's value is its own.",
            sports.length > 0
              ? `Start the sentence with the one sport it is about and a colon, from: ${sports.join(", ")}; or with "any:" if it holds for every sport. Output only that or NONE.`
              : "Output only the sentence or NONE.",
          ].join(" "),
        },
        { role: "user", content: contents.map((c) => `- ${c}`).join("\n") },
      ],
    });
    const text = turn.message.content.trim().split("\n")[0]?.trim() ?? "";
    if (!text || text === "NONE") return null;
    const prefixed = sports.length > 0 ? /^([a-z0-9 -]+):\s*(.+)$/i.exec(text) : null;
    if (!prefixed) return { content: text };
    const sport = prefixed[1]?.trim().toLowerCase();
    return { content: prefixed[2] ?? text, ...(sport && sport !== "any" ? { sport } : {}) };
  };
}
