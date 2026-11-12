/**
 * A section's machine, as JSON: what the section remembers, the states it moves between, and what
 * a person's press, a request's answer or another section's event does to it.
 *
 * Shaped like an XState v5 config (the names mean what they mean there), with three differences:
 * it is JSON only (guards and actions are expressions and a closed set of actions, never code), a
 * machine's root is PARALLEL by default (each region a tab group, a drawer, a menu, a request), and
 * a machine names what it shares with the page (`exports`) instead of being reached into.
 *
 *   {
 *     "context":  { "selected": [] },
 *     "computed": { "count": { "len": { "var": "context.selected" } } },
 *     "exports":  { "followed": { "var": "context.selected" } },
 *     "states": {
 *       "drawer": {
 *         "initial": "closed",
 *         "states": {
 *           "closed": { "on": { "drawer.open": "open" } },
 *           "open":   { "on": { "drawer.close": "closed", "key.escape": "closed" } }
 *         }
 *       }
 *     },
 *     "on": {
 *       "player.toggle": { "actions": [{ "assign": { "selected": { "toggle": [{ "var": "context.selected" }, { "var": "event.id" }] } } }] }
 *     }
 *   }
 *
 * A machine lives on the root node of its section's tree (`props.machine`), so it travels with the
 * tree wherever the tree is stored.
 *
 * PURE.
 */

import { z } from "zod";

/** A state's name: one segment of a state path. */
export const STATE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** An event's type: dotted words, `drawer.open`, `cart.add`. */
export const EVENT_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
/** A context field, a computed value, an export: one name. */
export const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A path into context for `assign`: `draft`, `form.email`, `lines.0.qty`. */
export const ASSIGN_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/;
/** A host action a request or `call` names: `fan_prefs.save`, `auth.logout`. */
export const HOST_ACTION_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const exprSchema = z.unknown();
const eventType = z.string().regex(EVENT_TYPE_RE, "an event type is dotted words: drawer.open");
const payloadSchema = z.record(z.string().regex(FIELD_NAME_RE), exprSchema);

/**
 * What a transition does besides moving: a closed set, each an object with one key.
 *
 * - `assign`   write context fields (a path each), every expression read against the state before
 * - `raise`    an event to this machine, handled after this one
 * - `send`     an event to the page: every other machine that handles it, in page order
 * - `emit`     a tracking event, by meaning (`player_followed`); the tenant's config maps it to sinks
 * - `navigate` go to a URL the expression builds
 * - `call`     a host action, fire and forget (`auth.logout`); its answer is not awaited
 * - `focus`    move keyboard focus to a node of this section (by node id)
 * - `scrollTo` bring a node of this section into view
 * - `if`       actions on a condition: `{ cond, then, else? }`
 */
export type MachineAction =
  | { assign: Record<string, unknown> }
  | { raise: { event: string; payload?: Record<string, unknown> } }
  | { send: { event: string; payload?: Record<string, unknown> } }
  | { emit: { name: string; params?: Record<string, unknown> } }
  | { navigate: { href: unknown; external?: boolean } }
  | { call: { action: string; input?: unknown } }
  | { focus: string }
  | { scrollTo: string }
  | { if: { cond: unknown; then: MachineAction[]; else?: MachineAction[] } };

export const ACTION_NAMES = ["assign", "raise", "send", "emit", "navigate", "call", "focus", "scrollTo", "if"] as const;

export const actionSchema: z.ZodType<MachineAction> = z.lazy(
  () =>
  z.union([
    z.object({ assign: z.record(z.string().regex(ASSIGN_PATH_RE, "a path into context"), exprSchema) }).strict(),
    z.object({ raise: z.object({ event: eventType, payload: payloadSchema.optional() }).strict() }).strict(),
    z.object({ send: z.object({ event: eventType, payload: payloadSchema.optional() }).strict() }).strict(),
    z
      .object({
        emit: z
          .object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/, "a tracking event is snake_case"), params: payloadSchema.optional() })
          .strict(),
      })
      .strict(),
    z.object({ navigate: z.object({ href: exprSchema, external: z.boolean().optional() }).strict() }).strict(),
    z.object({ call: z.object({ action: z.string().regex(HOST_ACTION_RE, "a host action is dotted: auth.logout"), input: exprSchema.optional() }).strict() }).strict(),
    z.object({ focus: z.string().min(1) }).strict(),
    z.object({ scrollTo: z.string().min(1) }).strict(),
    z
      .object({ if: z.object({ cond: exprSchema, then: z.array(actionSchema), else: z.array(actionSchema).optional() }).strict() })
      .strict(),
  ]) as z.ZodType<MachineAction>,
);

