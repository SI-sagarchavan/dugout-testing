import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest } from "@dugout/contracts";
import { createMemorySink, createScriptedModel, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { agent, type Sitemap } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
beforeAll(() => agent.seed(store, ["demo-cricket", "demo-football"]));

const sitemap: Sitemap = {
  pages: [
    { name: "News", slug: "news", children: [{ name: "News Detail", dynamic: true }] },
    { name: "Fixtures", slug: "fixtures", children: [{ name: "Matchcenter", dynamic: true }] },
    { name: "404", slug: "404" },
  ],
  navigation: [
    { name: "Home", url: "/" },
    { name: "News", url: "/news" },
    { name: "Fixtures", url: "/fixtures" },
  ],
};

/** The workflow the instructions describe, with an optional first attempt that fails validation. */
function writerScript(opts: { badMenuFirst?: boolean } = {}) {
  const bad = {
    ...sitemap,
    navigation: [...sitemap.navigation, { name: "Shop", url: "/shop" }],
  };
  return [
    () => ({ toolCalls: [{ name: "pages.catalog", arguments: {} }] }),
    ...(opts.badMenuFirst
      ? [() => ({ toolCalls: [{ name: "sitemap.validate", arguments: bad }] })]
      : []),
    () => ({ toolCalls: [{ name: "sitemap.validate", arguments: sitemap }] }),
    () => ({ toolCalls: [{ name: "sitemap.save", arguments: sitemap }] }),
    () => ({ toolCalls: [{ name: "final", arguments: sitemap }] }),
  ];
}

let sitemapsDir: string;
let runsDir: string;
beforeEach(async () => {
  sitemapsDir = await mkdtemp(join(tmpdir(), "sitemaps-"));
  runsDir = await mkdtemp(join(tmpdir(), "runs-"));
});

const build = (script: Parameters<typeof createScriptedModel>[0]) => {
  const client = createScriptedModel(script);
  // consolidation is off: these runs must not write memory into the shared test database
  const run = agent.create({
    store,
    client,
    models: scriptedModelConfig(),
    sitemapsDir,
    runsDir,
    consolidate: false,
  });
  return { run, client };
};

const input = { brief: "A T20 cricket club in Mumbai.", sports: ["cricket"] };
const approve = async () => ({ approved: true as const, by: "editor" });

describe("sitemap agent", () => {
  it("validates, saves after approval and ends through final", async () => {
    const { run } = build(writerScript());
    const sink = createMemorySink();
    const result = await run({ tenantId: "demo-cricket", input, approver: approve, sinks: [sink] });

    expect(result).toMatchObject({ status: "completed", output: sitemap });
    const dir = join(sitemapsDir, "demo-cricket");
    expect(JSON.parse(await readFile(join(dir, "pages.json"), "utf8"))).toEqual({
      pages: sitemap.pages,
    });
    const nav = JSON.parse(await readFile(join(dir, "navigation.json"), "utf8"));
    expect(nav.name).toBe("Header");
    expect(nav.nodes[1]).toEqual({
      name: "News",
      icon_url: "",
      route_name: "",
      url: "/news",
      open_in_new_tab: false,
      is_external: false,
      is_webview: false,
      children: [],
    });
    const granted = sink.events.filter((e) => e.type === "approval.granted");
    expect(granted).toHaveLength(1);
  });

  it("tells the model what is wrong, so it can fix the menu before saving", async () => {
    const { run, client } = build(writerScript({ badMenuFirst: true }));
    await run({ tenantId: "demo-cricket", input, approver: approve });
    const verdict = JSON.parse(client.requests[2]?.messages.at(-1)?.content ?? "{}");
    expect(verdict.valid).toBe(false);
    expect(verdict.issues).toEqual([
      'navigation[3].url: Menu url "/shop" is not a page in this sitemap',
    ]);
  });

  it("saves nothing when the editor rejects", async () => {
    const { run } = build(writerScript());
    const result = await run({
      tenantId: "demo-cricket",
      input,
      approver: async () => ({ approved: false, by: "editor", reason: "too many pages" }),
    });
    expect(result.status).toBe("rejected");
    await expect(stat(join(sitemapsDir, "demo-cricket"))).rejects.toThrow();
  });

  it("refuses to ask for approval on a sitemap that breaks a rule", async () => {
    const broken = { ...sitemap, navigation: [{ name: "Shop", url: "/shop" }] };
    const { run, client } = build([
      () => ({ toolCalls: [{ name: "sitemap.save", arguments: broken }] }),
      () => ({ toolCalls: [{ name: "sitemap.save", arguments: sitemap }] }),
      () => ({ toolCalls: [{ name: "final", arguments: sitemap }] }),
    ]);
    const sink = createMemorySink();
    const result = await run({ tenantId: "demo-cricket", input, approver: approve, sinks: [sink] });
    expect(client.requests[1]?.messages.at(-1)?.content).toContain("is not a page in this sitemap");
    expect(sink.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(result.status).toBe("completed");
  });

  it("does not accept a final result that breaks a rule", async () => {
    const broken = { ...sitemap, navigation: [{ name: "Shop", url: "/shop" }] };
    const { run, client } = build([
      () => ({ toolCalls: [{ name: "final", arguments: broken }] }),
      () => ({ toolCalls: [{ name: "final", arguments: sitemap }] }),
    ]);
    const result = await run({ tenantId: "demo-cricket", input, approver: approve });
    expect(client.requests[1]?.messages.at(-1)?.content).toContain("Invalid result");
    expect(result).toMatchObject({ status: "completed", output: sitemap });
  });

  it("saving the same sitemap twice changes nothing", async () => {
    const first = build(writerScript());
    await first.run({ tenantId: "demo-cricket", input, approver: approve });
    const file = join(sitemapsDir, "demo-cricket", "pages.json");
    const before = (await stat(file)).mtimeMs;
    const second = build(writerScript());
    const sink = createMemorySink();
    await second.run({ tenantId: "demo-cricket", input, approver: approve, sinks: [sink] });
    expect((await stat(file)).mtimeMs).toBe(before);
    const save = sink.events.find(
      (e) => e.type === "tool.completed" && e.data.tool === "sitemap.save",
    );
    expect(save?.type === "tool.completed" && save.data.content).toContain('"unchanged":true');
  });

  it("keeps each tenant's sitemap apart", async () => {
    await build(writerScript()).run({ tenantId: "demo-cricket", input, approver: approve });
    await build(writerScript()).run({ tenantId: "demo-football", input, approver: approve });
    for (const tenant of ["demo-cricket", "demo-football"]) {
      await expect(stat(join(sitemapsDir, tenant, "pages.json"))).resolves.toBeDefined();
    }
  });

  it("loads the skill, the tenant override and the house facts into the instructions", async () => {
    const { run, client } = build(writerScript());
    await run({ tenantId: "demo-football", input, approver: approve });
    const system = client.requests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("## Skill: sitemap");
    expect(system).toContain("US soccer fans");
    expect(system).toContain("Header menu order: Home, News, Fixtures, Standings");
    expect(system).not.toContain("T20 cricket followers");
  });

  it("offers final with the sitemap schema and the tools in the spec", async () => {
    const { run, client } = build(writerScript());
    await run({ tenantId: "demo-cricket", input, approver: approve });
    const tools = (client.requests[0] as ModelRequest).tools?.map((t) => t.name) ?? [];
    expect(tools).toEqual(
      expect.arrayContaining(["pages.catalog", "sitemap.validate", "sitemap.save", "final"]),
    );
  });

  it("rejects a brief that is empty or too long", () => {
    const { run } = build(writerScript());
    expect(() =>
      run({ tenantId: "demo-cricket", input: { brief: " " }, approver: approve }),
    ).toThrow();
    expect(() =>
      run({ tenantId: "demo-cricket", input: { brief: "x".repeat(4_001) }, approver: approve }),
    ).toThrow();
  });
});

describe("changes requested at approval", () => {
  const revised: Sitemap = {
    ...sitemap,
    pages: sitemap.pages.map((p) => (p.slug === "news" ? { ...p, slug: "stories" } : p)),
    navigation: sitemap.navigation.map((i) => (i.url === "/news" ? { ...i, url: "/stories" } : i)),
  };

  it("are handled in the same run, with no code in the agent, and only the new sitemap is saved", async () => {
    const { run, client } = build([
      ...writerScript().slice(0, 3),
      () => ({ toolCalls: [{ name: "sitemap.validate", arguments: revised }] }),
      () => ({ toolCalls: [{ name: "sitemap.save", arguments: revised }] }),
      () => ({ toolCalls: [{ name: "final", arguments: revised }] }),
    ]);
    const sink = createMemorySink();
    const shown: Sitemap[] = [];
    const result = await run({
      tenantId: "demo-cricket",
      input,
      approver: async (req) => {
        shown.push(req.input as Sitemap);
        return shown.length === 1
          ? { approved: false, by: "editor", changes: "Change the News path to /stories" }
          : { approved: true, by: "editor" };
      },
      sinks: [sink],
    });

    expect(result).toMatchObject({ status: "completed", output: revised });
    expect(shown).toEqual([sitemap, revised]);
    const saved = JSON.parse(
      await readFile(join(sitemapsDir, "demo-cricket", "pages.json"), "utf8"),
    );
    expect(saved.pages[0].slug).toBe("stories");
    // the model saw its own first sitemap and the request in one transcript
    const afterRequest = client.requests[3]?.messages ?? [];
    expect(JSON.stringify(afterRequest)).toContain('\\"slug\\":\\"news\\"');
    expect(afterRequest.at(-1)?.content).toContain("Change the News path to /stories");
    expect(
      sink.events.filter((e) => e.type === "tool.started" && e.data.tool === "sitemap.save"),
    ).toHaveLength(1);
  });
});
