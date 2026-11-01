import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySink, createScriptedModel, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup";
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { seedHouseFacts } from "@dugout/sdk";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  agent,
  applyEdits,
  type CardDraft,
  CardShape,
  checkCard,
  closeRenderBrowser,
  compareCard,
  heldDraft,
  pngSize,
  referenceOf,
  renderCardPng,
  sampleCard,
  summarize,
  unpaintedTypes,
  withinEight,
} from "../src/index.ts";
import { flattenOnPage, pngFromRgba, rgbaOf } from "../src/png.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(async () => {
  await closeRenderBrowser();
  await pool.end();
});

/** 1×1 PNG. Enough for the gate to see a file, not a render. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
beforeAll(() => seedHouseFacts(store, ["demo-cricket"]));

const sample = () => {
  const { tree, data } = sampleCard() as { tree: CardDraft["tree"]; data: CardDraft["data"] };
  return { cardId: "trial-card", tree, data } satisfies CardDraft;
};

const broken = (): CardDraft => {
  const draft = structuredClone(sample());
  const title = draft.tree.nodes.find((node) => node.id === "home");
  if (!title) throw new Error("sample card has no home node");
  title.props = { ...title.props, style: "type.not_a_token" };
  return draft;
};

describe("pixel gate", () => {
  it("fills a transparent screenshot with the near-black page", () => {
    const png = pngFromRgba(2, 1, Uint8Array.of(0, 0, 0, 0, 255, 0, 0, 255));
    const flat = rgbaOf(flattenOnPage(png));
    expect([...(flat?.rgba ?? [])]).toEqual([10, 10, 10, 255, 255, 0, 0, 255]);
    const opaque = pngFromRgba(1, 1, Uint8Array.of(1, 2, 3, 255));
    expect(flattenOnPage(opaque).equals(opaque)).toBe(true);
  });

  it("treats a band up to 8 pixels thick as close enough", () => {
    expect(pngSize(TINY_PNG)).toEqual({ width: 1, height: 1 });
    expect(withinEight({ w: 360, h: 8 })).toBe(true);
    expect(withinEight({ w: 8, h: 200 })).toBe(true);
    expect(withinEight({ w: 9, h: 9 })).toBe(false);
    expect(referenceOf(undefined)).toEqual({ mode: "off" });
    expect(referenceOf({ figma: "/tmp/tree.json" }).mode).toBe("invalid");
    expect(referenceOf({ screenshot: "/tmp/missing.png" }).mode).toBe("invalid");
    expect(referenceOf({ figma: "tree.json", screenshot: "shot.png" }).mode).toBe("invalid");
  });

  it("reads an absolute figma file and screenshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "card-ref-"));
    const figma = join(dir, "tree.json");
    const screenshot = join(dir, "shot.png");
    await writeFile(figma, "{}\n");
    await writeFile(screenshot, TINY_PNG);
    const ref = referenceOf({ cardId: "trial-card", figma, screenshot });
    expect(ref.mode).toBe("on");
    if (ref.mode !== "on") return;
    expect(ref.figmaPath).toBe(figma);
    expect(ref.screenshotPath).toBe(screenshot);
    const prompt = referenceOf({ cardId: "trial-card", screenshot });
    expect(prompt.mode).toBe("prompt");
  });

  it("names node types the renderer does not paint", () => {
    expect(
      unpaintedTypes({
        nodes: [{ type: "Stack" }, { type: "Widget" }, { type: "Button" }, { type: "Widget" }],
      }),
    ).toEqual(["Widget"]);
  });
});

describe("DSL checker", () => {
  it("accepts the sample card", () => {
    const draft = sample();
    expect(checkCard(draft.tree, draft.data)).toEqual({ ok: true, issues: [] });
  });

  it("accepts a tree the model sent as a JSON string", () => {
    const draft = sample();
    const encoded = JSON.stringify({ nodes: draft.tree.nodes });
    const parsed = CardShape.safeParse({
      cardId: draft.cardId,
      tree: encoded.slice(0, -1),
      data: JSON.stringify(draft.data),
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.tree.schemaVersion).toBe("1.0.0");
    expect(parsed.data.tree.nodes).toHaveLength(draft.tree.nodes.length);
  });

  it("rejects a token that is not in the theme", () => {
    const draft = broken();
    const check = checkCard(draft.tree, draft.data);
    expect(check.ok).toBe(false);
    expect(check.issues.join("\n")).toContain("type.not_a_token");
  });
});

describe("card agent", () => {
  it("drafts from the brief and does not save", async () => {
    const draft = sample();
    const cardsDir = await mkdtemp(join(tmpdir(), "cards-"));
    const renderRoot = await mkdtemp(join(tmpdir(), "render-"));
    const client = createScriptedModel([
      () => ({ toolCalls: [{ name: "card.draft", arguments: draft }] }),
      () => ({ toolCalls: [{ name: "card.check", arguments: {} }] }),
      () => ({ toolCalls: [{ name: "final", arguments: summarize(draft) }] }),
    ]);
    const run = agent.create({
      store,
      client,
      models: scriptedModelConfig(),
      cardsDir,
      renderRoot,
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
    });
    const result = await run({
      tenantId: "demo-cricket",
      input: { cardId: "trial-card", brief: "Southern Brave against Birmingham Phoenix" },
      approver: async () => ({ approved: true, by: "editor" }),
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.output).toEqual(summarize(draft));
    expect(heldDraft(result.runId)?.tree.nodes).toHaveLength(draft.tree.nodes.length);
    const preview = JSON.parse(
      await readFile(join(renderRoot, "packages/dsl/fixtures/preview/card.json"), "utf8"),
    ) as { nodes: unknown[] };
    expect(preview.nodes).toHaveLength(draft.tree.nodes.length);
    const system = client.requests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("## Skill: card");
    expect(system).toContain("surface.fixture_shell");
    expect(system).toContain("8 pixels thick");
    expect(system).toContain("Do not call card.save");
    expect(system).not.toContain("synthetic:agent-card");
  });

  it("denies a save before approval when the screenshot has not been matched", async () => {
    const draft = sample();
    const dir = await mkdtemp(join(tmpdir(), "card-ref-"));
    const figma = join(dir, "tree.json");
    const screenshot = join(dir, "shot.png");
    await writeFile(figma, `${JSON.stringify({ tree: draft.tree, data: draft.data })}\n`);
    await writeFile(screenshot, TINY_PNG);
    const cardsDir = await mkdtemp(join(tmpdir(), "cards-"));
    const renderRoot = await mkdtemp(join(tmpdir(), "render-"));
    const sink = createMemorySink();
    const run = agent.create({
      store,
      client: createScriptedModel([
        () => ({ toolCalls: [{ name: "card.figma", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "card.save", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "final", arguments: summarize(draft) }] }),
      ]),
      models: scriptedModelConfig(),
      cardsDir,
      renderRoot,
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
    });
    let asked = 0;
    const result = await run({
      tenantId: "demo-cricket",
      input: { cardId: "trial-card", brief: "match the screenshot", figma, screenshot },
      approver: async () => {
        asked += 1;
        return { approved: true, by: "editor" };
      },
      sinks: [sink],
    });
    expect(result.status).toBe("completed");
    expect(asked).toBe(0);
    const denied = sink.events.filter((event) => event.type === "tool.denied");
    expect(denied.map((event) => (event.type === "tool.denied" ? event.data.reason : ""))).toEqual([
      expect.stringContaining("card.diff"),
    ]);
    await expect(
      readFile(join(renderRoot, "packages/dsl/fixtures/preview/card.json")),
    ).rejects.toThrow();
  });

  it("checks a bad tree, then accepts the fix, and refuses save", async () => {
    const bad = broken();
    const good = sample();
    const cardsDir = await mkdtemp(join(tmpdir(), "cards-"));
    const renderRoot = await mkdtemp(join(tmpdir(), "render-"));
    const sink = createMemorySink();
    const run = agent.create({
      store,
      client: createScriptedModel([
        () => ({ toolCalls: [{ name: "card.draft", arguments: bad }] }),
        () => ({ toolCalls: [{ name: "card.check", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "card.draft", arguments: good }] }),
        () => ({ toolCalls: [{ name: "card.check", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "card.save", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "final", arguments: summarize(good) }] }),
      ]),
      models: scriptedModelConfig(),
      cardsDir,
      renderRoot,
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
    });
    let asked = 0;
    const result = await run({
      tenantId: "demo-cricket",
      input: { cardId: "trial-card", brief: "fix the type token" },
      approver: async () => {
        asked += 1;
        return { approved: true, by: "editor" };
      },
      sinks: [sink],
    });
    expect(result.status).toBe("completed");
    expect(asked).toBe(0);
    const checks = sink.events.filter(
      (event) => event.type === "tool.completed" && event.data.tool === "card.check",
    );
    expect(
      checks.map((event) => (event.type === "tool.completed" ? event.data.content : "")),
    ).toEqual([expect.stringContaining("type.not_a_token"), expect.stringContaining('"ok":true')]);
    const denied = sink.events.filter((event) => event.type === "tool.denied");
    expect(denied.map((event) => (event.type === "tool.denied" ? event.data.reason : ""))).toEqual([
      expect.stringContaining("Do not call card.save"),
    ]);
  });

  it("matches a render of the sample card to itself and rejects a recolored one", async () => {
    const draft = sample();
    const dir = await mkdtemp(join(tmpdir(), "card-png-"));
    const screenshot = join(dir, "ref.png");
    const png = await renderCardPng(draft, 360);
    await writeFile(screenshot, png);
    const same = await compareCard(draft, screenshot);
    expect(same.ok).toBe(true);
    expect(same.message).toBe("within 8 pixels");

    const recolored = structuredClone(draft);
    const root = recolored.tree.nodes.find((node) => node.parent === null);
    if (!root) throw new Error("sample card has no root");
    root.props = { ...root.props, surface: "surface.stat_strip" };
    const shifted = await compareCard(recolored, screenshot);
    expect(shifted.ok).toBe(false);
    expect(shifted.regions.some((region) => region.w > 8 && region.h > 8)).toBe(true);
  }, 120_000);

  it("saves once card.diff has accepted the screenshot", async () => {
    const draft = sample();
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const screenshot = join(dir, "ref.png");
    const figma = join(dir, "tree.json");
    await writeFile(screenshot, await renderCardPng(draft, 360));
    await writeFile(figma, JSON.stringify({ tree: draft.tree, data: draft.data }));
    const cardsDir = await mkdtemp(join(tmpdir(), "cards-"));
    const renderRoot = await mkdtemp(join(tmpdir(), "render-"));
    const run = agent.create({
      store,
      client: createScriptedModel([
        () => ({ toolCalls: [{ name: "card.figma", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "card.diff", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "card.save", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "final", arguments: summarize(draft) }] }),
      ]),
      models: scriptedModelConfig(),
      cardsDir,
      renderRoot,
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
    });
    let asked = 0;
    const result = await run({
      tenantId: "demo-cricket",
      input: { cardId: "trial-card", brief: "match the screenshot", figma, screenshot },
      approver: async () => {
        asked += 1;
        return { approved: true, by: "editor" };
      },
    });
    expect(result.status).toBe("completed");
    expect(asked).toBe(1);
    if (result.status !== "completed") return;
    expect(result.output).toEqual(summarize(draft));
  }, 120_000);

  it("refuses a resent tree and edits the loaded card by node id", async () => {
    const draft = sample();
    const cardsDir = await mkdtemp(join(tmpdir(), "cards-"));
    const renderRoot = await mkdtemp(join(tmpdir(), "render-"));
    const sink = createMemorySink();
    const short = {
      cardId: "trial-card",
      tree: {
        schemaVersion: "1.0.0",
        nodes: [
          {
            id: "card",
            parent: null,
            idx: 0,
            type: "Stack",
            src: "synthetic:trial-card:0",
            props: {},
          },
        ],
      },
      data: { match: { title: "Fixtures" } },
    };
    const run = agent.create({
      store,
      client: createScriptedModel([
        () => ({ toolCalls: [{ name: "card.draft", arguments: draft }] }),
        () => ({ toolCalls: [{ name: "card.check", arguments: short }] }),
        () => ({
          toolCalls: [
            {
              name: "card.edit",
              arguments: { edits: [{ id: "missing", props: { content: "nope" } }] },
            },
          ],
        }),
        () => ({
          toolCalls: [
            {
              name: "card.edit",
              arguments: { edits: [{ id: "home", props: { content: "Edited" } }] },
            },
          ],
        }),
        () => ({ toolCalls: [{ name: "card.check", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "final", arguments: summarize(draft) }] }),
      ]),
      models: scriptedModelConfig(),
      cardsDir,
      renderRoot,
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
    });
    const result = await run({
      tenantId: "demo-cricket",
      input: { cardId: "trial-card", brief: "a fixtures section" },
      approver: async () => ({ approved: true, by: "editor" }),
      sinks: [sink],
    });
    expect(result.status).toBe("completed");
    const denied = sink.events.filter((event) => event.type === "tool.denied");
    expect(denied.map((event) => (event.type === "tool.denied" ? event.data.reason : ""))).toEqual([
      expect.stringContaining("tree"),
    ]);
    const failed = sink.events.filter(
      (event) => event.type === "tool.completed" && event.data.ok === false,
    );
    expect(
      failed.map((event) => (event.type === "tool.completed" ? event.data.content : "")),
    ).toEqual([expect.stringContaining("no node missing")]);
    const saved = heldDraft(result.runId);
    expect(saved?.tree.nodes).toHaveLength(draft.tree.nodes.length);
    const home = saved?.tree.nodes.find((node) => node.id === "home");
    expect(home?.props.content).toBe("Edited");
  });

  it("reads a screenshot with the vision model and does not save", async () => {
    const draft = sample();
    const dir = await mkdtemp(join(tmpdir(), "card-see-"));
    const screenshot = join(dir, "shot.png");
    await writeFile(screenshot, TINY_PNG);
    const renderRoot = await mkdtemp(join(tmpdir(), "render-"));
    const seen: Buffer[] = [];
    const run = agent.create({
      store,
      client: createScriptedModel([
        () => ({ toolCalls: [{ name: "card.see", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "card.draft", arguments: draft }] }),
        () => ({ toolCalls: [{ name: "card.check", arguments: {} }] }),
        () => ({ toolCalls: [{ name: "final", arguments: summarize(draft) }] }),
      ]),
      models: scriptedModelConfig(),
      cardsDir: await mkdtemp(join(tmpdir(), "cards-")),
      renderRoot,
      see: async (png) => {
        seen.push(png);
        return "A white strip. The words are THE ROAD AHEAD.";
      },
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
    });
    const result = await run({
      tenantId: "demo-cricket",
      input: { cardId: "trial-card", brief: "A fixtures strip", screenshot },
      approver: async () => ({ approved: true, by: "editor" }),
    });
    expect(result.status).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.equals(flattenOnPage(TINY_PNG))).toBe(true);
    const preview = JSON.parse(
      await readFile(join(renderRoot, "packages/dsl/fixtures/preview/card.json"), "utf8"),
    ) as { nodes: unknown[] };
    expect(preview.nodes).toHaveLength(draft.tree.nodes.length);
  });
});

describe("card edits", () => {
  it("merges a named node and changes nothing when an id is missing", () => {
    const draft = sample();
    const before = structuredClone(draft.tree);
    const missing = applyEdits(draft.tree, draft.data, {
      edits: [{ id: "missing", props: { content: "nope" } }],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("missing");
    expect(draft.tree).toEqual(before);

    const applied = applyEdits(draft.tree, draft.data, {
      edits: [{ id: "home", props: { content: "Edited" } }],
      data: { match: { title: "Fixtures" } },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const home = (
      applied.tree as { nodes: Array<{ id: string; props: { content?: string; style?: string } }> }
    ).nodes.find((node) => node.id === "home");
    const original = before.nodes.find((node) => node.id === "home");
    if (!home || !original) throw new Error("sample card has no home node");
    expect(home.props.content).toBe("Edited");
    expect(home.props.style).toBe(original.props.style);
    expect((applied.data as { match: { title?: string } }).match.title).toBe("Fixtures");
  });
});
