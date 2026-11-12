/**
 * A node with `href` is the link itself: a card that opens its article stays the box it was, drawn
 * as an `<a>`, so it opens in a new tab and a crawler follows it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { Node } from "@fanos/dsl";
import { Stack } from "../src/components/Stack.js";
import { Text } from "../src/components/Text.js";
import { Button } from "../src/components/Button.js";
import type { HostLinkProps } from "../src/context.js";
import type { NodeRenderContext } from "../src/context.js";

const stack = (props: Record<string, unknown>, ctx: NodeRenderContext = {}) =>
  renderToStaticMarkup(
    createElement(Stack, { node: { id: "card", type: "Stack", src: "1:1", props } as unknown as Node, ctx }),
  );

describe("a node that links", () => {
  it("draws a card as the link, its href read from the item and anchored to the tenant", () => {
    const html = stack(
      { href: "/news/{n.slug}" },
      { data: { n: { slug: "brave-win" } }, origin: "https://club.test" } as NodeRenderContext,
    );
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="https://club.test/news/brave-win"');
  });

  it("opens another site in a new tab", () => {
    const html = stack({ href: "https://shop.test", external: true });
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("stays a box when its href reads nothing", () => {
    expect(stack({ href: "{n.url}" }, { data: { n: {} } } as NodeRenderContext)).toMatch(/^<div /);
  });

  it("keeps a heading a heading, with the link inside", () => {
    const html = renderToStaticMarkup(
      createElement(Text, {
        node: { id: "all", type: "Text", src: "1:2", props: { content: "VIEW ALL", as: "h2", href: "/news" } } as unknown as Node,
        ctx: {},
      }),
    );
    expect(html).toMatch(/^<h2[^>]*><a [^>]*>VIEW ALL<\/a><\/h2>$/);
    expect(html).toContain('href="/news"');
    expect(html).toContain('class="fos-link"');
  });
});

/** What next/link stands for in a test: it draws the <a> itself, marked so a test can tell. */
const NextLink = ({ href, children, ...rest }: HostLinkProps) =>
  createElement("a", { ...rest, href, "data-next-link": "" }, children);
const SITE = { origin: "https://club.test", link: NextLink } as NodeRenderContext;

describe("the two hosts", () => {
  it("draws a link to the site's own page with the host's link (Next.js), by its path", () => {
    const html = stack({ href: "/news/{n.slug}" }, { ...SITE, data: { n: { slug: "win" } } });
    expect(html).toMatch(/^<a [^>]*href="\/news\/win"/);
    expect(html).toContain("data-next-link");
    expect(html).toContain('data-fos-type="Stack"');
  });

  it("draws a link to another site as a plain <a> in a new tab, on the Next.js site too", () => {
    const html = stack({ href: "https://shop.example/kit" }, SITE);
    expect(html).not.toContain("data-next-link");
    expect(html).toContain('target="_blank"');
  });

  it("draws a plain <a href> when the host gives no link (the widget, Studio)", () => {
    const html = stack({ href: "/news" }, { origin: "https://club.test" } as NodeRenderContext);
    expect(html).toMatch(/^<a [^>]*href="https:\/\/club.test\/news"/);
    expect(html).not.toContain("data-next-link");
  });

  it("takes a Button's navigate action through the host's link too", () => {
    const html = renderToStaticMarkup(
      createElement(Button, {
        node: {
          id: "cta",
          type: "Button",
          src: "1:3",
          props: { label: "VIEW ALL", variant: "filled", styleN: 1, size: "md", action: { kind: "navigate", href: "/news" } },
        } as unknown as Node,
        ctx: SITE,
      }),
    );
    expect(html).toContain("data-next-link");
    expect(html).toContain('href="/news"');
  });
});
