import { createHash } from "node:crypto";
import { defineGraph, END, type GraphEdge } from "@dugout/core";
import { applyEdits, type EditBatch, EditBatchSchema } from "./edits.ts";

/** How many times the repair node may run before the graph stops. */
export const DEFAULT_ATTEMPTS = 3;

const MAX_BRIEF = 2_000;
const MAX_REPORT = 8_000;
const MAX_ATTEMPT_TEXT = 300;
/** The most `lastError` the repair agent's input takes (`RepairInput` in repair.ts). */
const MAX_LAST_ERROR = 500;
const clipError = (error: string) => error.slice(0, MAX_LAST_ERROR);
const fingerprint = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);
/** Past attempts a repair sees. Older ones add tokens and no new information. */
const SHOWN_ATTEMPTS = 5;
/** Identical reports in a row, after which another repair is not worth a model call. */
const STALLED_AFTER = 2;

/** One repair that ran: what it was answering, what it sent, and what became of it. */
export interface CardAttempt {
  repair: number;
  stage: string;
  /** What the repair answered, clipped. Not what is compared: see `key`. */
  report: string;
  edits: string;
  result: string;
  /**
   * A fingerprint of the WHOLE report. `report` is clipped for the model, and a report of several
   * issues differs from the last one only past the clip when a repair fixes the later ones, which
   * is progress. Absent on a checkpoint from before this existed.
   */
  key?: string;
}

export interface CardProgramState extends Record<string, unknown> {
  cardId: string;
  brief: string;
  figma: string;
  screenshot: string;
  tree: unknown;
  data: unknown;
  /** Which report the next repair is answering. */
  stage: "draft" | "check" | "diff";
  report: string;
  checkOk: boolean;
  diffOk: boolean;
  /** A 2× screenshot. The tree cannot make the sizes match, so the graph stops. */
  halt: boolean;
  repairs: number;
  passed: boolean;
  error: string;
  /** An editor's change request. Empty unless save was sent back. */
  changes: string;
  /** Every repair so far, so the next one does not send an edit that already failed. */
  attempts: CardAttempt[];
}

export interface CardProgramRequest {
  cardId: string;
  brief: string;
  figma?: string;
  screenshot?: string;
  maxAttempts?: number;
}

export interface CardLoad {
  ok: boolean;
  issues?: string[];
  tree?: unknown;
  data?: unknown;
}

export interface CardDiff {
  ok: boolean;
  message: string;
  size: {
    render: { width: number; height: number } | null;
    screenshot: { width: number; height: number } | null;
  };
  regions: Array<{ x: number; y: number; w: number; h: number; nodeIds: string[] }>;
  issues?: string[];
}

export interface CardApproval {
  approved: boolean;
  changes?: string;
}

/** A whole tree from the brief-only draft, or the edits a repair returned. */
export interface CardTaken {
  tree?: unknown;
  data?: unknown;
  edits?: EditBatch["edits"];
}

/** Code steps the graph calls. The repair model is not one of them. */
export interface CardProgramDeps {
  load: (input: {
    cardId: string;
    figma: string;
    screenshot: string;
  }) => Promise<CardLoad> | CardLoad;
  check: (
    tree: unknown,
    data: unknown,
  ) => Promise<{ ok: boolean; issues: string[] }> | { ok: boolean; issues: string[] };
  diff: (draft: { cardId: string; tree: unknown; data: unknown }) => Promise<CardDiff>;
  save: (draft: { cardId: string; tree: unknown; data: unknown }) => Promise<void>;
  approve: (draft: { cardId: string; tree: unknown; data: unknown }) => Promise<CardApproval>;
  /** A draft tree, or the edits a repair returned. A whole tree from repair is ignored. */
  take: (output: unknown, cardId: string) => CardTaken | undefined;
}

export interface RepairInput {
  cardId: string;
  brief: string;
  stage: CardProgramState["stage"];
  report: string;
  tree: unknown;
  data: unknown;
  /** Why the last edits were not applied. Empty when they were. */
  lastError: string;
  /** The latest few repairs, oldest first. */
  attempts: CardAttempt[];
}

