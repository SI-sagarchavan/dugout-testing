// Ticket 11, the frame-match half: a tool reports what is open, the model asks in its own words,
// the answer comes back as ordinary tool input, and memory learns it under the item's id. Run
// through the real agent with a scripted model, on two designs that have nothing in common: a
// recipe site's rail and a football club's squad strip.
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, type RunEvent } from "@dugout/contracts";
import {
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
  type ScriptStep,
  scriptedModelConfig,
} from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore, decisionKey } from "@dugout/memory";
import { afterAll, describe, expect, inject, it } from "vitest";
import { agent } from "../src/agent.ts";
import type { ControlPlane } from "../src/control-plane.ts";
import type { Built, Bundle, Measurement, Overrides } from "../src/frame.ts";
import type { LayoutIntent } from "../src/layout.ts";
import type { Engine } from "../src/tools.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

const measured: Measurement = {
  match: 90,
  comparedPixels: 100,
  coverage: 100,
  estimated: false,
  unchecked: [],
  plates: [],
  conformErrors: 0,
  conformWarnings: 0,
  totalDelta: 0,
  worstDelta: 0,
  placeholderIcons: 0,
  findings: [],
  surfaces: [],
};

const carousel = {
  slidesPerView: "auto" as const,
  slidesPerGroup: 1,
  centered: false,
  initialSlide: 0,
  loop: false,
  autoplay: false as const,
};

/** A recipe site's rail: a frame that has nothing to do with cricket. */
const recipes: LayoutIntent = {
  src: "7:100",
  name: "Weeknight recipes",
  kind: "carousel",
  confidence: "certain",
  items: ["r1", "r2", "r3", "r4"],
  evidence: [
    "4 matching items in one row",
    '1 of 4 items cut off by the edge of "Weeknight recipes"',
  ],
  ask: ['How many items does "Weeknight recipes" hold in all?'],
  choice: { src: "7:100", kind: "carousel", config: carousel },
  chrome: {},
};

/** A football club's squad strip. */
const squad: LayoutIntent = {
  src: "9:200",
  name: "First team",
  kind: "carousel",
  confidence: "certain",
  items: ["p1", "p2", "p3"],
  evidence: ["3 matching items in one row", "a designed previous and next arrow"],
  ask: ['Should "First team" move on its own?'],
  choice: { src: "9:200", kind: "carousel", config: carousel },
  chrome: { prev: "9:210", next: "9:211" },
};

function fake(intent: LayoutIntent, section: string) {
  const built = (overrides: Overrides) =>
    ({
      tree: { schemaVersion: "1", nodes: [] },
      notes: [],
      themeRaw: {},
      surfaces: { assets: {}, surfaces: {} },
      cropped: [],
      addedTexts: [],
      errors: [],
      missing: [],
      layoutNotes: overrides.layouts.map((l) => ({
        src: l.src,
        message: "carousel",
        applied: true,
      })),
      overrides,
    }) as unknown as Built;
  const bundle = {
    exportId: "e",
    rootName: "Frame",
    section,
    notes: [],
    themeArtifactId: "theme-1",
    themeRaw: { tokens: {} },
    doc: { rootNodeId: "1", root: { geometry: { bbox: { x: 0, y: 0, w: 1366, h: 412 } } } },
    byId: new Map(),
    plates: [{ nodeId: "1", name: "p", png: Buffer.alloc(0) }],
  } as unknown as Bundle;
  const engine: Engine = {
    bundle: async () => bundle,
    build: async (_b, overrides) => built(overrides),
    measure: async () => measured,
    firstPass: async (_b, start) => ({
      overrides: start,
      built: built(start),
      measurement: measured,
    }),
    layouts: async () => structuredClone([intent]),
  };
  const plane = { upload: async (kind: string) => `${kind}-id` } as unknown as ControlPlane;
  return { engine, plane };
}

/** frame.publish's input: the model settles whether the section shows data. */
const PUBLISH = { content: { data: "some", why: "the cards repeat with names" }, slots: [] };

