/**
 * Data binding — how a tree reads data, and the only module that knows how.
 *
 * A bound prop is a TEMPLATE: literal text with `{ref}` holes.
 *
 *   ref   := "{" path ( "|" pipe )* "}"
 *   path  := name ( "." ( name | index ) )*        news.items.0.title
 *   pipe  := name ( ":" arg )*                     date:"MMM DD, YYYY"
 *   arg   := '"' text '"' | bare word
 *
 * The web renderer, the native bundler and the validator all read refs through
 * here. Before this module each kept its own regex, and they had already
 * drifted: the renderer's `lookup` indexed arrays while its comment said it did
 * not, and a `null` field rendered as the four letters "null".
 *
 * PIPES ARE A CLOSED LIST. Every renderer — web, native, the bundler that
 * pre-resolves for native — has to implement each one identically, and an
 * agent that is allowed to invent a pipe will. Shaping data (renaming fields,
 * joining APIs, building `detail_url`) is the CAST hook's job and already
 * happens there in JSONata. A pipe only does what depends on the DESIGN: the
 * date pattern the mock-up shows, and what to draw when a field is empty.
 *
 * `{{RATIO}}` IS NOT A REF. It is a slot in CDN image URLs that the hook emits
 * and the Image fills from its own `ratio` — see `fillImageRatio`. The
 * look-around in the regex keeps `{{…}}` from parsing as `{…}`.
 *
 * PURE. No filesystem, no process, no clock.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const PATH = `${NAME}(?:\\.(?:${NAME}|\\d+))*`;
const ARG = `(?:"[^"]*"|[^\\s|:{}"]+)`;
const PIPE = `\\s*\\|\\s*${NAME}(?:\\s*:\\s*${ARG})*`;

/** One whole ref, `{path | pipe:arg}`. Groups: 1 = path, 2 = the pipe chain. */
const REF_SOURCE = `(?<!\\{)\\{(${PATH})((?:${PIPE})*)\\s*\\}(?!\\})`;

/** A fresh global regex over refs — fresh because a shared `g` regex carries `lastIndex`. */
export const refRegex = (): RegExp => new RegExp(REF_SOURCE, "g");

