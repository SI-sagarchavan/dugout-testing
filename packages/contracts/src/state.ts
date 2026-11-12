/**
 * A run's state (ADR 0035): what its tools keep for later calls and for the checks on `final`,
 * saved with every save point. Code reads and writes it; the model never sees it. It is for small
 * facts (an id, a link, a count, a list of ids): anything large stays where it is stored and the
 * state holds its reference.
 */

/** The name of one value in a run's state, and the type of that value. */
export interface StateKey<T> {
  readonly name: string;
  /** Never set: carries the value's type. */
  readonly __value?: T;
}

/** Names a value in a run's state: `const PUBLISHED = defineState<Published>("ui.published")`. */
export function defineState<T>(name: string): StateKey<T> {
  if (!name) throw new Error("a state key needs a name");
  return { name };
}

/** A run's state as saved: JSON values by key name. */
export type StateValues = Record<string, unknown>;

/** What a call set, as it travels back to the loop: a key set to `null` is removed. */
export type StatePatch = Record<string, unknown>;

/** Reads a run's state. Each value is a copy: changing it changes nothing until it is `set`. */
export interface RunStateReader {
  get<T>(key: StateKey<T>): T | undefined;
}

/** A run's state inside a tool call. What a call sets is kept only when the call succeeds. */
export interface RunState extends RunStateReader {
  /** Keeps `value` under `key`; `undefined` removes it. The value must be plain JSON. */
  set<T>(key: StateKey<T>, value: T | undefined): void;
}

/** The most one value may hold, as JSON characters: the state is saved with every save point. */
export const MAX_STATE_VALUE_CHARS = 32_000;

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/** A read-only view of saved state values. */
export function readRunState(values: StateValues | undefined): RunStateReader {
  return {
    get<T>(key: StateKey<T>): T | undefined {
      const value = values?.[key.name];
      return value === undefined || value === null ? undefined : copy(value as T);
    },
  };
}

/** `value` as it is kept: through JSON, so what is read back now is what a resumed run reads. */
function kept(name: string, value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`state ${name}: the value is not JSON`);
  if (json.length > MAX_STATE_VALUE_CHARS) {
    throw new Error(
      `state ${name} is ${json.length} characters; one value holds at most ${MAX_STATE_VALUE_CHARS}. Store it and keep its reference.`,
    );
  }
  return JSON.parse(json);
}

/**
 * The state one tool call reads and writes: `values` as the call found them, its own writes over
 * them. `patch` is what it set, for the loop to keep; undefined when it set nothing.
 */
export function createRunState(values: StateValues = {}): {
  state: RunState;
  patch(): StatePatch | undefined;
} {
  const set: StatePatch = {};
  return {
    state: {
      get<T>(key: StateKey<T>): T | undefined {
        const value = key.name in set ? set[key.name] : values[key.name];
        return value === undefined || value === null ? undefined : copy(value as T);
      },
      set<T>(key: StateKey<T>, value: T | undefined): void {
        set[key.name] = value === undefined || value === null ? null : kept(key.name, value);
      },
    },
    patch: () => (Object.keys(set).length > 0 ? { ...set } : undefined),
  };
}

/**
 * A run state with no loop behind it, which keeps what is set at once: for a test that calls a
 * run's tools one after another, and passes the same one to each call.
 */
export function memoryRunState(values: StateValues = {}): RunState {
  return {
    get<T>(key: StateKey<T>): T | undefined {
      const value = values[key.name];
      return value === undefined || value === null ? undefined : copy(value as T);
    },
    set<T>(key: StateKey<T>, value: T | undefined): void {
      if (value === undefined || value === null) delete values[key.name];
      else values[key.name] = kept(key.name, value);
    },
  };
}

/** `values` with a call's patch applied; undefined when nothing is left. */
export function applyStatePatch(
  values: StateValues | undefined,
  patch: StatePatch | undefined,
): StateValues | undefined {
  if (!patch) return values;
  const next: StateValues = { ...values };
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[name];
    else next[name] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
