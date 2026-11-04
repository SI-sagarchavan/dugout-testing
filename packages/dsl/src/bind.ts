/**
 * Applying a binding plan — the mechanical half of authoring.
 *
 * A plan says which nodes carry data and which siblings are one component
 * repeated. It cannot be derived from a tree (see `collapse.ts`), so it is an
 * input; what happens once you have one is arithmetic, and this is it.
 *
 * KEYED BY `src`, never by node id. Node ids come from Figma layer names —
 * `ids.ts` in @fanos/compile slugs the name and adds a numeric suffix on
 * collision — so a designer renaming a layer, reordering siblings, or editing
 * placeholder copy silently moves them. `src` is the Figma node id and survives
 * all three. The news grid makes the trap concrete: a node called
 * `over_400_players_will_be_available_in_th` whose content is "Chris Jordan saw
 * it through late on", because the copy was edited and the layer name was not.
 *
 * DRIFT IS REPORTED, NOT THROWN. One plan is meant to outlive many compiles of
 * the same frame, and a frame changes: nodes disappear, and the same Figma node
 * can compile to a different DSL type between exports — the news grid's button
 * is a `Button` primitive in one and a plain `Stack` in another, and `label`
 * exists on only one of them. Writing it anyway produces a tree that fails S12
 * with a prop nobody put there on purpose. So entries that cannot land are
 * skipped and named, and what could not be applied is the review queue.
 *
 * PURE. No filesystem, no process, no clock.
 */

import type { FlatNode, FlatTree } from "./flat.js";
import { allFields, nodeSpec } from "./nodes/index.js";
import { proposeCollapse } from "./collapse.js";
import { applyCollapse, moveNode, replaceNode, setProp, TreeOpError } from "./ops.js";
import { hasRef, type Predicate } from "./binding.js";

export interface PlanBinding {
  /** The Figma node id, NOT the DSL node id. */
  src: string;
  prop: string;
  /** Dotted path, relative to the document — or to the item inside a collapse. */
  path?: string;
  /**
   * The whole value, written as is, when the design puts words around the data: `({m.overs})`.
   * Its refs name what is in scope, the item's alias included. One of `path` or `template`.
   */
  template?: string;
}

/**
 * Another shape the same item takes, drawn by another instance of the component.
 *
 * A fixtures card is drawn RECENT in one instance and UPCOMING in the next; both are what one
 * item may look like. The variant's subtree is moved into the template, beside it, and each draws
 * behind its own `when`. Which state picks which variant is the plan's to say, not this file's.
 */
export interface PlanVariant {
  /** The variant's root, by `src`, in another instance. */
  src: string;
  /** When this variant draws, tested against the item. */
  when: Predicate;
  /** Bound inside the variant, as `fields` are inside the template. */
  fields?: PlanBinding[];
}

export interface PlanCollapse {
  /** Dotted path to the source list, e.g. `news.items`. */
  over: string;
  /** What one item is called inside the template, e.g. `article`. */
  as: string;
  slice?: [number, number];
  /** The instances, by `src`, in document order. The first is the template. */
  members: string[];
  /** Bound inside the template, so paths are relative to one item. */
  fields?: PlanBinding[];
  /**
   * `identical` (the default): the members must be the run `proposeCollapse` detects, so a plan
   * cannot fold a card that differs. `varies`: they are one component drawn with different text
   * widths, repairs or variants, which no exact signature groups; the plan names them, and they
   * must share a parent. What the template lacks comes back through `variants`.
   */
  shape?: "identical" | "varies";
  /** When the template itself draws, when it is one variant among several. */
  when?: Predicate;
  variants?: PlanVariant[];
}

/**
 * A literal prop the binding needs that is not a `{path}`.
 *
 * Binding real data is more than pointing text at fields. A CAST thumbnail is
 * `/static-assets/media/{{RATIO}}-<file>`, and the crop the CDN cuts comes from
 * the Image's `ratio` — which a compiled tree never sets on a fill image, so a
 * 1:1 card would be served the 16:9 default. And a video badge is only a
 * binding once it has a `when`. Applied after `bind` and `collapse`, so it can
 * reach a Repeater's template and test the item by its alias.
 */
export interface PlanSet {
  src: string;
  prop: string;
  value: unknown;
}

export interface BindingPlan {
  bind?: PlanBinding[];
  collapse?: PlanCollapse[];
  set?: PlanSet[];
  /** Free text. Ignored here; it travels with the plan for whoever reads it. */
  note?: string;
}

export type DriftReason = "missing" | "wrong-type" | "not-a-run" | "ambiguous";

export interface Drift {
  reason: DriftReason;
  src: string;
  message: string;
}

export interface BindResult {
  tree: FlatTree;
  /** How many props the plan actually wrote. */
  bound: number;
  /** How many sibling runs it folded. */
  collapsed: number;
  /** What it could not apply, and why. The review queue. */
  drift: Drift[];
}

