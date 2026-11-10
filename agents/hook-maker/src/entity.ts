/**
 * Whether data is about the team or competition a design is about (`.scratch/data-sources/issues/09`
 * and `17`). Code only, so it holds for any club. Lives with hook-maker, which judges the data it
 * finds, and data-bind's `bind.try` uses the same reading.
 */

/** What the design is about, from the need's `must`: the data has to be about it. */
export interface About {
  team?: string | undefined;
  competition?: string | undefined;
}

/** The words of a text as written, letters and figures only. */
const wordsOf = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];

/** Words that are no part of a name's own: "The Brave" is "Brave". */
const FILLER = new Set(["the", "a", "an", "of", "and", "fc", "cc", "afc", "club"]);
const significant = (words: string[]) => words.filter((w) => !FILLER.has(w.toLowerCase()));
const capitalised = (word: string) => /^\p{Lu}/u.test(word);
/** A short form written in capitals: KKR, RR. */
const isInitials = (word: string) => /^\p{Lu}{2,5}$/u.test(word);
const initialsOf = (words: string[]) =>
  significant(words)
    .map((w) => w[0] ?? "")
    .join("")
    .toLowerCase();

/**
 * Whether `text` holds `must` as the design writes it, by whole words (never inside a longer one:
 * "Brave" is not in "Braves", "RR" not in "Current error"):
 * - its words in a row ("Southern Brave"), or each of its words somewhere;
 * - its short name, the last word of a name of several ("Brave" for "Southern Brave"), unless a
 *   name of its own is written before it ("Atlanta Brave" is another team);
 * - its initials: a must written in capitals ("KKR") against capitalised words in a row
 *   ("Kolkata Knight Riders"), and a must of several words against its initials in capitals.
 */
export function holdsWords(text: string, must: string): boolean {
  const want = wordsOf(must);
  if (want.length === 0) return false;
  const lines = text.split(/\n/).map(wordsOf);
  const lower = (w: string) => w.toLowerCase();
  const wantLower = want.map(lower);
  const all = new Set(lines.flat().map(lower));
  // its words in a row
  const phrase = ` ${wantLower.join(" ")} `;
  if (lines.some((line) => ` ${line.map(lower).join(" ")} `.includes(phrase))) return true;
  // each of its words somewhere (words of three letters or more, fillers aside)
  const own = significant(want).filter((w) => w.length >= 3);
  if (own.length > 1 && own.every((w) => all.has(lower(w)))) return true;
  const single = want.length === 1 ? want[0] : undefined;
  // a must in capitals (KKR): capitalised words in a row whose initials spell it
  if (single && isInitials(single)) {
    const n = single.length;
    for (const line of lines) {
      const names = line.map((w) => (FILLER.has(lower(w)) ? undefined : w));
      const kept = names.filter((w): w is string => w !== undefined);
      for (let i = 0; i + n <= kept.length; i++) {
        const run = kept.slice(i, i + n);
        if (run.every(capitalised) && initialsOf(run) === lower(single)) return true;
      }
    }
  }
  if (want.length > 1) {
    const initials = initialsOf(want);
    // its initials, in capitals (KKR for Kolkata Knight Riders)
    if (
      initials.length >= 2 &&
      lines.some((l) => l.some((w) => isInitials(w) && lower(w) === initials))
    )
      return true;
    // its short name: the last word, not written after a name of its own
    const short = significant(want).at(-1);
    if (short && short.length >= 3) {
      const mine = new Set(wantLower);
      for (const line of lines) {
        for (const [i, w] of line.entries()) {
          if (lower(w) !== lower(short)) continue;
          const before = line[i - 1];
          if (
            !before ||
            mine.has(lower(before)) ||
            FILLER.has(lower(before)) ||
            !capitalised(before)
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** How the data came to be the section's: by a person's feed or choice, or found by the agent. */
export type Basis = "sources" | "chosen" | "found" | "built";

/**
 * Why the sample is not about the team or competition the design is about, or undefined.
 *
 * A hook found or built by the agent has to name what the design is about somewhere (an item's
 * team name, a heading, the feed's own fields). Data from a person's feed, a club's feed fact or
 * a hook a person chose (`trusted`) is the design's entity until it names another: many feeds,
 * a squad's among them, never name their own team, so naming none is no evidence, and naming only
 * other teams is. It reports the team names the data does have.
 */
export function wrongEntity(
  sample: unknown,
  about: About | undefined,
  opts: { trusted?: boolean } = {},
): string | undefined {
  const wants = Object.entries(about ?? {}).filter(([, v]) => typeof v === "string" && v);
  if (wants.length === 0) return undefined;
  const strings: string[] = [];
  const teams = new Map<string, number>();
  const walk = (value: unknown, key = "") => {
    if (strings.length > 20_000) return;
    if (typeof value === "string") {
      strings.push(value);
      if (/team|club|franchise|squad/i.test(key) && value.length <= 40) {
        teams.set(value, (teams.get(value) ?? 0) + 1);
      }
    } else if (Array.isArray(value)) for (const v of value) walk(v, key);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(sample);
  const text = strings.join("\n");
  const lacking = wants.filter(([, must]) => !holdsWords(text, String(must)));
  if (lacking.length === 0) return undefined;
  // a trusted feed that names no team at all says nothing against itself
  if (opts.trusted && teams.size === 0) return undefined;
  const holds = [...teams]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
  return `the data is about ${holds.length ? holds.join(", ") : "something else"}, the design is about ${lacking.map(([, must]) => must).join(" and ")}: nothing in the data names ${lacking.map(([kind, must]) => `the ${kind} ${must}`).join(" or ")}. This is another team's data: ask for a feed that is about it (data_source), or, to bind it as a stand-in, publish with despite saying so`;
}