/**
 * Where a transition goes:
 *
 * - `"open"`        a sibling of the state the transition is on (`"open.idle"` a state inside it)
 * - `".step2"`      a child of the state the transition is on
 * - `"#drawer.open"` a path from the machine's root
 *
 * On the machine's root, a bare name is a child of the root (the root has no siblings).
 */
export interface TransitionSpec {
  target?: string | string[];
  /** An expression; the transition is taken only when it is truthy. */
  guard?: unknown;
  actions?: MachineAction[];
  /** With a target inside the source state: leave and enter the source again (default: stay). */
  reenter?: boolean;
}
export type TransitionsSpec = string | TransitionSpec | Array<string | TransitionSpec>;

const transitionSchema: z.ZodType<TransitionSpec> = z
  .object({
    target: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    guard: exprSchema.optional(),
    actions: z.array(actionSchema).optional(),
    reenter: z.boolean().optional(),
  })
  .strict();

const transitionsSchema: z.ZodType<TransitionsSpec> = z.union([
  z.string().min(1),
  transitionSchema,
  z.array(z.union([z.string().min(1), transitionSchema])).min(1),
]);

/**
 * A request a state makes while it is active: the POST behind a SAVE. The host runs it (its
 * action route resolves the tenant and the signed-in fan, then calls the real endpoint); the
 * machine never holds a URL or a credential. Leaving the state cancels it, and an answer that
 * arrives after is dropped.
 */
export interface InvokeSpec {
  /** A request the machine declares in `requests`. */
  request: string;
  /** Its body, an expression over the state. */
  input?: unknown;
  /** On the answer: `event.output` is what the host returned. */
  onDone?: TransitionsSpec;
  /** On a failure: `event.error` is `{ message, status? }`. */
  onError?: TransitionsSpec;
}

const invokeSchema: z.ZodType<InvokeSpec> = z
  .object({
    request: z.string().regex(FIELD_NAME_RE),
    input: exprSchema.optional(),
    onDone: transitionsSchema.optional(),
    onError: transitionsSchema.optional(),
  })
  .strict();

export type StateType = "compound" | "parallel" | "final";

export interface StateNodeSpec {
  type?: StateType;
  /** A compound state's first child, entered when the state is (required when it has children). */
  initial?: string;
  states?: Record<string, StateNodeSpec>;
  on?: Record<string, TransitionsSpec>;
  entry?: MachineAction[];
  exit?: MachineAction[];
  /** Taken as soon as its guard holds, with no event: a derived state. */
  always?: TransitionsSpec;
  /** Taken once the state has been active this long: `{ "3000": "hidden" }` (milliseconds). */
  after?: Record<string, TransitionsSpec>;
  invoke?: InvokeSpec;
  /** Taken when the state is done: a compound state's final child entered, or every region's. */
  onDone?: TransitionsSpec;
  /** Names a node can test (`$state.tags`), shared by states that look alike: `busy`. */
  tags?: string[];
}

const stateNodeSchema: z.ZodType<StateNodeSpec> = z.lazy(() =>
  z
    .object({
      type: z.enum(["compound", "parallel", "final"]).optional(),
      initial: z.string().regex(STATE_NAME_RE).optional(),
      states: z.record(z.string().regex(STATE_NAME_RE, "a state's name is one word"), stateNodeSchema).optional(),
      on: z.record(eventType, transitionsSchema).optional(),
      entry: z.array(actionSchema).optional(),
      exit: z.array(actionSchema).optional(),
      always: transitionsSchema.optional(),
      after: z.record(z.string().regex(/^\d+$/, "a delay is whole milliseconds"), transitionsSchema).optional(),
      invoke: invokeSchema.optional(),
      onDone: transitionsSchema.optional(),
      tags: z.array(z.string().regex(FIELD_NAME_RE)).optional(),
    })
    .strict(),
);

