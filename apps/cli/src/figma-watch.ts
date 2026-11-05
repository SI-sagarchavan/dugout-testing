import type { ExportRecord } from "@dugout/agent-frame-match";

/** What a Handoff starts: the whole pass, one run (frame-match, then bind, as its children). */
export const FIGMA_AGENT = "section-builder";
/** Agents whose runs say a Handoff was already handled: frame-match ran alone before the pass existed. */
export const PRIOR_AGENTS: string[] = [FIGMA_AGENT, "frame-match"];

export interface FigmaWatchOptions {
  listExports(limit: number): Promise<ExportRecord[]>;
  /** The agent's runs so far, newest first; each input holds the export it was for. */
  priorRuns(): Promise<Array<{ input: unknown }>>;
  start(input: { exportId: string; project: string; receivedAt: string }): Promise<string>;
  project: string;
  /** With no prior run, exports from before this are left alone. */
  since: Date;
  /** The most exports to read on each look. */
  limit?: number;
}

/**
 * What turns the plugin's Handoff into a run. Handoff stores an export in the control plane, and this
 * looks there. A designer who sends one frame twice before a look gets a run on the newer one.
 */
export function createFigmaWatch(opts: FigmaWatchOptions) {
  let primed = false;
  const handled = new Set<string>();
  let since = opts.since.getTime();

  // A prior run says how far the last watcher got, so a Handoff made while this one was down still runs.
  const prime = async () => {
    let reached: number | undefined;
    for (const run of await opts.priorRuns()) {
      const input = run.input as { exportId?: unknown; receivedAt?: unknown } | null;
      if (typeof input?.exportId === "string") handled.add(input.exportId);
      if (typeof input?.receivedAt === "string") {
        reached = Math.max(reached ?? 0, Date.parse(input.receivedAt));
      }
    }
    if (reached !== undefined) since = reached;
    primed = true;
  };

  return {
    /** Queues a run for each frame sent since the last look. Returns what it queued. */
    async look(): Promise<Array<{ exportId: string; runId: string; rootName: string }>> {
      if (!primed) await prime();
      const exports = await opts.listExports(opts.limit ?? 20);
      const newest = new Map<string, ExportRecord & { at: number }>();
      for (const record of exports) {
        if (handled.has(record.id) || !record.receivedAt) continue;
        const at = Date.parse(record.receivedAt);
        if (at <= since) continue;
        // superseded by a newer send of the same frame, so it never needs a run
        const frame = `${record.fileKey ?? ""}/${record.rootNodeId ?? record.id}`;
        const held = newest.get(frame);
        if (!held || at > held.at) newest.set(frame, { ...record, at });
        else handled.add(record.id);
      }
      const queued = [];
      for (const record of [...newest.values()].sort((a, b) => a.at - b.at)) {
        const runId = await opts.start({
          exportId: record.id,
          project: opts.project,
          receivedAt: record.receivedAt as string,
        });
        handled.add(record.id);
        since = Math.max(since, record.at);
        queued.push({
          exportId: record.id,
          runId,
          rootName: record.rootName ?? record.rootNodeId ?? record.id,
        });
      }
      return queued;
    },
  };
}

/** The closing lines for a run: what happened, the preview link, and what is still off. */
export function finishedLines(
  ending: { type: string; data: Record<string, unknown> },
  runId: string,
): string[] {
  const usage = ending.data.usage as { costUsd: number; steps: number } | undefined;
  const cost = usage ? ` · $${usage.costUsd.toFixed(4)} · ${usage.steps} steps` : "";
  const lines = ["", "════════════════════════════════════════"];
  if (ending.type === "run.failed") {
    lines.push(`FINISHED: failed${cost}`, `  ${String(ending.data.message ?? "")}`);
  } else if (ending.type === "run.cancelled") {
    lines.push(`FINISHED: cancelled${cost}`);
  } else if (ending.data.status === "rejected") {
    lines.push(`FINISHED: you rejected it, nothing published${cost}`);
  } else {
    const out = (ending.data.output ?? {}) as {
      previewUrl?: string;
      measured?: boolean;
      coverage?: number;
      placeholderIcons?: number;
      unchecked?: string[];
      estimated?: boolean;
      unmeasuredBecause?: string;
      before?: number;
      match?: number;
      /** Set when the run was the whole pass (section-builder): the frame is bound to data too. */
      bound?: number;
      remaining?: string[];
      compilerFindings?: string[];
    };
    const data = out.bound !== undefined ? `; ${out.bound} node(s) bound to data` : "";
    const link = out.bound !== undefined ? "preview with data" : "preview";
    if (out.previewUrl && out.measured === false) {
      lines.push(
        `FINISHED: published UNMEASURED, nothing was compared${data}${cost}`,
        `  why: ${out.unmeasuredBecause ?? "no screenshot fits the frame"}`,
        `  ${link}: ${out.previewUrl}`,
      );
    } else if (out.previewUrl) {
      lines.push(
        `FINISHED: matched ${out.before}% → ${out.match}% over ${out.coverage ?? "?"}% of the frame${out.estimated ? " (placement estimated)" : ""}${data}${cost}`,
        `  ${link}: ${out.previewUrl}`,
      );
    } else {
      lines.push(`FINISHED: nothing published${cost}`);
    }
    if (out.placeholderIcons) {
      lines.push(`  logos and icons with no art: ${out.placeholderIcons}, drawn as placeholders`);
    }
    if (out.unchecked?.length) {
      const shown = out.unchecked.slice(0, 6).join(", ");
      const more = out.unchecked.length > 6 ? ` and ${out.unchecked.length - 6} more` : "";
      lines.push(`  not checked, no screenshot holds them: ${shown}${more}`);
    }
    for (const item of out.remaining ?? []) lines.push(`  still off: ${item}`);
    for (const item of out.compilerFindings ?? []) lines.push(`  for the compiler: ${item}`);
  }
  lines.push(
    `  run ${runId}`,
    "════════════════════════════════════════",
    "watching for the next Handoff...",
  );
  return lines;
}