/**
 * A screenshot that is exactly twice the render, or twice as tall at the same width
 * (the render was stretched to the file's width and the root height stayed put).
 * The 1× size is the PNG the pixel check can compare. Undefined for every other mismatch.
 */
export function oneToOneSize(
  render: { width: number; height: number } | null,
  screenshot: { width: number; height: number } | null,
): { width: number; height: number } | undefined {
  if (!render || !screenshot || render.width < 1 || render.height < 1) return undefined;
  if (screenshot.width === render.width * 2 && screenshot.height === render.height * 2) {
    return { width: render.width, height: render.height };
  }
  if (
    screenshot.width === render.width &&
    screenshot.height === render.height * 2 &&
    render.width % 2 === 0
  ) {
    return { width: render.width / 2, height: render.height };
  }
  return undefined;
}

export function initialCardState(request: CardProgramRequest): CardProgramState {
  return {
    cardId: request.cardId,
    brief: request.brief.trim().slice(0, MAX_BRIEF),
    figma: request.figma ?? "",
    screenshot: request.screenshot ?? "",
    tree: null,
    data: null,
    stage: "draft",
    report: "",
    checkOk: false,
    diffOk: false,
    halt: false,
    repairs: 0,
    passed: false,
    error: "",
    changes: "",
    attempts: [],
  };
}

/**
 * One card, as a graph.
 *
 * load, check, diff and save are code. draft writes the first tree when there is
 * no Figma file. repair returns edits, and the program applies them onto the tree
 * it already holds. A failed check comes back through repair, then check. A failed
 * diff comes back through repair, then check, then diff. Nothing edges back to load,
 * so a retry does not read the Figma file again or start a new card transcript.
 */
