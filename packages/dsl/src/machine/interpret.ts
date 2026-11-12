/**
 * A section's machine, run by XState v5: our JSON spec in, an XState machine out, and its PURE
 * transitions (`initialTransition`, `transition`), which compute the next snapshot and return the
 * actions without running any. So the same code runs on the server (the first paint is the
 * machine's initial state, its effects left for the browser), in the browser, in a test and in
 * SCRE, and nothing here waits, fetches or touches a timer: a request the machine makes, a delay it
 * waits for, a tracking event it fires, are EFFECTS the runtime carries out, and their answers come
 * back as events.
 *
 * What is ours, on top of XState:
 *
 * - Guards and actions are JSON. A guard is an expression (`expr.ts`) run by one guard, `expr`; the
 *   actions are a closed set (`schema.ts`), each mapped onto an XState built-in (`assign`, `raise`,
 *   `enqueueActions`) or onto one action, `effect`, that XState returns and we turn into an effect.
 * - Expressions read the page and the host (`$page`, `$user`, `$route`) besides the machine's own
 *   context and the event; XState hands a guard only those two, so the rest is set for the length
 *   of one synchronous call (`scopeFor`).
 * - `computed` and `exports` are derived after every step.
 * - A state's `invoke` names a request the HOST runs (its action route, with the fan's session):
 *   entering the state is a `request` effect, leaving it a `cancel`, and the answer comes back as
 *   `done.invoke.<path>` or `error.invoke.<path>`. An answer to a request no longer waited for is
 *   dropped.
 *
 * Semantics are XState's (SCXML's): note that a target in ANOTHER region of a parallel state leaves
 * and re-enters the regions between, so the source's own region starts again. Move another region
 * with an event, not a target (`machineIssues` warns).
 *
 * PURE.
 */

import {
    assign,
  enqueueActions,
  initialTransition,
  raise,
  setup,
  type AnyMachineSnapshot,
  transition as xTransition,
} from "xstate";
import { evaluate, ExprError, isTruthy, type Json, writePath } from "./expr.js";
import type { MachineAction, MachineEvent, MachineSpec, RequestSpec, StateNodeSpec, TransitionSpec, TransitionsSpec } from "./schema.js";

// ---------------------------------------------------------------------------
// Snapshots and effects
// ---------------------------------------------------------------------------

/** A state value as XState writes it: a region's state name, or an object of its regions. */
export type StateValue = string | { [region: string]: StateValue };

/** Everything a machine is, at one moment, as JSON: what the server hands the browser. */
export interface MachineSnapshot {
  /** Every active state's path, in document order: `drawer`, `drawer.open`. */
  active: string[];
  value: StateValue;
  context: Record<string, Json>;
  computed: Record<string, Json>;
  /** What the machine shares with the page, by key. */
  exports: Record<string, Json>;
  tags: string[];
  /** The states whose request is in flight, by path. */
  invokes: string[];
  /** The delays being waited for, by the event they raise. */
  timers: string[];
}

/** What the runtime is asked to do. `instance` is filled in by the page system. */
export type MachineEffect =
  /** A host action (`action`) or more of a data source the section reads (`source`): one of the two. */
  | { type: "request"; id: string; request: string; action?: string; source?: string; input: Json }
  | { type: "cancel"; id: string }
  | { type: "timer"; id: string; ms: number; event: MachineEvent }
  | { type: "cancelTimer"; id: string }
  | { type: "send"; event: MachineEvent }
  | { type: "emit"; name: string; params: Record<string, Json> }
  | { type: "navigate"; href: string; external: boolean }
  | { type: "call"; action: string; input: Json }
  | { type: "focus"; node: string }
  | { type: "scrollTo"; node: string }
  | { type: "error"; message: string };

/** What a machine's expressions read besides its own state: the page and the host. */
export interface MachineEnv {
  /** Every value the page's sections share (`exports`), and choices written outside any machine. */
  page?: Record<string, Json>;
  /** The signed-in fan, or null: `$user`. */
  user?: Json;
  /** The page being shown: `$route`. */
  route?: Json;
}

export interface Step {
  snapshot: MachineSnapshot;
  effects: MachineEffect[];
  /** Whether anything in the snapshot changed. */
  changed: boolean;
}

