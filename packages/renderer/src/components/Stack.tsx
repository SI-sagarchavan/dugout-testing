import type { ReactNode } from "react";
import type { Node } from "@fanos/dsl";
import { resolveNode } from "../resolve/style.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";
import { Anchor, linkOf } from "./link.js";

export function Stack({
  node,
  ctx,
  children,
}: {
  node: Node;
  ctx: NodeRenderContext;
  children?: ReactNode;
}) {
  const resolved = resolveNode(node.props as Record<string, unknown>, {
    flexChild: ctx.flexChild,
    parentDirection: ctx.flexRow ? "row" : "column",
  });
  // a card that opens its article is drawn as the link itself, so the layout is the same
  const link = linkOf(node, ctx);
  const attrs = {
    className: resolved.className,
    style: styleToReact(resolved.style),
    "data-fos-id": node.id,
    "data-fos-type": "Stack",
    ...resolved.dataAttrs,
  };
  return link ? (
    <Anchor to={link} ctx={ctx} {...attrs}>
      {children}
    </Anchor>
  ) : (
    <div {...attrs}>{children}</div>
  );
}
