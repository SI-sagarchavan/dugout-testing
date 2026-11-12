/**
 * A page's machines, together: one per section drawn (an INSTANCE: the same section twice is two),
 * plus any a host adds with no section of its own (a cart that lives in the layout).
 *
 * Each machine is its section's and nobody else's: another section never writes into it. Sections
 * meet in two ways only:
 *
 * - READS: a machine's `exports` are the page's, by key (`$page.followed`), for every node and every
 *   machine on the page. A key has one owner (`systemIssues` says when two sections claim one).
 * - EVENTS: `send` offers an event to every other machine on the page that handles it, in page
 *   order; a press can send one to the page directly (`on.click.to: "page"`). The drawer's SAVE
 *   says `players.chosen` and the page section, which owns the list, takes it.
 *
 * The page also holds values written outside any machine: a tab's `select` and a field's `key`
 * (ADR 0032), read as `$page.<key>` as well as `_page.<key>`. And the host's `$user` (the signed-in
 * fan, or null) and `$route` (the page shown), which the page reads and never writes.
 *
 * When what the page shares changes, every machine is offered `page.changed` and its eventless
 * transitions run, so a machine can follow another section's state without being told.
 *
 * PURE: the effects are returned, each with the instance it is for.
 */

import { deepEqual, type Json } from "./expr.js";
import {
  handlesEvent,
  hasAlways,
  initialStep,
  type MachineEffect,
  type MachineEnv,
  type MachineSnapshot,
  restoreContext,
  resumeEffects,
  step,
} from "./interpret.js";
import type { MachineEvent, MachineSpec } from "./schema.js";

export interface MachineEntry {
  instance: string;
  spec: MachineSpec;
}

export interface HostState {
  /** The signed-in fan (`{ id, name, initials, avatar, ... }`), or null when nobody is. */
  user?: Json;
  /** The page shown: `{ path, params }`. */
  route?: Json;
}

/** The page's state as JSON: what the server draws at and hands the browser. */
export interface SystemSnapshot {
  order: string[];
  machines: Record<string, MachineSnapshot>;
  /** Values written outside any machine: a tab's choice, a field's text. */
  free: Record<string, Json>;
  host: { user: Json; route: Json };
}

export interface PageSystem extends SystemSnapshot {
  specs: Record<string, MachineSpec>;
}

/** An effect for the runtime, with the instance it is for. `persist` is the system's own. */
export type SystemEffect =
  | (Exclude<MachineEffect, { type: "send" }> & { instance: string })
  | { type: "persist"; instance: string; storage: "local" | "session"; key: string; value: Record<string, Json> };

export interface SystemStep {
  system: PageSystem;
  effects: SystemEffect[];
  changed: boolean;
}

/** What the page shares: the free values, then each machine's exports, in page order. */
export function pageValues(system: SystemSnapshot): Record<string, Json> {
  const out: Record<string, Json> = { ...system.free };
  for (const instance of system.order) Object.assign(out, system.machines[instance]?.exports ?? {});
  return out;
}

const envOf = (system: SystemSnapshot): MachineEnv => ({
  page: pageValues(system),
  user: system.host.user,
  route: system.host.route,
});

/** At most this many deliveries per outside event: two machines that answer each other stop. */
const DELIVERY_LIMIT = 500;
const SETTLE_ROUNDS = 10;

const persisted = (spec: MachineSpec, snapshot: MachineSnapshot): Record<string, Json> | undefined =>
  spec.persist ? Object.fromEntries(spec.persist.fields.map((f) => [f, snapshot.context[f] ?? null])) : undefined;

interface Run {
  system: PageSystem;
  effects: SystemEffect[];
  changed: boolean;
}

function apply(run: Run, instance: string, next: MachineSnapshot, effects: MachineEffect[], queue: Array<{ to: string; event: MachineEvent }>): void {
  const spec = run.system.specs[instance]!;
  const before = run.system.machines[instance];
  run.system = { ...run.system, machines: { ...run.system.machines, [instance]: next } };
  if (before !== next) run.changed = true;
  for (const effect of effects) {
    if (effect.type === "send") {
      for (const other of run.system.order) {
        if (other !== instance && handlesEvent(run.system.specs[other]!, effect.event.type)) queue.push({ to: other, event: effect.event });
      }
    } else {
      run.effects.push({ ...effect, instance });
    }
  }
  if (spec.persist && before) {
    const was = persisted(spec, before);
    const now = persisted(spec, next)!;
    if (!deepEqual(was, now)) {
      run.effects.push({ type: "persist", instance, storage: spec.persist.storage, key: spec.persist.key ?? instance, value: now });
    }
  }
}

