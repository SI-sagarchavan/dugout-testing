/**
 * The pipeline's DSL package, loaded from its built `dist` as every agent loads the pipeline (run
 * `pnpm build` after changing it). Only what binding needs, typed here so this agent does not
 * depend on the `@fanos` toolchain.
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

export interface IrNode {
  id: string;
  name: string;
  type: string;
  componentKey?: string;
  text?: { characters?: string };
  children?: IrNode[];
}

export interface Drift {
  reason: string;
  src: string;
  message: string;
}

export interface Issue {
  code: string;
  nodeId?: string;
  message: string;
}

export interface Dsl {
  applyBindingPlan(
    tree: Tree,
    plan: unknown,
  ): { tree: Tree; bound: number; collapsed: number; drift: Drift[] };
  resolveTemplate(template: string, scope: unknown): { value: string; unresolved: string[] };
  evaluateWhen(when: unknown, scope: unknown): boolean;
  lookup(data: unknown, path: string): unknown;
  hasRef(value: unknown): boolean;
  fromCastFlow(response: unknown): unknown;
  /** A node's `clock` in its scope at `now`: its name, and its values when the data has the instant. */
  clockScope(
    clock: unknown,
    scope: unknown,
    now: number,
  ):
    | { as: string; to: number | undefined; values: Record<string, unknown> | undefined }
    | undefined;
  /** Structure only (S rules): a binding plan must leave a tree the renderer takes. */
  check(tree: Tree): Issue[];
}

let loaded: Promise<Dsl> | undefined;

export function loadDsl(): Promise<Dsl> {
  loaded ??= (async () => {
    const dsl = (await import(
      pathToFileURL(join(REPO_ROOT, "packages/dsl/dist/index.js")).href
    )) as {
      applyBindingPlan: Dsl["applyBindingPlan"];
      resolveTemplate: Dsl["resolveTemplate"];
      evaluateWhen: Dsl["evaluateWhen"];
      lookup: Dsl["lookup"];
      hasRef: Dsl["hasRef"];
      fromCastFlow: Dsl["fromCastFlow"];
      clockScope: Dsl["clockScope"];
      flatTreeSchema: {
        safeParse(tree: unknown): {
          success: boolean;
          error?: { issues: Array<{ message: string; path: unknown[] }> };
        };
      };
    };
    return {
      applyBindingPlan: dsl.applyBindingPlan,
      resolveTemplate: dsl.resolveTemplate,
      evaluateWhen: dsl.evaluateWhen,
      lookup: dsl.lookup,
      hasRef: dsl.hasRef,
      fromCastFlow: dsl.fromCastFlow,
      clockScope: dsl.clockScope,
      check(tree) {
        const parsed = dsl.flatTreeSchema.safeParse(tree);
        if (parsed.success) return [];
        return (parsed.error?.issues ?? []).slice(0, 10).map((i) => ({
          code: "S",
          message: `${i.path.join(".")}: ${i.message}`,
        }));
      },
    };
  })();
  return loaded;
}

/**
 * A data bag as a tree reads it. A value written `{ "castFlow": <response> }` is a saved Cast flow
 * response, unwrapped as a live one is (`fromCastFlow`): the tree binds `items`, never `data.1`.
 */
export function asBag(data: unknown, dsl: Pick<Dsl, "fromCastFlow">): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      const flow = (value as { castFlow?: unknown } | null)?.castFlow;
      return [key, flow === undefined ? value : dsl.fromCastFlow(flow)];
    }),
  );
}

/** Every IR node by its Figma id. */
export function indexIr(root: IrNode): Map<string, IrNode> {
  const byId = new Map<string, IrNode>();
  const walk = (node: IrNode) => {
    byId.set(node.id, node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return byId;
}