/** What a request runs, as its effect says it: a host action or a data source. */
const runs = (request: RequestSpec): { action: string } | { source: string } =>
  request.source !== undefined ? { source: request.source } : { action: request.action ?? "" };

/** The events a request's answer comes back as. */
export const doneInvoke = (path: string) => `done.invoke.${path}`;
export const errorInvoke = (path: string) => `error.invoke.${path}`;

export class MachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineError";
  }
}

// ---------------------------------------------------------------------------
// The scope of one call
// ---------------------------------------------------------------------------

/** The XState id of every machine: absolute targets are `#machine.<path>`. */
const MACHINE_ID = "machine";

interface CallScope {
  spec: MachineSpec;
  env: MachineEnv;
  /** The states active when the event arrived. */
  active: string[];
  tags: string[];
  errors: string[];
}

/**
 * XState hands a guard or an action only the context and the event. What else an expression reads
 * (the page, the host, the states active) is set here for the length of one call; every call into
 * XState is synchronous, so no other call can see it.
 */
let call: CallScope | undefined;

function within<T>(scope: CallScope, fn: () => T): T {
  const outer = call;
  call = scope;
  try {
    return fn();
  } finally {
    call = outer;
  }
}

function computedOf(spec: MachineSpec, context: Record<string, Json>, scope: Record<string, unknown>, errors: string[]): Record<string, Json> {
  let computed: Record<string, Json> = {};
  for (const [name, expr] of Object.entries(spec.computed ?? {})) {
    let value: Json = null;
    try {
      value = evaluate(expr, { ...scope, context, computed });
    } catch (e) {
      errors.push(`computed ${name}: ${messageOf(e)}`);
    }
    computed = { ...computed, [name]: value };
  }
  return computed;
}

const messageOf = (e: unknown) => (e instanceof ExprError ? e.message : e instanceof Error ? e.message : String(e));

/** The scope an expression is evaluated in, for a context and an event. */
function scopeFor(context: Record<string, Json>, event: unknown): Record<string, unknown> {
  const c = call;
  const base = {
    context,
    event,
    state: { active: c?.active ?? [], tags: c?.tags ?? [] },
    $page: c?.env.page ?? {},
    $user: c?.env.user ?? null,
    $route: c?.env.route ?? null,
  };
  return { ...base, computed: c ? computedOf(c.spec, context, base, c.errors) : {} };
}

function safeEval(expr: unknown, context: Record<string, Json>, event: unknown, what: string): Json {
  try {
    return evaluate(expr, scopeFor(context, event));
  } catch (e) {
    call?.errors.push(`${what}: ${messageOf(e)}`);
    return null;
  }
}

const evalPayload = (payload: Record<string, unknown> | undefined, context: Record<string, Json>, event: unknown) => {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(payload ?? {})) out[k] = safeEval(v, context, event, `payload ${k}`);
  return out;
};

// ---------------------------------------------------------------------------
// Our spec as an XState machine
// ---------------------------------------------------------------------------

type Ctx = Record<string, Json>;
interface ActionArgs {
  context: Ctx;
  event: { type: string };
}

/** The params of an `effect` action: what it asks the runtime to do, already evaluated. */
type EffectParams = Exclude<MachineEffect, { type: "timer" | "cancelTimer" | "error" }>;

const effect = (make: (args: ActionArgs) => EffectParams) => ({ type: "effect" as const, params: make as never });

