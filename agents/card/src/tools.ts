import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolContext } from "@dugout/contracts";
import { type CompletedRun, describeImage, REPO_ROOT } from "@dugout/core";
import { z } from "zod";
import { checkCard, pipelineRoot } from "./dsl.ts";
import { applyEdits, EditBatchSchema } from "./edits.ts";
import { diffCard, loadFigma, passBlock, referenceOf } from "./pixels.ts";
import { flattenOnPage } from "./png.ts";
import { type CardDraft, CardShape, summarize } from "./schema.ts";

const SEE_PROMPT = [
  "Describe this screenshot so someone can rebuild the same layout.",
  "Start with the frame: the colour behind the whole strip, then the header if there is one. Say what sits on the left of the header and what sits on the right, and the colour of that text.",
  "Then walk left to right. Give each card, date ribbon, and cut-off edge its own paragraph. Do not merge two cards into one.",
  "Quote every visible word. Say whether that text is red, navy, white, or grey, and whether a circular team badge is on that row.",
  "Say when a control is a button. Count the cards, including ones cut off at the edge.",
  "The page behind the card is near-black. A pale word on that page is not sitting on white.",
  "Cover every card from the left edge to the right edge. Do not stop in the middle of a card.",
  "Close with one line: Cards: <count>. Buttons: <the button labels you actually saw, quoted>.",
  "Do not write JSON. Do not write a component tree. Do not invent text that is not visible.",
].join(" ");

/** Vision read of a PNG. Tests pass their own. The default calls Claude and keeps the bytes out of the transcript. */
export type SeeImage = (png: Buffer, signal: AbortSignal) => Promise<string>;

const VISION_BYTES = 5_000_000;

async function defaultSee(png: Buffer, signal: AbortSignal): Promise<string> {
  return describeImage({ png, prompt: SEE_PROMPT, model: "sonnet", signal });
}

export const CARDS_DIR = join(REPO_ROOT, ".runs", "cards");

const noArgs = z.object({}).strict();

interface Held {
  draft: CardDraft;
  fromFigma: boolean;
}

/** The tree for one run. The model edits it by node id and never sends it back. */
const drafts = new Map<string, Held>();

export function holdDraft(runId: string, draft: CardDraft, fromFigma: boolean) {
  drafts.set(runId, { draft, fromFigma });
}

function runCardId(input: unknown): string {
  const cardId = (input as { cardId?: unknown } | null)?.cardId;
  if (typeof cardId !== "string" || !cardId) throw new Error("the run has no cardId");
  return cardId;
}

function requireDraft(ctx: Pick<ToolContext, "runId">): CardDraft {
  const held = drafts.get(ctx.runId);
  if (!held) {
    throw new Error(
      "No card is loaded. Call card.figma, or card.draft when this run has no Figma file.",
    );
  }
  return held.draft;
}

/** The card this run is holding. Tests read it when prompt generation does not save. */
export function heldDraft(runId: string): CardDraft | undefined {
  return drafts.get(runId)?.draft;
}

/**
 * A finished prompt run has no card.save. The host still writes the checked tree so the preview
 * page shows it. A Figma run stays behind the save approval.
 */
export async function publishPromptCard(
  run: CompletedRun,
  opts: { cardsDir?: string; renderRoot?: string } = {},
): Promise<void> {
  if (run.result.status !== "completed") return;
  const ref = referenceOf(run.ctx.input);
  if (ref.mode !== "off" && ref.mode !== "prompt") return;
  const draft = heldDraft(run.ctx.runId);
  if (!draft || !checkCard(draft.tree, draft.data).ok) return;
  await writeCard(
    opts.renderRoot ?? pipelineRoot(),
    opts.cardsDir ?? CARDS_DIR,
    draft,
    run.ctx.tenantId,
    run.ctx.runId,
    // generated from a brief, nobody approved a save: the preview only
    { record: false },
  );
}

