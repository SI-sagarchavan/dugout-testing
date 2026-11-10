/**
 * A Carousel node's props → what the server draws and what the browser hands Swiper.
 *
 * Pure, no React, no Swiper. Two halves:
 *
 * - `vars`: the values that may be tokens (gap, offsets, durations), as CSS custom properties
 *   on the carousel element. The server's first paint uses them directly; once Swiper runs it
 *   reads their COMPUTED values, so a token resolves to the tenant's pixels without the renderer
 *   ever inlining one.
 * - `spec`: every other option, as plain JSON on `data-fos-carousel`. Serialisable, so it
 *   crosses the server/client boundary as an attribute and a prop alike.
 */

import { cssVar } from "@fanos/tokens";
import { resolveDuration, resolveValue } from "../resolve/value.js";
import { CAROUSEL_VARS, type CarouselEffect, type CarouselSpec, type EffectKind } from "./shared.js";

export { CAROUSEL_VARS, cssNumber } from "./shared.js";
export type { CarouselEffect, CarouselSpec, EffectKind } from "./shared.js";

/** A `Resp<>` value's base, or the value itself. One DSL per device, so the base is all there is. */
function base<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "object" && !Array.isArray(value) && "base" in (value as object)) {
    return ((value as { base: T }).base ?? fallback) as T;
  }
  return value as T;
}

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

export function carouselSpec(
  id: string,
  props: Record<string, unknown>,
): { spec: CarouselSpec; vars: Record<string, string> } {
  const autoplay = props.autoplay as
    | false
    | { delay?: unknown; pauseOnHover?: unknown; stopOnInteraction?: unknown; stopOnLast?: unknown; reverse?: unknown }
    | undefined;
  const freeMode = props.freeMode as boolean | { momentum?: unknown; sticky?: unknown } | undefined;

  const spec: CarouselSpec = {
    id,
    slidesPerView: base(props.slidesPerView, 1 as number | "auto"),
    slidesPerGroup: base(props.slidesPerGroup, 1),
    centered: bool(props.centered, false),
    centeredBounds: bool(props.centeredBounds, false),
    initialSlide: typeof props.initialSlide === "number" ? props.initialSlide : 0,
    direction: props.direction === "vertical" ? "vertical" : "horizontal",
    rows: base(props.rows, 1),
    rowFill: props.rowFill === "row" ? "row" : "column",
    autoHeight: bool(props.autoHeight, false),
    effect: effectOf(props.effect),
    loop: bool(props.loop, false),
    rewind: bool(props.rewind, false),
    autoplay:
      autoplay && typeof autoplay === "object"
        ? {
            pauseOnHover: bool(autoplay.pauseOnHover, true),
            stopOnInteraction: bool(autoplay.stopOnInteraction, false),
            stopOnLast: bool(autoplay.stopOnLast, false),
            reverse: bool(autoplay.reverse, false),
          }
        : false,
    freeMode:
      freeMode === true
        ? { momentum: true, sticky: false }
        : freeMode && typeof freeMode === "object"
          ? { momentum: bool(freeMode.momentum, true), sticky: bool(freeMode.sticky, false) }
          : false,
    draggable: bool(props.draggable, true),
    grabCursor: bool(props.grabCursor, false),
    keyboard: bool(props.keyboard, true),
    mousewheel: bool(props.mousewheel, false),
    slideToClicked: bool(props.slideToClicked, false),
  };

  const vars: Record<string, string> = {};
  const length = (name: string, value: unknown) => {
    const css = resolveValue(base(value, undefined)).css;
    if (css) vars[name] = css;
  };
  length(CAROUSEL_VARS.gap, props.gap);
  length(CAROUSEL_VARS.before, props.offsetBefore);
  length(CAROUSEL_VARS.after, props.offsetAfter);
  if (spec.centered && typeof props.centerAt === "number") vars[CAROUSEL_VARS.center] = `${props.centerAt}px`;
  // a number on show sizes each slide to its share of the row; "auto" keeps each slide's own width
  if (typeof props.slidesPerView === "number" && props.slidesPerView > 0) {
    vars[CAROUSEL_VARS.perView] = String(props.slidesPerView);
  }
  if (props.speed !== undefined) vars[CAROUSEL_VARS.speed] = resolveDuration(props.speed).css;
  if (autoplay && typeof autoplay === "object" && autoplay.delay !== undefined) {
    vars[CAROUSEL_VARS.delay] = resolveDuration(autoplay.delay).css;
  }
  // How a slide change eases: Swiper reads it from its wrapper's transition timing.
  if (typeof props.easing === "string" && props.easing.startsWith("easing.")) {
    vars["--swiper-wrapper-transition-timing-function"] = cssVar(props.easing);
  }
  return { spec, vars };
}

const EFFECTS: readonly EffectKind[] = ["slide", "fade", "cube", "coverflow", "flip", "cards", "creative"];

/** The DSL's effect, a name or `{ kind, ...options }`, as one shape. */
function effectOf(value: unknown): CarouselEffect {
  if (typeof value === "string" && (EFFECTS as readonly string[]).includes(value)) {
    return { kind: value as EffectKind, options: {} };
  }
  if (value && typeof value === "object" && "kind" in value) {
    const { kind, ...options } = value as { kind: unknown } & Record<string, unknown>;
    if (typeof kind === "string" && (EFFECTS as readonly string[]).includes(kind)) {
      return { kind: kind as EffectKind, options };
    }
  }
  return { kind: "slide", options: {} };
}
