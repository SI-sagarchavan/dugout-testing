import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient } from "@dugout/contracts";
import {
  type Approver,
  createBedrockClient,
  createMemorySink,
  createScriptedModel,
  loadModelConfig,
  type ModelConfig,
  scriptedModelConfig,
} from "@dugout/core";
import { type EvalSuite, endedGracefully, writesGated } from "@dugout/evals";
import type { MemoryStore } from "@dugout/memory";
import {
  agent,
  type Built,
  type Bundle,
  type ControlPlane,
  type Engine,
  loadToolchain,
  type Measurement,
  type Output,
  spec,
} from "../src/index.ts";
import { FRAMES } from "./frames.ts";

export interface SuiteOptions {
  mode: "live" | "scripted";
  model?: string;
  store: MemoryStore;
  runsDir: string;
}

// The live cases read stored Sends from the local control plane, so they need the trial stack up.
// Scripted mode runs the same cases against fixed numbers, to check the plumbing alone.
const cases = FRAMES.map((frame) => ({
  id: frame.id,
  kind: "standard" as const,
  tenant: "demo-cricket",
  exportId: frame.exportId,
}));

/** What the code alone reached before the accuracy fixes, from `pnpm card-match:measure --write`. */
const baseline = JSON.parse(readFileSync(join(import.meta.dirname, "baseline.json"), "utf8")) as {
  recordedAt: string;
  frames: Record<string, { firstPass: { match: number; coverage: number } }>;
};

/** A frame mostly compared has to be this close, whatever its baseline was. */
const NEAR_MATCH = 90;
const NEAR_COVERAGE = 50;

export async function createSuite(opts: SuiteOptions): Promise<EvalSuite<(typeof cases)[number]>> {
  const live = opts.mode === "live";
  let models: ModelConfig;
  let client: ModelClient | undefined;
  if (live) {
    models = loadModelConfig();
    client = createBedrockClient({ models });
  } else {
    models = scriptedModelConfig();
  }
  const approver: Approver = async () => ({ approved: true, by: "eval" });

  return {
    agentId: spec.id,
    cases,
    async runCase(c) {
      try {
        return await runOne(c);
      } finally {
        // the render browser keeps the process alive, so each case closes what it opened
        if (live) await (await loadToolchain()).closeBrowser();
      }
    },
  };

  async function runOne(c: (typeof cases)[number]) {
    {
      const sink = createMemorySink();
      const matchDir = await mkdtemp(join(tmpdir(), "card-match-"));
      const run = agent.create({
        store: opts.store,
        models,
        ...(client ? { client } : { client: scriptedRun(0) }),
        ...(opts.model ? { model: opts.model } : {}),
        matchDir,
        // CARD_MATCH_VISION=off runs the same cases without frame.look: the arm to compare with
        ...(process.env.CARD_MATCH_VISION === "off" ? { vision: false } : {}),
        // CARD_MATCH_LOOK=last allows frame.look only once the findings have been worked
        ...(process.env.CARD_MATCH_LOOK === "last" ? { lookOrder: "last" as const } : {}),
        ...(live ? {} : { engine: fakeEngine(0), plane: fakePlane }),
        runsDir: opts.runsDir,
        consolidate: false,
      });
      const result = await run({
        tenantId: c.tenant,
        input: { exportId: c.exportId, project: "default" },
        approver,
        sinks: [sink],
      });
      const output = result.status === "completed" ? (result.output as Output) : undefined;
      const before = baseline.frames[c.id]?.firstPass;
      const coverage = (output as { coverage?: number } | undefined)?.coverage;
      const grades = [
        endedGracefully(sink.events),
        writesGated(sink.events, ["frame.publish"]),
        {
          grader: "published",
          pass: Boolean(output?.previewUrl),
          detail: output?.previewUrl ?? "no preview link",
        },
        ...(live && (coverage ?? 0) >= NEAR_COVERAGE
          ? [
              {
                grader: "near-the-design",
                // Against the design itself: not falling below a bad baseline passes a bad frame.
                pass: (output?.match ?? 0) >= NEAR_MATCH,
                detail: `match ${output?.match ?? "none"}%, wanted ${NEAR_MATCH}% over ${coverage}%`,
              },
            ]
          : []),
        {
          grader: "not-worse-than-compile",
          // The agent exists to improve on the plain compile. A published frame below it means a fix
          // hurt, and nothing undid it: the failure a pixel score hides until it is looked for.
          pass:
            !output ||
            output.measured === false ||
            (output.match ?? 100) >= (output.before ?? 0) - 0.05,
          detail: `match ${output?.match ?? "none"}% against ${output?.before ?? "none"}% for the plain compile`,
        },
        {
          grader: "says-what-is-left",
          pass: output?.match === 100 || (output?.remaining.length ?? 0) > 0,
          detail: `${output?.remaining.length ?? 0} items in remaining`,
        },
      ];
      // Against the recorded run, only with real numbers: scripted mode has none to compare.
      if (live && before) {
        grades.push(
          {
            grader: "catches-logos",
            pass: output?.placeholderIcons === 0,
            detail: `${output?.placeholderIcons ?? "unknown"} placeholders on show`,
          },
          {
            grader: "reports-coverage",
            pass: coverage !== undefined,
            detail:
              coverage === undefined
                ? "the result has no coverage, so a match over a sliver looks like a match"
                : `coverage ${coverage}%`,
          },
          {
            grader: "covers-at-least-baseline",
            pass: (coverage ?? 0) >= before.coverage,
            detail: `coverage ${before.coverage}% → ${coverage ?? "none"}% (baseline ${baseline.recordedAt.slice(0, 10)})`,
          },
          {
            grader: "match-not-below-baseline",
            // A match is over what was compared, so two are only comparable over the same share of
            // the frame: more coverage is a different, harder number. No measurement has no match.
            pass:
              output?.measured === false ||
              (coverage ?? 0) > before.coverage + 1 ||
              ((coverage ?? 0) >= before.coverage && (output?.match ?? 0) >= before.match - 0.5),
            detail: `match ${before.match}% over ${before.coverage}% → ${output?.measured === false ? "unmeasured" : `${output?.match ?? "none"}% over ${coverage ?? "?"}%`}`,
          },
        );
      }
      return {
        grades,
        runIds: [result.runId],
        costUsd: result.usage.costUsd,
        servedModels: [
          ...new Set(
            sink.events.flatMap((event) =>
              event.type === "step.completed" ? [event.data.servedModel] : [],
            ),
          ),
        ],
      };
    }
  }
}

