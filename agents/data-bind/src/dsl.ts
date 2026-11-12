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
  /** The page choice a Repeater's `over` reads (`squad.{_page.squad}`), and its list for one option. */
  overChoice(over: string): string | undefined;
  overFor(over: string, data: unknown, value: string): string;
  fromCastFlow(response: unknown): unknown;
  /** A date as epoch ms, read as the `date` pipe reads it; undefined when it is no readable date. */
  readDate(
    value: unknown,
    options?: { timeZone?: string; dateOrder?: "dmy" | "mdy" },
  ): number | undefined;
  /** The lists an `over` that reads a choice can draw, one per option the data has. */
  overLists(over: string, scope: unknown): Array<{ value: string; items: unknown[] }>;
  /** An item's scope as the renderer makes it: the item by its name, its list under `_each`. */
  itemScope(
    scope: unknown,
    as: string,
    item: unknown,
    list: readonly unknown[],
  ): Record<string, unknown>;
  /** A node's `clock` in its scope at `now`: its name, and its values when the data has the instant. */
  clockScope(
    clock: unknown,
    scope: unknown,
    now: number,
  ):
    | { as: string; to: number | undefined; values: Record<string, unknown> | undefined }
    | undefined;
  /** The CDN's `{{RATIO}}` slot in a picture URL, filled from the Image's `ratio` as the renderer does. */
  fillImageRatio(url: string, ratio: string | undefined): string;
  /**
   * Structure (S rules), refs the renderer cannot read (B4) and a `when` that is no condition: a
   * plan must leave a tree the renderer draws as the plan means.
   */
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
      overChoice: Dsl["overChoice"];
      overFor: Dsl["overFor"];
      fromCastFlow: Dsl["fromCastFlow"];
      readDate: Dsl["readDate"];
      overLists: Dsl["overLists"];
      itemScope: Dsl["itemScope"];
      clockScope: Dsl["clockScope"];
      fillImageRatio: Dsl["fillImageRatio"];
      predicateSchema: { safeParse(value: unknown): { success: boolean } };
      checkPipes(tree: unknown): Array<{ severity: string; message: string; nodeId?: string }>;
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
      overChoice: dsl.overChoice,
      overFor: dsl.overFor,
      fromCastFlow: dsl.fromCastFlow,
      readDate: dsl.readDate,
      overLists: dsl.overLists,
      itemScope: dsl.itemScope,
      clockScope: dsl.clockScope,
      fillImageRatio: dsl.fillImageRatio,
      check(tree) {
        const parsed = dsl.flatTreeSchema.safeParse(tree);
        if (parsed.success) {
          // a ref no renderer reads draws as written, braces and all: the page shows the template
          const refs = dsl
            .checkPipes(tree)
            .filter((i) => i.severity === "error")
            .map((i) => ({
              code: "B4",
              message: i.message,
              ...(i.nodeId ? { nodeId: i.nodeId } : {}),
            }));
          // a when that is no condition draws the node on every page (the renderer's rule): `false`
          // hides nothing (run 3b826dc5)
          const whens = tree.nodes
            .filter(
              (n) =>
                n.props.when !== undefined && !dsl.predicateSchema.safeParse(n.props.when).success,
            )
            .map((n) => ({
              code: "S12",
              nodeId: n.id,
              message: `${n.src} when ${JSON.stringify(n.props.when)}: not a condition, so the page draws ${n.src} for every item as if it had no when. A when reads the data: {"path":"<field>","exists":true}, eq, ne, in, gt, lt, or a list of them; a part drawn only when a list holds that many items tests that item ({"path":"<list>.<index>","exists":true})`,
            }));
          return [...refs, ...whens].slice(0, 10);
        }
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

/** How deep a section is signed: the section library's `SECTION_SIGNATURE_DEPTH`, kept alike. */
export const SECTION_SIGNATURE_DEPTH = 64;

let signer: Promise<(doc: unknown) => string | undefined> | undefined;

/**
 * A section's structural signature from its IR document (ADR 0033), as frame-match and the section
 * library sign it: what a decision a person makes on the section is about. Undefined when the IR
 * cannot be read, or the pipeline is not built.
 */
export function loadSigner(): Promise<(doc: unknown) => string | undefined> {
  signer ??= (async () => {
    try {
      const ir = (await import(
        pathToFileURL(join(REPO_ROOT, "packages/surface-canvas/dist/ir/index.js")).href
      )) as {
        parseFrameIRDocument(json: unknown): { root: unknown };
        computeStructuralSignature(node: unknown, depthLimit?: number): string;
      };
      return (doc: unknown) => {
        // the document as frame-match parsed it; a root kept on its own is signed as it is
        let root: unknown;
        try {
          root = ir.parseFrameIRDocument(doc).root;
        } catch {
          root = (doc as { root?: unknown } | undefined)?.root;
        }
        if (!root) return undefined;
        try {
          return ir.computeStructuralSignature(root, SECTION_SIGNATURE_DEPTH);
        } catch {
          return undefined;
        }
      };
    } catch {
      return () => undefined;
    }
  })();
  return signer;
}
