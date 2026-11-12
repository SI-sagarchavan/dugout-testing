/**
 * The pipeline's DSL package, loaded from its built `dist` as every agent loads the pipeline (run
 * `pnpm build` after changing it). Only what editing a tree needs.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@dugout/core";

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

export interface Dsl {
  setProp(tree: Tree, id: string, path: string, value: unknown): Tree;
  removeNode(tree: Tree, id: string, options?: { cascade?: boolean }): Tree;
  moveNode(tree: Tree, id: string, newParent: string, idx: number): Tree;
  wrapIn(
    tree: Tree,
    id: string,
    type: string,
    props?: Record<string, unknown>,
    wrapperId?: string,
  ): Tree;
  insertSubtree(
    tree: Tree,
    subtree: Tree,
    options: { parent: string; idx?: number; idPrefix?: string },
  ): Tree;
  applyBindingPlan(tree: Tree, plan: unknown): { tree: Tree; drift: Array<{ message: string }> };
  hasBindings(tree: Tree): boolean;
  /** What is wrong with a node's props as its type declares them. */
  propIssues(type: string, props: Record<string, unknown>): string[];
  propNamesOf(type: string): string[];
  /** Every primitive a node can be. */
  nodeTypes: readonly string[];
  /** Structure only: parents, ids and order. */
  structure(tree: Tree): string[];
}

let loaded: Promise<Dsl> | undefined;

export function loadDsl(): Promise<Dsl> {
  loaded ??= (async () => {
    const dsl = (await import(
      pathToFileURL(join(REPO_ROOT, "packages/dsl/dist/index.js")).href
    )) as Omit<Dsl, "structure" | "nodeTypes"> & {
      NODE_TYPES: readonly string[];
      flatTreeSchema: {
        safeParse(tree: unknown): {
          success: boolean;
          error?: { issues: Array<{ message: string; path: unknown[] }> };
        };
      };
    };
    return {
      setProp: dsl.setProp,
      removeNode: dsl.removeNode,
      moveNode: dsl.moveNode,
      wrapIn: dsl.wrapIn,
      insertSubtree: dsl.insertSubtree,
      applyBindingPlan: dsl.applyBindingPlan,
      hasBindings: dsl.hasBindings,
      propIssues: dsl.propIssues,
      propNamesOf: dsl.propNamesOf,
      nodeTypes: dsl.NODE_TYPES,
      structure(tree) {
        const parsed = dsl.flatTreeSchema.safeParse(tree);
        if (parsed.success) return [];
        return (parsed.error?.issues ?? [])
          .slice(0, 10)
          .map((i) => `${i.path.join(".")}: ${i.message}`);
      },
    };
  })();
  return loaded;
}
