/**
 * What the server's carousel and the browser's both need, and nothing else: no tokens package,
 * no Node. `mount.ts` is bundled for the browser and imports only this.
 */

export type EffectKind = "slide" | "fade" | "cube" | "coverflow" | "flip" | "cards" | "creative";

/** Swiper's effect and its options, as the DSL gave them (`@fanos/dsl` Carousel `effect`). */
export interface CarouselEffect {
  kind: EffectKind;
  options: Record<string, unknown>;
}

export interface CarouselSpec {
  /** The node id: controls name it in `data-fos-control-for`. */
  id: string;
  slidesPerView: number | "auto";
  slidesPerGroup: number;
  centered: boolean;
  centeredBounds: boolean;
  initialSlide: number;
  direction: "horizontal" | "vertical";
  rows: number;
  rowFill: "row" | "column";
  autoHeight: boolean;
  effect: CarouselEffect;
  loop: boolean;
  rewind: boolean;
  autoplay:
    | false
    | { pauseOnHover: boolean; stopOnInteraction: boolean; stopOnLast: boolean; reverse: boolean };
  freeMode: false | { momentum: boolean; sticky: boolean };
  draggable: boolean;
  grabCursor: boolean;
  keyboard: boolean;
  mousewheel: boolean;
  slideToClicked: boolean;
}

/** The custom properties the first paint and Swiper both read. */
export const CAROUSEL_VARS = {
  gap: "--fos-carousel-gap",
  before: "--fos-carousel-before",
  after: "--fos-carousel-after",
  center: "--fos-carousel-center",
  speed: "--fos-carousel-speed",
  delay: "--fos-carousel-delay",
  /** A number of slides on show: each slide's first-paint width is that share of the row. */
  perView: "--fos-carousel-per-view",
} as const;

/** A computed custom property as a number of px or ms: "16px" → 16, "0.3s" → 300. */
export function cssNumber(value: string | undefined, fallback: number): number {
  const v = (value ?? "").trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  if (v.endsWith("ms") || v.endsWith("px")) return n;
  if (v.endsWith("s")) return n * 1000;
  return n;
}
