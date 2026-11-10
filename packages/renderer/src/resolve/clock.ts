/**
 * A node's `clock`, on the server.
 *
 * The server draws every clock as it reads at render time, so the first paint (and a page with no
 * JavaScript, and a screenshot) shows real digits. What changes as time passes is handed to the
 * client as small pieces: the characters of a Text that reads a clock (`ClockText`), and a node
 * whose `when` reads one (`ClockGate`). Everything else in the subtree stays a Server Component,
 * and what the clock means is the tree's: nothing here knows a kick-off from a deadline.
 */

import {
  clockScope,
  conditionsOf,
  predicateSchema,
  refRegex,
  resolveTemplate,
  type Condition,
} from "@fanos/dsl";
import type { ClockRef } from "@fanos/renderer/client";
import { localeOf, type NodeRenderContext } from "../context.js";

const aliasOf = (path: string) => path.split(".")[0] ?? "";

/** The context a node and its subtree draw in: its clock's values in scope, under its name. */
export function withClock(props: Record<string, unknown>, ctx: NodeRenderContext): NodeRenderContext {
  if (props.clock === undefined) return ctx;
  const now = ctx.now ?? Date.now();
  // a time the data writes with no zone is one on the clocks of the zone the page is shown in
  const clock = clockScope(props.clock, ctx.data, now, localeOf(ctx));
  if (!clock) {
    console.warn("[fos-render] clock is not { to, as?, units? } — ignored");
    return ctx;
  }
  if (clock.to === undefined || clock.values === undefined) {
    console.warn(`[fos-render] clock "${clock.as}" reads no instant from the data — not drawn`);
    return ctx;
  }
  return {
    ...ctx,
    now,
    data: { ...(ctx.data ?? {}), [clock.as]: clock.values },
    clocks: { ...(ctx.clocks ?? {}), [clock.as]: { to: clock.to, units: clock.units } },
  };
}

/** The clocks of `clocks` that these paths read. */
function clocksRead(paths: string[], clocks: Record<string, ClockRef>): Record<string, ClockRef> {
  const read: Record<string, ClockRef> = {};
  for (const path of paths) {
    const as = aliasOf(path);
    const clock = clocks[as];
    if (clock) read[as] = clock;
  }
  return read;
}

/**
 * A `when`, split: the conditions the server decides now, and those that read a clock and are
 * decided in the browser as it ticks. A malformed `when` is the server's (it draws; S12 reports it).
 */
export function splitWhen(
  when: unknown,
  ctx: NodeRenderContext,
): { now: unknown; ticking: Condition[]; clocks: Record<string, ClockRef> } {
  const clocks = ctx.clocks;
  if (when === undefined || !clocks) return { now: when, ticking: [], clocks: {} };
  const parsed = predicateSchema.safeParse(when);
  if (!parsed.success) return { now: when, ticking: [], clocks: {} };
  const all = conditionsOf(parsed.data);
  const ticking = all.filter((c) => aliasOf(c.path) in clocks);
  if (ticking.length === 0) return { now: when, ticking: [], clocks: {} };
  const fixed = all.filter((c) => !(aliasOf(c.path) in clocks));
  return {
    now: fixed.length ? fixed : undefined,
    ticking,
    clocks: clocksRead(
      ticking.map((c) => c.path),
      clocks,
    ),
  };
}

/**
 * A template that reads a clock, in pieces: literal text and the refs to everything else resolved
 * now, the refs to a clock kept as written for the browser. Undefined when it reads no clock.
 */
export function clockParts(
  template: string,
  ctx: NodeRenderContext,
): { parts: Array<string | { ref: string }>; clocks: Record<string, ClockRef> } | undefined {
  const clocks = ctx.clocks;
  if (!clocks || !template.includes("{")) return undefined;
  const parts: Array<string | { ref: string }> = [];
  const paths: string[] = [];
  let last = 0;
  for (const match of template.matchAll(refRegex())) {
    const at = match.index ?? 0;
    if (at > last) parts.push(template.slice(last, at));
    const path = match[1] ?? "";
    if (aliasOf(path) in clocks) {
      parts.push({ ref: match[0] });
      paths.push(path);
    } else {
      parts.push(resolveTemplate(match[0], ctx.data, localeOf(ctx)).value);
    }
    last = at + match[0].length;
  }
  if (paths.length === 0) return undefined;
  if (last < template.length) parts.push(template.slice(last));
  return { parts, clocks: clocksRead(paths, clocks) };
}
