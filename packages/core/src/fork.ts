import type { ApprovalDecision, SavedRun } from "@dugout/contracts";

/** What a fork changes. Another model is chosen where the fork is run, not in its state. */
export interface ForkChange {
  /** The decision on the approval the save point waits for, perhaps the other one. */
  decision?: ApprovalDecision;
  /** A corrected input, sent as the next user message. */
  input?: unknown;
}

/**
 * The state a new run starts from when it is forked from save point `from` of another run. The
 * parent's transcript up to that point is copied unchanged, so reasoning a model signed against
 * it stays valid; a corrected input is appended after it. The fork counts only what it spends
 * itself: its parent paid for the steps before.
 */
export function forkRun(
  saved: SavedRun,
  from: { runId: string; version: number },
  change: ForkChange = {},
): SavedRun {
  const { checkpoint } = saved;
  if (change.decision && !checkpoint.waiting) {
    throw new Error(`save point ${from.version} of run ${from.runId} waits for no approval`);
  }
  const messages = structuredClone(saved.messages);
  if (change.input !== undefined) {
    if (checkpoint.turn || checkpoint.waiting) {
      throw new Error(
        `save point ${from.version} of run ${from.runId} is in the middle of a turn; a corrected input goes between turns`,
      );
    }
    messages.push({ role: "user", content: correctedInput(change.input) });
  }
  const usage = Object.fromEntries(Object.keys(checkpoint.usage).map((k) => [k, 0]));
  // a fork of the last save point goes on from there; the parent's ending is not the fork's
  const { ended: _, ...kept } = structuredClone(checkpoint);
  return {
    checkpoint: {
      ...kept,
      usage: usage as SavedRun["checkpoint"]["usage"],
      messages: messages.length,
      savedAfter: "fork",
      forkedFrom: from,
    },
    messages,
  };
}

/** The user message that brings a fork its corrected input. */
export function correctedInput(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return `The input was corrected. Work from this one instead:\n${text}`;
}