/** One of our actions as XState actions (built-ins, or `effect`, which XState hands back to us). */
function xAction(action: MachineAction): unknown {
  if ("assign" in action) {
    const values = action.assign;
    return assign(({ context, event }: ActionArgs) => {
      // every value read against the context before the action: the order of the fields is free
      const computed = Object.entries(values).map(([path, expr]) => [path, safeEval(expr, context, event, `assign ${path}`)] as const);
      let next: unknown = context;
      for (const [path, value] of computed) next = writePath(next, path, value);
      return next as Ctx;
    });
  }
  if ("raise" in action) {
    const { event: type, payload } = action.raise;
    return raise(({ context, event }: ActionArgs) => ({ ...evalPayload(payload, context, event), type }));
  }
  if ("send" in action) {
    const { event: type, payload } = action.send;
    return effect(({ context, event }) => ({ type: "send", event: { ...evalPayload(payload, context, event), type } }));
  }
  if ("emit" in action) {
    const { name, params } = action.emit;
    return effect(({ context, event }) => ({ type: "emit", name, params: evalPayload(params, context, event) }));
  }
  if ("navigate" in action) {
    const { href, external } = action.navigate;
    return effect(({ context, event }) => ({ type: "navigate", href: String(safeEval(href, context, event, "navigate") ?? ""), external: external === true }));
  }
  if ("call" in action) {
    const { action: name, input } = action.call;
    return effect(({ context, event }) => ({ type: "call", action: name, input: input === undefined ? null : safeEval(input, context, event, `call ${name}`) }));
  }
  if ("focus" in action) {
    const node = action.focus;
    return effect(() => ({ type: "focus", node }));
  }
  if ("scrollTo" in action) {
    const node = action.scrollTo;
    return effect(() => ({ type: "scrollTo", node }));
  }
  const { cond, then, else: otherwise } = action.if;
  return enqueueActions(({ context, event, enqueue }: ActionArgs & { enqueue: (a: never) => void }) => {
    const holds = isTruthy(safeEval(cond, context, event, "if"));
    for (const a of holds ? then : (otherwise ?? [])) enqueue(xAction(a) as never);
  });
}

const xActions = (actions: MachineAction[] | undefined) => (actions ?? []).map(xAction);

const transitionsOf = (spec: TransitionsSpec | undefined): TransitionSpec[] =>
  spec === undefined
    ? []
    : (Array.isArray(spec) ? spec : [spec]).map((t) => (typeof t === "string" ? { target: t } : t));

const childPath = (parent: string, name: string) => (parent ? `${parent}.${name}` : name);

/** The state path a target names, from the state the transition is on (see `TransitionSpec`). */
export function targetPath(source: string, target: string): string {
  if (target.startsWith("#")) return target.slice(1);
  if (target.startsWith(".")) return childPath(source, target.slice(1));
  if (source === "") return target;
  const parent = source.includes(".") ? source.slice(0, source.lastIndexOf(".")) : "";
  return childPath(parent, target);
}

interface Built {
  // biome-ignore lint/suspicious/noExplicitAny: built from JSON, typed by our schema, not XState's generics
  machine: any;
  /** Every state path, in document order (the root left out). */
  paths: string[];
  /** Every event type some state handles. */
  handles: Set<string>;
  hasAlways: boolean;
  /** Each invoking state's path, and what it invokes. */
  invokes: Map<string, NonNullable<StateNodeSpec["invoke"]>>;
  /** Each delay's event, and its milliseconds. */
  delays: Map<string, number>;
}

const cache = new WeakMap<object, Built>();

