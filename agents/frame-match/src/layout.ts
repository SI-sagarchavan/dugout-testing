/**
 * Layouts in a frame-match run: what `@fanos/compile` detected, and what a person decided.
 *
 * The schema is `@fanos/dsl`'s `layoutChoiceSchema`, restated in this package's zod (the
 * pipeline is on zod 3, the harness on zod 4, and the agent loads the pipeline's built `dist`
 * rather than importing it). `tests/layout.test.ts` holds the two to the same answers.
 */

import type { Answers, AskedQuestion } from "@dugout/contracts";
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
  /** Confidence in `kind`, 0 to 1 (`@fanos/dsl` `LAYOUT_THRESHOLDS`). */
  score?: number;
  /** The container's surroundings in plain lines: what a judge reads. */
  context?: string[];
  items: string[];
  evidence: string[];
  ask: string[];
  choice: LayoutChoice;
  chrome: { prev?: string; next?: string; pagination?: string };
  alternative?: LayoutKind;
  alternativeChoice?: LayoutChoice;
  alternativeAsk?: string[];
}

/** At or above this a layout is applied without asking anyone. */
export const APPLY_SCORE = 0.8;
/** A model's verdict counts when it is at least this sure; below it a person is asked. */
export const ACCEPT_SCORE = 0.75;

/** Asks a model one question in words (`describeText`), replaceable in a test. */
export type LayoutJudge = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** Whether the detector's score leaves a model something to settle. */
export const needsJudge = (i: LayoutIntent) =>
  (i.score ?? 1) < APPLY_SCORE && Boolean(i.alternative && i.alternativeChoice);

/** The question a model judges a doubtful container by: only what the frame and its names say. */
export function judgePrompt(i: LayoutIntent): string {
  const pick = [i.kind, i.alternative].filter(Boolean).join(" or ");
  return [
    "A designer's Figma frame is a still picture; a slider looks like a row of cards. Decide what this container is meant to be on the web.",
    `Candidates: ${pick}. A carousel is a row of slides that moves (arrows, swipe, dots) and holds more items than it shows; a row is a fixed set that never moves.`,
    "",
    `Container: "${i.name}" (score ${i.score ?? "?"} for ${i.kind}).`,
    "What the frame showed:",
    ...i.evidence.map((e) => `- ${e}`),
    "Its surroundings:",
    ...(i.context ?? []).map((c) => `- ${c}`),
    "",
    "Things that usually mean a carousel: a team or player roster, a news or video rail, items at a fixed width with a gap, a heading with a 'view all' link, more items than a row comfortably holds. A fixed row is a short set of equal-width items such as three feature blocks, stats or logos.",
    'Answer with one JSON object and nothing else: {"kind":"' +
      [i.kind, i.alternative].filter(Boolean).join('"|"') +
      '","confidence":0.0-1.0,"reason":"one short sentence"}',
  ].join("\n");
}

export interface Verdict {
  kind: LayoutKind;
  confidence: number;
  reason: string;
}

/** The model's answer, or undefined when it is not the JSON asked for. */
export function readVerdict(text: string): Verdict | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[0]) as Record<string, unknown>;
    const kind = v.kind;
    const confidence = Number(v.confidence);
    if (typeof kind !== "string" || !Number.isFinite(confidence)) return undefined;
    if (!["carousel", "row", "list", "grid", "tabs"].includes(kind)) return undefined;
    return {
      kind: kind as LayoutKind,
      confidence: Math.min(1, Math.max(0, confidence)),
      reason: typeof v.reason === "string" ? v.reason : "",
    };
  } catch {
    return undefined;
  }
}

/**
 * The intent with a model's verdict in it. A verdict for the kind or its alternative that is sure
 * enough (`ACCEPT_SCORE`) settles it: that kind, that score, no question left to a person about
 * what it is. Anything else leaves the detector's answer, and a person is asked as before.
 */
