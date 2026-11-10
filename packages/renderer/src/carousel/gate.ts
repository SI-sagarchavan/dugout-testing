import { evaluateCondition, pageScope, type Condition, type PageState } from "@fanos/dsl/runtime";

/** Event a carousel root hears when the slides it shows have changed: Swiper measures them again. */
export const CAROUSEL_REFRESH = "fos-carousel-refresh";

/**
 * Show the slides of a rail that follows a page choice (`data-fos-gate`: the conditions each
 * shows at) that `page` satisfies, hide the rest, and say so to the carousel when any changed.
 * Swiper skips hidden slides, so what it runs is the chosen option's list. Returns whether any
 * slide changed.
 */
export function gateSlides(root: HTMLElement, page: PageState): boolean {
  const scope = pageScope(page);
  let changed = false;
  for (const slide of root.querySelectorAll<HTMLElement>("[data-fos-gate]")) {
    const conditions = JSON.parse(slide.dataset.fosGate ?? "[]") as Condition[];
    const display = conditions.every((c) => evaluateCondition(c, scope)) ? "" : "none";
    if (slide.style.display !== display) {
      slide.style.display = display;
      changed = true;
    }
  }
  // once Swiper runs, its refresh does it, after taking its loop down (see mountCarousel)
  if (!root.dataset.fosSwiper) syncSlides(root);
  if (changed) root.dispatchEvent(new CustomEvent(CAROUSEL_REFRESH));
  return changed;
}

const SLIDE = "swiper-slide";

/**
 * A gated slide is a Swiper slide only while it shows. Swiper sizes around a hidden slide, but its
 * loop counts and moves every `.swiper-slide`, hidden ones too: a looping rail would slide onto
 * the options the page is not at and stop. Without the class Swiper does not see the slide at all.
 */
export function syncSlides(root: HTMLElement): void {
  for (const slide of root.querySelectorAll<HTMLElement>("[data-fos-gate]")) {
    slide.classList.toggle(SLIDE, slide.style.display !== "none");
  }
}
