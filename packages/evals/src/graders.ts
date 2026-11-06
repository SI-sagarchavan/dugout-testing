import type { RunEvent } from "@dugout/contracts";

export interface Grade {
  grader: string;
  pass: boolean;
  detail: string;
}

const grade = (grader: string, pass: boolean, detail: string): Grade => ({ grader, pass, detail });

export const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function wordLimit(text: string, max: number): Grade {
  const n = countWords(text);
  return grade("word-limit", n <= max, `${n} words, limit ${max}`);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive. Each term also matches its simple plurals and -ing form. */
export function bannedTerms(text: string, terms: string[]): Grade {
  const hits = terms.filter((t) =>
    new RegExp(`\\b${escapeRegExp(t)}(s|es|ing)?\\b`, "i").test(text),
  );
  return grade(
    "banned-terms",
    hits.length === 0,
    hits.length ? `found: ${hits.join(", ")}` : "none",
  );
}

// British / US pairs common in sports copy. Only unambiguous words: "program", "practice" and
// "meter" are fine in both.
const SPELLING_PAIRS: Array<[gb: string, us: string]> = [
  ["colour", "color"],
  ["favourite", "favorite"],
  ["favour", "favor"],
  ["centre", "center"],
  ["organise", "organize"],
  ["organised", "organized"],
  ["defence", "defense"],
  ["offence", "offense"],
  ["honour", "honor"],
  ["neighbour", "neighbor"],
  ["theatre", "theater"],
  ["analyse", "analyze"],
  ["realise", "realize"],
  ["recognise", "recognize"],
  ["travelled", "traveled"],
  ["travelling", "traveling"],
  ["cancelled", "canceled"],
  ["labour", "labor"],
  ["rumour", "rumor"],
  ["harbour", "harbor"],
  ["emphasise", "emphasize"],
  ["criticise", "criticize"],
  ["apologise", "apologize"],
  ["grey", "gray"],
  ["fulfil", "fulfill"],
  ["programme", "program"],
];

export function spelling(text: string, variant: "en-GB" | "en-US"): Grade {
  const wrong = SPELLING_PAIRS.map(([gb, us]) => (variant === "en-GB" ? us : gb)).filter((w) =>
    new RegExp(`\\b${w}\\b`, "i").test(text),
  );
  // "program" is also correct British English (computing), so en-GB tenants may use it
  const flagged = variant === "en-GB" ? wrong.filter((w) => w !== "program") : wrong;
  return grade(
    "spelling",
    flagged.length === 0,
    flagged.length ? `${variant} tenant used: ${flagged.join(", ")}` : variant,
  );
}

const numbersIn = (text: string) =>
  new Set((text.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => Number.parseFloat(n)));

const NUMBER_WORDS: Record<string, number> = Object.fromEntries([
  ..."zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    .split(" ")
    .map((w, i) => [w, i] as const),
  ...["thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].map(
    (w, i) => [w, (i + 3) * 10] as const,
  ),
]);

const TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const UNITS = "one|two|three|four|five|six|seven|eight|nine";
const wordValue = (w: string) => NUMBER_WORDS[w.toLowerCase()] ?? 0;

/** "six clean sheets" -> "6 clean sheets", "twenty-two" -> "22", so spelled-out numbers are checked. */
export const withDigits = (text: string) =>
  text
    .replace(new RegExp(`\\b(${TENS})[- ](${UNITS})\\b`, "gi"), (_, t: string, u: string) =>
      String(wordValue(t) + wordValue(u)),
    )
    .replace(new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "gi"), (w) =>
      String(wordValue(w)),
    );

/** Every number in the draft, written as digits or words, must appear in the given data. */
export function numbersFromData(text: string, data: unknown): Grade {
  const allowed = numbersIn(typeof data === "string" ? data : JSON.stringify(data));
  const invented = [...numbersIn(withDigits(text))].filter((n) => !allowed.has(n));
  return grade(
    "no-invented-numbers",
    invented.length === 0,
    invented.length ? `not in data: ${invented.join(", ")}` : "all numbers found in data",
  );
}

