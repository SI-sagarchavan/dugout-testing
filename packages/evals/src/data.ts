/**
 * Graders for the data side of a Handoff (`.scratch/data-sources/issues/06`): did a section get
 * its own data, in the design's format, with every part of it drawn. Code only, over a plain
 * outcome that a run is reduced to, so the same graders run on a live run and on a recorded one.
 */
import type { Grade } from "./graders.ts";

/** What a slot or frame ended as: the design's data, another team's shown for the shape, or none. */
export type DataEnding = "bound" | "stand-in" | "none";

/** One bound text of the page: the design's placeholder, and what each item draws there. */
export interface ShownText {
  node: string;
  placeholder: string;
  shown: string[];
}

/** A run of `data-bind`, reduced to what is graded. */
export interface DataOutcome {
  /** How the run ended; `completed` is the only good ending. */
  status: "completed" | "failed" | "waiting";
  /** What it says the slot ended as (data-bind's `data`); absent when the run did not complete. */
  ending?: DataEnding | undefined;
  /** The hook that gave the data, if one did. */
  hookId?: string | null | undefined;
  /** That hook's live output (cached between runs). */
  hookOutput?: unknown;
  /** Every text bound, against its placeholder. */
  shown: ShownText[];
  /** The last path segment of every path the plan binds: `matches.0.venue` is `venue`. */
  boundFields: string[];
  /** bind.try's problems that were left in the published plan. */
  problems: string[];
  /** Every state or kind of item the design draws that some item drew. */
  variantsDrawn: string[];
  /** Each dated list the plan draws: when each item is (epoch ms, dates as the page reads them), in the list's order. */
  dated?: Array<{ list: string; times: number[] }>;
  /** The time the run was judged at (epoch ms), so a recorded outcome is graded as it was. */
  at?: number;
  steps: number;
  costUsd: number;
}

/** What a case expects, confirmed by a person before it gates. */
export interface DataExpect {
  ending: DataEnding;
  /** The expected hook, or a JSON Schema its output passes (what `cast_validate` would check). */
  hook?: { id?: string; schema?: Record<string, unknown> };
  /** What the data has to be about. */
  must?: { team?: string; competition?: string };
  /** The fields the need cannot do without: each is bound to something. */
  required?: string[];
  /** The variants the design draws (result, upcoming, live): each is drawn by some item. */
  variants?: string[];
  /** The order the design's dated lists come in; every dated list the plan draws is graded against it. */
  order?: DataOrder;
}

/** The orders a design can mean (data-bind's `Need.order`, without `as-is`). */
export type DataOrder = "soonest-first" | "newest-first" | "upcoming-then-latest";

/** An item that started less than this long ago may still be on: soonest first may start with it. */
const STILL_ON_MS = 24 * 60 * 60 * 1000;

const grade = (grader: string, pass: boolean, detail: string): Grade => ({ grader, pass, detail });

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** True when `text` holds `must` as the design writes it: its words in a row, or all of them. */
export function holdsText(text: string, must: string): boolean {
  const have = words(text);
  const want = words(must);
  if (!want) return false;
  if (have.includes(want)) return true;
  const tokens = want.split(" ").filter((t) => t.length >= 4);
  return tokens.length > 0 && tokens.every((t) => have.includes(t));
}

const MONTHS = new Set(
  "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec".split(
    " ",
  ),
);
const WEEKDAYS = new Set(
  "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun".split(
    " ",
  ),
);

/**
 * The form of a text: digits are `9`, a month `month`, a weekday `day`, any other word itself in
 * lower case, with `^` for all capitals and `~` for a capital first. "21 JULY" is `9 month^`,
 * "(100 Balls)" `(9 balls~)`. (The same reading as `formOf` in `agents/hook-maker/src/form.ts`,
 * which this package cannot import.)
 */
export function formOf(text: string): string {
  return text
    .trim()
    .replace(/\d+(?:[.,]\d+)?/g, "9")
    .replace(/\p{L}+/gu, (word) => {
      const lower = word.toLowerCase();
      const name = MONTHS.has(lower) ? "month" : WEEKDAYS.has(lower) ? "day" : lower;
      const shout = word.length > 1 && word === word.toUpperCase();
      const title =
        !shout && word[0] === word[0]?.toUpperCase() && word[0] !== word[0]?.toLowerCase();
      return `${name}${shout ? "^" : title ? "~" : ""}`;
    })
    .replace(/\s+/g, " ");
}