/** A `{…}` that opens with a name, as a ref does; `{{RATIO}}` is not one. */
const REF_LIKE = /(?<!\{)\{(?!\{)\s*[A-Za-z_][^{}]*\}(?!\})/g;
const WHOLE_REF = new RegExp(`^${REF_SOURCE}$`);

/**
 * The `{path …}` spans of a template the grammar cannot read (`{state | replace:"R":"A","U":"B"}`).
 * No renderer resolves them, so the page draws them as written, braces and all.
 */
export function brokenRefs(template: string): string[] {
  if (!template.includes("{")) return [];
  return [...template.matchAll(REF_LIKE)].map((m) => m[0]).filter((span) => !WHOLE_REF.test(span));
}

/** A bare data path, as `Repeater.over` and `when` conditions take it. */
export const PATH_RE = new RegExp(`^${PATH}$`);

export interface Pipe {
  name: string;
  args: string[];
}

export interface Ref {
  /** The ref exactly as written, braces included. */
  text: string;
  path: string;
  pipes: Pipe[];
}

/** Every ref in a template, in order. */
export function parseRefs(template: string): Ref[] {
  if (!template.includes("{")) return [];
  return [...template.matchAll(refRegex())].map((m) => ({
    text: m[0],
    path: m[1]!,
    pipes: parsePipes(m[2] ?? ""),
  }));
}

/** Does this string carry at least one ref? */
export function hasRef(value: unknown): boolean {
  return typeof value === "string" && value.includes("{") && refRegex().test(value);
}

function parsePipes(chain: string): Pipe[] {
  const pipes: Pipe[] = [];
  for (const m of chain.matchAll(new RegExp(PIPE, "g"))) {
    const body = m[0].replace(/^\s*\|\s*/, "");
    const name = body.match(new RegExp(`^${NAME}`))![0];
    const args = [...body.slice(name.length).matchAll(new RegExp(`:\\s*(${ARG})`, "g"))].map((a) => {
      const raw = a[1]!;
      return raw.startsWith('"') ? raw.slice(1, -1) : raw;
    });
    pipes.push({ name, args });
  }
  return pipes;
}

/**
 * Rewrite the PATH of every ref, leaving its pipes alone.
 *
 * What a collapse needs: `{news.items.4.published_date | date:"MMM DD"}` inside
 * a folded card becomes `{article.published_date | date:"MMM DD"}`.
 */
export function mapRefPaths(template: string, rewrite: (path: string) => string): string {
  if (!template.includes("{")) return template;
  return template.replace(refRegex(), (whole, path: string, chain: string) => {
    const next = rewrite(path);
    return next === path ? whole : `{${next}${chain}}`;
  });
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Dot-path lookup. A numeric segment indexes an array — `news.items.0.title` —
 * which is how an index-tiered grid binds its lead card.
 */
export function lookup(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Pipes
// ---------------------------------------------------------------------------

export interface PipeSpec {
  /** Accepted argument counts. */
  arity: readonly number[];
  doc: string;
}

/**
 * The whole list. Adding one means adding it to every renderer.
 *
 * `date` takes the token set of `formatDate` in fanxp-web-renderer's utils
 * (DD MM YYYY YY HH hh mm ss a MMM MMMM DDD DDDD), so a pattern lifted from a
 * production molecule's `date_format` means the same thing here.
 */
export const PIPES: Readonly<Record<string, PipeSpec>> = {
  date: { arity: [1, 2], doc: 'date:"MMM DD, YYYY" or date:"hh:mm a":"Asia/Kolkata" — formatDate tokens; zone defaults to the render\'s' },
  default: { arity: [1], doc: 'default:"—" — used when the value is missing, null or ""' },
  pad: { arity: [1], doc: 'pad:2 — a whole number drawn with at least that many digits ("02"), as the design draws it' },
};

export interface ResolveOptions {
  /** IANA zone for `date` when the pipe names none. Defaults to UTC, so SSR is deterministic. */
  timeZone?: string;
  /** Which comes first in a date-only value that could be read either way (`07/08/2026`). */
  dateOrder?: DateOrder;
}

/** `undefined` means "nothing to draw" — the caller decides what that looks like. */
function applyPipe(pipe: Pipe, value: unknown, options: ResolveOptions): unknown {
  switch (pipe.name) {
    case "date": {
      if (value === undefined || value === null || value === "") return value;
      if (typeof value !== "string" && typeof value !== "number") return undefined;
      return formatDate(value, pipe.args[0] ?? "", pipe.args[1] ?? options.timeZone ?? "UTC", options.dateOrder);
    }
    case "default":
      return isEmpty(value) ? (pipe.args[0] ?? "") : value;
    case "pad": {
      const width = Number(pipe.args[0]);
      const whole = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : undefined;
      if (whole === undefined || !Number.isInteger(width) || width < 1) return value;
      const digits = String(Math.abs(whole)).padStart(width, "0");
      return whole < 0 ? `-${digits}` : digits;
    }
    default:
      return undefined;
  }
}

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === "";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Which comes first in a date that could be read either way (`07/08/2026`): month (`mdy`) or day (`dmy`). */
export type DateOrder = "mdy" | "dmy";

const MONTH_NUMBERS: Record<string, number> = {
  ...Object.fromEntries([...MONTHS_FULL, ...MONTHS].map((name, i) => [name.toLowerCase(), (i % 12) + 1])),
  sept: 9,
};
const WEEKDAY_WORDS = new Set([...DAYS_FULL, ...DAYS, "Tues", "Weds", "Thur", "Thurs"].map((d) => d.toLowerCase()));

/**
 * A date value, read. Three kinds, because they mean three things:
 *
 *   day      a calendar day with no time (`2026-07-22`, `22 Jul 2026`): the same day everywhere
 *   wall     a date and a time with no zone (`2026-07-22 13:45`, `7/22/2026 1:45 PM`): the time on
 *            the clocks of the zone the page is shown in, drawn as written
 *   instant  a moment (an offset or `Z` in the text, or epoch ms): drawn in the zone the page names
 */
type DateValue =
  | { kind: "day" | "wall"; year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number }
  | { kind: "instant"; epoch: number };

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a proleptic Gregorian date, any year (H. Hinnant's `days_from_civil`). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
}

/** No `Date` here (the purity gate, and `Date.UTC` turns year 26 into 1926): the month's length is arithmetic. */
function realDay(year: number, month: number, day: number): { year: number; month: number; day: number } | undefined {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return Number.isInteger(year) && length !== undefined && day >= 1 && day <= length ? { year, month, day } : undefined;
}

/** A two-digit year: 00–69 are 20xx, 70–99 19xx (POSIX `%y`). */
const fullYear = (text: string): number => (text.length === 2 ? (Number(text) < 70 ? 2000 : 1900) + Number(text) : Number(text));

const TIME_RE =
  /^(?:[Tt]|\s*,?\s*(?:at\s+|@\s*)?)(\d{1,2})(?:[:.](\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(?:([AaPp])\.?\s*[Mm]\.?)?(.*)$/;

/** A zone written after a time: `Z`, `UTC`, `GMT`, `+01:00`, `+0100`, `-05`, `GMT+1`. Minutes east of UTC. */
function offsetOf(text: string): number | undefined {
  const t = text.trim();
  if (/^z$/i.test(t) || /^(?:utc|gmt|ut)$/i.test(t)) return 0;
  const m = /^(utc|gmt|ut)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(t);
  if (!m || (!m[1] && m[3]!.length !== 2)) return undefined;
  const hours = Number(m[3]);
  const minutes = Number(m[4] ?? 0);
  if (hours > 23 || minutes > 59) return undefined;
  return (m[2] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Read a date value from text, in the forms feeds send it, without the machine's zone and without
 * `Date.parse` (which reads anything with no zone in the machine's). Undefined for anything it
 * cannot read, or a date that does not exist (`2/30/2026`).
 *
 * The date: `2026-07-22` (`/` and `.` too), `20260722`, `7/22/2026`, `7/22/26`, `22-07-2026`,
 * `22.07.2026`, `22 Jul 2026`, `22-Jul-2026`, `22nd July 2026`, `Jul 22, 2026`, `Sept 22, 2026`,
 * each optionally after a weekday (`Wed, `, `Wednesday `). Where day and month could swap
 * (`07/08/2026`) `order` decides; a part above 12 settles it by itself.
 * Then optionally a time: `T13:45`, ` 13:45:00.000`, ` 1:45 PM`, `, 1:45 p.m.`, ` at 13:45`; and
 * after the time optionally a zone: `Z`, `+01:00`, `+0100`, ` GMT`, ` UTC`, ` GMT+0100 (BST)`. A
 * zone by name or abbreviation (`BST`, `Europe/London`) is not read: it is no date.
 */
function readDateValue(text: string, order: DateOrder): DateValue | undefined {
  let t = text.trim().replace(/\s*\([^()]*\)$/, "");
  const weekday = /^([A-Za-z]+)\.?,?\s+/.exec(t);
  if (weekday && WEEKDAY_WORDS.has(weekday[1]!.toLowerCase())) t = t.slice(weekday[0].length);
  if (/^-?\d+$/.test(t)) {
    // all digits: a compact date (`20260722`, `202607221345`, `20260722134500`), else epoch ms
    const c = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/.exec(t);
    if (c && realDay(Number(c[1]), Number(c[2]), Number(c[3]))) {
      t = `${c[1]}-${c[2]}-${c[3]}${c[4] ? `T${c[4]}:${c[5]}${c[6] ? `:${c[6]}` : ""}` : ""}`;
    } else if (t.replace("-", "").length >= 10) {
      return { kind: "instant", epoch: Number(t) };
    } else return undefined;
  }
  t = t.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?/, (_, y, mo, d, h, mi, s) => `${y}-${mo}-${d}T${h}:${mi}${s ? `:${s}` : ""}`);

  let date: { year: number; month: number; day: number } | undefined;
  let rest: string;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)(.*)$/.exec(t))) {
    date = realDay(Number(m[1]), Number(m[2]), Number(m[3]));
    rest = m[4]!;
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)(.*)$/.exec(t))) {
    const [a, b, year] = [Number(m[1]), Number(m[2]), fullYear(m[3]!)];
    const dayFirst = a > 12 ? true : b > 12 ? false : order === "dmy";
    date = dayFirst ? realDay(year, b, a) : realDay(year, a, b);
    rest = m[4]!;
  } else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})(?!\d)(.*)$/.exec(t))) {
    const month = MONTH_NUMBERS[m[2]!.toLowerCase()];
    date = month ? realDay(Number(m[3]), month, Number(m[1])) : undefined;
    rest = m[4]!;
  } else if ((m = /^([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)(.*)$/.exec(t))) {
    const month = MONTH_NUMBERS[m[1]!.toLowerCase()];
    date = month ? realDay(Number(m[3]), month, Number(m[2])) : undefined;
    rest = m[4]!;
  } else return undefined;
  if (!date) return undefined;

  const clock = { hour: 0, minute: 0, second: 0, ms: 0 };
  if (rest.trim() === "") return { kind: "day", ...date, ...clock };
  const time = TIME_RE.exec(rest);
  if (!time) return undefined;
  const [, h, mi, s, frac, meridiem, zone = ""] = time;
  if (mi === undefined && meridiem === undefined) return undefined; // a bare number is no time
  let hour = Number(h);
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (/p/i.test(meridiem) ? 12 : 0);
  }
  clock.hour = hour;
  clock.minute = Number(mi ?? 0);
  clock.second = Number(s ?? 0);
  clock.ms = frac ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
  if (clock.hour > 23 || clock.minute > 59 || clock.second > 59) return undefined;
  const wall = { kind: "wall" as const, ...date, ...clock };
  if (zone.trim() === "") return wall;
  const offset = offsetOf(zone);
  if (offset === undefined) return undefined;
  return { kind: "instant", epoch: wallMs(wall) - offset * 60_000 };
}