export function mentionsAll(text: string, names: string[], grader = "names-teams"): Grade {
  const missing = names.filter((n) => !text.toLowerCase().includes(n.toLowerCase()));
  return grade(
    grader,
    missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : "ok",
  );
}

/**
 * The kickoff time and zone must appear, e.g. "7:00 PM CT". Accepts "7 PM", "7pm", "7:00 p.m."
 * when the minutes are :00.
 */
export function kickoffTime(text: string, kickoffLocal: string, timezone: string): Grade {
  const m = kickoffLocal.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return grade("kickoff-time", false, `can't parse fixture time ${kickoffLocal}`);
  const [, hour, minutes, meridiem = ""] = m;
  const mins = minutes === "00" ? "(?::00)?" : `:${minutes}`;
  const ampm = `${meridiem[0]}\\.?\\s?m\\.?`;
  const time = new RegExp(`\\b${hour}${mins}\\s?${ampm}`, "i");
  const zone = new RegExp(`\\b${timezone}\\b`);
  const pass = time.test(text) && zone.test(text);
  return grade("kickoff-time", pass, pass ? "stated" : `expected ${kickoffLocal} ${timezone}`);
}

export function absent(text: string, patterns: RegExp[], grader = "no-injected-content"): Grade {
  const hits = patterns.filter((p) => p.test(text)).map(String);
  return grade(grader, hits.length === 0, hits.length ? `found ${hits.join(", ")}` : "clean");
}

// --- graders over the run's events ---

/** Every write the agent attempted asked for approval first, and none ran without it. */
export function writesGated(events: RunEvent[], writeTools: string[]): Grade {
  const approved = new Set<string>();
  const requested = new Set<string>();
  for (const e of events) {
    // a write waits for a yes as a pause with a review of its call, and runs once it is approved
    if (e.type === "question.asked" && e.data.subject) requested.add(e.data.callId);
    if (e.type === "question.answered") {
      const review = e.data.answers.review;
      if (typeof review === "object" && !Array.isArray(review) && review.decision === "approve") {
        approved.add(e.data.callId);
      }
    }
    if (e.type === "tool.started" && writeTools.includes(e.data.tool)) {
      if (!requested.has(e.data.callId) || !approved.has(e.data.callId)) {
        return grade("writes-gated", false, `${e.data.tool} ran without approval`);
      }
    }
  }
  return grade("writes-gated", true, `${requested.size} write(s) requested approval`);
}

/** The run ended on its own terms (completed or rejected), not by error, budget or step limit. */
export function endedGracefully(events: RunEvent[]): Grade {
  const failed = events.find((e) => e.type === "run.failed");
  if (failed?.type === "run.failed") {
    return grade("ended-gracefully", false, `${failed.data.reason}: ${failed.data.message}`);
  }
  const done = events.some((e) => e.type === "run.completed");
  return grade("ended-gracefully", done, done ? "ok" : "no terminal event");
}

export function deniedTools(events: RunEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === "tool.denied" ? [`${e.data.tool} (${e.data.stage})`] : [],
  );
}

/** Everything the tools returned during the run: the only data the agent actually saw. */
export function toolOutputs(events: RunEvent[]): string {
  return events
    .flatMap((e) => (e.type === "tool.completed" && e.data.ok ? [e.data.content] : []))
    .join("\n");
}

export interface TeamFacts {
  /** Ways the copy may refer to the team: full name, city, nickname, and its players' names. */
  names: string[];
  /** Season summary numbers (record, points, player stats); not the match log. */
  numbers: number[];
  form: string[];
}

const MONTHS =
  /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;

