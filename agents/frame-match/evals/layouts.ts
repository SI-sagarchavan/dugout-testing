/**
 * What each container of the eval frames IS, as a person reads the design. `pnpm eval layout`
 * scores `detectLayout` against these.
 *
 * Labelled by reading each frame (2026-11-03), not by running the detector: where a label and
 * the detector disagree, the label is the one to question first, then the rule. Containers not
 * listed are not scored, except that a carousel anywhere unlisted is a failure: a static row
 * shipped as a carousel is the worse mistake.
 *
 * `confidence` is how sure detection should be: `unsure` means the frame cannot tell, and the
 * right result is a question for a person.
 */

import type { Confidence, LayoutKind } from "../src/layout.ts";

export interface LayoutLabel {
  /** The container's Figma id. */
  src: string;
  /** What it is, for a person reading a failure. */
  what: string;
  kind: LayoutKind;
  confidence?: Confidence;
  /** Designed controls detection must wire. */
  chrome?: Array<"prev" | "next" | "pagination" | "counter" | "progress">;
  /**
   * A carousel that draws only the slide on show: layers that must be in its slide (`src` is the
   * container they sit in). Scored by `pnpm eval read`; the IR detector cannot see one.
   */
  slide?: string[];
  /** Layers that must NOT be in the slide: what is pinned over it. */
  notSlide?: string[];
  /** For a carousel: centred on the slide drawn in the middle. */
  centered?: boolean;
}

export const LAYOUT_LABELS: Record<string, LayoutLabel[]> = {
  "player-strip": [
    {
      src: "35:10529",
      what: "five player cards, the fifth cut off",
      kind: "carousel",
      confidence: "certain",
    },
  ],
  "team-page": [
    {
      src: "35:10515",
      what: "the squad's WOMEN / MEN toggle, MEN selected",
      kind: "tabs",
    },
    {
      src: "35:10529",
      what: "player cards running off the page edge, with a back/next pair under them",
      kind: "carousel",
      confidence: "certain",
      chrome: ["prev", "next"],
    },
    {
      src: "35:10545",
      what: "fixture cards cut off at both edges, centred on the active one",
      kind: "carousel",
      confidence: "certain",
      chrome: ["prev", "next"],
      centered: true,
    },
  ],
  "fixtures-strip": [
    {
      src: "35:10545",
      what: "fixture cards cut off at both edges, centred on the active one",
      kind: "carousel",
      confidence: "certain",
      chrome: ["prev", "next"],
      centered: true,
    },
  ],
  "fixtures-inner": [
    {
      src: "35:10545",
      what: "the same fixtures carousel",
      kind: "carousel",
      confidence: "certain",
      chrome: ["prev", "next"],
      centered: true,
    },
  ],
  "latest-news": [{ src: "35:10439", what: "three stories stacked beside the lead", kind: "list" }],
  hospitality: [
    { src: "35:4763", what: "three hospitality packages, one under the other", kind: "list" },
    {
      src: "35:4813",
      what: "four video cards that exactly fill the row: fixed, or a carousel when there are more?",
      kind: "row",
      confidence: "unsure",
    },
  ],
  "ho-spider": [
    {
      src: "294:14767",
      what: "SCORECARD / SQUAD / GRAPHS / MORE INFO, GRAPHS selected",
      kind: "tabs",
      confidence: "certain",
    },
    {
      src: "294:14097",
      what: "the graphs' SPIDER / MANHATTAN / WORM switch, one selected",
      kind: "tabs",
    },
  ],
  "news-later": [],
  "video-card": [],
  "player-card": [],
  "match-centre": [],
  "ho-header": [],
  "ho-frame-101626": [
    {
      src: "294:14115",
      what: "a toggle between the two teams, one selected",
      kind: "tabs",
    },
  ],
  "ho-standings": [],
  "ho-frame-1984079082": [],
  "ho-merchandise": [],
  "ho-tickets": [],
  "ho-live": [],
};

/**
 * Frames that are not stored exports: their IR and design picture are kept in `evals/sections/`.
 * Scored by `pnpm eval read` only.
 */
export const LOCAL_FRAMES: Array<{ id: string; ir: string; design: string }> = [
  {
    // Southern Brave's hero (Handoff 9498f86c): one story drawn, two arrows, "01", a bar, a pinned match card
    id: "showcase",
    ir: "sections/showcase.ir.json",
    design: "sections/showcase.design.png",
  },
];

export const LOCAL_LABELS: Record<string, LayoutLabel[]> = {
  showcase: [
    {
      src: "542:10713",
      what: "a hero carousel of stories that draws only the one on show",
      kind: "carousel",
      confidence: "certain",
      chrome: ["prev", "next", "counter"],
      // the photo and the words move with the story
      slide: ["I542:10713;13020:17582", "I542:10713;13020:17586"],
      // the match card stays pinned
      notSlide: ["I542:10713;13744:55540"],
    },
  ],
};
