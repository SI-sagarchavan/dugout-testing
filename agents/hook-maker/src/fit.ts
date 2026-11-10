/**
 * Whether a hook's output gives what the answer says it does, checked by code against the output a
 * run with the transform applied really produced (never the model's reading of it). The model
 * judges meaning (is `teams[0].score` the runs?); code judges what it can: every required item is
 * accounted for, each path the answer names has something in it, and what is there is of the kind
 * the design draws (a picture is a URL, a score has figures, a date reads as a date).
 */
import { dateKey, pageValueOf } from "./dsl.ts";
import { formOf, hasForm } from "./form.ts";

export type FieldKind = "date" | "time" | "score" | "number" | "image" | "text";

export interface NeedItem {
  field: string;
  required: boolean;
  kind?: FieldKind | undefined;
  /** The design's placeholder: a number with its unit, a score, a count. */
  example?: string | undefined;
}

const empty = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * The values at a path from the root of the output: `days[].matches[].teams[0].logo`, or the same
 * with dots (`teams.0.logo`). `[]` goes through each item of a list, a name through each item of
 * a list it meets. Values the path does not reach are left out.
 */
export function valuesAt(output: unknown, path: string): unknown[] {
  let level: unknown[] = [output];
  for (const [, name, index] of path.matchAll(/([^.[\]]+)|\[(\d*)\]/g)) {
    if (name !== undefined) {
      level = level.flatMap((v) =>
        Array.isArray(v)
          ? /^\d+$/.test(name)
            ? [v[Number(name)]]
            : v.map((i) =>
                i && typeof i === "object" ? (i as Record<string, unknown>)[name] : undefined,
              )
          : v && typeof v === "object"
            ? [(v as Record<string, unknown>)[name]]
            : [],
      );
    } else if (index === "") {
      level = level.flatMap((v) => (Array.isArray(v) ? v : []));
    } else {
      level = level.map((v) => (Array.isArray(v) ? v[Number(index)] : undefined));
    }
  }
  return level.filter((v) => v !== undefined);
}

