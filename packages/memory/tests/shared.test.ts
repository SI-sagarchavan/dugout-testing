import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  buildContext,
  createHashEmbeddings,
  createMemoryStore,
  createSharedMemory,
  type Generalizer,
  memoryGroups,
  promoteSharedMemory,
  reembed,
  staleEmbeddings,
} from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
const adminPool = createPool(inject("adminDatabaseUrl"));
const embeddings = createHashEmbeddings();
const store = createMemoryStore({ pool, embeddings });
const shared = createSharedMemory({ pool: adminPool, embeddings });
const AGENT = "drafter";

// a sport and tenants of their own, so these tests never meet other tests' memory
const suffix = randomUUID().slice(0, 6);
const sport = `sport${suffix}`;
const other = `other${suffix}`;
const created: string[] = [];
afterAll(async () => {
  await adminPool.query("delete from memory_items where id = any($1)", [created]);
  await pool.end();
  await adminPool.end();
});

const fact = async (tenantId: string, key: string, content: string) => {
  const p = await store.proposeFact({
    tenantId,
    agentId: null,
    key,
    content,
    confidence: 1,
    sourceRunId: null,
  });
  return store.activateFact(tenantId, p.id, "seed");
};
const lesson = (tenantId: string, content: string) =>
  store.addEpisode({
    tenantId,
    agentId: AGENT,
    episodeType: "lesson",
    content,
    confidence: 0.9,
    sourceRunId: randomUUID(),
    ttlDays: 30,
  });
const proposeShared = async (scope: string, key: string | null, content: string) => {
  const item = await shared.propose({
    scope,
    kind: key ? "semantic" : "episodic",
    key,
    agentId: key ? null : AGENT,
    content,
    sources: [],
    support: 2,
  });
  created.push(item.id);
  return item;
};

describe("memory groups", () => {
  it("are what every tenant reads, plus each of the tenant's sports", () => {
    expect(memoryGroups({ sports: ["Cricket"] })).toEqual(["global", "sport:cricket"]);
    expect(memoryGroups({ sports: ["Athletics", "Table Tennis"] })).toEqual([
      "global",
      "sport:athletics",
      "sport:table-tennis",
    ]);
    expect(memoryGroups(undefined)).toEqual(["global"]);
  });

  it("narrow to the sports a run's input names", () => {
    const olympics = { sports: ["athletics", "swimming", "cricket"] };
    expect(memoryGroups(olympics, ["Swimming"])).toEqual(["global", "sport:swimming"]);
    expect(memoryGroups(olympics, [])).toEqual([
      "global",
      "sport:athletics",
      "sport:swimming",
      "sport:cricket",
    ]);
  });
});