function gate(draft: CardDraft, ctx: Pick<ToolContext, "runId" | "input">): string | undefined {
  const ref = referenceOf(ctx.input);
  if (ref.mode === "off" || ref.mode === "prompt") {
    return "This run generates the card from the brief. Do not call card.save. Call final with cardId, nodeCount and rootType.";
  }
  const check = checkCard(draft.tree, draft.data);
  if (!check.ok) return check.issues.join("\n");
  return passBlock(draft, ctx);
}

export function createCardTools(
  opts: { cardsDir?: string; renderRoot?: string; see?: SeeImage } = {},
) {
  const cardsDir = opts.cardsDir ?? CARDS_DIR;
  const renderRoot = opts.renderRoot ?? pipelineRoot();
  const see = opts.see ?? defaultSee;

  const cardFigma = defineTool({
    name: "card.figma",
    description:
      "Load the Figma-generated DSL for this run and keep it. Takes no arguments. Returns the tree so you can read node ids. Do not send the tree back. Call card.check with no arguments, and change a node with card.edit.",
    input: noArgs,
    effect: "read",
    timeoutMs: 10_000,
    alwaysInline: true,
    async run(_input, ctx) {
      const loaded = loadFigma(ctx.input);
      if (!loaded.ok || loaded.tree === undefined) return loaded;
      const parsed = CardShape.safeParse({
        cardId: runCardId(ctx.input),
        tree: loaded.tree,
        data: loaded.data ?? { match: {} },
      });
      if (!parsed.success) return { ok: false, issues: [z.prettifyError(parsed.error)] };
      holdDraft(ctx.runId, parsed.data, true);
      return {
        ...loaded,
        note: "Stored. Call card.check with {}. Change a node with card.edit. Do not send this tree back.",
      };
    },
  });

  const cardSee = defineTool({
    name: "card.see",
    description:
      "Read this run's reference screenshot with a vision model. Takes no arguments. Use the description for the layout and quote the words it reports. Do not call this when the run has a Figma file.",
    input: noArgs,
    effect: "read",
    timeoutMs: 60_000,
    async run(_input, ctx) {
      const ref = referenceOf(ctx.input);
      if (ref.mode === "on") {
        throw new Error(
          "This run has a Figma file. Call card.figma. card.diff compares the screenshot.",
        );
      }
      if (ref.mode !== "prompt") throw new Error("This run has no screenshot.");
      if (ref.size > VISION_BYTES) {
        throw new Error("the screenshot is over 5MB. The vision model cannot take it.");
      }
      const png = flattenOnPage(readFileSync(ref.screenshotPath));
      const description = await see(png, ctx.signal);
      return { description };
    },
  });

  const cardDraft = defineTool({
    name: "card.draft",
    description:
      "Store a card you wrote, once, when this run has no Figma file. Pass tree and data. If a Figma file is on the run, this is denied: call card.figma and card.edit instead.",
    input: CardShape,
    effect: "read",
    timeoutMs: 10_000,
    async run(draft, ctx) {
      const ref = referenceOf(ctx.input);
      if (ref.mode === "on" || drafts.get(ctx.runId)?.fromFigma) {
        throw new Error(
          "This run has a Figma file. Call card.figma, then card.edit. Do not send the tree.",
        );
      }
      const cardId = runCardId(ctx.input);
      if (draft.cardId !== cardId) throw new Error(`cardId must be ${cardId}`);
      holdDraft(ctx.runId, draft, false);
      return summarize(draft);
    },
  });

  const cardEdit = defineTool({
    name: "card.edit",
    description:
      "Change nodes on the loaded card. Pass edits: an array of { id, props } or { id, type }. props replaces those keys and leaves the rest of the node. At most 80 edits. Do not send the tree. Call card.check after.",
    input: EditBatchSchema,
    effect: "read",
    timeoutMs: 10_000,
    async run(batch, ctx) {
      const current = requireDraft(ctx);
      const next = applyEdits(current.tree, current.data, batch);
      if (!next.ok) throw new Error(next.error);
      const parsed = CardShape.safeParse({
        cardId: current.cardId,
        tree: next.tree,
        data: next.data,
      });
      if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
      holdDraft(ctx.runId, parsed.data, drafts.get(ctx.runId)?.fromFigma ?? false);
      return {
        updated: batch.edits.map((edit) => edit.id),
        nodeCount: parsed.data.tree.nodes.length,
      };
    },
  });

  const cardCheck = defineTool({
    name: "card.check",
    description:
      "Check the loaded card against the FanOS DSL and the Southern Brave tokens. Takes no arguments. Returns ok and issues. Fix the named nodes with card.edit, then call this again. Do not send the tree.",
    input: noArgs,
    effect: "read",
    timeoutMs: 10_000,
    resolve: (_input, ctx) => requireDraft(ctx),
    async run(draft) {
      return checkCard(draft.tree, draft.data);
    },
  });

  const cardDiff = defineTool({
    name: "card.diff",
    description:
      "Render the loaded card and compare it to this run's reference screenshot. Takes no arguments. ok is true when the render is the same size as the screenshot and every mismatch is at most 8 pixels thick. regions lists the thicker boxes and the node ids under them. Change those nodes with card.edit and call this again. Call card.save only when ok is true. Do not send the tree.",
    input: noArgs,
    effect: "read",
    timeoutMs: 90_000,
    resolve: (_input, ctx) => requireDraft(ctx),
    async run(draft, ctx) {
      return diffCard(draft, ctx);
    },
  });

  const cardSave = defineTool({
    name: "card.save",
    description:
      "Save the loaded card. Only for a run that has a Figma file. Takes no arguments. The tree must be one card.check accepted, and card.diff must have accepted this screenshot. An editor approves the save. Returns cardId, nodeCount and rootType. A prompt run must not call this.",
    input: noArgs,
    effect: "write",
    timeoutMs: 10_000,
    resolve: (_input, ctx) => requireDraft(ctx),
    block: gate,
    async run(draft, ctx) {
      const blocked = gate(draft, ctx);
      if (blocked) throw new Error(blocked);
      await writeCard(renderRoot, cardsDir, draft, ctx.tenantId, ctx.runId);
      return summarize(draft);
    },
  });

  return [cardFigma, cardSee, cardDraft, cardEdit, cardCheck, cardDiff, cardSave];
}

