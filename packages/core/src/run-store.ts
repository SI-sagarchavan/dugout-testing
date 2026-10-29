import type { Message, RunCheckpoint, RunStore, SavedRun } from "@dugout/contracts";

/** Keeps runs' working memory in this process: for tests, and runs that never outlive it. */
export function createMemoryRunStore(): RunStore & { runs: Map<string, SavedRun> } {
  const runs = new Map<string, SavedRun>();
  const key = (tenantId: string, runId: string) => `${tenantId}/${runId}`;
  return {
    runs,
    async load({ tenantId, runId }) {
      const run = runs.get(key(tenantId, runId));
      return run && structuredClone(run);
    },
    async save({ tenantId, runId }, checkpoint: RunCheckpoint, appended: Message[]) {
      const run = runs.get(key(tenantId, runId));
      const messages = [...(run?.messages ?? []), ...structuredClone(appended)];
      if (messages.length !== checkpoint.messages) {
        throw new Error(
          `run ${runId}: ${messages.length} messages saved, checkpoint says ${checkpoint.messages}`,
        );
      }
      runs.set(key(tenantId, runId), { checkpoint: structuredClone(checkpoint), messages });
    },
  };
}