const PREVIEW = "http://localhost:3000/v1/preview/dsl_tree-id?theme=t&surfaces=surface_set-id";

/** The tools' plumbing without a trial checkout: fixed numbers, nothing to find. */
function fakeEngine(match: number): Engine {
  const measured: Measurement = {
    match,
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
  const built = {
    tree: { schemaVersion: "1", nodes: [] },
    notes: [],
    themeRaw: {},
    surfaces: { assets: {}, surfaces: {} },
    cropped: [],
    addedTexts: [],
    errors: [],
    missing: [],
  } as unknown as Built;
  const bundle = {
    exportId: "e",
    rootName: "Frame",
    themeArtifactId: "t",
    themeRaw: {},
    doc: { root: { geometry: { bbox: { w: 100 } } } },
    byId: new Map(),
    order: new Map(),
    plates: [{ nodeId: "1", name: "p", png: Buffer.alloc(0) }],
  } as unknown as Bundle;
  return {
    bundle: async () => bundle,
    build: async () => built,
    measure: async () => measured,
    firstPass: async (_bundle, start) => ({ overrides: start, built, measurement: measured }),
  };
}

const fakePlane = () =>
  ({ upload: async (kind: string) => `${kind}-id` }) as unknown as ControlPlane;

function scriptedRun(match: number): ModelClient {
  return createScriptedModel([
    { toolCalls: [{ name: "frame.load", arguments: {} }] },
    { toolCalls: [{ name: "frame.publish", arguments: {} }] },
    {
      toolCalls: [
        {
          name: "final",
          arguments: {
            previewUrl: `${PREVIEW}&width=100&bg=808080`,
            treeArtifactId: "dsl_tree-id",
            measured: true,
            coverage: 100,
            estimated: false,
            unchecked: [],
            placeholderIcons: 0,
            before: match,
            match,
            remaining: ["Scripted: nothing was fixed"],
            compilerFindings: [],
          },
        },
      ],
    },
  ]);
}
