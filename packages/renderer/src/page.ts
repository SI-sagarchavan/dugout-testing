/**
 * A stored tree, made ready to render as a page: the one recipe every host follows.
 *
 * Studio's static preview and the Next.js site (`apps/web`) both render a Send from the same
 * artifacts: the compiled tree, the theme it compiled against and the surface set. Both need the
 * same CSS, the same asset URLs, the same binding plan applied and the same width, or the two
 * would show different pages for one Send. So the work lives here and each host only adds its
 * own document around it (an HTML string, or a Next.js page).
 *
 * Server only: theme CSS is emitted here, never in a browser bundle.
 */

import { applyBindingPlan, type BindingPlan, type FlatTree, hasBindings } from "@fanos/dsl";
import {
  type AssetContext,
  emitCss,
  LOCAL_ASSET_CONTEXT,
  parseSurfaceFile,
  parseThemeJson,
  type SurfaceSet,
} from "@fanos/tokens";

/**
 * Page width when neither the caller nor the tree's root states one. Also the viewport the
 * emitted media queries key off: a desktop design previewed narrower resolves tablet type.
 */
export const DEFAULT_PAGE_WIDTH = 1280;

export interface PageSource {
  tree: unknown;
  theme: unknown;
  /**
   * The surface set the tree's `surface.*` refs resolve against. The compiler folds plate fills
   * into surface refs, so without it every background, button and overlay resolves to nothing.
   */
  surfaces?: unknown;
  width?: number;
  /**
   * Applied when the tree has no bindings of its own. A plan is keyed by `src`, so one that
   * belongs to another frame drifts on every entry and leaves the tree as it was.
   */
  plan?: BindingPlan;
}

export interface PreparedPage {
  tree: FlatTree;
  /** Theme variables and surface classes. Goes before the renderer's base stylesheet. */
  css: string;
  assets: AssetContext;
  /** The width the page is for: the caller's, else the root's designed width, else the default. */
  width: number;
  /**
   * The root fills whatever it is given (`size.w: "full"`). A host must not pin such a root to
   * `width`, or a full-width band shows as a strip beside bare background.
   */
  fluid: boolean;
  /** What a binding plan did, when one was applied. */
  binding?: { bound: number; collapsed: number; drift: string[] };
}

export function preparePage(source: PageSource): PreparedPage {
  const theme = parseThemeJson(source.theme)[0];
  if (!theme) throw new Error("token set holds no themes");

  const surfaces = surfaceSetOf(source.surfaces);
  const assets = assetContextOf(surfaces);
  const { css } = emitCss(theme, { assets, scope: "root", ...(surfaces ? { surfaces } : {}) });

  const compiled = source.tree as FlatTree;
  const applied =
    source.plan && !hasBindings(compiled) ? applyBindingPlan(compiled, source.plan) : undefined;
  const tree = applied?.tree ?? compiled;

  return {
    tree,
    css,
    assets,
    width: source.width ?? rootWidthOf(tree) ?? DEFAULT_PAGE_WIDTH,
    fluid: rootIsFluid(tree),
    ...(applied
      ? {
          binding: {
            bound: applied.bound,
            collapsed: applied.collapsed,
            drift: applied.drift.map((d) => `${d.reason}: ${d.message}`),
          },
        }
      : {}),
  };
}

/**
 * Asset refs to URLs, from the run's own surface set and nothing else. `data:` is accepted with
 * `http(s):` because the default publisher inlines the bytes. A ref with no entry resolves through
 * `LOCAL_ASSET_CONTEXT` and, failing that, renders as nothing.
 */
function assetContextOf(surfaces: SurfaceSet | null): AssetContext {
  const urls: Record<string, string> = {};
  if (surfaces) {
    for (const [leaf, url] of surfaces.assets) {
      if (typeof url === "string" && /^(?:https?:|data:)/.test(url)) {
        urls[leaf] = url;
        urls[`asset.${leaf}`] = url;
      }
    }
  }
  return { ...LOCAL_ASSET_CONTEXT, urls };
}

/** Null for a run that stored no set: it renders without plates rather than not at all. */
function surfaceSetOf(value: unknown): SurfaceSet | null {
  if (!value || typeof value !== "object") return null;
  const set = value as { surfaces?: unknown };
  if (!set.surfaces || typeof set.surfaces !== "object") return null;
  if (Object.keys(set.surfaces as object).length === 0) return null;
  return parseSurfaceFile(value);
}

function rootProps(tree: FlatTree): { size?: { w?: unknown } } | undefined {
  const nodes = (tree as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return undefined;
  const root = nodes.find((n) => (n as { parent?: unknown }).parent === null);
  return (root as { props?: { size?: { w?: unknown } } } | undefined)?.props;
}

function rootIsFluid(tree: FlatTree): boolean {
  return rootProps(tree)?.size?.w === "full";
}

/** The compiler records an unbound width as `{ _unbound: true, raw: 1170 }`: the frame's width. */
function rootWidthOf(tree: FlatTree): number | null {
  const w = rootProps(tree)?.size?.w;
  if (typeof w === "number" && w > 0) return Math.round(w);
  if (w && typeof w === "object" && "raw" in w) {
    const raw = Number((w as { raw: unknown }).raw);
    if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
  }
  return null;
}