/** True when a value is of the kind the design draws there. */
export function isKind(kind: FieldKind, value: unknown): boolean {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? String(value)
        : undefined;
  if (text === undefined) return false;
  switch (kind) {
    case "image":
      return (
        /^(https?:)?\/\//i.test(text) ||
        text.startsWith("/") ||
        /\.(png|jpe?g|svg|webp|gif|avif)(\?|$)/i.test(text)
      );
    case "date":
      return !Number.isNaN(Date.parse(text)) || /\d/.test(text);
    case "time":
      return /\d{1,2}:\d{2}/.test(text);
    case "score":
      return /\d/.test(text);
    case "number":
      return /^[+-]?\d+([.,]\d+)?%?$/.test(text);
    default:
      return true;
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const mentions = (text: string, field: string) => {
  const a = norm(text);
  const b = norm(field);
  return b !== "" && (a.includes(b) || b.includes(a));
};

/** `team crest → matches[].teams[0].logo (a URL)` as its two halves. */
export function parseCover(line: string): { label: string; path: string } | undefined {
  const [label, rest] = line.split(/\s*(?:→|->)\s*/, 2);
  const path = rest?.trim().split(/\s+/)[0];
  return label && path ? { label: label.trim(), path } : undefined;
}

/** The value a page compares for a choice (`pageValueOf` in `@fanos/dsl`): the one rule. */
const choiceKey = (value: unknown) => pageValueOf(value);

/**
 * A need whose list a page choice filters (`filterBy`): the answer names the item field in
 * `covers` as `filterBy → <path>`, and that field holds each option, so choosing one draws items.
 */
export function filterIssues(
  filterBy: { key: string; options: string[] } | undefined,
  covers: string[],
  output: unknown,
): string[] {
  if (!filterBy) return [];
  const cover = covers.map(parseCover).find((c) => c && /^filter\s*by$/i.test(c.label));
  if (!cover) {
    return [
      `the need is filtered by the page choice "${filterBy.key}" (${filterBy.options.join(", ")}): give one list whose items carry the option they belong to, and say the field in covers as "filterBy → <path>"`,
    ];
  }
  const held = valuesAt(output, cover.path)
    .filter((v) => !empty(v))
    .map(choiceKey);
  if (held.length === 0) {
    return [`filterBy → ${cover.path} holds nothing in the output: the items carry no option`];
  }
  const none = filterBy.options.filter((o) => !held.includes(choiceKey(o)));
  return none.length
    ? [
        `filterBy → ${cover.path} never holds ${none.map((o) => `"${o}"`).join(", ")} (it holds ${[...new Set(held)].slice(0, 5).join(", ")}): choosing ${none.length > 1 ? "them" : "it"} would draw nothing. Write the field in the options' words`,
      ]
    : [];
}

export type Order = "soonest-first" | "newest-first" | "upcoming-then-latest" | "as-is";

/**
 * How long before now an item may have started and still be under way: soonest first may begin
 * with it (a live match, an event in progress). A day, for any kind of list.
 */
const UNDER_WAY_MS = 24 * 60 * 60 * 1000;

/** Whether the output holds a value that reads as a date: a list of dated items. */
function carriesDate(output: unknown): boolean {
  let seen = 0;
  const dated = (v: unknown): boolean => {
    if (seen++ > 5_000) return false;
    if (typeof v === "string") {
      const t = v.trim();
      return (
        (/^\d{4}-\d{2}-\d{2}/.test(t) ||
          /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(t) ||
          /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(
            t,
          ) ||
          /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i.test(t)) &&
        dateKey(t) !== undefined
      );
    }
    if (Array.isArray(v)) return v.some(dated);
    if (v && typeof v === "object") return Object.values(v).some(dated);
    return false;
  };
  return dated(output);
}

/**
 * The date keys of the items, by the option each belongs to when the answer names a `filterBy`
 * field on the same items (or on a list that holds them): each option's items are ordered on their
 * own, since the page shows one option at a time. One group, unnamed, otherwise.
 */
function datesByOption(
  output: unknown,
  orderPath: string,
  filterPath: string | undefined,
): Array<{ option?: string; keys: string[] }> {
  const keysOf = (values: unknown[]) =>
    values.map(dateKey).filter((k): k is string => k !== undefined);
  const at = filterPath?.lastIndexOf("[]") ?? -1;
  const list = filterPath && at >= 0 ? filterPath.slice(0, at + 2) : undefined;
  if (!filterPath || !list || !orderPath.startsWith(list)) {
    return [{ keys: keysOf(valuesAt(output, orderPath)) }];
  }
  const field = filterPath.slice(list.length).replace(/^\./, "");
  const rest = orderPath.slice(list.length).replace(/^\./, "");
  const groups = new Map<string, string[]>();
  for (const item of valuesAt(output, list)) {
    const option = valuesAt(item, field).find((v) => !empty(v));
    const key = option === undefined ? "" : choiceKey(option);
    groups.set(key, [...(groups.get(key) ?? []), ...keysOf(rest ? valuesAt(item, rest) : [item])]);
  }
  return [...groups].map(([option, keys]) => ({ ...(option ? { option } : {}), keys }));
}

/** What is out of order in one option's dates, or undefined. `now` and `started` are date keys. */
function outOfOrder(
  order: Exclude<Order, "as-is">,
  keys: string[],
  now: string,
  started: string,
): string | undefined {
  if (keys.length < 2) return undefined;
  const ascending = (list: string[]) => list.every((t, i) => i === 0 || (list[i - 1] ?? t) <= t);
  const descending = (list: string[]) => list.every((t, i) => i === 0 || (list[i - 1] ?? t) >= t);
  if (order === "soonest-first") {
    if (!ascending(keys)) return "is not soonest first: the dates go back and forth";
    // an item that started within the day may be under way: it comes first
    return (keys[0] ?? now) < started && keys.some((t) => t >= now)
      ? "starts with a past date while later items are still to come: soonest first starts at the next one (or one under way)"
      : undefined;
  }
  if (order === "newest-first") {
    return descending(keys)
      ? undefined
      : "is not newest first: the dates are not from latest to earliest";
  }
  // what is next (and what is under way) first, soonest first, then the latest results back
  let split = 0;
  while (
    split < keys.length &&
    (keys[split] ?? "") >= started &&
    (split === 0 || (keys[split - 1] ?? "") <= (keys[split] ?? ""))
  ) {
    split++;
  }
  const past = keys.slice(split);
  return past.every((t) => t < now) && descending(past)
    ? undefined
    : "is not upcoming then latest: what is next comes first (soonest first), then results from the latest back";
}

/** What `missing` says when the feed has nothing to come: its words name upcoming items. */
const NOTHING_TO_COME = /\b(upcoming|future|to come|scheduled|next|fixtures?)\b/i;

/**
 * A list that wants what is next (soonest first, or upcoming then latest) and holds only past
 * items: the cut was made before the sort, or a filter dropped what is to come. Fine only when the
 * feed has nothing to come, and the answer says so in `missing`.
 */
function onlyPast(
  order: Exclude<Order, "as-is">,
  keys: string[],
  started: string,
  missing: string[],
): string | undefined {
  if (order === "newest-first" || keys.length === 0) return undefined;
  if (keys.some((t) => t >= started)) return undefined;
  if (missing.some((m) => NOTHING_TO_COME.test(m))) return undefined;
  return "holds only past items, and the need wants what is next: the cut to the count may come before the sort, or a filter dropped the items still to come. Look at the feed for upcoming items (its sort or upcoming input, or the whole list before the cut); when it has none, say so in missing";
}

/**
 * Whether the dates of the items come in the order the need asks for, read from the output the
 * hook's run gave, the way the page reads dates. The answer names the date field in covers as
 * `order → <path>`; an output whose items carry no date has no order to check. With a
 * `filterBy → <path>` cover on the same items, each option's items are checked on their own. `now`
 * is the time the run is judged at (epoch ms), for what is upcoming and what is past.
 */
export function orderIssues(
  order: Order | undefined,
  covers: string[],
  output: unknown,
  now: number = Date.now(),
  missing: string[] = [],
): string[] {
  if (!order || order === "as-is") return [];
  const parsed = covers.map(parseCover);
  const cover = parsed.find((c) => c && /^order$/i.test(c.label));
  if (!cover) {
    return carriesDate(output)
      ? [
          `the need asks for ${order}: say the date field the items are ordered by in covers as "order → <path>"`,
        ]
      : [];
  }
  const filter = parsed.find((c) => c && /^filter\s*by$/i.test(c.label));
  const nowKey = dateKey(now) ?? "";
  const startedKey = dateKey(now - UNDER_WAY_MS) ?? nowKey;
  return datesByOption(output, cover.path, filter?.path).flatMap(({ option, keys }) => {
    const wrong =
      outOfOrder(order, keys, nowKey, startedKey) ?? onlyPast(order, keys, startedKey, missing);
    return wrong
      ? [`order → ${cover.path}${option ? ` (the items of the option "${option}")` : ""} ${wrong}`]
      : [];
  });
}

/** Whether a figure is a decimal ("19.3", "20,5") rather than a whole number ("100", "1,234"). */
const decimal = (text: string) => /\d[.,]\d/.test(text.replace(/\d{1,3}(?:,\d{3})+(?!\d)/g, "9"));

/** Whether `part` is in `form` as whole tokens: "9" in "(9 ball)", not "9" in "9#" (an ordinal). */
function holdsPart(form: string, part: string): boolean {
  const edge = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}#]/u.test(c);
  for (let i = form.indexOf(part); i >= 0; i = form.indexOf(part, i + 1)) {
    if (edge(form[i - 1]) && edge(form[i + part.length])) return true;
  }
  return false;
}

/**
 * Whether a value has the design's form, or fills a part of it: the whole form ("(98 Balls)" for
 * "(100 Balls)"), or a part of it with a number in it ("98" for "(100 Balls)", "166" for "166/5").
 * A decimal where every figure of the example is whole is another unit ("19.3" overs for balls).
 */
export function fillsForm(value: string, example: string): boolean {
  const have = formOf(value);
  const want = formOf(example);
  if (have === want) return true;
  if (!have.includes("9") || !holdsPart(want, have)) return false;
  const figures = example.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return !decimal(value) || figures.some(decimal);
}

/** What is wrong with an answer, in words the model can act on. Empty when it fits. */
export function fitIssues(
  items: NeedItem[],
  answer: { covers: string[]; missing: string[] },
  output: unknown,
): string[] {
  const issues: string[] = [];
  const covers = answer.covers.map(parseCover);
  for (const item of items.filter((i) => i.required)) {
    const said =
      answer.covers.some((c) => mentions(c.split(/→|->/)[0] ?? c, item.field)) ||
      answer.missing.some((m) => mentions(m, item.field));
    if (!said) {
      issues.push(
        `"${item.field}" is required by the need and is in neither covers nor missing: say which`,
      );
    }
  }
  for (const cover of covers) {
    if (!cover) continue;
    const found = valuesAt(output, cover.path);
    const filled = found.filter((v) => !empty(v));
    if (filled.length === 0) {
      issues.push(
        `covers "${cover.label}" at ${cover.path}, but the output has nothing there for any item: it is missing, not covered (or the path is wrong: it is from the root of the output)`,
      );
      continue;
    }
    const named = items.find((i) => mentions(cover.label, i.field));
    // a value the page writes with a pipe (a date, a time) stays the instant; any other short
    // figure the design writes is given in the design's form, or as the part of it the field fills
    // (the number of "(100 Balls)", the runs of "166/5"): the page writes the words around it
    if (
      named?.example &&
      hasForm(named.example) &&
      named.kind !== "date" &&
      named.kind !== "time"
    ) {
      const example = named.example;
      const off = filled.filter(
        (v) => (typeof v === "string" || typeof v === "number") && !fillsForm(String(v), example),
      );
      if (off.length * 2 >= filled.length) {
        issues.push(
          `"${cover.label}" at ${cover.path} holds ${JSON.stringify(off[0])} where the design writes "${example}": derive what the design shows in the transform (a unit converted, a field split or joined, a code written as the word), give the value or the number it fills (the page writes the words around it), and check it against the example with cast_eval_jsonata`,
        );
      }
    }
    const item = named?.kind ? named : undefined;
    if (item?.kind) {
      const off = filled.filter((v) => !isKind(item.kind as FieldKind, v));
      if (off.length * 2 >= filled.length) {
        issues.push(
          `"${cover.label}" at ${cover.path} should read as a ${item.kind} (the design draws ${item.field}), but it holds ${JSON.stringify(off[0])}`,
        );
      }
    }
  }
  return issues;
}
