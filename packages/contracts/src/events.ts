import { z } from "zod";
import { AssistantMessage } from "./messages.ts";
import { StepUsage, TokenUsage } from "./model.ts";

export const RunUsage = TokenUsage.extend({
  costUsd: z.number(),
  budgetCostUsd: z.number(),
  steps: z.number(),
});
export type RunUsage = z.infer<typeof RunUsage>;

const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({
    runId: z.string(),
    seq: z.number().int().positive(),
    at: z.string(),
    type: z.literal(type),
    data,
  });

const call = { step: z.number(), callId: z.string(), tool: z.string() };

export const RunEvent = z.discriminatedUnion("type", [
  event(
    "run.started",
    z.object({
      agentId: z.string(),
      agentVersion: z.number(),
      tenantId: z.string(),
      input: z.unknown(),
    }),
  ),
  // a later invocation picked the run up from its saved state
  event(
    "run.resumed",
    z.object({
      agentId: z.string(),
      agentVersion: z.number(),
      tenantId: z.string(),
      step: z.number(),
      reason: z.enum(["approval", "recovery", "fork"]),
      // set when a fork carries on from its parent's save point
      forkedFrom: z.object({ runId: z.string(), version: z.number() }).optional(),
    }),
  ),
  event(
    "context.built",
    z.object({
      tokens: z.number(),
      sources: z.array(z.object({ id: z.string(), kind: z.string(), tokens: z.number() })),
    }),
  ),
  event("token", z.object({ step: z.number(), text: z.string() })),
  // a fragment of a tool call's arguments while the model writes them, `final` included: how
  // structured output streams. Not valid JSON until the call ends; like tokens, never stored.
  event(
    "tool.input.delta",
    z.object({
      step: z.number(),
      index: z.number(),
      callId: z.string(),
      tool: z.string(),
      text: z.string(),
    }),
  ),
  event(
    "step.completed",
    z.object({
      step: z.number(),
      message: AssistantMessage,
      usage: StepUsage,
      servedModel: z.string(),
      finishReason: z.string(),
    }),
  ),
  event("tool.started", z.object({ ...call, input: z.unknown() })),
  event(
    "tool.completed",
    z.object({
      ...call,
      ok: z.boolean(),
      content: z.string(),
      durationMs: z.number(),
    }),
  ),
  event(
    "tool.denied",
    z.object({ ...call, stage: z.enum(["registry", "spec", "policy"]), reason: z.string() }),
  ),
  event("approval.requested", z.object({ ...call, input: z.unknown() })),
  event("approval.granted", z.object({ ...call, by: z.string() })),
  event("approval.rejected", z.object({ ...call, by: z.string(), reason: z.string() })),
  event("approval.changes_requested", z.object({ ...call, by: z.string(), changes: z.string() })),
  event(
    "run.completed",
    z.object({
      status: z.enum(["completed", "rejected"]),
      output: z.unknown(),
      usage: RunUsage,
    }),
  ),
  event(
    "run.failed",
    z.object({
      reason: z.enum(["budget", "max_steps", "invalid_output", "error"]),
      message: z.string(),
      usage: RunUsage,
    }),
  ),
  // someone stopped the run: a host, before or while it ran
  event(
    "run.cancelled",
    z.object({ by: z.string(), reason: z.string().optional(), usage: RunUsage }),
  ),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];

/** An event before the log stamps `runId`, `seq` and `at`. */
export type RunEventInput = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "seq" | "at">
    : never
  : never;

export interface EventSink {
  write(event: RunEvent): void | Promise<void>;
}
