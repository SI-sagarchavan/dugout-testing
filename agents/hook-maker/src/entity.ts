/**
 * What data names, against the team or competition a design is about. hook-maker reports it
 * (`namesIn`, in `hook.evidence`) and its model judges whether the data is about the design's
 * entity; it never refuses an answer on that judgement. `holdsWords` is kept for its readers
 * outside hook-maker (data-bind's `bind.try`, the build record).
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

export interface NamesReport {
  /** Each value of the need's `must`, and how many strings of the data hold its words as written. */
  must: Array<{ kind: string; value: string; appears: number }>;
  /** The short texts the data holds most often, each with how often and the path it is most at. */
  repeated: Array<{ value: string; times: number; at: string }>;
}

/** How many repeated texts a report shows, and how long a text may be to count as a name. */
const SHOWN = 8;
const NAME_LENGTH = 60;

/**
 * What the data names, for the model to judge whether it is about what the design is about: how
 * often each value of `must` appears in the data's texts (as written, case aside), and the short
 * texts it repeats most (team names in fixtures, a club in a table, a category), each with where.
 * It judges nothing: a feed may never name its own team, and a short name or initials may stand
 * for the must; the model reads it.
 */
export function namesIn(output: unknown, about: About | undefined): NamesReport | undefined {
  const wants = Object.entries(about ?? {}).filter(
    (e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "",
  );
  if (wants.length === 0) return undefined;
  const strings: string[] = [];
  const seen = new Map<string, { times: number; at: Map<string, number> }>();
  const walk = (value: unknown, path: string) => {
    if (strings.length > 20_000) return;
    if (typeof value === "string") {
      strings.push(value);
      const text = value.trim();
      // a name: some letters, short, not a link or a path
      if (text.length > NAME_LENGTH || !/\p{L}/u.test(text) || /^(https?:)?\/\/|^\//i.test(text)) {
        return;
      }
      const entry = seen.get(text) ?? { times: 0, at: new Map<string, number>() };
      entry.times++;
      entry.at.set(path, (entry.at.get(path) ?? 0) + 1);
      seen.set(text, entry);
    } else if (Array.isArray(value)) for (const v of value) walk(v, `${path}[]`);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(output, "");
  const lower = strings.map((s) => s.toLowerCase());
  return {
    must: wants.map(([kind, value]) => ({
      kind,
      value,
      appears: lower.filter((s) => s.includes(value.trim().toLowerCase())).length,
    })),
    repeated: [...seen]
      .sort((a, b) => b[1].times - a[1].times)
      .slice(0, SHOWN)
      .map(([value, e]) => ({
        value,
        times: e.times,
        at: [...e.at].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
      })),
  };
}