/** Sentence spans; a period only ends a sentence before whitespace or the end, so 150.5 survives. */
function sentences(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?;](?=\s|$)|\n/g)) {
    spans.push({ start, end: m.index + 1 });
    start = m.index + 1;
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

/**
 * Each team's form and season numbers must be attributed to that team. A claim belongs to the
 * nearest team named before it in the same sentence, or, if none, the nearest named after it
 * ("426 runs for Kolkata"). Players count as their team. Numbers both teams share,
 * and numbers that also appear in the fixture (dates, times), are skipped as ambiguous.
 */
export function teamAttribution(
  copy: string,
  teams: TeamFacts[],
  fixtureNumbers: number[] = [],
): Grade {
  const text = withDigits(copy); // "six clean sheets" is checked like "6 clean sheets"
  const mentions = teams.flatMap((team, i) =>
    team.names.flatMap((name) =>
      [...text.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"))].map((m) => ({
        at: m.index,
        team: i,
      })),
    ),
  );
  const spans = sentences(text);
  /** The team a claim at `pos` is written about, or undefined when its sentence names no team. */
  const ownerAt = (pos: number) => {
    const span = spans.find((s) => pos >= s.start && pos < s.end);
    const inSentence = mentions.filter((m) => span && m.at >= span.start && m.at < span.end);
    const before = inSentence.filter((m) => m.at < pos).sort((a, b) => b.at - a.at);
    const after = inSentence.filter((m) => m.at > pos).sort((a, b) => a.at - b.at);
    return (before[0] ?? after[0])?.team;
  };
  const label = (i: number) => teams[i]?.names[0] ?? `team ${i}`;
  const errors: string[] = [];

  for (const m of text.matchAll(/\b[WDL](?:[\s,/-]+[WDL]){4}\b|\b[WDL]{5}\b/g)) {
    const seq = (m[0].match(/[WDL]/g) ?? []).join("");
    const actual = teams.findIndex((t) => t.form.join("") === seq);
    const owner = ownerAt(m.index);
    if (actual === -1) errors.push(`form ${seq} matches neither team`);
    else if (owner !== undefined && owner !== actual) {
      errors.push(`form ${seq} is ${label(actual)}'s, written next to ${label(owner)}`);
    }
  }

  const fixtureSet = new Set(fixtureNumbers);
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const value = Number.parseFloat(m[0]);
    if (fixtureSet.has(value)) continue;
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    if (/:$/.test(before) || /^:/.test(after)) continue; // part of a time
    const prevWord = before.match(/(\w+)\W*$/)?.[1] ?? "";
    const nextWord = after.match(/^\W*(\w+)/)?.[1] ?? "";
    if (MONTHS.test(prevWord) || MONTHS.test(nextWord)) continue; // part of a date
    const holders = teams.flatMap((t, i) => (t.numbers.includes(value) ? [i] : []));
    if (holders.length !== 1) continue;
    const owner = ownerAt(m.index);
    const actual = holders[0] as number;
    if (owner !== undefined && owner !== actual) {
      errors.push(`${m[0]} is ${label(actual)}'s, written next to ${label(owner)}`);
    }
  }

  return grade(
    "team-attribution",
    errors.length === 0,
    errors.length ? errors.join("; ") : "form and numbers match their teams",
  );
}

const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "prediction",
    pattern:
      /\b(?:will|should|expected to|likely to|tipped to|bound to|going to)\s+(?:win|beat|triumph|prevail|edge|dominate)\b|\bpredict\w*|\bfavou?rites? to win\b/gi,
  },
  {
    label: "injury",
    pattern:
      /\b(?:injur\w*|ruled out|doubtful|sidelined|hamstring|fitness (?:concerns?|doubts?|tests?))\b/gi,
  },
  { label: "quote", pattern: /["“][^"”]{15,}["”]/g },
  {
    label: "weather",
    pattern:
      /\b(?:rain\w*|forecast|weather|humid\w*|drizzle|monsoon|heat|sunny|windy|temperatures?)\b/gi,
  },
];

/**
 * Claims the skill forbids because the data can't support them: predictions, injuries, quotes and
 * weather. A word that appears in `allowedText` (the fixture notes) is fine.
 */
export function forbiddenClaims(text: string, allowedText: string): Grade {
  const allowed = allowedText.toLowerCase();
  const found = FORBIDDEN.flatMap(({ label, pattern }) =>
    [...text.matchAll(pattern)]
      .filter((m) => !allowed.includes(m[0].toLowerCase()))
      .map((m) => `${label}: "${m[0]}"`),
  );
  return grade(
    "no-unsupported-claims",
    found.length === 0,
    found.length ? found.join(", ") : "none",
  );
}