/** A minimal JSON Schema check: type, properties, required, items, enum. Enough for a hook's output. */
export function schemaIssues(value: unknown, schema: Record<string, unknown>, at = "$"): string[] {
  const issues: string[] = [];
  const type = schema.type as string | undefined;
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (type && !(type === kind || (type === "integer" && Number.isInteger(value)))) {
    return [`${at}: expected ${type}, got ${kind}`];
  }
  const allowed = schema.enum as unknown[] | undefined;
  if (allowed && !allowed.includes(value)) issues.push(`${at}: not one of ${allowed.join(", ")}`);
  if (kind === "object") {
    const object = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (object[key] === undefined) issues.push(`${at}.${key}: missing`);
    }
    for (const [key, sub] of Object.entries(
      (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {},
    )) {
      if (object[key] !== undefined) issues.push(...schemaIssues(object[key], sub, `${at}.${key}`));
    }
  }
  if (kind === "array" && schema.items) {
    (value as unknown[]).slice(0, 20).forEach((item, i) => {
      issues.push(...schemaIssues(item, schema.items as Record<string, unknown>, `${at}[${i}]`));
    });
  }
  return issues;
}

/** The hook is the expected one, or its output passes the case's schema. */
export function dataHook(expect: DataExpect["hook"], outcome: DataOutcome): Grade {
  if (!expect) return grade("hook", true, "no hook expected");
  if (expect.id && outcome.hookId === expect.id) return grade("hook", true, expect.id);
  if (expect.schema && outcome.hookOutput !== undefined) {
    const issues = schemaIssues(outcome.hookOutput, expect.schema);
    return grade("hook", issues.length === 0, issues.slice(0, 3).join("; ") || "output fits");
  }
  return grade(
    "hook",
    false,
    `${outcome.hookId ?? "no hook"}${expect.id ? `, wanted ${expect.id}` : ", and no output to check against the schema"}`,
  );
}

/** The data is about the design's team and competition: some bound text holds each. */
export function dataEntity(must: DataExpect["must"], outcome: DataOutcome): Grade {
  const wants = Object.entries(must ?? {}).filter(([, v]) => v);
  if (wants.length === 0) return grade("right-entity", true, "the design names none");
  const text = [
    ...outcome.shown.flatMap((s) => s.shown),
    ...(outcome.hookOutput === undefined ? [] : [JSON.stringify(outcome.hookOutput)]),
  ].join(" \n ");
  const lacking = wants.filter(([, value]) => !holdsText(text, String(value)));
  return grade(
    "right-entity",
    lacking.length === 0,
    lacking.length === 0
      ? wants.map(([k, v]) => `${k} ${v}`).join(", ")
      : `the data never names ${lacking.map(([k, v]) => `${k} ${v}`).join(", ")}`,
  );
}

/** Every required field is bound to something in the published plan. */
export function dataCoverage(required: string[] | undefined, outcome: DataOutcome): Grade {
  const bound = new Set(outcome.boundFields);
  const lacking = (required ?? []).filter((f) => !bound.has(f));
  const reads = outcome.problems.filter((p) => /reads nothing|nothing behind/i.test(p));
  return grade(
    "coverage",
    lacking.length === 0 && reads.length === 0,
    lacking.length || reads.length
      ? [lacking.length ? `not bound: ${lacking.join(", ")}` : "", ...reads.slice(0, 2)]
          .filter(Boolean)
          .join("; ")
      : `${(required ?? []).length} required fields bound`,
  );
}

/**
 * A placeholder whose form is the design's to keep: short and holding a number ("21 JULY",
 * "19:30", "166/5", "(100 Balls)"). A name, a label or a sentence is whatever the data says.
 */
export const hasForm = (placeholder: string) => placeholder.length <= 16 && /\d/.test(placeholder);

/** Each bound text has the form of the design's placeholder ("21 JULY", "19:30", "166/5"). */
export function dataFormat(outcome: DataOutcome): Grade {
  const off = outcome.shown
    .filter((s) => hasForm(s.placeholder))
    .flatMap((s) =>
      s.shown
        .filter((value) => formOf(value) !== formOf(s.placeholder))
        .slice(0, 1)
        .map((value) => `${s.node}: "${value}" where the design writes "${s.placeholder}"`),
    );
  return grade("format", off.length === 0, off.slice(0, 3).join("; ") || "every text in form");
}