/** Our spec as an XState machine (cached per spec object). Throws `MachineError` on a bad spec. */
export function build(spec: MachineSpec): Built {
  const hit = cache.get(spec);
  if (hit) return hit;
  const paths: string[] = [];
  const handles = new Set<string>();
  const invokes = new Map<string, NonNullable<StateNodeSpec["invoke"]>>();
  const delays = new Map<string, number>();
  let hasAlways = false;

  const xTransitions = (source: string, t: TransitionsSpec | undefined) =>
    transitionsOf(t).map((x) => ({
      ...(x.target === undefined
        ? {}
        : { target: (Array.isArray(x.target) ? x.target : [x.target]).map((to) => `#${MACHINE_ID}${targetPath(source, to) ? `.${targetPath(source, to)}` : ""}`) }),
      ...(x.guard === undefined ? {} : { guard: { type: "expr", params: { expr: x.guard, source } } }),
      ...(x.actions ? { actions: xActions(x.actions) } : {}),
      ...(x.reenter ? { reenter: true } : {}),
    }));

  const node = (s: StateNodeSpec, path: string, isRoot: boolean): Record<string, unknown> => {
    const states: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(s.states ?? {})) {
      const p = childPath(path, name);
      paths.push(p);
      states[name] = node(child, p, false);
    }
    const on: Record<string, unknown> = {};
    for (const [event, t] of Object.entries(s.on ?? {})) {
      handles.add(event);
      on[event] = xTransitions(path, t);
    }
    const entry = xActions(s.entry);
    const exit = xActions(s.exit);
    if (s.invoke) {
      const request = spec.requests?.[s.invoke.request];
      if (!request) throw new MachineError(`"${path}" invokes "${s.invoke.request}", which the machine does not declare in requests`);
      if (isRoot) throw new MachineError("the root cannot invoke: put the request on a state");
      invokes.set(path, s.invoke);
      const input = s.invoke.input;
      const name = s.invoke.request;
      entry.push(
        effect(({ context, event }) => ({
          type: "request",
          id: path,
          request: name,
          ...runs(request),
          input: input === undefined ? null : safeEval(input, context, event, `input of ${name}`),
        })),
      );
      exit.unshift(effect(() => ({ type: "cancel", id: path })));
      if (s.invoke.onDone) {
        handles.add(doneInvoke(path));
        on[doneInvoke(path)] = xTransitions(path, s.invoke.onDone);
      }
      if (s.invoke.onError) {
        handles.add(errorInvoke(path));
        on[errorInvoke(path)] = xTransitions(path, s.invoke.onError);
      }
    }
    const after: Record<string, unknown> = {};
    for (const [ms, t] of Object.entries(s.after ?? {})) {
      delays.set(`xstate.after.${ms}.${MACHINE_ID}${path ? `.${path}` : ""}`, Number(ms));
      after[ms] = xTransitions(path, t);
    }
    if (s.always) hasAlways = true;
    const type = isRoot ? (s.type ?? "parallel") : s.type;
    return {
      ...(type && !(type === "compound" && !s.states) ? { type: type === "compound" ? "compound" : type } : {}),
      ...(s.initial ? { initial: s.initial } : {}),
      ...(Object.keys(states).length ? { states } : {}),
      ...(Object.keys(on).length ? { on } : {}),
      ...(entry.length ? { entry } : {}),
      ...(exit.length ? { exit } : {}),
      ...(s.always ? { always: xTransitions(path, s.always) } : {}),
      ...(Object.keys(after).length ? { after } : {}),
      ...(s.onDone ? { onDone: xTransitions(path, s.onDone) } : {}),
      ...(s.tags?.length ? { tags: s.tags } : {}),
    };
  };

  // biome-ignore lint/suspicious/noExplicitAny: see Built.machine
  let machine: any;
  try {
    const root = node(spec as StateNodeSpec, "", true);
    // a compound state with several children and no initial is XState's to refuse; say which
    for (const p of ["", ...paths]) {
      const s = p === "" ? (spec as StateNodeSpec) : stateAt(spec, p);
      const kids = Object.keys(s?.states ?? {});
      const kind = p === "" ? (spec.type ?? "parallel") : (s?.type ?? "compound");
      if (kind === "compound" && kids.length > 1 && !s?.initial) throw new MachineError(`"${p || "root"}" has ${kids.length} states and no initial`);
      if (s?.initial && !kids.includes(s.initial)) throw new MachineError(`"${p || "root"}" starts at "${s.initial}", which is not one of its states`);
    }
    for (const [p, t] of allTransitions(spec)) {
      for (const to of t.target === undefined ? [] : Array.isArray(t.target) ? t.target : [t.target]) {
        const target = targetPath(p, to);
        if (target !== "" && !paths.includes(target)) {
          throw new MachineError(`a transition on "${p || "root"}" goes to "${to}", which is no state`);
        }
      }
    }
    machine = setup({
      guards: {
        expr: ({ context, event }: ActionArgs, params: { expr: unknown; source: string }) => {
          try {
            return isTruthy(evaluate(params.expr, scopeFor(context, event)));
          } catch (e) {
            call?.errors.push(`guard on "${params.source || "root"}": ${messageOf(e)}`);
            return false;
          }
        },
      },
      actions: {
        // handed back by the pure transition and carried out by the runtime
        effect: () => {},
      },
    } as never).createMachine({ id: MACHINE_ID, context: structuredClone(spec.context ?? {}), ...root } as never);
  } catch (e) {
    if (e instanceof MachineError) throw e;
    throw new MachineError(messageOf(e));
  }
  const built = { machine, paths, handles, hasAlways, invokes, delays };
  cache.set(spec, built);
  return built;
}

