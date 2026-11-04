import { Children, type ReactNode } from "react";
import type { Node } from "@fanos/dsl";
import { resolveNode } from "../resolve/style.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";

export function Box({
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
  /**
   * Paint and nothing else: no content inside, no control wired to it, no look of its own on hover
   * or press (`states`, which needs the pointer). The strip's edge fades are
   * this, laid over the cards; the stylesheet lets the pointer through them, as a website's
   * decorative overlay does, so a drag that starts on a fade still moves the carousel. Inside a
   * control (a pagination dot) the stylesheet gives the pointer back.
   */
  const decor =
    Children.count(children) === 0 && node.props.controlFor === undefined && node.props.states === undefined;
  return (
    <div
      className={resolved.className}
      style={styleToReact(resolved.style)}
      data-fos-id={node.id}
      data-fos-type="Box"
      {...(decor ? { "data-fos-decor": "" } : {})}
      {...resolved.dataAttrs}
    >
      {children}
    </div>
  );
}