function drain(run: Run, queue: Array<{ to: string; event: MachineEvent }>): void {
  let deliveries = 0;
  while (queue.length > 0) {
    if (++deliveries > DELIVERY_LIMIT) {
      run.effects.push({ type: "error", instance: queue[0]!.to, message: `stopped after ${DELIVERY_LIMIT} events between sections: two machines answer each other` });
      return;
    }
    const { to, event } = queue.shift()!;
    const spec = run.system.specs[to];
    const snapshot = run.system.machines[to];
    if (!spec || !snapshot) continue;
    const result = step(spec, snapshot, event, envOf(run.system));
    apply(run, to, result.snapshot, result.effects, queue);
  }
}

/** After a change to what the page shares, each machine sees it: `page.changed`, then its `always`. */
function settle(run: Run, from: Record<string, Json>): void {
  let before = from;
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const now = pageValues(run.system);
    if (deepEqual(before, now)) return;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((k) => !deepEqual(before[k], now[k]));
    before = now;
    const queue: Array<{ to: string; event: MachineEvent }> = [];
    for (const instance of run.system.order) {
      const spec = run.system.specs[instance]!;
      if (handlesEvent(spec, "page.changed") || hasAlways(spec)) queue.push({ to: instance, event: { type: "page.changed", keys } });
    }
    drain(run, queue);
  }
}

/** A page's machines at their first moment, each in its initial state. */
export function createSystem(entries: MachineEntry[], options: HostState & { page?: Record<string, Json> } = {}): SystemStep {
  let system: PageSystem = {
    specs: {},
    order: [],
    machines: {},
    free: { ...(options.page ?? {}) },
    host: { user: options.user ?? null, route: options.route ?? null },
  };
  const run: Run = { system, effects: [], changed: true };
  for (const entry of entries) {
    system = run.system;
    if (entry.instance in system.specs) throw new Error(`two machines on the page are "${entry.instance}"`);
    run.system = { ...system, specs: { ...system.specs, [entry.instance]: entry.spec }, order: [...system.order, entry.instance] };
    const first = initialStep(entry.spec, envOf(run.system));
    const queue: Array<{ to: string; event: MachineEvent }> = [];
    apply(run, entry.instance, first.snapshot, first.effects, queue);
    drain(run, queue);
  }
  settle(run, { ...(options.page ?? {}) });
  return { system: run.system, effects: run.effects, changed: true };
}

export interface DispatchOptions {
  /** Offer it to every other machine on the page too (`on.<event>.to: "page"`). */
  page?: boolean;
}

/**
 * An event from outside the machines: a press, a typed character, a request's answer, a delay that
 * ran out. `to` is the instance it is for; null offers it to the whole page.
 */
export function dispatch(system: PageSystem, to: string | null, event: MachineEvent, options: DispatchOptions = {}): SystemStep {
  const run: Run = { system, effects: [], changed: false };
  const before = pageValues(system);
  const queue: Array<{ to: string; event: MachineEvent }> = [];
  if (to !== null && system.specs[to]) queue.push({ to, event });
  if (to === null || options.page) {
    for (const other of system.order) {
      if (other !== to && handlesEvent(system.specs[other]!, event.type)) queue.push({ to: other, event });
    }
  }
  drain(run, queue);
  settle(run, before);
  return { system: run.system, effects: run.effects, changed: run.changed };
}

/** A value written on the page outside any machine: a tab pressed, a field typed in (ADR 0032). */
export function setPageValue(system: PageSystem, key: string, value: Json): SystemStep {
  if (deepEqual(system.free[key], value)) return { system, effects: [], changed: false };
  const before = pageValues(system);
  const run: Run = { system: { ...system, free: { ...system.free, [key]: value } }, effects: [], changed: true };
  settle(run, before);
  return { system: run.system, effects: run.effects, changed: true };
}

/**
 * A section's machine joining a page already running (a section drawn after the others, or the
 * browser taking over the server's): at the snapshot given, or its initial state.
 */
export function addMachine(system: PageSystem, entry: MachineEntry, snapshot?: MachineSnapshot): SystemStep {
  if (system.specs[entry.instance]) return { system, effects: [], changed: false };
  const before = pageValues(system);
  const run: Run = {
    system: { ...system, specs: { ...system.specs, [entry.instance]: entry.spec }, order: [...system.order, entry.instance] },
    effects: [],
    changed: true,
  };
  const queue: Array<{ to: string; event: MachineEvent }> = [];
  if (snapshot) {
    apply(run, entry.instance, snapshot, [], queue);
  } else {
    const first = initialStep(entry.spec, envOf(run.system));
    apply(run, entry.instance, first.snapshot, first.effects, queue);
  }
  drain(run, queue);
  settle(run, before);
  return { system: run.system, effects: run.effects, changed: true };
}

