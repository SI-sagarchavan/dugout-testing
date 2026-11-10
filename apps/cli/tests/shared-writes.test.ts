import { type Decision, type RunEvent, reviewQuestion } from "@dugout/contracts";
import type { AnyAgent } from "@dugout/sdk";
import type { RunQueue } from "@dugout/worker";
import { describe, expect, it } from "vitest";
import { followRun, type Terminal } from "../src/session.ts";

const TENANT = "club-a";
const usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  budgetCostUsd: 0,
  steps: 0,
};

/**
 * A run that waits once for a yes to a top-level write, then ends when it is decided: the queue
 * as the terminal sees it, without a worker.
 */
function oneWrite(shared: boolean) {
  const decided: Decision[] = [];
  const asked: RunEvent = {
    runId: "r1",
    seq: 1,
    at: "2026-11-09T00:00:00.000Z",
    type: "question.asked",
    data: {
      step: 1,
      callId: "call_1_0",
      tool: "cast.upsertApi",
      questions: [reviewQuestion("cast.upsertApi", { shared })],
      from: [],
      subject: { input: { name: "dugout: squad" } },
    },
  };
  const ended: RunEvent = {
    runId: "r1",
    seq: 2,
    at: "2026-11-09T00:00:01.000Z",
    type: "run.completed",
    data: { status: "completed", output: {}, usage },
  };
  const queue = {
    async *follow(_t: string, _r: string, afterSeq: number) {
      if (afterSeq < 1) yield asked;
      else if (decided.length > 0) yield ended;
    },
    waitingFor: async () => (decided.length === 0 ? "call_1_0" : undefined),
    decide: async (_t: string, _r: string, _c: string, decision: Decision) => {
      decided.push(decision);
      return "queued";
    },
  } as unknown as RunQueue;
  return { queue, decided };
}

function scripted(answers: string[]) {
  const asked: string[] = [];
  const out: string[] = [];
  const terminal: Terminal = {
    write: (text) => void out.push(text),
    line: (text) => void out.push(`${text}\n`),
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? "";
    },
  };
  return { terminal, asked, text: () => out.join("") };
}

const follow = (
  queue: RunQueue,
  terminal: Terminal,
  sharedWrites?: (tenantId: string) => Promise<boolean>,
) =>
  followRun({
    queue,
    // shown as JSON: no agent's own card
    agent: { cli: {} } as Pick<AnyAgent, "cli">,
    tenantId: TENANT,
    runId: "r1",
    terminal,
    by: "editor",
    autoApprove: true,
    signal: new AbortController().signal,
    hintMs: 60_000,
    ...(sharedWrites ? { sharedWrites } : {}),
  });

describe("--yes and a write to something shared (ticket 12)", () => {
  it("asks a person for a shared write when the tenant has not opted in", async () => {
    const { queue, decided } = oneWrite(true);
    const { terminal, asked } = scripted(["y"]);
    const read: string[] = [];
    const ending = await follow(queue, terminal, async (tenantId) => {
      read.push(tenantId);
      return false;
    });
    expect(ending).toMatchObject({ type: "run.completed" });
    expect(asked).toHaveLength(1);
    expect(decided).toEqual([{ by: "editor", answers: { review: { decision: "approve" } } }]);
    // the opt-in is read for the run's own tenant
    expect(read).toEqual([TENANT]);
  });

  it("asks a person when nothing can say whether the tenant opted in", async () => {
    const { queue } = oneWrite(true);
    const { terminal, asked } = scripted(["y"]);
    await follow(queue, terminal);
    expect(asked).toHaveLength(1);
  });

  it("approves a shared write without asking when the tenant opted in, recorded as auto", async () => {
    const { queue, decided } = oneWrite(true);
    const { terminal, asked, text } = scripted([]);
    const ending = await follow(queue, terminal, async () => true);
    expect(ending).toMatchObject({ type: "run.completed" });
    expect(asked).toHaveLength(0);
    expect(decided).toEqual([
      { by: "editor (auto)", answers: { review: { decision: "approve" } } },
    ]);
    expect(text()).toContain("approved without asking: cast.upsertApi");
  });

  it("approves a write that is not shared without reading the opt-in", async () => {
    const { queue, decided } = oneWrite(false);
    const { terminal, asked } = scripted([]);
    await follow(queue, terminal, async () => {
      throw new Error("not read for a write nobody else uses");
    });
    expect(asked).toHaveLength(0);
    expect(decided).toHaveLength(1);
  });
});