/**
 * What a request runs: a host action, or a data source the section reads. One of the two.
 *
 * A source is the section's own data (`photos`, the name its refs start with: `{photos.title}`), run
 * again with the request's input over the inputs it was bound with (the next page of a list behind
 * LOAD MORE). What it answers is added to what the page holds of that source (`addToSource`: lists
 * appended, the rest replaced), and the nodes reading it draw again. The machine never holds it, as
 * it never holds server data: it holds which page it asked for, and its answer is only that the
 * request ended (`done.invoke.<state>`, or `error.invoke.<state>`).
 */
export interface RequestSpec {
  /** The host action that runs it: `fan_prefs.save`. A person approves each write action once. */
  action?: string;
  /** A data source the section reads, run again for more of it: `photos`. */
  source?: string;
  /** What it does, for the approval and for Studio. */
  description?: string;
}

export const requestSchema: z.ZodType<RequestSpec> = z
  .object({
    action: z.string().regex(HOST_ACTION_RE, "a host action is dotted: fan_prefs.save").optional(),
    source: z.string().regex(FIELD_NAME_RE, "a data source is the name the section's refs start with: photos").optional(),
    description: z.string().optional(),
  })
  .strict()
  .refine((r) => (r.action === undefined) !== (r.source === undefined), {
    message: "a request runs a host action (action) or a data source the section reads (source): one of the two",
  });

/** Where a machine's context survives a reload: the fan's cart, the draft of a long form. */
export interface PersistSpec {
  storage: "local" | "session";
  /** The context fields kept. */
  fields: string[];
  /** The storage key; defaults to the machine's instance. */
  key?: string;
}

export interface MachineSpec extends Omit<StateNodeSpec, "type"> {
  /** The root: regions side by side (default), or one state at a time. */
  type?: "parallel" | "compound";
  /** What the section remembers, as JSON, before anything happens. */
  context?: Record<string, unknown>;
  /** Values derived from the state, recomputed after every change, in order: `$state.computed.<name>`. */
  computed?: Record<string, unknown>;
  /** Values the section shares with the page, by a page-wide key: `$page.<key>` in any section. */
  exports?: Record<string, unknown>;
  requests?: Record<string, RequestSpec>;
  persist?: PersistSpec;
}

export const machineSchema: z.ZodType<MachineSpec> = z
  .object({
    type: z.enum(["parallel", "compound"]).optional(),
    initial: z.string().regex(STATE_NAME_RE).optional(),
    states: z.record(z.string().regex(STATE_NAME_RE, "a state's name is one word"), stateNodeSchema).optional(),
    on: z.record(eventType, transitionsSchema).optional(),
    entry: z.array(actionSchema).optional(),
    exit: z.array(actionSchema).optional(),
    always: transitionsSchema.optional(),
    after: z.record(z.string().regex(/^\d+$/), transitionsSchema).optional(),
    invoke: invokeSchema.optional(),
    tags: z.array(z.string().regex(FIELD_NAME_RE)).optional(),
    context: z.record(z.string().regex(FIELD_NAME_RE, "a context field is one name"), z.unknown()).optional(),
    computed: z.record(z.string().regex(FIELD_NAME_RE), exprSchema).optional(),
    exports: z.record(z.string().regex(FIELD_NAME_RE, "a page key is one name"), exprSchema).optional(),
    requests: z.record(z.string().regex(FIELD_NAME_RE), requestSchema).optional(),
    persist: z
      .object({
        storage: z.enum(["local", "session"]),
        fields: z.array(z.string().regex(FIELD_NAME_RE)).min(1),
        key: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** An event as a machine receives it: its type and whatever it carries. */
export interface MachineEvent {
  type: string;
  [key: string]: unknown;
}