/** The epoch ms a set of clock fields would be in UTC. */
const wallMs = (f: { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number }) =>
  daysFromCivil(f.year, f.month, f.day) * DAY_MS + ((f.hour * 60 + f.minute) * 60 + f.second) * 1000 + f.ms;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The clock fields of an instant in a zone, or undefined for a zone Intl does not know. */
function fieldsIn(epoch: number, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hourCycle: "h23",
        era: "short",
      });
    } catch {
      return undefined; // an unknown zone
    }
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(epoch).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  return {
    year: /^B/i.test(parts.era ?? "") ? 1 - year : year,
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    ms: ((epoch % 1000) + 1000) % 1000,
  };
}

/** The epoch ms of a wall-clock time in a zone (in a gap the clocks skip, the time after it). */
function wallInZone(ms: number, timeZone: string): number | undefined {
  const offsetAt = (epoch: number) => {
    const f = fieldsIn(epoch, timeZone);
    return f ? wallMs(f) - epoch : undefined;
  };
  const first = offsetAt(ms);
  if (first === undefined) return undefined;
  const second = offsetAt(ms - first) ?? first;
  return ms - second;
}

const readOf = (input: unknown, order: DateOrder): DateValue | undefined =>
  typeof input === "number"
    ? Number.isFinite(input)
      ? { kind: "instant", epoch: input }
      : undefined
    : typeof input === "string"
      ? readDateValue(input, order)
      : undefined;