/** The spec of the state at a path. */
export function stateAt(spec: MachineSpec, path: string): StateNodeSpec | undefined {
  let s: StateNodeSpec | undefined = spec as StateNodeSpec;
  for (const name of path.split(".")) s = s?.states?.[name];
  return s;
}

/** Every transition in a spec, with the path of the state it is on. */
export function allTransitions(spec: MachineSpec): Array<[string, TransitionSpec]> {
  const out: Array<[string, TransitionSpec]> = [];
  const walk = (s: StateNodeSpec, path: string) => {
    for (const t of Object.values(s.on ?? {})) for (const x of transitionsOf(t)) out.push([path, x]);
    for (const x of transitionsOf(s.always)) out.push([path, x]);
    for (const t of Object.values(s.after ?? {})) for (const x of transitionsOf(t)) out.push([path, x]);
    for (const x of transitionsOf(s.onDone)) out.push([path, x]);
    for (const x of transitionsOf(s.invoke?.onDone)) out.push([path, x]);
    for (const x of transitionsOf(s.invoke?.onError)) out.push([path, x]);
    for (const [name, child] of Object.entries(s.states ?? {})) walk(child, childPath(path, name));
  };
  walk(spec as StateNodeSpec, "");
  return out;
}

/** Whether the machine has any transition for this event type. */
export const handlesEvent = (spec: MachineSpec, type: string): boolean => build(spec).handles.has(type);

/** Whether the machine has eventless transitions, which may move when the page changes. */
export const hasAlways = (spec: MachineSpec): boolean => build(spec).hasAlways;

/** Every state path a machine has, in document order (the root left out). */
export const statePaths = (spec: MachineSpec): string[] => build(spec).paths;

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** The active state paths of a state value, in document order. */
function activeOf(paths: string[], value: unknown): string[] {
  const on = new Set<string>();
  const walk = (v: unknown, prefix: string) => {
    if (typeof v === "string") {
      on.add(childPath(prefix, v));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, sub] of Object.entries(v)) {
        const p = childPath(prefix, k);
        on.add(p);
        walk(sub, p);
      }
    }
  };
  walk(value, "");
  return paths.filter((p) => on.has(p));
}

interface XAction {
  type: string;
  params?: unknown;
}

/** XState's returned actions as our effects; the in-flight requests and delays kept up to date. */
function effectsOf(b: Built, actions: XAction[], invokes: Set<string>, timers: Set<string>): MachineEffect[] {
  const out: MachineEffect[] = [];
  for (const a of actions) {
    if (a.type === "effect") {
      const e = a.params as EffectParams;
      if (e.type === "request") invokes.add(e.id);
      if (e.type === "cancel" && !invokes.delete(e.id)) continue;
      if (e.type === "navigate" && !e.href) continue;
      out.push(e);
    } else if (a.type === "xstate.raise") {
      // a raise with no delay XState has already handled; one with a delay is a timer
      const p = a.params as { event: MachineEvent; id?: string; delay?: number };
      if (p.delay === undefined) continue;
      const id = p.id ?? p.event.type;
      timers.add(id);
      out.push({ type: "timer", id, ms: p.delay, event: p.event });
    } else if (a.type === "xstate.cancel") {
      const id = (a.params as { sendId: string }).sendId;
      if (timers.delete(id)) out.push({ type: "cancelTimer", id });
    }
  }
  return out;
}

function snapshotOf(b: Built, spec: MachineSpec, x: AnyMachineSnapshot, invokes: Set<string>, timers: Set<string>, env: MachineEnv, errors: string[]): MachineSnapshot {
  const context = x.context as Ctx;
  const active = activeOf(b.paths, x.value);
  const tags = [...(x.tags as Set<string>)].sort();
  const scope = within({ spec, env, active, tags, errors }, () => scopeFor(context, { type: "machine.snapshot" }));
  const computed = scope.computed as Record<string, Json>;
  const exports: Record<string, Json> = {};
  for (const [key, expr] of Object.entries(spec.exports ?? {})) {
    try {
      exports[key] = evaluate(expr, scope);
    } catch (e) {
      errors.push(`export ${key}: ${messageOf(e)}`);
      exports[key] = null;
    }
  }
  return {
    active,
    value: x.value as StateValue,
    context,
    computed,
    exports,
    tags,
    invokes: [...invokes].sort(),
    timers: [...timers].sort(),
  };
}

