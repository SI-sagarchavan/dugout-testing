import type { BuildPattern, BuildReport, RunEvent, Situation } from "@dugout/contracts";
import { MAX_PUBLISH_REFUSALS } from "./tools.ts";

/** The parts of the run's result this reads (`Result` in agent.ts). */
interface Ending {
  previewUrl?: string;
  measured?: boolean;
  coverage?: number;
  before?: number;
  match?: number;
  remaining?: string[];
  compilerFindings?: string[];
  content?: string;
  settled?: Array<{ id: string; value?: unknown; by: string }>;
  slots?: Array<{ name?: string; content?: string }>;
}

/** One call of a tool with what it answered, when the answer is JSON. */
interface Call {
  tool: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

/** The run's own calls that ended without an error, in order, with their answers. */
function callsOf(events: RunEvent[]): Call[] {
  const inputs = new Map<string, unknown>();
  const calls: Call[] = [];
  for (const event of events) {
    if (event.type === "tool.started") inputs.set(event.data.callId, event.data.input);
    if (event.type !== "tool.completed" || !event.data.ok) continue;
    try {
      const result = JSON.parse(event.data.content);
      const input = inputs.get(event.data.callId);
      if (result && typeof result === "object" && input && typeof input === "object") {
        calls.push({
          tool: event.data.tool,
          input: input as Record<string, unknown>,
          result: result as Record<string, unknown>,
        });
      }
    } catch {
      // an answer that is not JSON (a stored reference) says nothing here
    }
  }
  return calls;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * What a run did to match a frame (ADR 0034): each container's layout as applied and who settled
 * it, the split, the overrides that were kept with what each gained, the match before and after
 * and what the compiler should have done. Read from the run's result and its own calls, by code.
 * Good when it was measured, ended no lower than the plain compile and was not let through after
 * the gate's refusals ran out.
 */
export function record(run: {
  input: unknown;
  output: unknown;
  events: RunEvent[];
  section: Situation;
}): BuildReport | undefined {
  const out = run.output as Ending | undefined;
  const calls = callsOf(run.events);
  const overrides = calls
    .filter((c) => c.tool === "frame.override" && c.result.kept === true)
    .map((c) => ({
      change: c.input,
      ...(typeof c.result.was === "number" && typeof c.result.match === "number"
        ? { gained: round(c.result.match - c.result.was) }
        : {}),
    }));
  const layouts = calls
    .filter((c) => c.tool === "frame.layout" && c.result.kept !== false)
    .map((c) => ({ choice: c.input.choice, settled: c.input.settled ?? [] }));
  const split = calls.findLast((c) => c.tool === "frame.split");
  // a run that never published and changed nothing has nothing to say about the section
  if (!out && overrides.length === 0 && layouts.length === 0 && !split) return undefined;
  const refusals = run.events.filter(
    (e) => e.type === "tool.denied" && e.data.tool === "frame.publish" && e.data.advisory,
  ).length;
  const forced = refusals >= MAX_PUBLISH_REFUSALS;
  const measured = out?.measured === true && out.match !== undefined;
  const on = run.section.name ? `"${run.section.name}"` : "the frame";
  const kinds = layouts.flatMap((l) => {
    const kind = (l.choice as { kind?: unknown } | undefined)?.kind;
    return typeof kind === "string" ? [kind] : [];
  });
  const input = (run.input ?? {}) as { handoffId?: string; exportId?: string };
  const layout = layoutPattern(kinds);
  return {
    did: {
      layouts,
      ...(split ? { split: { joins: split.input.joins, settled: split.input.settled ?? [] } } : {}),
      overrides,
      ...(out?.settled?.length ? { settled: out.settled } : {}),
      ...(out?.before === undefined ? {} : { before: out.before }),
      ...(out?.match === undefined ? {} : { match: out.match }),
      ...(out?.coverage === undefined ? {} : { coverage: out.coverage }),
      compilerFindings: out?.compilerFindings ?? [],
      ...(forced ? { forced: true } : {}),
    },
    // what each container is and which kinds of fix were kept: no node id, token or value
    portable: {
      layouts: kinds,
      overrides: overrides.map((o) => ({
        kinds: Object.keys(o.change),
        ...(o.gained === undefined ? {} : { gained: o.gained }),
      })),
      compilerFindings: out?.compilerFindings?.length ?? 0,
    },
    good: measured && !forced && (out?.match ?? 0) >= (out?.before ?? 0) - 0.05,
    ...(measured && out?.match !== undefined ? { score: out.match } : {}),
    remaining: out?.remaining ?? [],
    line: out
      ? `matched ${on}${measured ? ` at ${out.match}% (${out.before ?? "?"}% compiled)` : ", not measured"}: ${overrides.length} overrides kept${kinds.length ? `, ${kinds.join(", ")}` : ""}`
      : `worked on ${on} and did not publish`,
    ...(kinds.length === 1 && kinds[0] ? { section: { layout: kinds[0] } } : {}),
    ...(layout ? { patterns: [layout] } : {}),
    ...(input.handoffId ? { handoffId: input.handoffId } : {}),
    ...(out?.previewUrl ? { previewUrl: out.previewUrl } : {}),
  };
}

/**
 * The layout of a section that shows a list, when its containers are all of one kind:
 * `layout.<list>` once sections agree. The list is the section's label from the record of the run
 * that found its data (hook-maker's `list`); a section with none gives no pattern.
 */
export function layoutPattern(kinds: string[]): BuildPattern | undefined {
  const [kind] = kinds;
  if (!kind || new Set(kinds).size !== 1) return undefined;
  return {
    key: "layout.{list}",
    value: { layout: kind, list: "{list}" },
    sentence: `A section that shows the list "{list}" is a ${kind}`,
  };
}
