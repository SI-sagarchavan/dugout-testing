/** A flat DSL tree, as `@fanos/dsl` stores one: only what is read here. */
export interface FlatTreeLike {
  schemaVersion?: string;
  nodes: Array<
    { id: string; parent: string | null; idx: number; src: string } & Record<string, unknown>
  >;
}

/**
 * The part of a published DSL tree that draws one section, as a tree of its own. The section's
 * layer is the node whose `src` is `rootSrc` (the Figma id the section was found at); when the
 * compiler left that layer out, the topmost node drawn from a layer inside the section. Its
 * descendants come with it, the root's parent is cleared and its `idx` is 0. Undefined when no
 * node of the tree was drawn from the section.
 */
export function sectionTree(
  tree: unknown,
  rootSrc: string,
  within: (src: string) => boolean,
): FlatTreeLike | undefined {
  const nodes = (tree as FlatTreeLike | null)?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inside = nodes.filter((n) => within(n.src));
  const top = inside.filter((n) => n.parent === null || !within(byId.get(n.parent)?.src ?? ""));
  const root = top.find((n) => n.src === rootSrc) ?? top[0];
  if (!root) return undefined;
  const kids = new Map<string, typeof nodes>();
  for (const n of nodes) {
    if (n.parent !== null) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  }
  const out: typeof nodes = [{ ...root, parent: null, idx: 0 }];
  const walk = (id: string) => {
    for (const child of kids.get(id) ?? []) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(root.id);
  return {
    ...(typeof (tree as FlatTreeLike).schemaVersion === "string"
      ? { schemaVersion: (tree as FlatTreeLike).schemaVersion as string }
      : {}),
    nodes: out,
  };
}
