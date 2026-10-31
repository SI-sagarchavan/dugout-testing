import { z } from "zod";

const nodeId = z.string().regex(/^[a-z0-9][a-z0-9_]{0,63}$/);

/** One node on the tree the host already holds. props replaces those keys and leaves the rest. */
export const NodeEditSchema = z
  .object({
    id: nodeId,
    type: z.string().min(1).max(40).optional(),
    props: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type NodeEdit = z.infer<typeof NodeEditSchema>;

/** The only way the model changes a loaded card. The tree itself stays with the host. */
export const EditBatchSchema = z
  .object({
    edits: z.array(NodeEditSchema).max(80).default([]),
    data: z
      .object({ match: z.record(z.string(), z.string()) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((batch, ctx) => {
    if (batch.edits.length === 0 && !batch.data) {
      ctx.addIssue({ code: "custom", message: "send at least one edit, or data.match" });
    }
  });
export type EditBatch = z.infer<typeof EditBatchSchema>;

interface EditableNode {
  id?: unknown;
  type?: unknown;
  props?: Record<string, unknown>;
}

/**
 * Applies a batch onto a tree the caller owns. A missing id fails the batch and changes nothing.
 */
export function applyEdits(
  tree: unknown,
  data: unknown,
  batch: EditBatch,
): { ok: true; tree: unknown; data: unknown } | { ok: false; error: string } {
  if (!tree || typeof tree !== "object" || !Array.isArray((tree as { nodes?: unknown }).nodes)) {
    return { ok: false, error: "there is no tree to edit" };
  }
  const next = structuredClone(tree) as { nodes: EditableNode[] };
  const missing: string[] = [];
  for (const edit of batch.edits) {
    const node = next.nodes.find((item) => item.id === edit.id);
    if (!node) {
      missing.push(edit.id);
      continue;
    }
    if (edit.type) node.type = edit.type;
    if (edit.props) node.props = { ...(node.props ?? {}), ...edit.props };
  }
  if (missing.length > 0) return { ok: false, error: `no node ${missing.join(", ")}` };
  const current =
    data && typeof data === "object" && !Array.isArray(data)
      ? (structuredClone(data) as { match?: Record<string, string> })
      : { match: {} };
  if (!current.match || typeof current.match !== "object") current.match = {};
  if (batch.data?.match) current.match = { ...current.match, ...batch.data.match };
  return { ok: true, tree: next, data: current };
}