export function applyVerdict(i: LayoutIntent, v: Verdict | undefined): LayoutIntent {
  if (!v) return i;
  const line = `a model judged it ${v.kind} (${v.confidence.toFixed(2)})${v.reason ? `: ${v.reason}` : ""}`;
  const evidence = [...i.evidence, line];
  const settled = v.confidence >= ACCEPT_SCORE;
  if (!settled) return { ...i, evidence };
  if (v.kind === i.kind) {
    return {
      ...i,
      evidence,
      score: v.confidence,
      confidence: "certain",
      ask: i.kind === "row" ? [] : i.ask,
    };
  }
  if (v.kind === i.alternative && i.alternativeChoice) {
    // the questions that fit the new kind: a carousel's are written when it is asked, a row has none
    const { alternative: _a, alternativeChoice: _c, alternativeAsk: _k, ...rest } = i;
    return {
      ...rest,
      kind: v.kind,
      choice: i.alternativeChoice,
      score: v.confidence,
      confidence: "certain",
      evidence,
      ask: i.alternativeAsk ?? [],
    };
  }
  return { ...i, evidence };
}

/** What a run tells the model and the reviewer about one container. */
export interface LayoutReport {
  src: string;
  name: string;
  kind: LayoutKind;
  confidence: Confidence;
  /** Confidence in `kind`, 0 to 1. */
  score?: number;
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

/** The kinds a container can be, as a person picks one. */
const KIND_OPTIONS: Array<{ value: LayoutKind; label: string; description: string }> = [
  { value: "carousel", label: "A carousel", description: "Slides that move, with arrows or dots" },
  { value: "row", label: "A fixed row", description: "The items as drawn, no moving" },
  { value: "list", label: "A list", description: "The items stacked, as many as the data has" },
  { value: "grid", label: "A grid", description: "Columns and rows of items" },
  { value: "tabs", label: "Tabs", description: "One group of items on show at a time" },
];

/** The "(proposed: ...)" a layout's own question ends with, taken off it. */
function splitProposed(ask: string): { text: string; proposed: string } {
  const m = /^(.*?)\s*\(proposed:\s*(.*)\)\s*$/s.exec(ask);
  return m ? { text: m[1] ?? ask, proposed: m[2] ?? "" } : { text: ask, proposed: "" };
}

/**
 * What a person is asked about one container (ADR 0029), written from what the frame showed, so a
 * run stops with questions that fit this frame: what it is when the frame leaves that open, then
 * for a carousel how many items it holds, whether it moves on its own, whether it loops, and a
 * platform config to apply when there is one. Each has the frame's own proposal. Nothing when the
 * frame leaves nothing open.
 */
export function layoutQuestions(report: LayoutReport, proposed: LayoutChoice): AskedQuestion[] {
  if (report.ask.length === 0 && report.confidence === "certain") return [];
  const shows = `The frame shows: ${report.evidence.join("; ")}.`;
  const out: AskedQuestion[] = [];
  if (report.confidence !== "certain") {
    out.push({
      id: "kind",
      question: `What is "${report.name}"?`,
      why: shows,
      kind: "choice",
      options: KIND_OPTIONS.filter((o) => o.value === proposed.kind || o.value !== "tabs"),
      allowOther: false,
      proposed: [report.kind],
    });
  }
  if (proposed.kind === "carousel") {
    const c = proposed.config;
    const shown = /^(\d+) /.exec(report.evidence[0] ?? "")?.[1];
    out.push(
      {
        id: "items",
        question: `How many items does "${report.name}" hold in all?`,
        why: `${shown ? `The frame shows ${shown}. ` : ""}A carousel repeats for every item the data gives; a number fixes it.`,
        kind: "choice",
        options: [
          {
            value: "data",
            label: "Whatever the data holds",
            description: "Repeats for every item",
          },
        ],
        allowOther: true,
        proposed: [c.pages ? String(c.pages) : "data"],
      },
      {
        id: "autoplay",
        question: `Should "${report.name}" move on its own, and how long on each item?`,
        why: "The frame is one still: it cannot show whether it moves.",
        kind: "choice",
        options: [
          {
            value: "off",
            label: "No autoplay",
            description: "Moves when someone presses an arrow or swipes",
          },
          { value: "3000", label: "Every 3 seconds", description: "" },
          { value: "5000", label: "Every 5 seconds", description: "" },
          { value: "8000", label: "Every 8 seconds", description: "" },
        ],
        allowOther: true,
        proposed: [c.autoplay ? String(c.autoplay.delayMs) : "off"],
      },
      {
        id: "loop",
        question: `After the last item, should "${report.name}" wrap around to the first?`,
        why: "The frame cannot show what is after the last item.",
        kind: "confirm",
        options: [],
        allowOther: false,
        proposed: [c.loop ? "yes" : "no"],
      },
      {
        id: "platform",
        question: "Is there a platform carousel config to apply?",
        why: "A config (slides_per_view, nav_arrows, nav_indicator ...) sets how it behaves; code applies it with the design first. Skip when there is none.",
        kind: "text",
        options: [],
        allowOther: false,
        proposed: [],
      },
    );
    return out;
  }
  // a container that is not a carousel: the compiler's own open questions, with its proposals
  for (const [n, ask] of report.ask.entries()) {
    const { text, proposed: guess } = splitProposed(ask);
    out.push({
      id: `ask_${n + 1}`,
      question: text,
      why: shows,
      kind: "text",
      options: [],
      allowOther: false,
      proposed: guess ? [guess] : [],
    });
  }
  return out;
}

/** What a person said, read as a delay in milliseconds: "4s", "every 4 seconds", 4500. */
function delayOf(said: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(ms|millisecond\w*|s|sec\w*)?/i.exec(said);
  if (!m) return undefined;
  const n = Number(m[1]);
  const seconds = /^(s|sec)/i.test(m[2] ?? "") || (!m[2] && n < 100);
  const ms = Math.round(seconds ? n * 1000 : n);
  return ms > 0 ? ms : undefined;
}

/**
 * The model's proposal with the person's answers put in it: the kind they chose, autoplay, loop,
 * a page count, and a platform config. What they left out stays as proposed. `notes` says what
 * could not be read, and `said` what they wrote about a container the answers do not map onto.
 */
export function applyLayoutAnswers(
  proposed: LayoutChoice,
  answers: Answers,
): { choice: LayoutChoice; platform?: Record<string, unknown>; notes: string[]; said: string[] } {
  const notes: string[] = [];
  const said = Object.entries(answers)
    .filter(([id, a]) => id.startsWith("ask_") && typeof a === "string" && a.trim())
    .map(([id, a]) => `${id}: ${a}`);
  const kind = answers.kind;
  if (typeof kind === "string" && kind !== proposed.kind) {
    if (kind === "row" || kind === "list")
      return { choice: { src: proposed.src, kind }, notes, said };
    notes.push(
      `${kind} needs its own settings (columns, tabs): the proposal is kept as a ${proposed.kind}`,
    );
  }
  if (proposed.kind !== "carousel") return { choice: proposed, notes, said };

  const config = { ...proposed.config };
  const autoplay = answers.autoplay;
  if (typeof autoplay === "string") {
    if (autoplay === "off") config.autoplay = false;
    else {
      const ms = delayOf(autoplay);
      if (ms) config.autoplay = { delayMs: ms };
      else notes.push(`autoplay "${autoplay}" was not a time: left as proposed`);
    }
  }
  if (typeof answers.loop === "boolean") config.loop = answers.loop;
  const items = answers.items;
  if (typeof items === "string" && items !== "data") {
    const n = Number.parseInt(items, 10);
    if (Number.isInteger(n) && n > 0) config.pages = n;
    else notes.push(`items "${items}" was not a number: it holds whatever the data holds`);
  }
  let platform: Record<string, unknown> | undefined;
  const given = answers.platform;
  if (typeof given === "string" && given.trim()) {
    try {
      const parsed: unknown = JSON.parse(given);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        platform = parsed as Record<string, unknown>;
      } else notes.push("the platform config was not a JSON object: not applied");
    } catch {
      notes.push("the platform config was not JSON: not applied");
    }
  }
  return {
    choice: { ...proposed, config },
    ...(platform ? { platform } : {}),
    notes,
    said,
  };
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
