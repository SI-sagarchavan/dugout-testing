/**
 * Layouts in a card-match run: what `@fanos/compile` detected, and what a person decided.
 *
 * The schema is `@fanos/dsl`'s `layoutChoiceSchema`, restated in this package's zod (the
 * pipeline is on zod 3, the harness on zod 4, and the agent loads the pipeline's built `dist`
 * rather than importing it). `tests/layout.test.ts` holds the two to the same answers.
 */

import { z } from "zod";

export const CarouselConfig = z
  .object({
    slidesPerView: z
      .union([z.number().positive(), z.literal("auto")])
      .describe('"auto": each slide keeps its designed width. A number: that many fit the row'),
    slidesPerGroup: z.number().int().positive().default(1).describe("Slides moved per arrow press"),
    centered: z.boolean().default(false).describe("The active slide sits in the middle"),
    initialSlide: z.number().int().min(0).default(0).describe("The slide on show first, from 0"),
    pages: z.number().int().positive().optional().describe("How many pages, when a person said"),
    loop: z.boolean().default(false).describe("Wrap around after the last slide"),
    autoplay: z
      .union([z.literal(false), z.object({ delayMs: z.number().int().positive() }).strict()])
      .default(false)
      .describe("false, or { delayMs }: moves on its own, this long on each slide"),
    controls: z
      .object({
        arrows: z
          .object({
            placement: z.enum(["as-drawn", "edges"]).optional(),
            states: z.record(z.string(), z.unknown()).optional(),
          })
          .strict()
          .optional(),
        pagination: z
          .object({ states: z.record(z.string(), z.unknown()).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional()
      .describe(
        "For the arrows and dots the design drew: arrows.placement edges (prev at the start edge, next at the end) or as-drawn; states, their look when disabled, active, inactive or hovered",
      ),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "How it moves, which the frame cannot show: effect, speed, easing, freeMode, direction, rewind",
      ),
  })
  .strict();

// A plain union, not a discriminated one: that becomes `oneOf` in a tool's JSON Schema, which
// Bedrock refuses. Each member is strict with its own `kind`, so it parses the same.
export const LayoutChoice = z.union([
  z
    .object({ src: z.string().min(1), kind: z.literal("carousel"), config: CarouselConfig })
    .strict(),
  z
    .object({
      src: z.string().min(1),
      kind: z.literal("grid"),
      config: z
        .object({ columns: z.number().int().positive(), rows: z.number().int().positive() })
        .strict(),
    })
    .strict(),
  z
    .object({
      src: z.string().min(1),
      kind: z.literal("tabs"),
      config: z.object({ options: z.array(z.string()), active: z.number().int().min(0) }).strict(),
    })
    .strict(),
  z.object({ src: z.string().min(1), kind: z.literal("list") }).strict(),
  z.object({ src: z.string().min(1), kind: z.literal("row") }).strict(),
]);
export type LayoutChoice = z.infer<typeof LayoutChoice>;

export type LayoutKind = LayoutChoice["kind"];
export type Confidence = "certain" | "likely" | "unsure";

/** `@fanos/dsl` `LayoutIntent`, as this package reads it. */
export interface LayoutIntent {
  src: string;
  name: string;
  kind: LayoutKind;
  confidence: Confidence;
  items: string[];
  evidence: string[];
  ask: string[];
  choice: LayoutChoice;
  chrome: { prev?: string; next?: string; pagination?: string };
  alternative?: LayoutKind;
}

/** What a run tells the model and the reviewer about one container. */
export interface LayoutReport {
  src: string;
  name: string;
  kind: LayoutKind;
  confidence: Confidence;
  evidence: string[];
  /** Questions the frame cannot answer. Empty: nothing to ask. */
  ask: string[];
  /** What is applied now, or the proposal when nothing is yet. */
  choice: LayoutChoice;
  /** The tree has this choice in it. */
  applied: boolean;
  /** A person approved this choice through frame.layout. */
  decided: boolean;
  /** Why the choice is not in the tree, when it is not. */
  note?: string;
  alternative?: LayoutKind;
  /** The controls the design drew for it, by Figma id: they keep their look. */
  chrome?: { prev?: string; next?: string; pagination?: string };
}

/** A choice in plain words, for a person approving it. */
export function describeChoice(choice: LayoutChoice): string {
  switch (choice.kind) {
    case "carousel": {
      const c = choice.config;
      const parts = [
        c.slidesPerView === "auto"
          ? "slides keep their designed width"
          : `${c.slidesPerView} slides on show`,
        c.centered
          ? `centred, starting on slide ${c.initialSlide + 1}`
          : c.initialSlide > 0
            ? `starting on slide ${c.initialSlide + 1}`
            : "",
        c.slidesPerGroup > 1 ? `moves ${c.slidesPerGroup} at a time` : "",
        c.pages ? `${c.pages} pages` : "",
        c.autoplay ? `moves on its own every ${c.autoplay.delayMs / 1000}s` : "no autoplay",
        c.loop ? "loops" : "no loop",
        c.controls?.arrows?.placement === "edges" ? "arrows at the edges" : "",
        c.controls?.arrows?.states
          ? `arrows ${Object.keys(c.controls.arrows.states).join(", ")} look set`
          : "",
        c.controls?.pagination?.states ? "dots' active look set" : "",
        effectOf(c.props?.effect),
      ].filter(Boolean);
      return `carousel: ${parts.join("; ")}`;
    }
    case "grid":
      return `grid of ${choice.config.columns} columns and ${choice.config.rows} rows`;
    case "tabs":
      return `tabs ${choice.config.options.map((o) => `"${o}"`).join(", ")}, "${choice.config.options[choice.config.active]}" selected`;
    case "list":
      return "a list, as drawn";
    case "row":
      return "a fixed row, as drawn";
  }
}

/** A carousel effect in a word or two. */
function effectOf(effect: unknown): string {
  const kind =
    typeof effect === "string" ? effect : (effect as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && kind !== "slide" ? `${kind} effect` : "";
}

/** The approval card for frame.layout: what the frame showed, what is asked, what is proposed. */
export function questionCard(report: LayoutReport | undefined, proposed: LayoutChoice): string[] {
  const lines = [`Layout of "${report?.name ?? proposed.src}" [${proposed.src}]`];
  if (report) {
    lines.push(`The frame shows: ${report.evidence.join("; ")}.`);
    if (report.ask.length > 0) lines.push("It cannot show:", ...report.ask.map((q) => `  - ${q}`));
  }
  lines.push(`Proposed: ${describeChoice(proposed)}.`);
  lines.push(
    'Approve to apply it. To change it, request a change in plain words ("a carousel, autoplay every 5 seconds, loop" or "keep it a fixed row").',
  );
  return lines;
}

type CarouselChoice = Extract<LayoutChoice, { kind: "carousel" }>;

/** A look in one state, in colour tokens (`@fanos/dsl` `StateLook`). */
interface StateLook {
  tone?: string;
  fill?: string;
}

/** `@fanos/dsl` `fromPlatformCarousel`'s answer, as this package reads it. */
export interface PlatformRead {
  /** The Carousel's own props: how it behaves and moves. */
  props: Record<string, unknown>;
  arrows?: {
    visible: boolean;
    position?: "center" | "top" | "bottom";
    subVariant?: string;
    enabled?: StateLook;
    disabled?: StateLook;
    icon?: string;
    variant?: string;
  };
  indicator?: {
    visible: boolean;
    kind: "pagination" | "counter" | "progress";
    position?: "top" | "bottom";
    offset?: number;
    activeWidth?: number;
    active?: StateLook;
    inactive?: StateLook;
    variant?: string;
  };
  progress?: { visible: boolean; type: "linear" | "circle"; look?: StateLook };
  warnings: string[];
}

/** What a config may set on the Carousel beyond the layout: how it moves, never where. */
const PLATFORM_MOTION = ["freeMode", "effect", "speed", "easing", "rewind"] as const;

/**
 * A platform carousel config applied to a proposal, the design first.
 *
 * - The frame shows how many slides are on show, the centring, the gap and the direction: those
 *   stay as detected, and the config's are noted.
 * - What a frame cannot show comes from the config: autoplay, loop, free mode, and the looks in
 *   a state of the controls the design drew (an arrow with nowhere to go, the current page's
 *   dot). `nav_arrows.position: center` puts the designed arrows at the carousel's two edges.
 * - Controls the design did not draw are not drawn: the config names their look by number
 *   (`variant`), with no sizes or surfaces to draw it from. That is said, not guessed.
 */
export function withPlatform(
  choice: CarouselChoice,
  read: PlatformRead,
  drew: { arrows: boolean; indicator: boolean },
): { choice: CarouselChoice; notes: string[] } {
  const p = read.props;
  const notes = [...read.warnings];
  const config = { ...choice.config };
  if (typeof p.loop === "boolean") config.loop = p.loop;
  const autoplay = p.autoplay as false | { delay?: { raw?: unknown } } | undefined;
  if (autoplay === false) config.autoplay = false;
  else if (autoplay && typeof autoplay.delay?.raw === "number")
    config.autoplay = { delayMs: autoplay.delay.raw };

  const props: Record<string, unknown> = { ...(config.props ?? {}) };
  for (const key of PLATFORM_MOTION) if (p[key] !== undefined) props[key] = p[key];
  if (Object.keys(props).length > 0) config.props = props;

  const controls: NonNullable<CarouselChoice["config"]["controls"]> = {
    ...(config.controls ?? {}),
  };
  const { arrows, indicator, progress } = read;
  if (arrows?.visible) {
    if (drew.arrows) {
      const look = { ...(controls.arrows ?? {}) };
      if (arrows.position === "center") look.placement = "edges";
      if (arrows.disabled) look.states = { ...(look.states ?? {}), disabled: arrows.disabled };
      controls.arrows = look;
      notes.push(
        `the design draws its arrows, so they keep their look${arrows.position === "center" ? ", one at each edge" : ""}; ${
          arrows.disabled
            ? "the config's disabled colours apply to them"
            : "with no disabled colours, they fade when there is nowhere to go"
        }`,
      );
    } else {
      notes.push(
        `the config shows arrows (variant ${arrows.variant ?? "?"}), but the design draws none and a variant has no look to draw from: none are drawn`,
      );
    }
  }
  if (indicator?.visible) {
    if (drew.indicator && indicator.kind === "pagination") {
      const states: Record<string, unknown> = {};
      if (indicator.active) states.active = indicator.active;
      if (indicator.inactive) states.inactive = indicator.inactive;
      if (Object.keys(states).length > 0) controls.pagination = { states };
      notes.push(
        `the design draws its dots, so they keep their shape${Object.keys(states).length > 0 ? "; the config's colours mark the current page" : ""}`,
      );
    } else if (drew.indicator) {
      notes.push(
        `the design draws dots and the config asks for a ${indicator.kind}: the design's dots stay`,
      );
    } else {
      notes.push(
        `the config shows a ${indicator.kind} (variant ${indicator.variant ?? "?"}), but the design draws none and a variant has no look to draw from: none is drawn`,
      );
    }
  }
  if (progress?.visible) {
    notes.push(
      "the config shows an autoplay progress bar, but the design draws none: none is drawn",
    );
  }
  if (Object.keys(controls).length > 0) config.controls = controls;

  const shown = (field: string, value: unknown, frame: string) => {
    if (value !== undefined)
      notes.push(`${field} ${JSON.stringify(value)} left out: the frame shows ${frame}`);
  };
  if (p.slidesPerView !== undefined && p.slidesPerView !== config.slidesPerView) {
    shown(
      "slides_per_view",
      p.slidesPerView,
      config.slidesPerView === "auto"
        ? "each slide at its designed width"
        : `${config.slidesPerView} on show`,
    );
  }
  if (typeof p.centered === "boolean" && p.centered !== config.centered) {
    shown(
      "centered_slides",
      p.centered,
      config.centered ? "the active slide centred" : "the slides from the start",
    );
  }
  if (p.gap !== undefined)
    shown("space_between", (p.gap as { raw?: unknown }).raw ?? p.gap, "the gap between the slides");
  if (p.direction === "vertical") shown("direction", "vertical", "a horizontal row");
  return { choice: { ...choice, config }, notes };
}

/** A platform config in a line, for the approval card: what it sets, what the frame overrules. */
export function describePlatform(json: Record<string, unknown>): string[] {
  const sets: string[] = [];
  const nav = (json.nav_arrows ?? {}) as Record<string, unknown>;
  const indicator = (json.nav_indicator ?? {}) as Record<string, unknown>;
  const progress = (json.autoplay_progress ?? {}) as Record<string, unknown>;
  if (json.autoplay === true) {
    sets.push(`autoplay every ${(Number(json.autoplay_interval) || 3000) / 1000}s`);
  } else if (json.autoplay === false) sets.push("no autoplay");
  if (typeof json.loop === "boolean") sets.push(json.loop ? "loops" : "no loop");
  if (nav.visibility === true)
    sets.push(`arrows (${[nav.position, nav.sub_variant].filter(Boolean).join(", ")})`);
  if (indicator.visibility === true)
    sets.push(`${indicator.type ?? "bullets"} indicator at the ${indicator.position ?? "bottom"}`);
  if (progress.visibility === true) sets.push(`${progress.type ?? "linear"} autoplay progress`);
  const frame = ["slides_per_view", "centered_slides", "space_between", "direction"].filter(
    (k) => k in json,
  );
  return [
    `From the platform config: ${sets.join("; ") || "nothing that applies"}.`,
    ...(frame.length > 0 ? [`Left to the frame, which shows them: ${frame.join(", ")}.`] : []),
    "Arrows and dots the design drew keep their look; the config gives their disabled and current-page colours, and where the arrows sit. Controls the design did not draw are not drawn.",
  ];
}
