/**
 * Starts Swiper on a carousel the server already drew. Browser only.
 *
 * Nothing is re-rendered: Swiper takes over the server's `.swiper` / `.swiper-wrapper` /
 * `.swiper-slide` markup, so the first paint and the running carousel are the same elements and
 * nothing jumps. Once it runs, `data-fos-swiper` turns the first-paint CSS off (the wrapper's
 * `gap`, offset and centring), because Swiper now does each of those itself.
 *
 * The carousel draws nothing. Its controls are nodes of the tree with `controlFor` naming it, and
 * each keeps the look the tree gave it. What this does is behaviour: it moves the slides, and it
 * says which state each part is in, as `data-fos-state`, for the tree's `states` to style:
 *
 * - each slide's node: `active` on show, `inactive` otherwise;
 * - prev and next (a pair beside the carousel, or one on every slide): `disabled` when there is
 *   nowhere to go;
 * - pagination: each child is a page's dot, `active` or `inactive`; a single child is repeated
 *   per page;
 * - counter: its text, from its format;
 * - progress: filled by scale, to the time gone on this slide or to how far through the slides.
 */

import Swiper from "swiper";
import type { SwiperOptions } from "swiper/types";
import {
  A11y,
  Autoplay,
  EffectCards,
  EffectCoverflow,
  EffectCreative,
  EffectCube,
  EffectFade,
  EffectFlip,
  FreeMode,
  Grid,
  Keyboard,
  Mousewheel,
} from "swiper/modules";
import { CAROUSEL_REFRESH, syncSlides } from "./gate.js";
import { CAROUSEL_VARS, cssNumber, type CarouselSpec } from "./shared.js";

type Modules = NonNullable<SwiperOptions["modules"]>;