describe("shared memory", () => {
  it("is read by runs of its group once approved, and written by no run", async () => {
    const tenant = `t-${suffix}-a`;
    const item = await proposeShared(`sport:${sport}`, "fixtures.toss", "Show the toss time.");
    const facts = (groups: string[]) =>
      store.activeFacts(tenant, groups).then((all) => all.map((f) => f.content));

    // a proposal is invisible to every run
    expect(await facts(["global", `sport:${sport}`])).toEqual([]);
    await shared.activate(item.id, "reviewer");
    expect(await facts(["global", `sport:${sport}`])).toEqual(["Show the toss time."]);
    expect(await facts(["global", `sport:${other}`])).toEqual([]);

    // the app role can neither change a shared row nor add one
    const changed = await withTenant(pool, tenant, (db) =>
      db.query("update memory_items set content = 'changed' where id = $1", [item.id]),
    );
    expect(changed.rowCount).toBe(0);
    await expect(
      withTenant(pool, tenant, (db) =>
        db.query(
          `insert into memory_items (tenant_id, shared_scope, kind, key, content, embedding, status, confidence)
           values (null, 'global', 'semantic', 'x', 'injected', $1, 'active', 1)`,
          [`[${new Array(1024).fill(0).join(",")}]`],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("gives way to the tenant's own fact, and a sport's rule to its own", async () => {
    const tenant = `t-${suffix}-b`;
    const scope = `sport:${sport}`;
    await fact(tenant, "fixtures.order", "Our fixtures list home games first.");
    for (const [s, key, content] of [
      [scope, "fixtures.order", "List fixtures by date."],
      [scope, "fixtures.venue", "Give each fixture's venue."],
      [`sport:${other}`, "fixtures.venue", "Venue rule of another sport."],
    ] as const) {
      await shared.activate((await proposeShared(s, key, content)).id, "reviewer");
    }
    const skillsDir = await mkdtemp(join(tmpdir(), "skills-"));
    await writeFile(join(skillsDir, "x.md"), "x");
    const { text } = await buildContext({
      reader: store,
      skillsDir,
      skills: [],
      onDemandSkills: [],
      tenantId: tenant,
      groups: ["global", scope],
      agentId: AGENT,
      query: "fixtures",
      budgetTokens: 10_000,
      readSemantic: true,
      readEpisodic: false,
    });
    expect(text).toContain(
      "## House facts\n\nThese are reviewed facts for this tenant. Follow them.\n\n- Our fixtures list home games first.",
    );
    expect(text).toContain(`## Shared with every ${sport} client`);
    expect(text).toContain("- Give each fixture's venue.");
    expect(text).not.toContain("List fixtures by date.");
    expect(text).not.toContain("Venue rule of another sport.");
  });

  it("adds approved shared lessons to a tenant's own, with how many clients they came from", async () => {
    const tenant = `t-${suffix}-c`;
    await lesson(tenant, "Our editor wants the captain named first.");
    const item = await proposeShared(`sport:${sport}`, null, "Name both captains in a preview.");
    await shared.activate(item.id, "reviewer");

    const recalled = await store.recallEpisodes({
      tenantId: tenant,
      groups: ["global", `sport:${sport}`],
      agentId: AGENT,
      query: "captain preview",
      episodeType: "lesson",
    });
    expect(recalled.map((l) => l.content).sort()).toEqual([
      "Name both captains in a preview.",
      "Our editor wants the captain named first.",
    ]);
  });
});

describe("promotion", () => {
  const tenants = [
    { id: `p-${suffix}-1`, name: "Mumbai Mariners", sports: [sport] },
    { id: `p-${suffix}-2`, name: "Chennai Chargers", sports: [sport] },
    { id: `p-${suffix}-3`, name: "Austin United", sports: [other] },
  ];
  const [t1, t2, t3] = tenants.map((t) => t.id) as [string, string, string];
  // stands in for the model: keeps the first item's words
  const generalize: Generalizer = async ({ contents }) => ({ content: `${contents[0]}` });

  it("proposes the same point from several tenants for their sport, or for every tenant across sports", async () => {
    await lesson(t1, "Give the toss time in previews");
    await lesson(t2, "Give the toss time in previews");
    await fact(t1, "style.betting", "Never use betting language");
    await fact(t3, "style.betting", "Never use betting language");
    await fact(t2, "venue", "Home ground only for this club"); // one tenant: never shared
    await lesson(t1, "Mumbai Mariners readers want the coach quoted");
    await lesson(t2, "Mumbai Mariners readers want the coach quoted");

    const { proposed, skipped } = await promoteSharedMemory({ shared, generalize, tenants });
    created.push(...proposed.map((p) => p.id));
    const byKind = Object.fromEntries(proposed.map((p) => [p.kind, p]));

    expect(proposed).toHaveLength(2);
    expect(byKind.episodic).toMatchObject({
      sharedScope: `sport:${sport}`,
      agentId: AGENT,
      content: "Give the toss time in previews",
      strength: 2,
      status: "proposed",
    });
    expect(byKind.episodic?.sources).toHaveLength(2);
    expect(byKind.semantic).toMatchObject({
      sharedScope: "global",
      key: "style.betting",
      content: "Never use betting language",
    });
    // the generalisation still named a tenant, so it stays tenant memory
    expect(skipped).toBe(1);

    // nothing promoted is proposed again
    const again = await promoteSharedMemory({ shared, generalize, tenants });
    expect(again.proposed).toEqual([]);
  });

  it("puts a point that clients with several sports share under the sport it is about", async () => {
    const swim = `swim${suffix}`;
    const multi = [
      { id: `m-${suffix}-1`, name: "Games One", sports: [sport, swim] },
      { id: `m-${suffix}-2`, name: "Games Two", sports: [sport, swim, other] },
      { id: `m-${suffix}-3`, name: "Club Three", sports: [sport] },
    ];
    const [m1, m2, m3] = multi.map((t) => t.id) as [string, string, string];
    // the two multi-sport clients share two sports, so the generalizer names one
    await lesson(m1, "Give heat times in swimming results");
    await lesson(m2, "Give heat times in swimming results");
    // a single-sport club and a multi-sport client share only one sport
    await fact(m1, "results.order", "Order results by finishing position");
    await fact(m3, "results.order", "Order results by finishing position");
    const offered: string[][] = [];
    const naming: Generalizer = async ({ contents, sports }) => {
      offered.push(sports);
      return { content: `${contents[0]}`, ...(sports.length > 0 ? { sport: swim } : {}) };
    };

    const { proposed } = await promoteSharedMemory({
      shared,
      generalize: naming,
      tenants: multi,
    });
    created.push(...proposed.map((p) => p.id));
    const scopes = Object.fromEntries(proposed.map((p) => [p.kind, p.sharedScope]));
    expect(scopes).toEqual({ episodic: `sport:${swim}`, semantic: `sport:${sport}` });
    expect(offered).toContainEqual([sport, swim]);
  });
});

describe("embedding again", () => {
  it("embeds the rows another embedder made, and only those", async () => {
    const tenant = `embed${suffix}`;
    const row = await lesson(tenant, "Name the venue in the first line");
    created.push(row.id);
    const model = `test-${suffix}`;
    const next = { model, embed: async (texts: string[]) => texts.map(() => unit(7)) };
    expect(await staleEmbeddings(adminPool, model, tenant)).toEqual({ "hash-v1": 1 });
    expect(await reembed({ pool: adminPool, embeddings: next, tenantId: tenant })).toBe(1);
    const { rows } = await adminPool.query(
      "select embedding_model, embedding::text as v from memory_items where id = $1",
      [row.id],
    );
    expect(rows[0].embedding_model).toBe(model);
    expect(JSON.parse(rows[0].v)[7]).toBe(1);
    // nothing left to do, and a row written by the new embedder says so itself
    expect(await reembed({ pool: adminPool, embeddings: next, tenantId: tenant })).toBe(0);
    const written = await createMemoryStore({ pool, embeddings: next }).addEpisode({
      tenantId: tenant,
      agentId: AGENT,
      episodeType: "lesson",
      content: "Say who is unavailable",
      confidence: 0.9,
      sourceRunId: randomUUID(),
      ttlDays: 30,
    });
    created.push(written.id);
    expect(await staleEmbeddings(adminPool, model, tenant)).toEqual({});
  });
});

/** A unit vector along one axis. */
function unit(axis: number): number[] {
  const v = new Array<number>(1024).fill(0);
  v[axis] = 1;
  return v;
}
