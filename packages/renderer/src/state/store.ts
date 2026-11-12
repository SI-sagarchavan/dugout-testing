/**
 * The page's state in the browser: ONE store per window for every section drawn in it (an iframe a
 * host draws into shares its parent's, as one page does). It holds the page system
 * (`@fanos/dsl/runtime`'s `PageSystem`): each section's machine at the snapshot the server drew it
 * at, the values written outside any machine (a tab's choice, a field's text: ADR 0032), and the
 * host's `$user` and `$route`.
 *
 * Machines are pure; this is where their effects happen. A request goes to the host (by default a
 * POST to `/api/actions/<action>`, which resolves the tenant and the signed-in fan), a delay is a
 * timer, a tracking event goes to the tenant's sinks (by default GTM's `dataLayer`), a persisted
 * machine's fields go to storage. Each answer comes back as an event. A host changes any of these
 * with `configureRuntime`.
 *
 * Browser only; no React.
 */

import {
  addMachine,
  createSystem,
  dispatch,
  type DispatchOptions,
  type Json,
  type MachineEvent,
  type MachineSnapshot,
  type MachineSpec,
  type PageSystem,
  pageValues,
  restoreMachine,
  resumeSystem,
  setPageValue,
  type SystemEffect,
} from "@fanos/dsl/runtime";

export interface RuntimeConfig {
  /** Run a request a machine makes: the host's action route. Resolve with its answer, reject on failure. */
  request: (action: string, input: Json, signal: AbortSignal) => Promise<Json>;
  /**
   * More of a data source a section reads (a request with `source`): the host runs the source again
   * with `input` over the inputs the section was bound with, adds the answer to the data it holds
   * for that section (`addToSource`), and draws the section again. Resolve when it is drawn, reject
   * on failure. The default has no data of its own to add to, and rejects.
   */
  load: (source: string, input: Json, instance: string, signal: AbortSignal) => Promise<void>;
  /** A host action fired and forgotten (`auth.logout`). Defaults to `request`, answer ignored. */
  call: (action: string, input: Json) => void;
  /** A tracking event, by meaning; the tenant's mapping to GTM, GA4, Meta is the host's. */
  track: (name: string, params: Record<string, Json>, instance: string) => void;
  navigate: (href: string, external: boolean) => void;
  /** Where a persisted machine's fields live. */
  storage: (kind: "local" | "session") => Pick<Storage, "getItem" | "setItem"> | undefined;
  /** A machine's own error (an expression that failed); never thrown at the page. */
  report: (message: string, instance: string) => void;
}

/** What a failed request answers the machine with: `event.error`. */
export interface RequestError {
  message: string;
  status?: number;
}

