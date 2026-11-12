import type { ReactNode } from "react";
import { absolutize, type Node } from "@fanos/dsl";
import { interpolate } from "../resolve/data.js";
import { type HostLinkProps, localeOf, type NodeRenderContext } from "../context.js";

/** Where a link goes, as drawn. */
export interface LinkTarget {
  href: string;
  /** Another site (`external`, or an address off the tenant's site): a new tab, a plain `<a>`. */
  external: boolean;
}

/**
 * A node's `href` as drawn: read where the node is drawn (`/news/{item.slug}`), then anchored to the
 * tenant like a picture, since a path on its site is a dead link in Studio. Undefined when the node
 * links nowhere, or its href reads nothing (no item, no field): a card is not made a link to "".
 */
export function linkOf(node: Node, ctx: NodeRenderContext): LinkTarget | undefined {
  const props = node.props as { href?: unknown; external?: unknown };
  if (typeof props.href !== "string" || props.href === "") return undefined;
  return targetOf(props.href, props.external === true, ctx);
}

/** An href (a literal or a template) as drawn, or undefined when it reads nothing. */
export function targetOf(href: string, external: boolean, ctx: NodeRenderContext): LinkTarget | undefined {
  const { value, unresolved } = href.includes("{")
    ? interpolate(href, ctx.data, localeOf(ctx))
    : { value: href, unresolved: [] as unknown[] };
  if (!value || unresolved.length > 0) return undefined;
  const drawn = absolutize(value, ctx.origin);
  return { href: drawn, external: external || offSite(drawn, ctx.origin) };
}

/** An absolute address on another host than the tenant's site. */
function offSite(href: string, origin: string | undefined): boolean {
  // with no site to compare with (a host that names none), nothing is known to be off it
  if (!origin || !/^(https?:)?\/\//i.test(href)) return false;
  try {
    return new URL(href, origin).origin !== new URL(origin).origin;
  } catch {
    return true;
  }
}

/** The path of an address on the tenant's own site, which the host's router takes. */
function onSite(href: string, origin: string | undefined): string {
  if (!origin || !href.startsWith(origin)) return href;
  return href.slice(origin.replace(/\/+$/, "").length) || "/";
}

/**
 * The element a link is drawn as. On the host's own site, its link (`next/link` on the Next.js site,
 * which navigates in the app) with the address as a path; anywhere else (the widget, Studio), or to
 * another site, a plain `<a href>`, another site in a new tab.
 */
export function Anchor({
  to,
  ctx,
  children,
  ...attrs
}: Omit<HostLinkProps, "href"> & { to: LinkTarget; ctx: NodeRenderContext; children?: ReactNode }) {
  if (to.external) {
    return (
      <a {...attrs} href={to.href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  const Host = ctx.link;
  if (Host) {
    return (
      <Host {...attrs} href={onSite(to.href, ctx.origin)}>
        {children}
      </Host>
    );
  }
  return (
    <a {...attrs} href={to.href}>
      {children}
    </a>
  );
}