/** Mount on `root` (`[data-fos-carousel]`). Returns the teardown. */
export function mountCarousel(root: HTMLElement): () => void {
  if (otherWindow(root)) return mountInItsWindow(root);
  const drawn = JSON.parse(root.dataset.fosCarousel ?? "{}") as CarouselSpec;
  const viewport = root.querySelector<HTMLElement>(":scope > .swiper");
  if (!viewport) return () => {};

  // gated slides the page is not at are no slides of Swiper's; their order, kept to put back
  syncSlides(root);
  const wrapper = viewport.querySelector<HTMLElement>(":scope > .swiper-wrapper");
  const order = wrapper ? [...wrapper.children] : [];

  const computed = getComputedStyle(root);
  const read = (name: string, fallback: number) => cssNumber(computed.getPropertyValue(name), fallback);
  const gap = lengthPx(root, CAROUSEL_VARS.gap);
  // a loop with too few slides does not run: it rewinds instead (see enoughToLoop)
  const loops = drawn.loop && enoughToLoop(viewport, drawn, gap);
  const spec: CarouselSpec = { ...drawn, loop: loops, rewind: drawn.rewind || (drawn.loop && !loops) };

  // Ids repeat across two renders on one page; a control belongs to the carousel in its own render.
  const scope: ParentNode = root.closest("[data-fos-root]") ?? document;
  const controls = (part: string) => [
    ...scope.querySelectorAll<HTMLElement>(
      `[data-fos-control-for="${CSS.escape(spec.id)}"][data-fos-control="${part}"]`,
    ),
  ];
  const prevs = controls("prev");
  const nexts = controls("next");
  const counters = controls("counter");
  const bars = controls("progress");
  const timed = bars.filter((el) => el.dataset.fosOf !== "slides");
  const through = bars.filter((el) => el.dataset.fosOf === "slides");

  const modules: Modules = [A11y, Keyboard];
  const options: SwiperOptions = {
    slidesPerView: spec.slidesPerView,
    slidesPerGroup: spec.slidesPerGroup,
    spaceBetween: gap,
    slidesOffsetBefore: lengthPx(root, CAROUSEL_VARS.before),
    slidesOffsetAfter: lengthPx(root, CAROUSEL_VARS.after),
    centeredSlides: spec.centered,
    centeredSlidesBounds: spec.centeredBounds,
    initialSlide: spec.initialSlide,
    direction: spec.direction,
    autoHeight: spec.autoHeight,
    speed: read(CAROUSEL_VARS.speed, 300),
    loop: spec.loop,
    rewind: spec.rewind,
    allowTouchMove: spec.draggable,
    grabCursor: spec.grabCursor,
    slideToClickedSlide: spec.slideToClicked,
    keyboard: { enabled: spec.keyboard, onlyInViewport: true },
    a11y: { enabled: true },
    watchSlidesProgress: true,
  };

  if (spec.autoplay) {
    modules.push(Autoplay);
    options.autoplay = {
      delay: read(CAROUSEL_VARS.delay, 3000),
      pauseOnMouseEnter: spec.autoplay.pauseOnHover,
      disableOnInteraction: spec.autoplay.stopOnInteraction,
      stopOnLastSlide: spec.autoplay.stopOnLast,
      reverseDirection: spec.autoplay.reverse,
    };
  }
  if (spec.freeMode) {
    modules.push(FreeMode);
    options.freeMode = { enabled: true, momentum: spec.freeMode.momentum, sticky: spec.freeMode.sticky };
  }
  if (spec.rows > 1) {
    modules.push(Grid);
    options.grid = { rows: spec.rows, fill: spec.rowFill };
  }
  if (spec.mousewheel) {
    modules.push(Mousewheel);
    options.mousewheel = { forceToAxis: true };
  }
  applyEffect(spec, modules, options);
  options.modules = modules;

  root.dataset.fosSwiper = "on";
  const swiper = new Swiper(viewport, options);
  const rows = controls("pagination").map((row) =>
    pageDots(row, (page) => swiper.slideTo(Math.min(page * (swiper.params.slidesPerGroup ?? 1), swiper.slides.length - 1))),
  );

  // The arrows are wired here, not by Swiper's Navigation: there may be one pair per slide, and
  // their disabled look is the node's `states.disabled`, not a class of Swiper's.
  const arrows = [
    ...prevs.map((el) => press(el, () => swiper.slidePrev())),
    ...nexts.map((el) => press(el, () => swiper.slideNext())),
  ];

  const update = () => {
    const current = spec.loop ? swiper.realIndex : swiper.activeIndex;
    swiper.slides.forEach((slide, i) => {
      const index = spec.loop ? Number(slide.dataset.swiperSlideIndex ?? i) : i;
      for (const node of slide.children) setState(node, index === current ? "active" : "inactive");
    });
    const bounded = !spec.loop && !spec.rewind;
    for (const el of prevs) setState(el, bounded && swiper.isBeginning ? "disabled" : undefined);
    for (const el of nexts) setState(el, bounded && swiper.isEnd ? "disabled" : undefined);
    const pages = pageCount(swiper, spec);
    const page = currentPage(swiper, spec);
    for (const row of rows) row.show(pages, page);
    for (const el of counters) {
      const format = el.dataset.fosFormat || "{index} / {count}";
      writeText(el, format.replaceAll("{index}", String(page + 1)).replaceAll("{count}", String(pages)));
    }
    for (const el of through) fill(el, pages > 1 ? page / (pages - 1) : 1);
  };
  // Time gone on this slide, for a bar of the autoplay: 0 → 1 as the slide's time runs out.
  const onTimeLeft = (_s: Swiper, _ms: number, left: number) => {
    for (const el of timed) fill(el, 1 - left);
  };
  // The slides shown changed (a page choice gated some): measure them again, from the first.
  const refresh = () => {
    if (spec.loop) swiper.loopDestroy();
    syncSlides(root);
    if (spec.loop) {
      // the loop moved slides about; the options come back in the order the server drew them
      for (const el of order) wrapper?.append(el);
      swiper.recalcSlides();
      swiper.loopCreate();
    }
    swiper.update();
    // the first of the slides now shown; in a loop that is a real index, not a place in the DOM
    if (spec.loop) swiper.slideToLoop(0, 0);
    else swiper.slideTo(0, 0);
    update();
  };
  root.addEventListener(CAROUSEL_REFRESH, refresh);
  const EVENTS = ["slideChange", "snapIndexChange", "reachBeginning", "reachEnd", "fromEdge", "resize"] as const;
  for (const e of EVENTS) swiper.on(e, update);
  swiper.on("autoplayTimeLeft", onTimeLeft);
  for (const el of timed) fill(el, 0);
  update();

  return () => {
    root.removeEventListener(CAROUSEL_REFRESH, refresh);
    for (const e of EVENTS) swiper.off(e, update);
    swiper.off("autoplayTimeLeft", onTimeLeft);
    for (const off of arrows) off();
    for (const row of rows) row.stop();
    swiper.destroy(true, true);
    delete root.dataset.fosSwiper;
  };
}

