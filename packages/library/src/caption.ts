import { describeImage } from "@dugout/core";

/** What a section is, as a person would look for it. `other` when none fits. */
export const SECTION_KINDS = [
  "header",
  "footer",
  "hero",
  "fixtures",
  "results",
  "standings",
  "news",
  "video",
  "gallery",
  "players",
  "stats",
  "tickets",
  "shop",
  "promo",
  "sponsors",
  "social",
  "form",
  "other",
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export interface Description {
  caption: string;
  kind: SectionKind;
  tags: string[];
}

export interface CaptionInput {
  /** The section's picture, small enough for a vision model. */
  png: Buffer;
  summary: string;
  layout: string;
}

export interface Captioner {
  readonly model: string;
  caption(input: CaptionInput): Promise<Description>;
}

const MAX_TAGS = 8;

export function captionPrompt(input: Pick<CaptionInput, "summary" | "layout">): string {
  return [
    "The picture is one section of a sports club's website or app, cut from a design.",
    "Describe the COMPONENT so a designer can find it again by searching: what it is, how it is",
    "laid out, what each repeated item holds, and how it looks. Do not describe what it shows",
    "today: no team names, players, scores, dates, prices or headlines. Say 'the home and away",
    "crests', not which clubs.",
    "",
    `Its structure, from the design file: ${input.summary}`,
    input.layout !== "none" ? `Layout detection says it is a ${input.layout}.` : "",
    "",
    'Reply with JSON only: {"caption":"one or two sentences","kind":"<kind>","tags":["..."]}.',
    `kind is one of: ${SECTION_KINDS.join(", ")}.`,
    `tags are 3 to ${MAX_TAGS} short lowercase phrases a person would type to find it, such as`,
    '"fixtures carousel", "match card", "dark theme", "two crests".',
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

/** The first JSON object in a reply, however the model dressed it. */
export function parseDescription(text: string): Description {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error(`no JSON in the caption reply: ${text.slice(0, 200)}`);
  const json = JSON.parse(text.slice(start, end + 1)) as {
    caption?: unknown;
    kind?: unknown;
    tags?: unknown;
  };
  const caption = typeof json.caption === "string" ? json.caption.trim() : "";
  if (!caption) throw new Error("the caption reply has no caption");
  const kind = SECTION_KINDS.includes(json.kind as SectionKind)
    ? (json.kind as SectionKind)
    : "other";
  const tags = Array.isArray(json.tags)
    ? json.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, MAX_TAGS)
    : [];
  return { caption, kind, tags };
}

/** A Claude model in `config/models.json` reading each picture (`describeImage`). */
export function createVisionCaptioner(
  opts: { model?: string; describe?: typeof describeImage } = {},
): Captioner {
  const model = opts.model ?? "haiku";
  const describe = opts.describe ?? describeImage;
  return {
    model,
    async caption(input) {
      return parseDescription(
        await describe({ png: input.png, prompt: captionPrompt(input), model }),
      );
    },
  };
}