/**
 * A date with no time part, in the forms `readDate` reads. Its year, month and day, or undefined
 * for anything else (a date with a time, an instant, or not a date).
 */
export function calendarDay(
  text: string,
  order: DateOrder = "mdy",
): { year: number; month: number; day: number } | undefined {
  const value = readDateValue(text, order);
  return value?.kind === "day" ? { year: value.year, month: value.month, day: value.day } : undefined;
}

export interface ReadDateOptions {
  /** The zone a date or time written with no zone is on the clocks of. UTC when unset. */
  timeZone?: string;
  /** Which comes first where day and month could swap. Month, when unset. */
  dateOrder?: DateOrder;
}

/**
 * A date value as epoch ms: what to sort or compare dates by. An instant is its moment; a time with
 * no zone is that time on the clocks of `timeZone`; a calendar day is its start there. Undefined
 * for what is not a readable date (see `formatDate`), or an unknown zone.
 */
export function readDate(value: unknown, options: ReadDateOptions = {}): number | undefined {
  const read = readOf(value, options.dateOrder ?? "mdy");
  if (!read) return undefined;
  return read.kind === "instant" ? read.epoch : wallInZone(wallMs(read), options.timeZone ?? "UTC");
}

/**
 * fanxp's `formatDate`, minus its one environmental input: the zone is always explicit. Theirs
 * falls back to the machine's zone, which makes a server render and a browser render of the same
 * card disagree after midnight UTC.
 *
 * What it reads is `readDateValue`'s list, and never through `Date.parse`. An instant (an offset or
 * `Z` in the text, or epoch ms) is drawn in `timeZone`. A calendar day, and a time written with no
 * zone, are drawn as written: the first is the same day everywhere, the second is a time on the
 * clocks of the zone the page is shown in. `YYYYMMDDHHmmss` gives a key that sorts.
 *
 * Returns `undefined` for an unreadable or impossible date, or an unknown zone for an instant, so a
 * `default` pipe can catch it.
 */
