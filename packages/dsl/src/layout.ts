/**
 * Layout intent — what a container of the design IS, beyond how it looks in one frame.
 *
 * A screenshot of a carousel is a clipped row, and the compiler, matching pixels, compiles it as
 * one. Detection (`@fanos/compile` `detectLayout`) reads the Figma IR for what the frame does
 * show: repeated cards, a card cut off by the clip edge, a pair of arrows, a row of dots. It
 * proposes an intent per container, with the evidence it used and how sure it is. Whatever a
 * frame cannot show (how many pages, autoplay, loop) is listed in `ask` for a person.
 *
 * One DSL per device: a desktop frame yields the desktop tree, a mobile frame the mobile one. So
 * every value here is plain, never `{ base, md, lg }`.
 *
 * A `LayoutChoice` is the decided half: the kind and config to lower the container to. It is
 * what a run keeps, keyed by the container's Figma id, so a recompile applies it again.
 */

import { z } from "zod";
import { PAGE_KEY_RE } from "./page.js";

export const LAYOUT_KINDS = ["list", "row", "grid", "carousel", "tabs"] as const;
export type LayoutKind = (typeof LAYOUT_KINDS)[number];

/** The carousel options a person may be asked about or change. Geometry comes from the frame. */
export const carouselConfigSchema = z
  .object({
    /** "auto": each slide keeps its designed width. A number: slides fit the container. */
    slidesPerView: z.union([z.number().positive(), z.literal("auto")]),
    /** Slides moved per arrow press or swipe. */
    slidesPerGroup: z.number().int().positive().default(1),
    /** The active slide sits in the middle, cut-off neighbours either side. */
    centered: z.boolean().default(false),
    /** The slide on show first: the one the design draws active. */
    initialSlide: z.number().int().min(0).default(0),
    /** How many pages there are: the designed dot count, or a person's answer. Informational. */
    pages: z.number().int().positive().optional(),
    loop: z.boolean().default(false),
    autoplay: z.union([z.literal(false), z.object({ delayMs: z.number().int().positive() })]).default(false),
    /**
     * What the frame cannot show about the controls the design drew (they stay nodes, wired with
     * `controlFor`, and keep their drawn look):
     *
     * - `arrows.placement`: `edges` puts prev at the carousel's start edge and next at its end,
     *   in the row the design drew them in; `as-drawn` (the default) leaves them where they are.
     * - `arrows.states` / `pagination.states`: how they look in a state a frame cannot draw
     *   (disabled, active, inactive, hover), as node `states`. A designed arrow with none fades
     *   when disabled.
     */
    controls: z
      .object({
        arrows: z
          .object({ placement: z.enum(["as-drawn", "edges"]).optional(), states: z.record(z.unknown()).optional() })
          .strict()
          .optional(),
        pagination: z.object({ states: z.record(z.unknown()).optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    /**
     * Carousel props the frame cannot show, set as they are: how it moves (`effect`, `speed`,
     * `easing`, `freeMode`, `direction`, `rewind`, …), never where. A platform config is read into
     * these (`fromPlatformCarousel`); the validator checks every token.
     */
    props: z.record(z.unknown()).optional(),
  })
  .strict();
export type CarouselConfig = z.infer<typeof carouselConfigSchema>;

export const gridConfigSchema = z.object({ columns: z.number().int().positive(), rows: z.number().int().positive() }).strict();
export const tabsConfigSchema = z
  .object({
    /** The tab labels as the design writes them. */
    options: z.array(z.string()),
    /** The tab drawn as selected. */
    active: z.number().int().min(0),
    /**
     * The page choice the tabs write, read as `_page.<key>` by any section (`page.ts`). Named by a
     * person when it means something the labels do not say (`squad`); else made from the labels.
     */
    key: z.string().regex(PAGE_KEY_RE).optional(),
  })
  .strict();

/** The decided layout of one container. `list` and `row` keep the compiled Stack as it is. */
export const layoutChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ src: z.string(), kind: z.literal("carousel"), config: carouselConfigSchema }).strict(),
  z.object({ src: z.string(), kind: z.literal("grid"), config: gridConfigSchema }).strict(),
  z.object({ src: z.string(), kind: z.literal("tabs"), config: tabsConfigSchema }).strict(),
  z.object({ src: z.string(), kind: z.literal("list") }).strict(),
  z.object({ src: z.string(), kind: z.literal("row") }).strict(),
]);
export type LayoutChoice = z.infer<typeof layoutChoiceSchema>;

/**
 * - `certain`: the frame shows it (a card cut off by the clip edge, designed arrows or dots).
 *   Applied without asking.
 * - `likely`: the structure says so and nothing contradicts it (a column of identical items).
 * - `unsure`: two kinds fit what the frame shows. A person is asked.
 */
export const CONFIDENCE = ["certain", "likely", "unsure"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/**
 * How far a detection is trusted, 0 to 1 (`LayoutIntent.score`: the confidence in its `kind`).
 *
 * - `apply` and above: the frame shows it; applied with no question.
 * - below `apply`, with another kind that also fits: a model reads the container's context
 *   (`LayoutIntent.context`) and judges. Its verdict counts when it is at least `accept` sure.
 * - still below `apply` after that: a person is asked, as before.
 */
export const LAYOUT_THRESHOLDS = { apply: 0.8, accept: 0.75 } as const;

/** The band a score falls in: `certain` is applied unasked, `unsure` has a kind that also fits. */
export function confidenceOf(score: number, hasAlternative: boolean): Confidence {
  if (score >= LAYOUT_THRESHOLDS.apply) return "certain";
  return hasAlternative ? "unsure" : "likely";
}

/** Designed controls, by Figma id. They stay nodes, wired to the carousel with `controlFor`. */
export interface LayoutChrome {
  prev?: string;
  next?: string;
  /** The row of dots: one child per page, one of them drawn active. */
  pagination?: string;
}

export interface LayoutIntent {
  /** The container's Figma id. */
  src: string;
  /** The container's layer name, for a person reading the proposal. */
  name: string;
  kind: LayoutKind;
  confidence: Confidence;
  /** Confidence in `kind`, 0 to 1: the sum of the evidence's weights (see `LAYOUT_THRESHOLDS`). */
  score: number;
  /** What the container sits in, in plain lines: the facts a model judges the kind from. */
  context: string[];
  /** The repeated items, by Figma id, in order. */
  items: string[];
  /** What the frame showed, in plain words. */
  evidence: string[];
  /** What the frame cannot answer, as questions for a person. Empty when nothing is missing. */
  ask: string[];
  /** The proposal: what applying this intent as it stands would lower to. */
  choice: LayoutChoice;
  chrome: LayoutChrome;
  /** The kind the frame also fits, when `confidence` is `unsure`. */
  alternative?: LayoutKind;
  /** What applying `alternative` would lower to; set with it. */
  alternativeChoice?: LayoutChoice;
  /** The questions `alternative` would leave open, as `ask` is for `kind`. */
  alternativeAsk?: string[];
}