/** Every variant the design draws is drawn by some item. */
export function dataVariants(expected: string[] | undefined, outcome: DataOutcome): Grade {
  const lacking = (expected ?? []).filter((v) => !outcome.variantsDrawn.includes(v));
  return grade(
    "variants",
    lacking.length === 0,
    lacking.length ? `never drawn: ${lacking.join(", ")}` : `${(expected ?? []).length} drawn`,
  );
}

/**
 * Each dated list is in the order the design means, and one that wants what is next does not hold
 * only past items. A list of fewer than two dated items has no order to grade.
 */
export function dataOrder(expected: DataOrder | undefined, outcome: DataOutcome): Grade {
  if (!expected) return grade("order", true, "the design asks for no order");
  const now = outcome.at ?? Date.now();
  const started = now - STILL_ON_MS;
  const faults = (outcome.dated ?? []).flatMap(({ list, times }) => {
    if (times.length < 2) return [];
    const up = times.every((t, i) => i === 0 || (times[i - 1] ?? t) <= t);
    const down = times.every((t, i) => i === 0 || (times[i - 1] ?? t) >= t);
    const nothingComing = expected !== "newest-first" && times.every((t) => t < started);
    if (expected === "soonest-first") {
      if (!up) return [`${list}: not soonest first`];
      if ((times[0] ?? now) < started && times.some((t) => t >= now)) {
        return [`${list}: starts with past items while later ones are still to come`];
      }
    } else if (expected === "newest-first") {
      if (!down) return [`${list}: not newest first`];
    } else {
      const split = times.findIndex((t) => t < now);
      const coming = split === -1 ? times : times.slice(0, split);
      const past = split === -1 ? [] : times.slice(split);
      const ordered =
        coming.every((t, i) => i === 0 || (coming[i - 1] ?? t) <= t) &&
        past.every((t, i) => i === 0 || (past[i - 1] ?? t) >= t);
      if (!ordered) return [`${list}: not what is next, then the latest results`];
    }
    return nothingComing ? [`${list}: only past items, where the design wants what is next`] : [];
  });
  const graded = (outcome.dated ?? []).filter((d) => d.times.length >= 2).length;
  return grade(
    "order",
    faults.length === 0,
    faults.slice(0, 3).join("; ") || `${graded} dated list(s) ${expected}`,
  );
}

/** The slot ended as the case expects, and the run did not fail. */
export function dataEnding(expected: DataEnding, outcome: DataOutcome): Grade[] {
  return [
    grade("no-failed-run", outcome.status === "completed", `the run ${outcome.status}`),
    grade(
      "ending",
      outcome.ending === expected,
      `${outcome.ending ?? "none given"}, wanted ${expected}`,
    ),
  ];
}

/**
 * Nothing the page shows broken was published: bind.try's problems left in the published plan (a
 * picture that loads nothing, a ref with nothing behind it), which `despite` let through. What a
 * keep accepted is not here: a person would agree it stays.
 */
export function dataNothingBroken(outcome: DataOutcome): Grade {
  const left = outcome.problems;
  return grade(
    "nothing-broken",
    left.length === 0,
    left.length === 0
      ? "no problem left in the published plan"
      : `published with ${left.length} problem(s) left: ${left.slice(0, 3).join(" | ")}`,
  );
}

/** All the graders a case asks for. Cost and steps are reported, never graded. */
export function gradeData(expect: DataExpect, outcome: DataOutcome): Grade[] {
  const bound = outcome.status === "completed" && expect.ending !== "none";
  return [
    ...dataEnding(expect.ending, outcome),
    ...(bound
      ? [
          dataHook(expect.hook, outcome),
          // a stand-in is about another team by definition: it is graded on its ending alone
          ...(expect.ending === "bound" ? [dataEntity(expect.must, outcome)] : []),
          dataCoverage(expect.required, outcome),
          dataNothingBroken(outcome),
          dataFormat(outcome),
          dataVariants(expect.variants, outcome),
          dataOrder(expect.order, outcome),
        ]
      : []),
    grade(
      "cost-and-steps",
      true,
      `${outcome.steps} steps, $${outcome.costUsd.toFixed(3)} (reported, not graded)`,
    ),
  ];
}