export function formatDate(
  input: string | number,
  pattern: string,
  timeZone: string,
  dateOrder: DateOrder = "mdy",
): string | undefined {
  const read = readOf(input, dateOrder);
  if (!read) return undefined;
  const f = read.kind === "instant" ? fieldsIn(read.epoch, timeZone) : read;
  if (!f) return undefined;

  const weekday = (((daysFromCivil(f.year, f.month, f.day) + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const year = pad(f.year, 4);
  const tokens: Record<string, string> = {
    DDDD: DAYS_FULL[weekday] ?? "",
    DDD: DAYS[weekday] ?? "",
    DD: pad(f.day),
    MMMM: MONTHS_FULL[f.month - 1] ?? "",
    MMM: MONTHS[f.month - 1] ?? "",
    MM: pad(f.month),
    YYYY: year,
    YY: year.slice(-2),
    HH: pad(f.hour),
    hh: pad(f.hour % 12 || 12),
    mm: pad(f.minute),
    ss: pad(f.second),
    a: f.hour >= 12 ? "PM" : "AM",
  };
  return pattern.replace(/DDDD|DDD|DD|MMMM|MMM|MM|YYYY|YY|HH|hh|mm|ss|a/g, (t) => tokens[t] ?? t);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveResult {
  value: string;
  /** Refs that could not be drawn — missing path, unknown pipe, or an object where text goes. */
  unresolved: string[];
}

/**
 * Fill every ref in `template` from `scope`.
 *
 * A ref that cannot be drawn is left as its literal text and reported. Never
 * the string "undefined", "null" or "[object Object]": a present-but-null field
 * draws as nothing, which is what a CAST payload's `duration: null` means.
 */
export function resolveTemplate(template: string, scope: unknown, options: ResolveOptions = {}): ResolveResult {
  if (!template.includes("{")) return { value: template, unresolved: [] };
  const unresolved: string[] = [];
  const value = template.replace(refRegex(), (whole, path: string, chain: string) => {
    let v = lookup(scope, path);
    for (const pipe of parsePipes(chain)) {
      if (!(pipe.name in PIPES)) {
        v = undefined;
        break;
      }
      v = applyPipe(pipe, v, options);
    }
    if (v === undefined || (typeof v === "object" && v !== null)) {
      unresolved.push(path);
      return whole;
    }
    return v === null ? "" : String(v);
  });
  return { value, unresolved };
}

// ---------------------------------------------------------------------------
// `when` — conditional rendering
// ---------------------------------------------------------------------------

/**
 * A condition on one path, with exactly one operator.
 *
 * `when` takes one condition or a list (all must hold). NOT recursive: no
 * `any`/`all`/`not` nesting, because the agent emits this through a JSON
 * schema and recursive schemas are what structured output fails on (see
 * `flat.ts`). `in` covers OR on one field, `ne`/`exists:false` cover NOT.
 *
 * This is what fanxp's molecules hand-code as `data?.duration && atoms.x.visibility`
 * and `asset_type_id === 4`, and what its analytics bridge already spells as
 * `when: [{ path, equals }]`.
 */
export type Scalar = string | number | boolean | null;

export interface Condition {
  path: string;
  eq?: Scalar;
  ne?: Scalar;
  in?: Scalar[];
  /** true: present (not missing, null, "" or []). false: the opposite. */
  exists?: boolean;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  /**
   * Equal to what another path holds: an item's team and the page's chosen one
   * (`{ path: "item.team", eqPath: "_page.squad" }`). Nothing missing is equal to anything.
   *
   * An item's field against the page is a FILTER over the item's list, and the page at a value no
   * item of that list holds (an ALL tab, "Everything", "Both", or no choice made yet) lets every
   * item through: see `page.ts`.
   */
  eqPath?: string;
}

export type Predicate = Condition | Condition[];

export const CONDITION_OPS = ["eq", "ne", "in", "exists", "gt", "gte", "lt", "lte", "eqPath"] as const;

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const conditionSchema = z
  .object({
    path: z.string().regex(PATH_RE, "not a data path"),
    eq: scalarSchema.optional(),
    ne: scalarSchema.optional(),
    in: z.array(scalarSchema).min(1).optional(),
    exists: z.boolean().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    eqPath: z.string().regex(PATH_RE, "not a data path").optional(),
  })
  .strict()
  .refine((c) => CONDITION_OPS.filter((op) => op in c).length === 1, {
    message: `a condition takes exactly one of ${CONDITION_OPS.join(", ")}`,
  });

export const predicateSchema = z.union([conditionSchema, z.array(conditionSchema).min(1)]);

/** The conditions of a `when`, as a list. */
export const conditionsOf = (predicate: Predicate): Condition[] =>
  Array.isArray(predicate) ? predicate : [predicate];

const present = (v: unknown): boolean => !isEmpty(v) && !(Array.isArray(v) && v.length === 0);

/** The root a `when` reads the page's choices under (`page.ts`). */
export const PAGE_SCOPE = "_page";

/**
 * A choice's value as it is compared: "Men's" and `mens`, "WOMEN" and `women` are one. A page
 * choice's values are made from a design's labels and a feed writes its own way, so a comparison
 * on the page (an `eq` on `_page.…`, any `eqPath`) is of these, not of the strings as written.
 */
export function choiceValue(value: unknown): string {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const onPage = (path: string) => path === PAGE_SCOPE || path.startsWith(`${PAGE_SCOPE}.`);
const sameChoice = (a: unknown, b: unknown) =>
  a !== undefined && a !== null && b !== undefined && b !== null && typeof a !== "object" && typeof b !== "object"
    ? choiceValue(a) === choiceValue(b)
    : false;

/**
 * Where a Repeater puts, in each item's scope, the list it draws, by the name the item is read by:
 * `{ _each: { article: [...] } }`. What a filter on the page reads to know which values the
 * list's items hold (`heldBy`). A data source's name starts with a lower-case letter, so `_each`
 * is never one.
 */
export const EACH_SCOPE = "_each";

/** An item scope: the item under its name, and its list under `_each`. */
export function itemScope(scope: unknown, as: string, item: unknown, list: readonly unknown[]): Record<string, unknown> {
  const base = scope !== null && typeof scope === "object" ? (scope as Record<string, unknown>) : {};
  const each = base[EACH_SCOPE];
  return {
    ...base,
    [as]: item,
    [EACH_SCOPE]: { ...(each !== null && typeof each === "object" ? each : {}), [as]: list },
  };
}

/**
 * What every item of the list an item path reads holds there: for `article.category` in a
 * Repeater over articles, each article's category. Undefined when the path's head is not a
 * repeated item.
 */
export function heldBy(scope: unknown, path: string): unknown[] | undefined {
  const [as, ...rest] = path.split(".");
  const each = lookup(scope, EACH_SCOPE);
  const list = each !== null && typeof each === "object" ? (each as Record<string, unknown>)[as ?? ""] : undefined;
  if (!Array.isArray(list)) return undefined;
  return rest.length ? list.map((item) => lookup(item, rest.join("."))) : list;
}

/** Of the two paths of an `eqPath`, the one on the page and the one in the data; undefined unless one of each. */
function pageAndData(condition: Condition): { page: string; data: string } | undefined {
  if (condition.eqPath === undefined) return undefined;
  const [a, b] = [onPage(condition.path), onPage(condition.eqPath)];
  if (a === b) return undefined;
  return a ? { page: condition.path, data: condition.eqPath } : { page: condition.eqPath, data: condition.path };
}

export function evaluateCondition(condition: Condition, scope: unknown): boolean {
  const v = lookup(scope, condition.path);
  if (condition.exists !== undefined) return present(v) === condition.exists;
  if (condition.eqPath !== undefined) {
    const other = lookup(scope, condition.eqPath);
    if (sameChoice(v, other)) return true;
    // a filter: the page at a value no item of the list holds lets every item through
    const sides = pageAndData(condition);
    const held = sides ? heldBy(scope, sides.data) : undefined;
    if (!sides || !held) return false;
    const chosen = lookup(scope, sides.page);
    return !held.some((h) => sameChoice(h, chosen));
  }
  if ("eq" in condition) return onPage(condition.path) ? sameChoice(v, condition.eq) : v === condition.eq;
  if ("ne" in condition) return onPage(condition.path) ? !sameChoice(v, condition.ne) : v !== condition.ne;
  if (condition.in) {
    return onPage(condition.path)
      ? condition.in.some((x) => sameChoice(v, x))
      : condition.in.includes(v as Scalar);
  }
  if (typeof v !== "number") return false;
  if (condition.gt !== undefined) return v > condition.gt;
  if (condition.gte !== undefined) return v >= condition.gte;
  if (condition.lt !== undefined) return v < condition.lt;
  if (condition.lte !== undefined) return v <= condition.lte;
  return false;
}

/**
 * Should this node draw? A missing or malformed `when` draws — the validator
 * reports the malformed one (S12); the renderer is not the place to hide it.
 */
export function evaluateWhen(when: unknown, scope: unknown): boolean {
  if (when === undefined || when === null) return true;
  const parsed = predicateSchema.safeParse(when);
  if (!parsed.success) return true;
  return conditionsOf(parsed.data).every((c) => evaluateCondition(c, scope));
}

// ---------------------------------------------------------------------------
// Images — the `{{RATIO}}` slot and relative URLs
// ---------------------------------------------------------------------------

export const RATIO_SLOT = "{{RATIO}}";

/**
 * Crops the SI media CDN serves for `/static-assets/media/{{RATIO}}-<file>`.
 *
 * Measured against dc.surface.fan-os.net on 2026-10-23: each returns a 480px-wide
 * crop of that aspect; `0` returns the 16:9 default; an unlisted ratio (7-5)
 * returns a 1×1 pixel with a 200, so a wrong ratio fails SILENTLY. The list
 * matches the aspect classes in fanxp-web-renderer's `class.config.ts`.
 */
export const CDN_RATIOS = ["16/9", "9/16", "1/1", "2/3", "3/2", "4/3", "3/4", "21/9"] as const;

/**
 * Fill the CDN's `{{RATIO}}` slot from an Image's `ratio` — `16/9` → `16-9`,
 * none → `0`, as fanxp's `resolveRatioToken` does. A URL without the slot is
 * returned unchanged.
 */
export function fillImageRatio(url: string, ratio: string | undefined): string {
  if (!url.includes(RATIO_SLOT)) return url;
  const token = ratio && ratio !== "auto" ? ratio.replace(/\s/g, "").replace(/[/:]/, "-") : "0";
  return url.split(RATIO_SLOT).join(token);
}

/**
 * Root-relative URLs from a CAST payload (`/static-assets/…`, `/news/…`) are
 * relative to the TENANT's site, not to wherever the tree is being rendered —
 * a Studio preview on localhost would otherwise request its own origin.
 */
export function absolutize(url: string, origin: string | undefined): string {
  if (!origin || !url.startsWith("/") || url.startsWith("//")) return url;
  return `${origin.replace(/\/+$/, "")}${url}`;
}