export function defineCardProgram(request: CardProgramRequest, deps: CardProgramDeps) {
  const maxAttempts = request.maxAttempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("card: maxAttempts must be at least 1");
  }
  const figma = Boolean(request.figma);
  const shot = Boolean(request.screenshot);
  const state0 = initialCardState(request);

  const repairInput = (state: CardProgramState): RepairInput => ({
    cardId: state.cardId,
    brief: state.brief,
    stage: state.stage,
    report: state.report,
    tree: state.tree,
    data: state.data,
    lastError: clipError(state.error),
    // A checkpoint from before attempts existed has none.
    // the fingerprint is for the program, not the model
    attempts: (state.attempts ?? []).slice(-SHOWN_ATTEMPTS).map(({ key: _key, ...shown }) => shown),
  });

  const editsOf = (output: unknown, cardId: string): EditBatch | undefined => {
    const taken = deps.take(output, cardId);
    if (!taken?.edits) return undefined;
    const parsed = EditBatchSchema.safeParse({
      edits: taken.edits,
      ...(taken.data !== undefined ? { data: taken.data } : {}),
    });
    return parsed.success ? parsed.data : undefined;
  };

  const applyRepair = (output: unknown, state: CardProgramState) => {
    const bumped = state.repairs + 1;
    const batch = editsOf(output, state.cardId);
    const attempt = (edits: string, result: string): CardAttempt => ({
      repair: bumped,
      stage: state.stage,
      report: state.report.slice(0, MAX_ATTEMPT_TEXT),
      edits: edits.slice(0, MAX_ATTEMPT_TEXT),
      result: result.slice(0, MAX_ATTEMPT_TEXT),
      key: fingerprint(state.report),
    });
    if (!batch) {
      const error = messageOf(output, "repair did not return edits");
      return {
        repairs: bumped,
        changes: "",
        error,
        attempts: [attempt("none", error)],
      };
    }
    const applied = applyEdits(state.tree, state.data, batch);
    if (!applied.ok) {
      return {
        repairs: bumped,
        changes: "",
        error: applied.error,
        attempts: [attempt(summarize(batch), applied.error)],
      };
    }
    return {
      tree: applied.tree,
      data: applied.data,
      repairs: bumped,
      changes: "",
      error: "",
      attempts: [attempt(summarize(batch), "applied")],
    };
  };

  /** True when the last repairs were each answering this same report. */
  const stalled = (state: CardProgramState, report: string): boolean => {
    const last = (state.attempts ?? []).slice(-STALLED_AFTER);
    const key = fingerprint(report);
    const head = report.slice(0, MAX_ATTEMPT_TEXT);
    return (
      last.length === STALLED_AFTER &&
      // a checkpoint from before the fingerprint falls back to the clipped text
      last.every((item) => (item.key !== undefined ? item.key === key : item.report === head))
    );
  };

  const nodes = {
    ...(figma
      ? {
          load: {
            kind: "step" as const,
            run: async (state: CardProgramState) => {
              const loaded = await deps.load({
                cardId: state.cardId,
                figma: state.figma,
                screenshot: state.screenshot,
              });
              if (!loaded.ok || loaded.tree === undefined) {
                return {
                  tree: null,
                  error: loaded.issues?.join("\n") || "the Figma DSL did not load",
                };
              }
              return { tree: loaded.tree, data: loaded.data ?? { match: {} }, error: "" };
            },
          },
        }
      : {
          draft: {
            kind: "task" as const,
            agentId: "card-draft",
            input: (state: CardProgramState): RepairInput => ({
              cardId: state.cardId,
              brief: state.brief,
              stage: "draft",
              report: "There is no Figma tree. Write the card the brief describes.",
              tree: null,
              data: null,
              lastError: clipError(state.error),
              attempts: [],
            }),
            until: (output: unknown) => deps.take(output, state0.cardId)?.tree !== undefined,
            maxAttempts: 1,
            apply: (output: unknown, state: CardProgramState) => {
              const taken = deps.take(output, state.cardId);
              if (taken?.tree === undefined) {
                return { error: messageOf(output, "draft did not return a tree") };
              }
              return { tree: taken.tree, data: taken.data ?? { match: {} }, error: "" };
            },
          },
        }),
    check: {
      kind: "step" as const,
      run: async (state: CardProgramState) => {
        const check = await deps.check(state.tree, state.data);
        const report = clip(check.issues.join("\n"));
        const stuck = !check.ok && stalled(state, report);
        return {
          checkOk: check.ok,
          stage: "check" as const,
          report,
          halt: stuck,
          diffOk: false,
          ...(stuck ? { error: NO_PROGRESS } : {}),
        };
      },
    },
    repair: {
      kind: "task" as const,
      agentId: "card-repair",
      input: repairInput,
      until: (output: unknown) => editsOf(output, state0.cardId) !== undefined,
      maxAttempts: 1,
      apply: applyRepair,
    },
    ...(shot
      ? {
          diff: {
            kind: "step" as const,
            run: async (state: CardProgramState) => {
              const report = await deps.diff({
                cardId: state.cardId,
                tree: state.tree,
                data: state.data,
              });
              const scaled = oneToOneSize(report.size.render, report.size.screenshot);
              if (!report.ok && scaled && report.size.render && report.size.screenshot) {
                const error = [
                  `The screenshot is ${report.size.screenshot.width}×${report.size.screenshot.height} and the render is ${report.size.render.width}×${report.size.render.height}.`,
                  `That is a 2× capture. The pixel check needs a 1× PNG at ${scaled.width}×${scaled.height}.`,
                ].join(" ");
                return { diffOk: false, halt: true, stage: "diff" as const, report: error, error };
              }
              const lines = [report.message];
              if (!report.ok && report.size.render && report.size.screenshot) {
                lines.push(
                  "Change the root size so the render matches the screenshot. Do not ask.",
                );
              }
              for (const region of report.regions) {
                const ids = region.nodeIds.length ? region.nodeIds.join(", ") : "no node";
                lines.push(`region ${region.x},${region.y} ${region.w}×${region.h}: ${ids}`);
              }
              if (report.issues?.length) lines.push(...report.issues);
              const text = clip(lines.join("\n"));
              const stuck = !report.ok && stalled(state, text);
              return {
                diffOk: report.ok,
                halt: stuck,
                stage: "diff" as const,
                report: text,
                error: stuck ? NO_PROGRESS : "",
              };
            },
          },
        }
      : {}),
    save: {
      kind: "step" as const,
      run: async (state: CardProgramState) => {
        const draft = { cardId: state.cardId, tree: state.tree, data: state.data };
        const answer = await deps.approve(draft);
        if (answer.approved) {
          await deps.save(draft);
          return { passed: true, changes: "", error: "" };
        }
        if (answer.changes && state.repairs < maxAttempts) {
          return {
            passed: false,
            changes: answer.changes,
            report: clip(answer.changes),
            stage: "check" as const,
            error: "",
          };
        }
        return {
          passed: false,
          changes: "",
          error: answer.changes ? "no repairs left for that change" : "save was rejected",
        };
      },
    },
  };

  const edges: Array<GraphEdge<CardProgramState>> = [];
  if (figma) {
    edges.push(
      { from: "load", to: END, when: (state) => !state.tree },
      { from: "load", to: "check" },
    );
  } else {
    edges.push(
      { from: "draft", to: END, when: (state) => !state.tree },
      { from: "draft", to: "check" },
    );
  }
  edges.push(
    // First match wins, so a stalled repair ends the graph before it can edge back.
    { from: "check", to: END, when: (state) => state.halt },
    {
      from: "check",
      to: "repair",
      when: (state) => !state.checkOk && state.repairs < maxAttempts,
    },
    { from: "check", to: END, when: (state) => !state.checkOk },
  );
  if (shot) {
    edges.push(
      { from: "check", to: "diff" },
      { from: "diff", to: "save", when: (state) => state.diffOk },
      { from: "diff", to: END, when: (state) => state.halt },
      { from: "diff", to: "repair", when: (state) => state.repairs < maxAttempts },
      { from: "diff", to: END },
    );
  } else {
    edges.push({ from: "check", to: "save" });
  }
  edges.push(
    { from: "repair", to: "check" },
    { from: "save", to: END, when: (state) => state.passed },
    {
      from: "save",
      to: "repair",
      when: (state) => state.changes !== "" && state.repairs < maxAttempts,
    },
    { from: "save", to: END },
  );

  return defineGraph<CardProgramState>({
    id: "card",
    initial: state0,
    fields: {
      cardId: { reduce: "replace" },
      brief: { reduce: "replace" },
      figma: { reduce: "replace" },
      screenshot: { reduce: "replace" },
      tree: { reduce: "replace" },
      data: { reduce: "replace" },
      stage: { reduce: "replace" },
      report: { reduce: "replace" },
      checkOk: { reduce: "replace" },
      diffOk: { reduce: "replace" },
      halt: { reduce: "replace" },
      repairs: { reduce: "replace" },
      passed: { reduce: "replace" },
      error: { reduce: "replace" },
      changes: { reduce: "replace" },
      attempts: { reduce: "append" },
    },
    start: figma ? "load" : "draft",
    maxVisits: 4 + maxAttempts * 4,
    nodes,
    edges,
  });
}

const NO_PROGRESS = "repair is not changing the result";

/** `node_1: props padding, color` for each node an edit batch touches. */
function summarize(batch: EditBatch): string {
  const parts = batch.edits.map((edit) => {
    const what = [
      ...(edit.type ? [`type ${edit.type}`] : []),
      ...(edit.props ? [`props ${Object.keys(edit.props).join(", ")}`] : []),
    ];
    return `${edit.id}: ${what.join(", ") || "no change"}`;
  });
  if (batch.data) parts.push(`data ${Object.keys(batch.data.match).join(", ")}`);
  return parts.join("; ");
}

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_REPORT) return trimmed;
  return `${trimmed.slice(0, MAX_REPORT - 1)}…`;
}

function messageOf(output: unknown, fallback: string): string {
  const message = (output as { message?: string } | null)?.message;
  return (message ?? fallback).replace(/\s+/g, " ").trim().slice(0, 500);
}