const call = (name: string, args: unknown = {}): ScriptStep => ({
  toolCalls: [{ name, arguments: args }],
});
const finalCall = call("final", {
  previewUrl: "x",
  treeArtifactId: "x",
  measured: true,
  coverage: 100,
  estimated: false,
  unchecked: [],
  placeholderIcons: 0,
  remaining: ["the frame is at 90: its anti-aliasing"],
  compilerFindings: [],
  notes: [],
});

/** One run of frame-match on a section. `steps` is what the model does; it replies from scratch each time. */
async function run(
  tenantId: string,
  intent: LayoutIntent,
  section: string,
  steps: ScriptStep[],
  options: {
    runId: string;
    runStore?: ReturnType<typeof createMemoryRunStore>;
    /** The directory a run keeps its work in: the same one when a paused run is resumed. */
    matchDir?: string;
    /** The write is approved when it is asked (a run with no one to answer a question). */
    approving?: boolean;
    resume?: { answers: Record<string, unknown>; events: RunEvent[] };
  },
) {
  const { engine, plane } = fake(intent, section);
  const runStore = options.runStore ?? createMemoryRunStore();
  const matchDir = options.matchDir ?? (await mkdtemp(join(tmpdir(), "frame-match-open-")));
  const sink = createMemorySink();
  const requests: Array<{ tools: string[]; messages: unknown[] }> = [];
  const model = createScriptedModel(steps);
  const client = {
    complete(req: Parameters<typeof model.complete>[0], ...rest: unknown[]) {
      requests.push({
        tools: req.tools.map((t) => t.name),
        messages: structuredClone(req.messages),
      });
      return (model.complete as (...a: unknown[]) => unknown)(req, ...rest) as ReturnType<
        typeof model.complete
      >;
    },
  };
  const result = await agent.create({
    store,
    models: scriptedModelConfig(),
    client,
    matchDir,
    engine,
    plane: () => plane,
    vision: false,
    runsDir: await mkdtemp(join(tmpdir(), "runs-")),
    consolidate: true,
  })({
    tenantId,
    input: { exportId: "6f1d2c1e-7a3b-4c7e-9a10-000000000001", project: "default" },
    responder:
      options.resume || options.approving
        ? async () => approve("sagar")
        : async () => ({ pending: true }),
    runId: options.runId,
    store: runStore,
    sinks: [sink],
    ...(options.resume
      ? {
          resume: {
            reason: "answered" as const,
            decision: { by: "Sagar Chavan", answers: options.resume.answers as never },
            events: options.resume.events,
          },
        }
      : {}),
  });
  const asked = sink.events.find((e) => e.type === "question.asked") as
    | Extract<RunEvent, { type: "question.asked" }>
    | undefined;
  return { result, runStore, matchDir, events: sink.events, asked, requests };
}

const loadedOpen = (requests: Array<{ messages: unknown[] }>) => {
  const last = requests.at(-1)?.messages as Array<{ role: string; content: string }>;
  const tool = [...last].reverse().find((m) => m.role === "tool" && m.content.includes('"open"'));
  return JSON.parse(tool?.content ?? "{}").open as Array<Record<string, unknown>>;
};

