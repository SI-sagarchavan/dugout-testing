/**
 * Render context — passed as a prop tree rather than React context, because
 * every component is a Server Component and we want zero client boundaries.
 */

import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import type { AssetContext } from "@fanos/tokens";
import type { ClockRef } from "@fanos/renderer/client";
import type { PageState } from "@fanos/dsl";
import type { DataBag } from "./resolve/data.js";

export interface RenderConfig {
  /** Binding data for `{path}` interpolation. */
  data?: DataBag;
  /**
   * Where the page's choices start (`_page`): a host that draws several sections gives each the
   * same, from `pageDefaults` over all of them, so a section that reads a choice another writes
   * draws it at its start. A tree's own options start at the one drawn selected without it.
   */
  page?: PageState;
  /** Asset CDN resolution. Local dev: LOCAL_ASSET_CONTEXT. */
  assets?: AssetContext;
  /** Theme slug for data-fos-theme when CSS is scoped by attr. */
  themeSlug?: string;
  /**
   * The tenant site that root-relative URLs in bound data belong to, e.g.
   * `https://dc.surface.fan-os.net`. A CAST payload's images are
   * `/static-assets/…`; rendered anywhere but the tenant's own domain (Studio,
   * the harness) they would otherwise be requested from the wrong host.
   */
  origin?: string;
  /** IANA zone for the `date` pipe. Defaults to UTC, so SSR is deterministic. */
  timeZone?: string;
  /** Which comes first in a date-only value that could be read either way (`07/08/2026`). */
  dateOrder?: "mdy" | "dmy";
  /**
   * The time the page is drawn at, epoch ms, for a node's `clock`. Defaults to the time of the
   * render; a test or a screenshot fixes it so the digits are the same every time.
   */
  now?: number;
  /**
   * The host's link, for a link to a page of its own site: the Next.js site passes `next/link`, so
   * a card that opens its article navigates in the app. Left out (the widget a JS embed draws,
   * Studio's canvas), a plain `<a href>`. A link to another site is always a plain `<a>`.
   */
  link?: HostLink;
}

/** What a host's link takes: `next/link` takes these and draws the `<a>` itself. */
export type HostLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children?: ReactNode;
};
export type HostLink = ComponentType<HostLinkProps>;

export interface NodeRenderContext extends RenderConfig {
  /** Parent is a Stack — enables size.w:"full" → flex:1 1 0. */
  flexChild?: boolean;
  /**
   * True only when the parent Stack runs HORIZONTALLY.
   *
   * `size.w: "full"` means "share the free space" on a row (the stat strip's
   * equal columns) but plain `width: 100%` on a column — there `flex: 1 1 0`
   * sizes the MAIN axis and collapses the child's HEIGHT to zero, which is what
   * made the news card's 16:9 thumbnail vanish.
   */
  flexRow?: boolean;
  /** Parent is an Overlay — children may use place.anchor. */
  overlayChild?: boolean;
  /** The clocks in scope, by the name they are read by: what ticks in the browser. */
  clocks?: Record<string, ClockRef>;
  /** The section's machine on the page, when it has one: what its nodes' events go to. */
  instance?: string;
  /** Where the item being drawn sits in the nearest Repeater: what a node's `at` reads. */
  place?: { index: number; count: number };
}

/** The locale a tree's dates and times are drawn in: what `resolveTemplate` takes as options. */
export function localeOf(ctx: Pick<RenderConfig, "timeZone" | "dateOrder">): {
  timeZone?: string;
  dateOrder?: "mdy" | "dmy";
} {
  return {
    ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}),
    ...(ctx.dateOrder ? { dateOrder: ctx.dateOrder } : {}),
  };
}