export function applyBindingPlan(tree: FlatTree, plan: BindingPlan): BindResult {
  const drift: Drift[] = [];
  let next = tree;
  let bound = 0;
  let collapsed = 0;

  /** The node a `src` names in THIS compile, or null if the frame lost it. */
  const find = (from: FlatTree, src: string): FlatNode | null => {
    const hits = from.nodes.filter((n) => n.src === src);
    if (hits.length > 1) {
      drift.push({
        reason: "ambiguous",
        src,
        message: `${hits.length} nodes claim src ${src}; the plan cannot say which`,
      });
      return null;
    }
    return hits[0] ?? null;
  };

  for (const entry of plan.bind ?? []) {
    const node = find(next, entry.src);
    if (!node) {
      drift.push({
        reason: "missing",
        src: entry.src,
        message: `src ${entry.src} is not in this tree — nothing bound to ${entry.path}`,
      });
      continue;
    }
    next = asPicture(next, node, entry.prop);
    const target = find(next, entry.src)!;
    if (!accepts(target.type, entry.prop)) {
      drift.push({
        reason: "wrong-type",
        src: entry.src,
        message: `src ${entry.src} compiled to a ${target.type}, which has no "${entry.prop}" — ${describe(entry)} not bound`,
      });
      continue;
    }
    next = setProp(next, target.id, entry.prop, valueOf(entry, ""));
    bound += 1;
  }

  for (const group of plan.collapse ?? []) {
    const members = group.members.map((src) => find(next, src));
    const templateNode = members[0];
    if (members.some((m) => m === null) || !templateNode) {
      drift.push({
        reason: "missing",
        src: group.members[0] ?? "",
        message: `not every member of the ${group.over} run is in this tree — not collapsed`,
      });
      continue;
    }

    /**
     * The plan says WHICH siblings; `proposeCollapse` still has to agree they
     * are the same shape. A plan that names three nodes the signature does not
     * group would fold a card that is not a repeat — losing whatever made it
     * different — so disagreement is drift, not something to push through.
     * Unless the plan says the shapes vary: then they need only share a parent.
     */
    const memberIds = (members as FlatNode[]).map((m) => m.id);
    const proposal =
      group.shape === "varies"
        ? templateNode.parent === null
          ? undefined
          : { parentId: templateNode.parent, memberIds }
        : proposeCollapse(next).find((p) => p.templateId === templateNode.id);
    if (!proposal || proposal.memberIds.join() !== memberIds.join()) {
      drift.push({
        reason: "not-a-run",
        src: group.members[0] ?? "",
        message: proposal
          ? `the plan's ${group.over} members ${group.members.join(", ")} do not match the detected run ${srcsOf(next, proposal.memberIds).join(", ")}`
          : group.shape === "varies"
            ? `${templateNode.src} is the root — not collapsed`
            : `${templateNode.src} and the other members are not one shape in this tree — not collapsed (shape "varies" folds them anyway)`,
      });
      continue;
    }

    const fieldMap: Record<string, { prop: string; path: string }> = {};
    /** Fields written as a whole template: set once the template is in place. */
    const templated: Array<{ id: string; prop: string; value: string }> = [];
    for (const field of group.fields ?? []) {
      const node = find(next, field.src);
      if (!node) {
        drift.push({
          reason: "missing",
          src: field.src,
          message: `src ${field.src} is not in this tree — nothing bound to ${describe(field, group.as)}`,
        });
        continue;
      }
      next = asPicture(next, node, field.prop);
      const target = find(next, field.src)!;
      if (!accepts(target.type, field.prop)) {
        drift.push({
          reason: "wrong-type",
          src: field.src,
          message: `src ${field.src} compiled to a ${target.type}, which has no "${field.prop}" — ${describe(field, group.as)} not bound`,
        });
        continue;
      }
      // `fieldMap` holds one prop per node: a second (a crest's `alt` beside its `src`) is set after.
      if (field.template !== undefined || target.id in fieldMap) {
        templated.push({ id: target.id, prop: field.prop, value: valueOf(field, group.as) });
      } else if (field.path) fieldMap[target.id] = { prop: field.prop, path: field.path };
    }

    /**
     * A member can be a variant of the template: a whole card drawn in another state. It stays, to
     * be moved beside the template, instead of being removed with the other members.
     */
    const variantRoots = new Set((group.variants ?? []).map((v) => v.src));
    const folded = (members as FlatNode[])
      .filter((m) => m.id === templateNode.id || !variantRoots.has(m.src))
      .map((m) => m.id);

    try {
      next = applyCollapse(
        next,
        { parentId: proposal.parentId, memberIds: folded, templateId: templateNode.id },
        {
          over: group.over,
          as: group.as,
          ...(group.slice ? { slice: group.slice } : {}),
          fieldMap,
        },
      );
      for (const t of templated) next = setProp(next, t.id, t.prop, t.value);
      bound += Object.keys(fieldMap).length + templated.length;
      collapsed += 1;

      // The item's other shapes, beside the template, each behind its own condition.
      const repeater = next.nodes.find((n) => n.id === `${templateNode.id}__repeat`);
      if (repeater && (group.variants?.length || group.when)) {
        if (group.when) next = setProp(next, templateNode.id, "when", group.when);
        for (const variant of group.variants ?? []) {
          const root = find(next, variant.src);
          if (!root) {
            drift.push({ reason: "missing", src: variant.src, message: `variant ${variant.src} is not in this tree (the frame lost it, or another collapse removed it as a member) — not drawn` });
            continue;
          }
          const place = next.nodes.filter((n) => n.parent === repeater.id).length;
          next = moveNode(next, root.id, repeater.id, place);
          next = setProp(next, root.id, "when", variant.when);
          for (const field of variant.fields ?? []) {
            const node = find(next, field.src);
            if (!node) {
              drift.push({
                reason: "missing",
                src: field.src,
                message: `src ${field.src} is not in this tree — nothing bound to ${describe(field, group.as)}`,
              });
              continue;
            }
            next = asPicture(next, node, field.prop);
            const target = find(next, field.src)!;
            if (!accepts(target.type, field.prop)) {
              drift.push({
                reason: "wrong-type",
                src: field.src,
                message: `src ${field.src} compiled to a ${target.type}, which has no "${field.prop}" — ${describe(field, group.as)} not bound`,
              });
              continue;
            }
            next = setProp(next, target.id, field.prop, valueOf(field, group.as));
            bound += 1;
          }
        }
      }
    } catch (err) {
      // A rejected op is the plan disagreeing with the tree, which is drift by
      // another name — never a reason to hand back a half-applied tree.
      drift.push({
        reason: "not-a-run",
        src: group.members[0] ?? "",
        message: err instanceof TreeOpError ? err.message : String(err),
      });
    }
  }

  for (const entry of plan.set ?? []) {
    const node = find(next, entry.src);
    if (!node) {
      drift.push({
        reason: "missing",
        src: entry.src,
        message: `src ${entry.src} is not in this tree — "${entry.prop}" not set`,
      });
      continue;
    }
    if (!accepts(node.type, entry.prop)) {
      drift.push({
        reason: "wrong-type",
        src: entry.src,
        message: `src ${entry.src} compiled to a ${node.type}, which has no "${entry.prop}" — not set`,
      });
      continue;
    }
    next = setProp(next, node.id, entry.prop, entry.value);
  }

  return { tree: next, bound, collapsed, drift };
}

