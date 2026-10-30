import { z } from "zod";

export const CHANNELS = ["social", "push", "headline"] as const;
export type Channel = (typeof CHANNELS)[number];

export const PREVIEW_MAX_WORDS = 120;
export const SOCIAL_MAX_CHARS = 280;
export const PUSH_MAX_CHARS = 120;
export const HEADLINE_MAX_CHARS = 80;

/** Whole word, plus a simple plural or -ing. Same list the preview evals ban. */
const BANNED = /\b(?:bet|betting|odds|wager|punt|bookie|bookmaker|gamble|gambling)(?:s|es|ing)?\b/i;

export const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

const channelText = (max: number) => z.string().trim().min(1).max(max);

/** The pack before the cross-field checks. `final` and `pack.save` use {@link PackSchema}. */
export const PackShape = z.object({
  fixtureId: z.string().regex(/^[a-z]-\d{3}$/),
  channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length),
  preview: z.object({
    title: z.string().trim().min(3).max(120),
    body: z.string().trim().min(20).max(2_000),
  }),
  // Required, and null when that channel was not requested. An optional field is one a strict
  // model may leave out, then send the same call again after the refusal.
  social: channelText(SOCIAL_MAX_CHARS).nullable(),
  push: channelText(PUSH_MAX_CHARS).nullable(),
  headline: channelText(HEADLINE_MAX_CHARS).nullable(),
});

export type Pack = z.infer<typeof PackShape>;

/** Rules that don't need the fixture. `pack.save` refuses these before it asks for approval. */
export function packTextProblems(pack: Pack): string[] {
  const problems: string[] = [];
  if (new Set(pack.channels).size !== pack.channels.length) {
    problems.push("channels: name each channel once");
  }
  const words = countWords(pack.preview.body);
  if (words > PREVIEW_MAX_WORDS) {
    problems.push(`preview.body: ${words} words, limit ${PREVIEW_MAX_WORDS}`);
  }
  for (const channel of CHANNELS) {
    const text = pack[channel];
    if (pack.channels.includes(channel) && text === null) {
      problems.push(
        `${channel} is null. channels includes ${channel}, so set ${channel} to its text`,
      );
    }
    if (text !== null && !pack.channels.includes(channel)) {
      problems.push(`${channel} was not requested, so set it to null`);
    }
  }
  const fields: Array<[string, string | null]> = [
    ["preview.title", pack.preview.title],
    ["preview.body", pack.preview.body],
    ["social", pack.social],
    ["push", pack.push],
    ["headline", pack.headline],
  ];
  for (const [field, text] of fields) {
    if (text && BANNED.test(text)) problems.push(`${field}: betting language is not allowed`);
  }
  return problems;
}

/** What `pack.save` still checks against the fixture, after the reviewer has approved. */
export interface FixtureCheck {
  kickoffLocal: string;
  homeName: string;
}

export function packFixtureProblems(pack: Pack, fixture: FixtureCheck): string[] {
  const problems: string[] = [];
  if (pack.push && !pack.push.includes(fixture.kickoffLocal)) {
    problems.push(`push: must include the kickoff time ${fixture.kickoffLocal}`);
  }
  if (
    pack.headline &&
    fixture.homeName &&
    !pack.headline.toLowerCase().includes(fixture.homeName.toLowerCase())
  ) {
    problems.push(`headline: must name the home team ${fixture.homeName}`);
  }
  return problems;
}

export const PackSchema = PackShape.superRefine((pack, ctx) => {
  for (const message of packTextProblems(pack)) {
    ctx.addIssue({ code: "custom", message });
  }
});

/** Stored pack. A channel that was not requested is left out, rather than written as null. */
export type StoredPack = Omit<Pack, Channel> & Partial<Record<Channel, string>>;

/** The pack as it is hashed and stored, without the save's own hash or run id. */
export function packRecord(pack: Pack): StoredPack {
  return {
    fixtureId: pack.fixtureId,
    channels: pack.channels,
    preview: pack.preview,
    ...(pack.social !== null ? { social: pack.social } : {}),
    ...(pack.push !== null ? { push: pack.push } : {}),
    ...(pack.headline !== null ? { headline: pack.headline } : {}),
  };
}