/** Click, Enter or Space on `el` does `go`. Returns the teardown. */
function press(el: HTMLElement, go: () => void): () => void {
  const click = (e: Event) => {
    e.preventDefault();
    if (el.getAttribute("data-fos-state") !== "disabled") go();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") click(e);
  };
  el.addEventListener("click", click);
  el.addEventListener("keydown", key);
  return () => {
    el.removeEventListener("click", click);
    el.removeEventListener("keydown", key);
  };
}

/** Set (or clear) the state the tree's `states` style, and say it to assistive tech. */
function setState(el: Element, state: "active" | "inactive" | "disabled" | undefined): void {
  if (state) el.setAttribute("data-fos-state", state);
  else el.removeAttribute("data-fos-state");
  if (el.hasAttribute("data-fos-control")) {
    const part = el.getAttribute("data-fos-control");
    if (part === "prev" || part === "next") el.setAttribute("aria-disabled", String(state === "disabled"));
  }
}

/** Swiper's effect module and options, from the DSL's effect. Unknown options are left out. */
function applyEffect(spec: CarouselSpec, modules: Modules, options: SwiperOptions): void {
  const { kind, options: o } = spec.effect;
  if (kind === "slide") return;
  options.effect = kind;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const defined = <T extends object>(v: T): T =>
    Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as T;
  switch (kind) {
    case "fade":
      modules.push(EffectFade);
      options.fadeEffect = { crossFade: bool(o.crossFade) ?? true };
      return;
    case "cube":
      modules.push(EffectCube);
      options.cubeEffect = defined({ shadow: bool(o.shadow), slideShadows: bool(o.shadows) });
      return;
    case "flip":
      modules.push(EffectFlip);
      options.flipEffect = defined({ slideShadows: bool(o.shadows) });
      return;
    case "coverflow":
      modules.push(EffectCoverflow);
      options.coverflowEffect = defined({
        rotate: num(o.rotate),
        stretch: num(o.stretch),
        depth: num(o.depth),
        scale: num(o.scale),
        modifier: num(o.modifier),
        slideShadows: bool(o.shadows),
      });
      return;
    case "cards":
      modules.push(EffectCards);
      options.cardsEffect = defined({
        rotate: bool(o.rotate),
        perSlideOffset: num(o.perSlideOffset),
        perSlideRotate: num(o.perSlideRotate),
        slideShadows: bool(o.shadows),
      });
      return;
    case "creative": {
      modules.push(EffectCreative);
      const side = (v: unknown) => {
        const t = (v ?? {}) as Record<string, unknown>;
        return defined({
          translate: Array.isArray(t.translate) ? (t.translate as Array<string | number>) : undefined,
          rotate: Array.isArray(t.rotate) ? (t.rotate as number[]) : undefined,
          scale: num(t.scale),
          opacity: num(t.opacity),
          origin: typeof t.origin === "string" ? t.origin : undefined,
          shadow: bool(t.shadow),
        });
      };
      options.creativeEffect = defined({
        prev: side(o.prev),
        next: side(o.next),
        limitProgress: num(o.limitProgress),
        perspective: bool(o.perspective),
      });
      return;
    }
  }
}

/** Pages: the snap points Swiper settles on, or each real slide when it loops. */
function pageCount(swiper: Swiper, spec: CarouselSpec): number {
  if (spec.loop) return Math.max(1, swiper.slides.filter((s) => !s.classList.contains("swiper-slide-duplicate") && s.style.display !== "none").length);
  return Math.max(1, swiper.snapGrid.length);
}
const currentPage = (swiper: Swiper, spec: CarouselSpec) => (spec.loop ? swiper.realIndex : swiper.snapIndex);

