/**
 * What a hook's output gives, read by code from the output a run with the transform applied really
 * produced (never the model's reading of it). Two kinds of reading:
 *
 * - facts the answer must agree with, refused at `final` when it does not (`fitIssues`,
 *   `filterIssues`, `orderIssues`): a path the answer names that holds nothing, a path that holds no
 *   value of the kind the design draws, an option of the page's choice no item holds, a field the
 *   answer must name and does not;
 * - evidence for the model to judge (`fieldEvidence`, `orderEvidence`, `countEvidence`, in
 *   `hook.evidence`): the values beside the design's example, the dates in output order, how many
 *   items each list holds. Code says what it sees; whether that is the design's form, order or
 *   count is the model's call.
 */
import { dateKey, pageValueOf } from "./dsl.ts";

export type FieldKind = "date" | "time" | "score" | "number" | "image" | "link" | "text";

export interface NeedItem {
  field: string;
  required: boolean;
  kind?: FieldKind | undefined;
  /** The design's placeholder, as drawn. */
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
    case "link":
      // the item's own page: a URL or a path on the club's site, or the slug or id a route.* house
      // fact builds one from
      return /^(https?:)?\/\//i.test(text) || text.startsWith("/") || /^[\w.-]+$/.test(text);
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

/** A label as compared: case, punctuation and spacing aside. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Whether a label names a field as the need writes it: the same words, case and punctuation aside. */
export const namesField = (label: string, field: string) =>
  norm(field) !== "" && norm(label) === norm(field);

/** Whether a line of `missing` is about a field: it starts with the field as the need writes it. */
const missingSays = (line: string, field: string) => {
  const a = norm(line);
  const b = norm(field);
  return b !== "" && (a === b || a.startsWith(`${b} `));
};

/** `team crest → matches[].teams[0].logo (a URL)` as its two halves. */
export function parseCover(line: string): { label: string; path: string } | undefined {
  const [label, rest] = line.split(/\s*(?:→|->)\s*/, 2);
  const path = rest?.trim().split(/\s+/)[0];
  return label && path ? { label: label.trim(), path } : undefined;
}

/** The value a page compares for a choice (`pageValueOf` in `@fanos/dsl`): the one rule. */
const choiceKey = (value: unknown) => pageValueOf(value);

const filterCover = (covers: string[]) =>
  covers.map(parseCover).find((c) => c && /^filter\s*by$/i.test(c.label));

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
  const cover = filterCover(covers);
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

/** How many items hold each option of the choice, as the page compares them. */
export function filterEvidence(
  filterBy: { key: string; options: string[] } | undefined,
  covers: string[],
  output: unknown,
): { key: string; path?: string; options: Array<{ option: string; items: number }> } | undefined {
  if (!filterBy) return undefined;
  const cover = filterCover(covers);
  const held = cover
    ? valuesAt(output, cover.path)
        .filter((v) => !empty(v))
        .map(choiceKey)
    : [];
  return {
    key: filterBy.key,
    ...(cover ? { path: cover.path } : {}),
    options: filterBy.options.map((option) => ({
      option,
      items: held.filter((h) => h === choiceKey(option)).length,
    })),
  };
}

export type Order = "soonest-first" | "newest-first" | "upcoming-then-latest" | "as-is";

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

const orderCover = (covers: string[]) =>
  covers.map(parseCover).find((c) => c && /^order$/i.test(c.label));

/**
 * The need has an order and the items carry a date: the answer names the field they are ordered by
 * in covers as `order → <path>`, so the dates can be read. Whether they are in the need's order is
 * the model's judgement, from `orderEvidence`.
 */
export function orderIssues(order: Order | undefined, covers: string[], output: unknown): string[] {
  if (!order || order === "as-is" || orderCover(covers)) return [];
  return carriesDate(output)
    ? [
        `the need asks for ${order}: say the date field the items are ordered by in covers as "order → <path>"`,
      ]
    : [];
}

/**
 * The dates of the items as they come, by the option each belongs to when the answer names a
 * `filterBy` field on the same items (or on a list that holds them): the page shows one option at
 * a time. One group, unnamed, otherwise. Each value as the output writes it.
 */
function datesByOption(
  output: unknown,
  orderPath: string,
  filterPath: string | undefined,
): Array<{ option?: string; dates: unknown[] }> {
  const at = filterPath?.lastIndexOf("[]") ?? -1;
  const list = filterPath && at >= 0 ? filterPath.slice(0, at + 2) : undefined;
  if (!filterPath || !list || !orderPath.startsWith(list)) {
    return [{ dates: valuesAt(output, orderPath) }];
  }
  const field = filterPath.slice(list.length).replace(/^\./, "");
  const rest = orderPath.slice(list.length).replace(/^\./, "");
  const groups = new Map<string, unknown[]>();
  for (const item of valuesAt(output, list)) {
    const option = valuesAt(item, field).find((v) => !empty(v));
    const key = option === undefined ? "" : choiceKey(option);
    groups.set(key, [...(groups.get(key) ?? []), ...(rest ? valuesAt(item, rest) : [item])]);
  }
  return [...groups].map(([option, dates]) => ({ ...(option ? { option } : {}), dates }));
}

/** How many values a report shows of a list, the rest counted. */
const SHOWN = 12;

export interface OrderEvidence {
  order: Order;
  /** The time the run is judged at. */
  now: string;
  path: string;
  groups: Array<{
    option?: string;
    /** The dates as the output writes them, in output order (the first few). */
    dates: unknown[];
    /** How many values the path holds; `unread` of them do not read as a date. */
    count: number;
    unread: number;
    /** How the readable dates run, in output order. */
    runs: "rising" | "falling" | "both ways" | "one date";
    before: number;
    after: number;
  }>;
}

/**
 * The dates the answer's `order →` path holds, in output order, beside the need's order and the
 * time now: how they run and how many are before and after now. It judges nothing.
 */
export function orderEvidence(
  order: Order | undefined,
  covers: string[],
  output: unknown,
  now: number = Date.now(),
): OrderEvidence | { order: Order; note: string } | undefined {
  if (!order || order === "as-is") return undefined;
  const cover = orderCover(covers);
  if (!cover) {
    return {
      order,
      note: carriesDate(output)
        ? 'name the date field the items are ordered by as "order → <path>" in covers to see its dates in output order'
        : "the output carries no value that reads as a date",
    };
  }
  const nowKey = dateKey(now) ?? "";
  return {
    order,
    now: new Date(now).toISOString(),
    path: cover.path,
    groups: datesByOption(output, cover.path, filterCover(covers)?.path).map(
      ({ option, dates }) => {
        const keys = dates.map(dateKey).filter((k): k is string => k !== undefined);
        const rising = keys.every((t, i) => i === 0 || (keys[i - 1] ?? t) <= t);
        const falling = keys.every((t, i) => i === 0 || (keys[i - 1] ?? t) >= t);
        return {
          ...(option ? { option } : {}),
          dates: dates.slice(0, SHOWN),
          count: dates.length,
          unread: dates.length - keys.length,
          runs:
            keys.length < 2 || (rising && falling)
              ? ("one date" as const)
              : rising
                ? ("rising" as const)
                : falling
                  ? ("falling" as const)
                  : ("both ways" as const),
          before: keys.filter((k) => k < nowKey).length,
          after: keys.filter((k) => k >= nowKey).length,
        };
      },
    ),
  };
}

/** What is wrong with an answer, as facts the model can act on. Empty when it agrees with the output. */
export function fitIssues(
  items: NeedItem[],
  answer: { covers: string[]; missing: string[] },
  output: unknown,
): string[] {
  const issues: string[] = [];
  const covers = answer.covers.map(parseCover);
  for (const item of items.filter((i) => i.required)) {
    const said =
      covers.some((c) => c && namesField(c.label, item.field)) ||
      answer.missing.some((m) => missingSays(m, item.field));
    if (!said) {
      issues.push(
        `"${item.field}" is required by the need and is in neither covers nor missing: name it as the need writes it, in covers ("${item.field} → <path>") or at the start of a line of missing ("${item.field}: why")`,
      );
    }
  }
  for (const cover of covers) {
    if (!cover) continue;
    const filled = valuesAt(output, cover.path).filter((v) => !empty(v));
    if (filled.length === 0) {
      issues.push(
        `covers "${cover.label}" at ${cover.path}, but the output has nothing there for any item: it is missing, not covered (or the path is wrong: it is from the root of the output)`,
      );
      continue;
    }
    const kind = items.find((i) => namesField(cover.label, i.field))?.kind;
    if (kind && filled.every((v) => !isKind(kind, v))) {
      issues.push(
        `"${cover.label}" at ${cover.path} holds no ${kind} (the need's kind for it): its values are ${filled
          .slice(0, 3)
          .map((v) => JSON.stringify(v))
          .join(", ")}`,
      );
    }
  }
  return issues;
}

export interface FieldEvidence {
  /** The covers line, as the answer wrote it. */
  cover: string;
  path: string;
  /** The need's field the label names (as the need writes it), or null when it names none. */
  field: string | null;
  /** The design's placeholder for it, when the need has one. */
  example?: string;
  kind?: FieldKind;
  /** How many values the path reaches, and how many of them hold something. */
  reached: number;
  filled: number;
  /** A few distinct values, as the output holds them. */
  values: unknown[];
  /** How many filled values do not read as the need's kind, with one of them. */
  notKind?: { count: number; sample: unknown };
}

/**
 * For each covers line, what its path holds in the output, beside the design's example and kind
 * for the need's field it names: a few real values, how many items have one. Whether the values
 * are in the design's form is the model's call.
 */
export function fieldEvidence(
  items: NeedItem[],
  covers: string[],
  output: unknown,
): FieldEvidence[] {
  return covers.flatMap((line) => {
    const cover = parseCover(line);
    if (!cover) return [];
    const item = items.find((i) => namesField(cover.label, i.field));
    const reached = valuesAt(output, cover.path);
    const filled = reached.filter((v) => !empty(v));
    const distinct = [...new Map(filled.map((v) => [JSON.stringify(v), v])).values()];
    const off = item?.kind ? filled.filter((v) => !isKind(item.kind as FieldKind, v)) : [];
    return [
      {
        cover: line,
        path: cover.path,
        field: item?.field ?? null,
        ...(item?.example ? { example: item.example } : {}),
        ...(item?.kind ? { kind: item.kind } : {}),
        reached: reached.length,
        filled: filled.length,
        values: distinct.slice(0, 5),
        ...(off.length ? { notKind: { count: off.length, sample: off[0] } } : {}),
      },
    ];
  });
}

/**
 * The lists the answer's paths go through and how many items each holds (`days[]` 3,
 * `days[].matches[]` 7), beside the count the design draws.
 */
export function countEvidence(
  count: number | "data" | undefined,
  covers: string[],
  output: unknown,
): { count?: number | "data"; lists: Array<{ list: string; items: number }> } {
  const lists = new Map<string, number>();
  for (const line of covers) {
    const path = parseCover(line)?.path;
    if (!path) continue;
    for (let at = path.indexOf("[]"); at >= 0; at = path.indexOf("[]", at + 2)) {
      const list = path.slice(0, at + 2);
      if (!lists.has(list)) lists.set(list, valuesAt(output, list).length);
    }
  }
  return {
    ...(count !== undefined ? { count } : {}),
    lists: [...lists].map(([list, items]) => ({ list, items })),
  };
}
