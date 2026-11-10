import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approve } from "@dugout/contracts";
import {
  createBedrockClient,
  createMemorySink,
  loadModelConfig,
  type Responder,
} from "@dugout/core";
import { type CaseOutcome, type DataOutcome, type EvalSuite, gradeData } from "@dugout/evals";
import type { MemoryStore } from "@dugout/memory";
import { loadDsl } from "../src/dsl.ts";
import { dateKey } from "../src/facts.ts";
import { agent } from "../src/index.ts";
import { createPlane, previewOf, type RunInput } from "../src/tools.ts";
import { CASES, type DataCase } from "./cases.ts";
import { outcomeOf } from "./extract.ts";

export interface SuiteOptions {
  mode: "live" | "scripted";
  model?: string;
  store: MemoryStore;
  runsDir: string;
  /** Call Cast for real (hook-maker finds or builds the hook). Without it, a case reuses the hook
   * output its first live run cached in `evals/data/`: Cast allows 25 live runs an hour. */
  live?: boolean;
}

const DIR = join(import.meta.dirname, "data");

/** What each grader said for a case when the baseline was recorded (evals/data-baseline.json). */
const baseline = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, "data-baseline.json"), "utf8")) as {
      recordedAt: string;
      cases: Record<string, Record<string, boolean>>;
    };
  } catch {
    return undefined;
  }
})();
const cachePath = (id: string) => join(DIR, `${id}.hook.json`);
const recordedPath = (id: string) => join(DIR, `${id}.outcome.json`);

/** A hook's output as its first live run saw it: what a case binds when Cast is not called. */
interface CachedHook {
  hookId: string | null;
  output: unknown;
  cachedAt: string;
}

/** Say why a case cannot give a result yet; the runner reports it as skipped, not failed. */
const skipped = (why: string): CaseOutcome => ({
  grades: [],
  runIds: [],
  costUsd: 0,
  servedModels: [],
  skipped: why,
});

export async function createSuite(opts: SuiteOptions): Promise<EvalSuite<DataCase>> {
  const live = opts.mode === "live";
  const responder: Responder = async () => approve("eval");

  /** The grades for an outcome; an unconfirmed case reports them and does not gate. */
  const outcome = (c: DataCase, data: DataOutcome, extra: Partial<CaseOutcome>): CaseOutcome => {
    const before = baseline?.cases[c.id];
    const grades = [
      ...gradeData(c.expect, data),
      // what passed when the baseline was recorded still passes: a change is never a loss
      ...(before
        ? [
            (() => {
              const lost = gradeData(c.expect, data).filter((g) => before[g.grader] && !g.pass);
              return {
                grader: "not-worse-than-baseline",
                pass: lost.length === 0,
                detail: lost.length
                  ? `was passing on ${baseline?.recordedAt.slice(0, 10)}: ${lost.map((g) => g.grader).join(", ")}`
                  : `nothing lost since ${baseline?.recordedAt.slice(0, 10)}`,
              };
            })(),
          ]
        : []),
    ];
    const base = { runIds: [], costUsd: data.costUsd, servedModels: [], ...extra };
    if (c.confirmed) return { ...base, grades };
    const line = grades.map((g) => `${g.pass ? "✓" : "✗"} ${g.grader}: ${g.detail}`).join(" | ");
    return {
      ...base,
      grades: [],
      skipped: `expected answer not confirmed yet; it would be: ${line}`,
    };
  };

  return {
    agentId: "data-bind",
    cases: CASES,
    async runCase(c) {
      if (!c.preview) return skipped(c.needs ?? "no published frame for it (set `preview`)");
      // scripted: no model and no Cast, so grade the outcome a live run recorded, if there is one
      if (!live) {
        if (!existsSync(recordedPath(c.id))) return skipped("scripted mode: no recorded outcome");
        const recorded = JSON.parse(readFileSync(recordedPath(c.id), "utf8")) as DataOutcome;
        return outcome(c, recorded, {});
      }

      const { project, tree: treeId } = previewOf(c.preview);
      const plane = createPlane(project);
      const meta = await plane.meta(treeId);
      const slots = (meta.slots as Array<{ id: string; name: string }> | undefined) ?? [];
      const slot = c.slot ? slots.find((s) => s.name === c.slot) : undefined;
      if (c.slot && !slot) return skipped(`the frame has no slot named ${c.slot}`);

      // Cast is called only with --live; otherwise the cached hook output is the run's data
      const cached = existsSync(cachePath(c.id))
        ? (JSON.parse(readFileSync(cachePath(c.id), "utf8")) as CachedHook)
        : undefined;
      if (!opts.live && !c.data && !cached) {
        return skipped(
          "no cached hook output: run it once with --live (Cast allows 25 runs an hour)",
        );
      }
      const data =
        c.data ??
        (!opts.live && cached
          ? await plane.upload("sample_data", cached.output, { source: "dugout:eval", case: c.id })
          : undefined);

      const models = loadModelConfig();
      const sink = createMemorySink();
      const run = agent.create({
        store: opts.store,
        models,
        client: createBedrockClient({ models }),
        ...(opts.model ? { model: opts.model } : {}),
        runsDir: opts.runsDir,
        consolidate: false,
        ...(await liveMcp(opts.live === true)),
      });
      const result = await run({
        tenantId: c.tenant,
        input: {
          preview: c.preview,
          ...(data ? { data } : {}),
          ...(slot ? { slot: slotInput(meta, slot.id) } : {}),
        },
        responder,
        sinks: [sink],
      });
      const out = result.status === "completed" ? (result.output as Record<string, string>) : {};
      const [tree, plan, bag] = await Promise.all([
        plane.json(treeId),
        out.planArtifactId ? plane.json(out.planArtifactId) : undefined,
        out.dataArtifactId ? plane.json(out.dataArtifactId) : undefined,
      ]);
      const reduced = outcomeOf({
        status: result.status,
        output: result.status === "completed" ? result.output : undefined,
        events: sink.events,
        tree,
        plan,
        bag,
        timeOf: dateKey((await loadDsl()).readDate),
        steps: result.usage.steps,
        costUsd: result.usage.costUsd,
      });
      // cache what Cast gave, once, for the runs that do not call it
      if (opts.live && reduced.hookOutput !== undefined && !c.data) {
        mkdirSync(DIR, { recursive: true });
        const cache: CachedHook = {
          hookId: reduced.hookId ?? null,
          output: reduced.hookOutput,
          cachedAt: new Date().toISOString(),
        };
        writeFileSync(cachePath(c.id), `${JSON.stringify(cache, null, 2)}\n`);
      }
      if (cached && !opts.live) reduced.hookId = cached.hookId;
      writeFileSync(
        join(opts.runsDir, `data-${c.id}.outcome.json`),
        `${JSON.stringify(reduced, null, 2)}\n`,
      );
      return outcome(c, reduced, { runIds: [result.runId] });
    },
  };
}

/** The slot as frame-match stored it in the tree's meta: the whole object data-bind takes. */
function slotInput(meta: Record<string, unknown>, id: string): NonNullable<RunInput["slot"]> {
  const slot = (meta.slots as Array<Record<string, unknown>>).find((s) => s.id === id);
  return { ...slot, readFrom: slot?.readFrom ?? [] } as NonNullable<RunInput["slot"]>;
}

/** The Cast tools, only when the run calls Cast for real. */
async function liveMcp(call: boolean) {
  if (!call) return {};
  const { defaultMcpHost } = await import("@dugout/mcp");
  return { mcp: defaultMcpHost() };
}