/** The preview page reads these two files on each request. */
export function previewPaths(renderRoot: string) {
  return {
    tree: join(renderRoot, "packages/dsl/fixtures/preview/card.json"),
    data: join(renderRoot, "packages/renderer/fixtures/preview/card.data.json"),
  };
}

export async function writeCard(
  renderRoot: string,
  cardsDir: string,
  draft: CardDraft,
  tenantId: string,
  runId: string,
  /**
   * `false` writes the preview only. The record is the last card an editor APPROVED to be saved:
   * a run that generated one from a brief was never asked, so it must not replace it.
   */
  opts: { record?: boolean } = {},
) {
  const preview = previewPaths(renderRoot);
  await mkdir(join(preview.tree, ".."), { recursive: true });
  await mkdir(join(preview.data, ".."), { recursive: true });
  const tree = `${JSON.stringify(draft.tree, null, 2)}\n`;
  const data = `${JSON.stringify(draft.data, null, 2)}\n`;
  await writeFile(preview.tree, tree);
  await writeFile(preview.data, data);
  if (opts.record === false) return { preview, record: undefined };
  const record = join(cardsDir, tenantId, `${draft.cardId}.json`);
  await mkdir(join(record, ".."), { recursive: true });
  await writeFile(
    record,
    `${JSON.stringify({ cardId: draft.cardId, runId, tree: draft.tree, data: draft.data }, null, 2)}\n`,
  );
  return { preview, record };
}