describe.each([
  { name: "a recipe site's rail", intent: recipes, section: "sig-recipes" },
  { name: "a football club's squad strip", intent: squad, section: "sig-squad" },
])("$name: the open items of a container (ticket 11)", ({ intent, section }) => {
  const layout = (autoplay: number) =>
    call("frame.layout", {
      choice: {
        src: intent.src,
        kind: "carousel",
        // pages: null is how a model says "whatever the data holds"; it is left out
        config: { ...carousel, pages: null, autoplay: { delayMs: autoplay } },
      },
      settled: [{ id: "autoplay", by: "person" }],
    });

  it("is asked by the model, in its words, offering every candidate and what canTake accepts; the answer is applied as input and learned under its id", async () => {
    const tenant = `t-open-${randomUUID().slice(0, 8)}`;
    const runId = `run1-${tenant}`;
    // the model reads frame.load's open items and asks about autoplay, writing the question itself
    const first = await run(
      tenant,
      intent,
      section,
      [
        call("frame.load"),
        // the options are written from the candidates; "Other" takes what canTake accepts
        call("ask", {
          questions: [
            {
              id: "autoplay",
              question: `Should ${intent.name} move on its own?`,
              why: `${intent.evidence[0]}; a still frame cannot show it`,
              kind: "choice",
              options: [
                { value: "off", label: "No autoplay", description: "" },
                { value: "3000", label: "Every 3 seconds", description: "" },
                { value: "5000", label: "Every 5 seconds", description: "" },
                { value: "8000", label: "Every 8 seconds", description: "" },
              ],
              allowOther: true,
              proposed: ["off"],
              remember: "section",
              fact: "layout.carousel.autoplay",
            },
          ],
        }),
      ],
      { runId },
    );
    expect(first.result.status).toBe("waiting");
    // frame.load did not stop the run: the only question is the model's, with its section about it
    expect(first.events.filter((e) => e.type === "question.asked")).toHaveLength(1);
    expect(first.asked?.data.questions[0]).toMatchObject({
      id: "autoplay",
      about: { agent: "frame-match", scope: "section", section },
    });
    // what the model read: every candidate and what canTake accepts, from the tool
    const items = loadedOpen(first.requests.slice(-1));
    const autoplay = items.find((i) => i.id === "autoplay") as {
      candidates: Array<{ value: string }>;
      canTake: string;
      evidence: string;
    };
    expect(autoplay.candidates.map((c) => c.value)).toEqual(["off", "3000", "5000", "8000"]);
    expect(autoplay.canTake).toContain("delayMs");
    const offered = first.asked?.data.questions[0]?.options.map((o) => o.value);
    expect(offered).toEqual(autoplay.candidates.map((c) => c.value));

    // the person answers; the model applies it as ordinary input and the run ends
    const done = await run(
      tenant,
      intent,
      section,
      [layout(5000), call("frame.publish", PUBLISH), finalCall],
      {
        runId,
        runStore: first.runStore,
        matchDir: first.matchDir,
        resume: {
          answers: { autoplay: "5000" },
          events: first.events,
        },
      },
    );
    expect(done.result.status, JSON.stringify(done.result).slice(0, 600)).toBe("completed");
    const settled = (
      done.result as { output: { settled?: Array<{ id: string; by: string; value: string }> } }
    ).output.settled;
    expect(settled).toContainEqual({ id: "autoplay", by: "person", value: `${intent.src}: 5000` });
    // the other items the tool reported were the model's own call, and recorded so
    expect(settled?.find((s) => s.id === "loop")?.by).toBe("agent");
    // memory learned it under the item's id, on this section
    expect(
      await store.decision(tenant, decisionKey("frame-match", "autoplay", section)),
    ).toMatchObject({
      value: "5000",
    });

    // the next Handoff of the section: the item carries what was decided, the model takes it from
    // `before` and settles it by memory, and no one is asked
    const second = await run(
      tenant,
      intent,
      section,
      [
        call("frame.load"),
        call("frame.layout", {
          choice: {
            src: intent.src,
            kind: "carousel",
            config: { ...carousel, autoplay: { delayMs: 5000 } },
          },
          settled: [{ id: "autoplay", by: "memory" }],
        }),
        call("frame.publish", PUBLISH),
        finalCall,
      ],
      { runId: `run2-${tenant}`, approving: true },
    );
    // the only thing asked is the write's approval; nothing about the layout
    expect(
      second.events
        .filter((e) => e.type === "question.asked")
        .flatMap((e) =>
          (e as { data: { questions: Array<{ id: string }> } }).data.questions.map((q) => q.id),
        ),
    ).toEqual(["review"]);
    const before = loadedOpen(second.requests.slice(0, 2)).find((i) => i.id === "autoplay")
      ?.before as string;
    expect(before).toContain("5000");
    const again = (second.result as { output: { settled?: Array<{ id: string; by: string }> } })
      .output.settled;
    expect(again?.find((s) => s.id === "autoplay")?.by).toBe("memory");
  });
});
