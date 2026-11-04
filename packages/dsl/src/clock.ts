/**
 * A clock — the time left until an instant, or gone since it, in the units a design draws.
 *
 * Any node may carry `clock: { to, as, units }`. Inside it, `{as.d}`, `{as.h}`, `{as.m}` and
 * `{as.s}` read the units, `{as.past}` says the instant has gone, and `{as.total}` is the whole
 * difference in seconds. The designed digits are ordinary Texts bound to those values, so they
 * keep their own look, and what happens around the instant is ordinary `when`: hide the digits
 * once `past`, show a "LIVE" label instead, show the days only while `d` is above 0.
 *
 * Nothing here knows what is being counted to. A kick-off, a ticket sale, a deadline and a match
 * clock counting up are the same thing: an instant from the data and the units the design draws.
 * Which instant, which units and what to show either side of it are the binding's choice.
 *
 * PURE. `now` is always an argument: the renderer reads the clock, once per render and then once
 * per tick, and passes it in.
 */

import { z } from "zod";
import { hasRef, lookup, resolveTemplate } from "./binding.js";

export const CLOCK_UNITS = ["d", "h", "m", "s"] as const;
export type ClockUnit = (typeof CLOCK_UNITS)[number];

const SECONDS: Record<ClockUnit, number> = { d: 86_400, h: 3_600, m: 60, s: 1 };

export const clockSchema = z
  .object({
    to: z.union([z.string().min(1), z.number()]),
    as: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a plain name: countdown, kickoff")
      .optional(),
    units: z.array(z.enum(CLOCK_UNITS)).min(1).optional(),
  })
  .strict();

export type Clock = z.infer<typeof clockSchema>;

export interface ClockValues {
  d?: number;
  h?: number;
  m?: number;
  s?: number;
  /** The instant has come: what is counted is the time since it. */
  past: boolean;
  /** The whole difference, in seconds. */
  total: number;
}

/** The name a clock's subtree reads it by. */
export const clockAlias = (clock: Pick<Clock, "as">): string => clock.as ?? "clock";

/** The units a clock draws, largest first. */
export const clockUnits = (clock: Pick<Clock, "units">): ClockUnit[] => {
  const units = clock.units ?? [...CLOCK_UNITS];
  return CLOCK_UNITS.filter((unit) => units.includes(unit));
};

/** How often what a clock draws changes, in ms: once per its smallest unit. */
export const clockTick = (units: readonly ClockUnit[]): number =>
  Math.min(...units.map((unit) => SECONDS[unit])) * 1000;

/**
 * An instant as epoch ms. An ISO string with no offset is read as UTC, as the `date` pipe reads
 * it, so the server and the browser count to the same moment.
 */
export function parseInstant(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const text = value.trim();
  if (/^-?\d{10,}$/.test(text)) return Number(text);
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text}Z` : text;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The values of a clock at `now`. Each unit listed holds what is left after the larger ones, and
 * the largest holds everything above it: with units `h m`, 2 days and 3 hours is `h: 51`.
 */
export function clockValues(units: readonly ClockUnit[], to: number, now: number): ClockValues {
  const diff = to - now;
  const total = Math.floor(Math.abs(diff) / 1000);
  const values: ClockValues = { past: diff <= 0, total };
  let left = total;
  for (const unit of CLOCK_UNITS) {
    if (!units.includes(unit)) continue;
    const n = Math.floor(left / SECONDS[unit]);
    values[unit] = n;
    left -= n * SECONDS[unit];
  }
  return values;
}

/** The instant a clock counts to, read in the node's scope: `{match.start_time}` or a literal. */
export function clockInstant(clock: Pick<Clock, "to">, scope: unknown): number | undefined {
  const { to } = clock;
  if (typeof to === "number") return parseInstant(to);
  const single = to.match(/^\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}$/);
  if (single?.[1]) return parseInstant(lookup(scope, single[1]));
  if (!hasRef(to)) return parseInstant(to);
  const { value, unresolved } = resolveTemplate(to, scope);
  return unresolved.length ? undefined : parseInstant(value);
}

export interface ClockScope {
  /** What the subtree reads it by. */
  as: string;
  units: ClockUnit[];
  /** Epoch ms, or undefined when the data has no instant there. */
  to: number | undefined;
  /** The values at `now`, when there is an instant. */
  values: ClockValues | undefined;
}

/** A node's `clock`, resolved in its scope at `now`. Undefined when the prop is not a clock. */
export function clockScope(clock: unknown, scope: unknown, now: number): ClockScope | undefined {
  const parsed = clockSchema.safeParse(clock);
  if (!parsed.success) return undefined;
  const units = clockUnits(parsed.data);
  const to = clockInstant(parsed.data, scope);
  return {
    as: clockAlias(parsed.data),
    units,
    to,
    values: to === undefined ? undefined : clockValues(units, to, now),
  };
}
