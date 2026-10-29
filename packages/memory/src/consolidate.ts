import type { ModelClient, RunEvent } from "@dugout/contracts";
import type { MemoryItem, MemoryWriter } from "./store.ts";
import { PROPOSE_TOOL } from "./tools.ts";

export const EPISODE_TTL_DAYS = 180;

export interface Rejection {
  tool: string;
  input: unknown;
  reason: string;
}

/** Turns a reviewer rejection into a one-line lesson for future runs. */
export type LessonWriter = (rejection: Rejection) => Promise<string>;

export interface ConsolidateOptions {
  writer: MemoryWriter;
  tenantId: string;
  agentId: string;
  runId: string;
  events: RunEvent[];
  lessons?: LessonWriter;
}

/**
 * The only path from a run into long-term memory. Rejections become episodes; `memory.propose`
 * calls become proposed facts that wait for review.
 */
export async function consolidateRun(
  opts: ConsolidateOptions,
): Promise<{ episodes: MemoryItem[]; proposals: MemoryItem[] }> {
  const { writer, tenantId, agentId, runId, events } = opts;
  const episodes: MemoryItem[] = [];
  const proposals: MemoryItem[] = [];

  const requested = new Map<string, unknown>();
  const proposed = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === "approval.requested") requested.set(event.data.callId, event.data.input);
    if (event.type === "tool.started" && event.data.tool === PROPOSE_TOOL) {
      proposed.set(event.data.callId, event.data.input);
    }
    if (event.type === "approval.rejected") {
      const rejection = {
        tool: event.data.tool,
        input: requested.get(event.data.callId),
        reason: event.data.reason,
      };
      const lesson = await opts.lessons?.(rejection).catch(() => undefined);
      const content = lesson
        ? `${lesson} (Reviewer: "${rejection.reason}")`
        : `A reviewer rejected a ${rejection.tool} draft: "${rejection.reason}"`;
      episodes.push(
        await writer.addEpisode({
          tenantId,
          agentId,
          content,
          confidence: lesson ? 0.9 : 0.7,
          sourceRunId: runId,
          ttlDays: EPISODE_TTL_DAYS,
        }),
      );
    }
    if (event.type === "tool.completed" && event.data.ok && proposed.has(event.data.callId)) {
      const input = proposed.get(event.data.callId) as {
        key: string;
        content: string;
        confidence: number;
      };
      proposals.push(await writer.proposeFact({ tenantId, agentId, ...input, sourceRunId: runId }));
    }
  }
  return { episodes, proposals };
}

/** A `LessonWriter` that asks a model for one imperative sentence. */
export function createModelLessonWriter(client: ModelClient, model: string): LessonWriter {
  return async ({ tool, input, reason }) => {
    const turn = await client.complete({
      model,
      tools: [],
      messages: [
        {
          role: "system",
          content:
            "A reviewer rejected an AI agent's draft. Write ONE short imperative sentence the agent should follow next time to avoid the same rejection. Output only the sentence.",
        },
        {
          role: "user",
          content: `Tool: ${tool}\nDraft: ${JSON.stringify(input)}\nReviewer's reason: ${reason}`,
        },
      ],
    });
    const lesson = turn.message.content.trim().split("\n")[0]?.trim();
    if (!lesson) throw new Error("empty lesson");
    return lesson;
  };
}
