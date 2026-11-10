/**
 * What code saw of a run's tool results that the model only reads as text: an adapter's `observe`
 * records the structured data of a result under the run, and a sync check (`verifyFinal`) reads it
 * back. In memory and bounded: a run resumed in another process has none, and a check that finds
 * none does not refuse (it cannot know), so a crash never turns into a refusal.
 */
const MAX_RUNS = 200;
const runs = new Map<string, Map<string, unknown>>();

/** Keeps `value` under `key` for the run, replacing the last one. */
export function observe(runId: string, key: string, value: unknown): void {
  const mine = runs.get(runId) ?? new Map<string, unknown>();
  runs.delete(runId); // most recently used last
  runs.set(runId, mine.set(key, value));
  for (const old of runs.keys()) {
    if (runs.size <= MAX_RUNS) break;
    runs.delete(old);
  }
}

/** The last value kept under `key` for the run, or undefined. */
export function observed<T = unknown>(runId: string, key: string): T | undefined {
  return runs.get(runId)?.get(key) as T | undefined;
}

/** Forgets a run (tests). */
export function forget(runId: string): void {
  runs.delete(runId);
}
