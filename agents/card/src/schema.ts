import { z } from "zod";
import { checkCard } from "./dsl.ts";

export const CARD_ID = /^[a-z][a-z0-9-]{0,40}$/;

const rawNumber = z.object({ raw: z.number(), _unbound: z.literal(true) }).strict();
const length = z.union([z.string(), rawNumber]);

const NODE_TYPES = [
  "Box",
  "Stack",
  "Overlay",
  "Text",
  "Image",
  "Icon",
  "Divider",
  "Button",
] as const;

const props = z.looseObject({
  direction: z.enum(["row", "column"]).optional(),
  gap: z.union([z.string(), rawNumber]).optional(),
  align: z.enum(["start", "center", "end", "stretch", "baseline"]).optional(),
  justify: z.enum(["start", "center", "end", "between", "around", "evenly"]).optional(),
  clip: z.boolean().optional(),
  wrap: z.boolean().optional(),
  surface: z.string().optional(),
  space: z
    .looseObject({
      p: length.optional(),
      px: length.optional(),
      py: length.optional(),
      pt: length.optional(),
      pr: length.optional(),
      pb: length.optional(),
      pl: length.optional(),
    })
    .optional(),
  size: z
    .union([
      z.string(),
      rawNumber,
      z.looseObject({
        w: length.optional(),
        h: length.optional(),
        ratio: z.string().optional(),
      }),
    ])
    .optional(),
  place: z
    .object({
      anchor: z
        .enum([
          "fill",
          "top-start",
          "top-center",
          "top-end",
          "top-fill",
          "mid-start",
          "center",
          "mid-end",
          "mid-fill",
          "bottom-start",
          "bottom-center",
          "bottom-end",
          "bottom-fill",
        ])
        .optional(),
      offset: z
        .object({
          block: length.optional(),
          inline: length.optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  content: z.string().optional(),
  style: z.string().optional(),
  tone: z.string().optional(),
  textCase: z.enum(["none", "upper", "lower", "title"]).optional(),
  as: z.enum(["h1", "h2", "h3", "h4", "h5", "h6", "p", "span"]).optional(),
  truncate: z.number().int().optional(),
  orientation: z.enum(["horizontal", "vertical", "vertical-up", "vertical-down"]).optional(),
  src: z.string().optional(),
  alt: z.string().optional(),
  fit: z.enum(["cover", "contain", "fill", "none"]).optional(),
  name: z.string().optional(),
});

const node = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]{0,63}$/),
    parent: z.string().min(1).nullable(),
    idx: z.number().int().nonnegative(),
    type: z.enum(NODE_TYPES),
    src: z.string().min(1),
    props,
  })
  .strict();

const treeObject = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    nodes: z.array(node).min(1),
  })
  .strict();

const dataObject = z
  .object({
    match: z.record(z.string(), z.string()),
  })
  .strict();

/**
 * A large tree sometimes arrives as a JSON string, and the string can stop before the object's
 * closing brace. Parse that back into the object the checker expects.
 */
function treeValue(value: unknown): unknown {
  const parsed = jsonObject(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  if (typeof record.schemaVersion !== "string" && Array.isArray(record.nodes)) {
    return { schemaVersion: "1.0.0", ...record };
  }
  return parsed;
}

function jsonObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{")) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!text.endsWith("]")) return value;
    try {
      return JSON.parse(`${text}}`) as unknown;
    } catch {
      return value;
    }
  }
}

export const CardShape = z
  .object({
    cardId: z.string().regex(CARD_ID),
    tree: z.preprocess(treeValue, treeObject),
    data: z.preprocess(jsonObject, dataObject),
  })
  .strict();
export type CardDraft = z.infer<typeof CardShape>;

/** The same card, without the string coerce. `final` can describe this to the model. */
export const CardObject = z
  .object({
    cardId: z.string().regex(CARD_ID),
    tree: treeObject,
    data: dataObject,
  })
  .strict();

/** The editor is asked only after the trial validator accepts the tree. */
export const SaveSchema = CardShape.superRefine((draft, ctx) => {
  const check = checkCard(draft.tree, draft.data);
  if (!check.ok) ctx.addIssue({ code: "custom", message: check.issues.join("\n") });
});

export const Output = z
  .object({
    cardId: z.string().regex(CARD_ID),
    nodeCount: z.number().int().positive(),
    rootType: z.enum(NODE_TYPES),
  })
  .strict();
export type CardOutput = z.infer<typeof Output>;

export function summarize(draft: CardDraft): CardOutput {
  const root = draft.tree.nodes.find((item) => item.parent === null);
  return {
    cardId: draft.cardId,
    nodeCount: draft.tree.nodes.length,
    rootType: root?.type ?? "Stack",
  };
}