/** Fill a bar by scale along its long side, from its start. */
function fill(el: HTMLElement, amount: number): void {
  const p = Math.min(1, Math.max(0, amount));
  const tall = el.offsetHeight > el.offsetWidth;
  el.style.transformOrigin = tall ? "center top" : "left center";
  el.style.transform = tall ? `scaleY(${p})` : `scaleX(${p})`;
}

/** Replace a Text node's characters, keeping the element that carries its style. */
function writeText(el: HTMLElement, text: string): void {
  let target: HTMLElement = el;
  while (target.children.length === 1 && target.firstElementChild instanceof HTMLElement) {
    target = target.firstElementChild;
  }
  target.textContent = text;
}

/**
 * A row of dots, one child per page.
 *
 * - Dots with `states` take `active` and `inactive`, and a row of ONE such dot is its template,
 *   repeated per page.
 * - Dots without (a design's row, where the dot drawn differently is the current page) have that
 *   look, its class and paint, moved to the current page's dot.
 *
 * With fewer dots than pages, the pages are spread over the dots.
 */
function pageDots(row: HTMLElement, go: (page: number) => void) {
  const dots = [...row.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
  const withStates = dots.some((d) => d.dataset.fosStates);
  const template = withStates && dots.length === 1 ? dots[0] : undefined;
  const looks = withStates ? undefined : drawnLooks(dots);

  const wire = (dot: HTMLElement, i: number) => {
    dot.setAttribute("role", "button");
    dot.setAttribute("tabindex", "0");
    dot.setAttribute("aria-label", `Page ${i + 1}`);
    dot.dataset.fosPage = String(i);
  };
  dots.forEach(wire);

  const pick = (e: Event) => {
    const dot = (e.target as HTMLElement).closest<HTMLElement>("[data-fos-page]");
    if (dot && dot.parentElement === row) go(Number(dot.dataset.fosPage));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    pick(e);
  };
  row.addEventListener("click", pick);
  row.addEventListener("keydown", key);

  return {
    show(pages: number, page: number) {
      if (template) {
        while (dots.length < pages) {
          const dot = template.cloneNode(true) as HTMLElement;
          row.append(dot);
          dots.push(dot);
          wire(dot, dots.length - 1);
        }
        dots.forEach((dot, i) => {
          dot.hidden = i >= pages;
        });
      }
      const shown = template ? pages : dots.length;
      const on = shown === pages ? page : Math.round((page / Math.max(1, pages - 1)) * (shown - 1));
      dots.forEach((dot, i) => {
        if (looks) looks.apply(dot, i === on);
        else setState(dot, i === on ? "active" : "inactive");
        dot.setAttribute("aria-current", i === on ? "true" : "false");
        if (!template) dot.dataset.fosPage = String(Math.round((i / Math.max(1, shown - 1)) * (pages - 1)));
      });
    },
    stop() {
      row.removeEventListener("click", pick);
      row.removeEventListener("keydown", key);
    },
  };
}

/**
 * A design's dots: the one drawn differently is the current page's. Its class and paint (every
 * inline declaration but where it sits, since a dot in an Overlay is placed by its own inset)
 * move to the dot of the page on show.
 */
function drawnLooks(dots: HTMLElement[]) {
  if (dots.length < 2) return undefined;
  const PLACEMENT = /^(position|inset|top|right|bottom|left|margin|transform|translate|z-index|order|--(inset|top|right|bottom|left|m[trblxy]?-))/;
  const look = (el: HTMLElement) => ({
    className: el.className,
    paint: Object.fromEntries(
      Array.from({ length: el.style.length }, (_, i) => el.style.item(i))
        .filter((p) => !PLACEMENT.test(p))
        .map((p) => [p, el.style.getPropertyValue(p)]),
    ) as Record<string, string>,
  });
  const all = dots.map(look);
  const id = (l: ReturnType<typeof look>) => `${l.className}|${JSON.stringify(l.paint)}`;
  const counts = new Map<string, number>();
  for (const l of all) counts.set(id(l), (counts.get(id(l)) ?? 0) + 1);
  const activeIndex = all.findIndex((l) => counts.get(id(l)) === 1);
  if (activeIndex < 0) return undefined;
  const active = all[activeIndex]!;
  const rest = all.find((_, i) => i !== activeIndex)!;
  const painted = new Set(all.flatMap((l) => Object.keys(l.paint)));
  return {
    apply(el: HTMLElement, on: boolean) {
      const l = on ? active : rest;
      el.className = l.className;
      for (const p of painted) {
        const v = l.paint[p];
        if (v) el.style.setProperty(p, v);
        else el.style.removeProperty(p);
      }
    },
  };
}

/**
 * A length custom property on `root`, in px. Its computed value is the token's text as the theme
 * wrote it (`1rem`, `calc(...)`), which Swiper cannot read and `parseFloat` gets wrong ("1rem" is
 * not 1px), so the browser resolves it: a probe with the variable as its margin, measured. 0 when
 * unset.
 */
function lengthPx(root: HTMLElement, name: string): number {
  if (!getComputedStyle(root).getPropertyValue(name).trim()) return 0;
  const probe = root.ownerDocument.createElement("div");
  // a margin, not a width: an offset may be negative (slides pulled back to bleed), a width not
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;padding:0;border:0;margin:0;margin-top:var(${name})`;
  root.append(probe);
  const px = Number.parseFloat(getComputedStyle(probe).marginTop);
  probe.remove();
  return Number.isFinite(px) ? px : 0;
}

/**
 * The window `el` belongs to, when it is not this module's: a host that draws the section into an
 * iframe from its own page (Surface Studio) hands this an element of the frame's document. Swiper
 * only starts on an element of its own window (`instanceof HTMLElement`), and listens for drags on
 * its own document, so it has to run in the frame's.
 */
function otherWindow(el: HTMLElement): Window | undefined {
  const win = el.ownerDocument.defaultView;
  return win && win !== globalThis.window && !(el instanceof HTMLElement) ? win : undefined;
}

type Mounted = HTMLElement & { __fosStop?: () => void; __fosGone?: boolean };

/**
 * Loads this module again inside the element's own window and mounts there, so Swiper, its
 * `HTMLElement` and its listeners are the frame's. The teardown stops it, or stops it from
 * starting when it has not loaded yet.
 */
function mountInItsWindow(root: HTMLElement): () => void {
  const el = root as Mounted;
  const doc = root.ownerDocument;
  const key = `m${Math.random().toString(36).slice(2)}`;
  root.setAttribute("data-fos-mount", key);
  const script = doc.createElement("script");
  script.type = "module";
  script.textContent = `import(${JSON.stringify(import.meta.url)}).then((m) => {
  const el = document.querySelector('[data-fos-mount="${key}"]');
  if (el && el.isConnected && !el.__fosGone) el.__fosStop = m.mountCarousel(el);
});`;
  doc.head.append(script);
  return () => {
    el.__fosGone = true;
    el.__fosStop?.();
    delete el.__fosStop;
    root.removeAttribute("data-fos-mount");
    script.remove();
  };
}

/**
 * Whether Swiper can loop these slides. It needs more than are on view: the slides on view and a
 * step more (half the view more, centred), or it warns and stops after a slide or two. A partly
 * shown slide counts as on view. With too few, the carousel rewinds to the first after the last,
 * so it still moves on its own and by hand.
 */
function enoughToLoop(viewport: HTMLElement, spec: CarouselSpec, gap: number): boolean {
  const slides = [...viewport.querySelectorAll<HTMLElement>(":scope > .swiper-wrapper > .swiper-slide")];
  let onView: number;
  if (spec.slidesPerView === "auto") {
    const room = spec.direction === "vertical" ? viewport.clientHeight : viewport.clientWidth;
    let used = 0;
    onView = 0;
    for (const slide of slides) {
      used += (spec.direction === "vertical" ? slide.offsetHeight : slide.offsetWidth) + (onView > 0 ? gap : 0);
      onView += 1;
      if (used >= room) break;
    }
  } else {
    onView = Math.ceil(spec.slidesPerView);
  }
  const step = spec.centered ? Math.max(spec.slidesPerGroup, Math.ceil(onView / 2)) : spec.slidesPerGroup;
  return slides.length >= onView + step;
}
