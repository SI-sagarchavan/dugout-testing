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
  chrome?: Array<"prev" | "next" | "pagination">;
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
  ],
  "news-later": [],
  "video-card": [],
  "player-card": [],
  "match-centre": [],
  "ho-header": [],
  "ho-frame-101626": [],
  "ho-standings": [],
  "ho-frame-1984079082": [],
  "ho-merchandise": [],
  "ho-tickets": [],
  "ho-live": [],
};