/** The Figma ids of tree nodes, for a message a plan's author can act on. */
const srcsOf = (tree: FlatTree, ids: readonly string[]) =>
  ids.map((id) => tree.nodes.find((n) => n.id === id)?.src ?? id);

/** What a binding writes: its template as is, or its path as one ref (under the item's alias). */
function valueOf(entry: PlanBinding, as: string): string {
  if (entry.template !== undefined) return entry.template;
  return `{${as ? `${as}.` : ""}${entry.path ?? ""}}`;
}

const describe = (entry: PlanBinding, as = "") =>
  entry.template ?? `${as ? `${as}.` : ""}${entry.path ?? ""}`;

/**
 * A glyph the design drew where the data supplies a picture becomes an Image.
 *
 * A crest in a mock-up is often a vector, which compiles to an Icon; a team's crest in the data is
 * a URL. Binding `src` says it is a picture, so the node takes the Icon's box and becomes one.
 * Nothing else changes type: any other prop an Icon lacks is still drift.
 */
function asPicture(tree: FlatTree, node: FlatNode, prop: string): FlatTree {
  if (node.type !== "Icon" || (prop !== "src" && prop !== "alt")) return tree;
  const { name, tone: _tone, size, ...rest } = node.props as Record<string, unknown>;
  const box = size === undefined ? {} : { size: typeof size === "object" && size !== null && !("raw" in size) ? size : { w: size, h: size } };
  return replaceNode(tree, node.id, {
    type: "Image",
    props: { ...rest, ...box, src: "", alt: typeof name === "string" ? name : "", fit: "contain" },
  });
}

/** Does this node type declare that prop at all? Guards the S12 case above. */
function accepts(type: string, prop: string): boolean {
  const spec = nodeSpec(type);
  if (!spec) return false;
  return prop in allFields(spec);
}

/**
 * Does this tree ask for data at all?
 *
 * A compiled tree keeps Figma's literal characters, so handing it a data
 * document changes nothing — the reason `?data=` on a fresh run looks broken.
 * Cheap enough to call before deciding whether a plan needs applying.
 */
export function hasBindings(tree: FlatTree): boolean {
  return tree.nodes.some((n) => Object.values(n.props).some(hasRef));
}