const withErrors = (effects: MachineEffect[], errors: string[]): MachineEffect[] => [
  ...effects,
  ...[...new Set(errors)].map((message): MachineEffect => ({ type: "error", message })),
];

/** A machine's first moment: its initial states entered, their entry actions run. */
export function initialStep(spec: MachineSpec, env: MachineEnv = {}): Step {
  const b = build(spec);
  const errors: string[] = [];
  const invokes = new Set<string>();
  const timers = new Set<string>();
  const [x, actions] = within({ spec, env, active: [], tags: [], errors }, () => initialTransition(b.machine));
  const effects = effectsOf(b, actions as XAction[], invokes, timers);
  const snapshot = snapshotOf(b, spec, x as AnyMachineSnapshot, invokes, timers, env, errors);
  return { snapshot, effects: withErrors(effects, errors), changed: true };
}

const resolved = (b: Built, snapshot: MachineSnapshot) => b.machine.resolveState({ value: snapshot.value as never, context: snapshot.context });

/** The machine's answer to one event. An answer to a request it no longer waits for is dropped. */
export function step(spec: MachineSpec, snapshot: MachineSnapshot, event: MachineEvent, env: MachineEnv = {}): Step {
  const b = build(spec);
  const invokes = new Set(snapshot.invokes);
  const timers = new Set(snapshot.timers);
  // late answers: a request cancelled by leaving its state, a delay whose state was left
  const answered = /^(?:done|error)\.invoke\.(.+)$/.exec(event.type)?.[1];
  if (answered !== undefined && !invokes.delete(answered)) return { snapshot, effects: [], changed: false };
  if (event.type.startsWith("xstate.after.") && !timers.delete(event.type)) return { snapshot, effects: [], changed: false };
  const errors: string[] = [];
  const [x, actions] = within({ spec, env, active: snapshot.active, tags: snapshot.tags, errors }, () =>
    xTransition(b.machine, resolved(b, snapshot), event as never),
  );
  const effects = effectsOf(b, actions as XAction[], invokes, timers);
  const next = snapshotOf(b, spec, x as AnyMachineSnapshot, invokes, timers, env, errors);
  const changed = JSON.stringify(next) !== JSON.stringify(snapshot);
  return { snapshot: changed ? next : snapshot, effects: withErrors(effects, errors), changed };
}

/**
 * Context fields written from outside the machine's own steps: a persisted cart read back from
 * storage after the page is up. Only fields the machine declares are taken; eventless transitions
 * then run, so a state derived from them follows.
 */
export function restoreContext(spec: MachineSpec, snapshot: MachineSnapshot, fields: Record<string, unknown>, env: MachineEnv = {}): Step {
  const known = new Set(Object.keys(spec.context ?? {}));
  let context = snapshot.context;
  for (const [k, v] of Object.entries(fields)) if (known.has(k)) context = { ...context, [k]: v as Json };
  return step(spec, { ...snapshot, context }, { type: "machine.restore" }, env);
}

/**
 * What the browser has to start for a snapshot the server drew: each delay and each request the
 * active states wait on. The server computes the first moment and carries out none of its effects.
 */
export function resumeEffects(spec: MachineSpec, snapshot: MachineSnapshot, env: MachineEnv = {}): MachineEffect[] {
  const b = build(spec);
  const out: MachineEffect[] = [];
  for (const id of snapshot.timers) {
    const ms = b.delays.get(id);
    if (ms !== undefined) out.push({ type: "timer", id, ms, event: { type: id } });
  }
  const errors: string[] = [];
  for (const path of snapshot.invokes) {
    const invoke = b.invokes.get(path);
    const request = invoke ? spec.requests?.[invoke.request] : undefined;
    if (!invoke || !request) continue;
    const input =
      invoke.input === undefined
        ? null
        : within({ spec, env, active: snapshot.active, tags: snapshot.tags, errors }, () =>
            safeEval(invoke.input, snapshot.context, { type: "machine.resume" }, `input of ${invoke.request}`),
          );
    out.push({ type: "request", id: path, request: invoke.request, ...runs(request), input });
  }
  return withErrors(out, errors);
}
