/**
 * The flat tree and binding plan as this agent reads and writes them: plain JSON, the shapes
 * `@fanos/dsl` defines. PURE.
 */

export interface TreeNode {
  id: string;
  parent: string | null;
  idx: number;
  type: string;
  src: string;
  props: Record<string, unknown>;
}

export interface Tree {
  schemaVersion: string;
  nodes: TreeNode[];
}

export interface PlanField {
  src: string;
  prop: string;
  path?: string;
  template?: string;
}

export interface PlanCollapse {
  over: string;
  as: string;
  members: string[];
  fields?: PlanField[];
  when?: unknown;
  shape?: string;
  slice?: [number, number];
  variants?: unknown[];
}

export interface PlanSet {
  src: string;
  prop: string;
  value: unknown;
}

export interface Plan {
  bind?: PlanField[];
  collapse?: PlanCollapse[];
  set?: PlanSet[];
  note?: string;
  [key: string]: unknown;
}

export const clone = <T>(value: T): T => structuredClone(value);

/** Each node's children, in order. */
export function childrenOf(tree: Tree): Map<string, TreeNode[]> {
  const kids = new Map<string, TreeNode[]>();
  for (const n of tree.nodes) {
    if (n.parent === null) continue;
    const list = kids.get(n.parent) ?? [];
    list.push(n);
    kids.set(n.parent, list);
  }
  for (const list of kids.values()) list.sort((a, b) => a.idx - b.idx);
  return kids;
}

export const rootOf = (tree: Tree): TreeNode | undefined =>
  tree.nodes.find((n) => n.parent === null);

/** A node and everything under it, the node first. */
export function subtree(tree: Tree, id: string, kids = childrenOf(tree)): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode | undefined) => {
    if (!node) return;
    out.push(node);
    for (const child of kids.get(node.id) ?? []) walk(child);
  };
  walk(tree.nodes.find((n) => n.id === id));
  return out;
}

/**
 * Where each node of a member sits in it, as child indexes from the member (`/2/0/1`). Two cards of
 * one component line up by it even when one is another variant, whose layers have other ids.
 */
export function placesIn(member: TreeNode, kids: Map<string, TreeNode[]>): Map<string, TreeNode> {
  const out = new Map<string, TreeNode>();
  const walk = (node: TreeNode, path: string) => {
    out.set(path, node);
    for (const [i, child] of (kids.get(node.id) ?? []).entries()) walk(child, `${path}/${i}`);
  };
  walk(member, "");
  return out;
}

/** The node's path in the member it is under, or undefined when it is under none of them. */
export function placeOf(
  tree: Tree,
  src: string,
  members: string[],
  kids = childrenOf(tree),
): { member: string; path: string; node: TreeNode } | undefined {
  for (const m of members) {
    const root = tree.nodes.find((n) => n.src === m);
    if (!root) continue;
    for (const [path, node] of placesIn(root, kids)) {
      if (node.src === src) return { member: m, path, node };
    }
  }
  return undefined;
}

/** Add a condition to a `when`, keeping what it had. */
export function withWhen(existing: unknown, condition: Record<string, unknown>): unknown {
  if (existing === undefined || existing === null) return condition;
  return [...(Array.isArray(existing) ? existing : [existing]), condition];
}