const defaults: RuntimeConfig = {
  request: async (action, input, signal) => {
    const res = await fetch(`/api/actions/${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
      credentials: "same-origin",
      signal,
    });
    const body = (await res.json().catch(() => null)) as Json;
    if (!res.ok) {
      const message = body && typeof body === "object" && !Array.isArray(body) && typeof body.message === "string" ? body.message : res.statusText;
      throw { message, status: res.status } satisfies RequestError;
    }
    return body;
  },
  load: async (source) => {
    throw { message: `this page cannot load more of "${source}": its host gives no load` } satisfies RequestError;
  },
  call: (action, input) => {
    void config.request(action, input, new AbortController().signal).catch((e) => config.report(`${action}: ${errorOf(e).message}`, ""));
  },
  track: (name, params) => {
    const w = globalThis as { dataLayer?: unknown[] };
    w.dataLayer ??= [];
    w.dataLayer.push({ event: name, ...params });
  },
  navigate: (href, external) => {
    if (external) globalThis.open?.(href, "_blank", "noopener");
    else globalThis.location?.assign(href);
  },
  storage: (kind) => {
    try {
      return kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    } catch {
      return undefined;
    }
  },
  report: (message, instance) => console.warn(`[fos-state] ${instance ? `${instance}: ` : ""}${message}`),
};

let config: RuntimeConfig = defaults;

/** A host's own transport, tracking, navigation or storage. Call once, before sections hydrate. */
export function configureRuntime(overrides: Partial<RuntimeConfig>): void {
  config = { ...config, ...overrides };
}

const errorOf = (e: unknown): RequestError =>
  e && typeof e === "object" && typeof (e as RequestError).message === "string"
    ? { message: (e as RequestError).message, ...(typeof (e as RequestError).status === "number" ? { status: (e as RequestError).status } : {}) }
    : { message: String(e) };

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let system: PageSystem = createSystem([]).system;
const listeners = new Set<() => void>();

export const getSystem = (): PageSystem => system;

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: PageSystem, effects: SystemEffect[]): void {
  if (next !== system) {
    system = next;
    for (const listener of [...listeners]) listener();
  }
  run(effects);
}

/** An event for a section's machine (or, with `instance` null, the whole page). */
export function send(instance: string | null, event: MachineEvent, options: DispatchOptions = {}): void {
  const out = dispatch(system, instance, event, options);
  commit(out.system, out.effects);
}

/** A value written outside any machine: a tab pressed, a field typed in. */
export function setValue(key: string, value: Json): void {
  const out = setPageValue(system, key, value);
  if (out.changed) commit(out.system, out.effects);
}

/** Values the page starts with, each only if the page has not set it yet. */
export function seedValues(values: Record<string, Json>): void {
  let next = system;
  const effects: SystemEffect[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (key in next.free) continue;
    const out = setPageValue(next, key, value);
    next = out.system;
    effects.push(...out.effects);
  }
  commit(next, effects);
}

export interface Seed {
  /** The signed-in fan and the route, as the server drew them. */
  host?: { user: Json; route: Json };
  /** The page's values written outside any machine, as the server drew them. */
  free?: Record<string, Json>;
}

/**
 * A drawn section's machine joins the page at the snapshot the server drew it at; then the requests
 * and delays that snapshot waits on start, and a persisted machine's fields are read back.
 */
export function registerMachine(instance: string, spec: MachineSpec, snapshot: MachineSnapshot | undefined, seed: Seed = {}): void {
  if (system.specs[instance]) return;
  let next = system;
  if (seed.host && next.host.user === null && next.host.route === null) next = { ...next, host: seed.host };
  if (seed.free) next = { ...next, free: { ...seed.free, ...next.free } };
  const added = addMachine(next, { instance, spec }, snapshot);
  commit(added.system, [...added.effects, ...resumeSystem(added.system, instance)]);
  if (spec.persist) {
    const raw = config.storage(spec.persist.storage)?.getItem(storageKey(spec.persist.key ?? instance));
    if (raw) {
      try {
        const out = restoreMachine(system, instance, JSON.parse(raw) as Record<string, unknown>);
        commit(out.system, out.effects);
      } catch {
        config.report("persisted state could not be read; starting fresh", instance);
      }
    }
  }
}

const storageKey = (key: string) => `fos:${key}`;

/** What the page shares now: `$page`. */
export const currentValues = (): Record<string, Json> => pageValues(system);

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, AbortController>();
const keyOf = (instance: string, id: string) => `${instance}\u0000${id}`;

/** The documents sections are drawn in, for focus and scroll. */
export const documents = new Set<Document>();

function nodeEl(instance: string, node: string): HTMLElement | null {
  for (const doc of documents) {
    const el = doc.querySelector<HTMLElement>(`[data-fos-instance="${CSS.escape(instance)}"] [data-fos-id="${CSS.escape(node)}"]`);
    if (el) return el;
  }
  return null;
}

function run(effects: SystemEffect[]): void {
  for (const effect of effects) {
    const { instance } = effect;
    switch (effect.type) {
      case "request": {
        const key = keyOf(instance, effect.id);
        inflight.get(key)?.abort();
        const controller = new AbortController();
        inflight.set(key, controller);
        const answer: Promise<Json> =
          effect.source !== undefined
            ? config.load(effect.source, effect.input, instance, controller.signal).then(() => null)
            : config.request(effect.action ?? "", effect.input, controller.signal);
        answer.then(
          (output) => {
            if (inflight.get(key) !== controller) return;
            inflight.delete(key);
            send(instance, { type: `done.invoke.${effect.id}`, output });
          },
          (e) => {
            if (inflight.get(key) !== controller || controller.signal.aborted) return;
            inflight.delete(key);
            send(instance, { type: `error.invoke.${effect.id}`, error: errorOf(e) as unknown as Json });
          },
        );
        break;
      }
      case "cancel": {
        const key = keyOf(instance, effect.id);
        inflight.get(key)?.abort();
        inflight.delete(key);
        break;
      }
      case "timer": {
        const key = keyOf(instance, effect.id);
        clearTimeout(timers.get(key));
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key);
            send(instance, effect.event);
          }, effect.ms),
        );
        break;
      }
      case "cancelTimer": {
        const key = keyOf(instance, effect.id);
        clearTimeout(timers.get(key));
        timers.delete(key);
        break;
      }
      case "emit":
        config.track(effect.name, effect.params, instance);
        break;
      case "navigate":
        config.navigate(effect.href, effect.external);
        break;
      case "call":
        config.call(effect.action, effect.input);
        break;
      case "focus":
        // after the change is drawn: the field the drawer opens with is in the DOM
        requestAnimationFrame(() => nodeEl(instance, effect.node)?.focus());
        break;
      case "scrollTo":
        requestAnimationFrame(() => nodeEl(instance, effect.node)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
        break;
      case "persist":
        try {
          config.storage(effect.storage)?.setItem(storageKey(effect.key), JSON.stringify(effect.value));
        } catch {
          config.report("could not persist (storage full or blocked)", instance);
        }
        break;
      case "error":
        config.report(effect.message, instance);
        break;
    }
  }
}
