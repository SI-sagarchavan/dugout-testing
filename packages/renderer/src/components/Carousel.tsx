/**
 * Carousel — a Swiper slider whose first paint is drawn by the server.
 *
 * The server draws the slides in a row as the design does: the gap between them, the inline
 * offset before the first, a centred active slide. That is all a screenshot sees, and all a
 * visitor sees until Swiper has loaded, so it must already be the design. Swiper then takes over
 * the same elements (see `carousel/mount.ts`).
 *
 * Only the universal props go through `resolveNode`. A Carousel's own `direction`, `gap`, `clip`
 * and `align` mean something else than a Stack's, and `resolveNode` would read them as a Stack's.
 */

import type { ReactNode } from "react";
import { CarouselRoot } from "@fanos/renderer/client";
import { UNIVERSAL_PROP_NAMES, type Node } from "@fanos/dsl";
import { carouselSpec } from "../carousel/spec.js";
import { resolveNode } from "../resolve/style.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";

const UNIVERSAL = new Set(UNIVERSAL_PROP_NAMES);

export function Carousel({ node, ctx, slides }: { node: Node; ctx: NodeRenderContext; slides: ReactNode[] }) {
  const props = node.props as Record<string, unknown>;
  const universal = Object.fromEntries(Object.entries(props).filter(([key]) => UNIVERSAL.has(key)));
  const resolved = resolveNode(universal, {
    flexChild: ctx.flexChild,
    parentDirection: ctx.flexRow ? "row" : "column",
  });
  const { spec, vars } = carouselSpec(node.id, props);
  const align = typeof props.align === "string" ? props.align : "stretch";

  return (
    <CarouselRoot
      spec={spec}
      page={ctx.page}
      className={`${resolved.className} fos-carousel`}
      style={styleToReact({ ...resolved.style, ...vars })}
      dataAttrs={{
        ...resolved.dataAttrs,
        "data-fos-id": node.id,
        "data-fos-type": "Carousel",
        "data-fos-carousel-clip": props.clip === false ? "false" : "true",
        "data-fos-align": align,
        ...(spec.centered && vars["--fos-carousel-center"] ? { "data-fos-centered": "true" } : {}),
        ...(vars["--fos-carousel-per-view"] ? { "data-fos-per-view": vars["--fos-carousel-per-view"] } : {}),
      }}
    >
      {slides}
    </CarouselRoot>
  );
}
