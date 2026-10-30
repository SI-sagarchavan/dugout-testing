import type { Message, RunCheckpoint, RunStore, SavedRun, SavePoint } from "@dugout/contracts";

interface Kept {
  messages: Message[];
  /** Every save point, oldest first. */
  points: Array<{ checkpoint: RunCheckpoint; savedAt: string }>;
}

/** Keeps runs' working memory in this process: for tests, and runs that never outlive it. */
export function createMemoryRunStore(): RunStore & { runs: Map<string, Kept> } {
  const runs = new Map<string, Kept>();
  const key = (tenantId: string, runId: string) => `${tenantId}/${runId}`;
  return {
    runs,
    async load({ tenantId, runId }, version) {
      const run = runs.get(key(tenantId, runId));
      const point = version === undefined ? run?.points.at(-1) : run?.points[version - 1];
      if (!run || !point) return undefined;
      const saved: SavedRun = {
        checkpoint: point.checkpoint,
        messages: run.messages.slice(0, point.checkpoint.messages),
      };
      return structuredClone(saved);
    },
    async save({ tenantId, runId }, checkpoint: RunCheckpoint, appended: Message[]) {
      const run = runs.get(key(tenantId, runId)) ?? { messages: [], points: [] };
      const messages = [...run.messages, ...structuredClone(appended)];
      if (messages.length !== checkpoint.messages) {
        throw new Error(
          `run ${runId}: ${messages.length} messages saved, checkpoint says ${checkpoint.messages}`,
        );
      }
      const point = { checkpoint: structuredClone(checkpoint), savedAt: new Date().toISOString() };
      runs.set(key(tenantId, runId), { messages, points: [...run.points, point] });
    },
    async history({ tenantId, runId }) {
      const points = runs.get(key(tenantId, runId))?.points ?? [];
      return points.map(({ checkpoint, savedAt }, i) => savePoint(i + 1, checkpoint, savedAt));
    },
  };
}

/** How a history lists a save point. */
export function savePoint(version: number, checkpoint: RunCheckpoint, savedAt: string): SavePoint {
  const { step, savedAfter, messages, waiting } = checkpoint;
  return {
    version,
    step,
    savedAfter,
    messages,
    ...(waiting ? { waiting: { callId: waiting.callId, tool: waiting.tool } } : {}),
    savedAt,
  };
}