/** A section leaving the page: its requests and delays cancelled, its exports gone. */
export function removeMachine(system: PageSystem, instance: string): SystemStep {
  const snapshot = system.machines[instance];
  if (!snapshot) return { system, effects: [], changed: false };
  const before = pageValues(system);
  const { [instance]: _spec, ...specs } = system.specs;
  const { [instance]: _snap, ...machines } = system.machines;
  const run: Run = { system: { ...system, specs, machines, order: system.order.filter((i) => i !== instance) }, effects: [], changed: true };
  for (const id of snapshot.invokes) run.effects.push({ type: "cancel", instance, id });
  for (const id of snapshot.timers) run.effects.push({ type: "cancelTimer", instance, id });
  settle(run, before);
  return { system: run.system, effects: run.effects, changed: true };
}

/** A persisted machine's fields read back after the page is up. */
export function restoreMachine(system: PageSystem, instance: string, fields: Record<string, unknown>): SystemStep {
  const spec = system.specs[instance];
  const snapshot = system.machines[instance];
  if (!spec || !snapshot) return { system, effects: [], changed: false };
  const before = pageValues(system);
  const run: Run = { system, effects: [], changed: false };
  const result = restoreContext(spec, snapshot, fields, envOf(system));
  const queue: Array<{ to: string; event: MachineEvent }> = [];
  // a restore is not a change to persist again
  run.system = { ...run.system, machines: { ...run.system.machines, [instance]: result.snapshot } };
  run.changed = result.changed;
  for (const effect of result.effects) if (effect.type !== "send") run.effects.push({ ...effect, instance });
  drain(run, queue);
  settle(run, before);
  return { system: run.system, effects: run.effects, changed: run.changed };
}

/** What the browser starts for the machines the server drew: their delays and requests. */
export function resumeSystem(system: PageSystem, instance?: string): SystemEffect[] {
  const out: SystemEffect[] = [];
  for (const id of instance ? [instance] : system.order) {
    const spec = system.specs[id];
    const snapshot = system.machines[id];
    if (!spec || !snapshot) continue;
    for (const effect of resumeEffects(spec, snapshot, envOf(system))) if (effect.type !== "send") out.push({ ...effect, instance: id });
  }
  return out;
}

/** The JSON part of a system, for the server to hand the browser. */
export function systemSnapshot(system: PageSystem): SystemSnapshot {
  return { order: system.order, machines: system.machines, free: system.free, host: system.host };
}

// ---------------------------------------------------------------------------
// What a node reads
// ---------------------------------------------------------------------------

/** The roots a node reads state under. `$user` and `$route` are fixed for a page; the rest change. */
export const STATE_ROOTS = ["$state", "$page", "$entry", "$user", "$route"] as const;
/** The roots whose values change in the browser: a node reading one is redrawn there. */
export const LIVE_ROOTS = ["$state", "$page", "$entry", "_page"] as const;

const rootOf = (path: string) => path.split(".")[0] ?? "";

/** Does this path read something that changes in the browser? */
export const isLivePath = (path: string): boolean => (LIVE_ROOTS as readonly string[]).includes(rootOf(path));

/** Does this path read a machine, the page, or the host? */
export const isStatePath = (path: string): boolean =>
  (STATE_ROOTS as readonly string[]).includes(rootOf(path)) || rootOf(path) === "_page";

/**
 * The scope a node of `instance`'s section reads state in, merged over its data:
 *
 *   $state.active    every active state path (`drawer.open`): `{ path: "$state.active", has: "drawer.open" }`
 *   $state.tags      the tags of the active states
 *   $state.value     the state value, as XState writes it
 *   $state.context   what the machine remembers
 *   $state.computed  what it derives
 *   $page.<key>      what any section shares, and the page's choices (also `_page.<key>`)
 *   $user, $route    the host's
 */
export function stateScope(system: SystemSnapshot, instance: string | undefined): Record<string, unknown> {
  const page = pageValues(system);
  const own = instance === undefined ? undefined : system.machines[instance];
  return {
    $state: own
      ? { active: own.active, tags: own.tags, value: own.value, context: own.context, computed: own.computed }
      : { active: [], tags: [], value: {}, context: {}, computed: {} },
    $page: page,
    _page: page,
    $user: system.host.user,
    $route: system.host.route,
  };
}
