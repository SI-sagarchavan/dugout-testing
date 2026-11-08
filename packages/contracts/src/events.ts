import { z } from "zod";
import { AssistantMessage } from "./messages.ts";
import { StepUsage, TokenUsage } from "./model.ts";
import { Answers, AskedQuestion, Subject } from "./questions.ts";

/**
 * What a host adds to the `by` of an answer it gave without asking anyone (`--yes`, a watcher
 * publishing unattended). A decision nobody made must not be remembered as one an editor did.
 */
export const AUTO_APPROVED = " (auto)";
/** The `by` of an answer the harness gave from what a person approved before (ADR 0029). */
export const FROM_MEMORY = "memory";

export const RunUsage = TokenUsage.extend({
  costUsd: z.number(),
  budgetCostUsd: z.number(),
  steps: z.number(),
});
export type RunUsage = z.infer<typeof RunUsage>;

/**
 * Where an event of a child run came from. A child's events are written to the stream of the run
 * a host started, one stream per invocation (ADR 0025): `runId` and `seq` are that run's, and
 * this says which child, at any depth, did it. `parentRunId` is the run whose call started the
 * child, so a host can draw the tree. A child's `run.completed` ends the child, never the stream.
 */
export const ChildRef = z.object({
  runId: z.string(),
  agentId: z.string(),
  parentRunId: z.string(),
  callId: z.string(),
});
export type ChildRef = z.infer<typeof ChildRef>;

const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({
    runId: z.string(),
    seq: z.number().int().positive(),
    at: z.string(),
    type: z.literal(type),
    data,
    child: ChildRef.optional(),
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
      // a child run: the run and call that started it (ADR 0025)
      parent: z.object({ runId: z.string(), callId: z.string() }).optional(),
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
      reason: z.enum(["answered", "recovery", "fork"]),
      // set when a fork carries on from its parent's save point
      forkedFrom: z.object({ runId: z.string(), version: z.number() }).optional(),
    }),
  ),
  event(
    "context.built",
    z.object({
      tokens: z.number(),
      sources: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          tokens: z.number(),
          /** What was put in the prompt, so a host can show it. */
          text: z.string().optional(),
        }),
      ),
    }),
  ),
  event(
    "context.compacted",
    z.object({
      /** The step the smaller request is for. */
      step: z.number(),
      tokensBefore: z.number(),
      tokensAfter: z.number(),
      /** Older tool results replaced by a reference. */
      elided: z.number(),
      /** Transcript messages replaced by a summary. */
      summarized: z.number(),
      /** The model that wrote the summary, when there was one. */
      summarizer: z.string().optional(),
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
      // what the call spent besides the run's own model turns: a child run's (ADR 0025)
      usage: RunUsage.optional(),
    }),
  ),
  event(
    "tool.denied",
    z.object({
      ...call,
      stage: z.enum(["registry", "spec", "policy"]),
      reason: z.string(),
      // the tool's own gate said "not yet" (`Tool.advisoryBlock`): guidance, not a failure
      advisory: z.boolean().optional(),
    }),
  ),
  // The model's `final` was turned down and it goes on: the reason it was given, on the record.
  event("final.refused", z.object({ step: z.number(), callId: z.string(), reason: z.string() })),
  // The run stops for a person (ADR 0029): the model's `ask`, a tool's own questions, a child run's
  // passed up (`from`: the runs they came from, nearest first), or a write waiting for a yes, which
  // is one question of kind `review` and carries the call it is about (`subject`).
  event(
    "question.asked",
    z.object({
      ...call,
      questions: z.array(AskedQuestion),
      from: z.array(z.string()),
      subject: Subject.optional(),
    }),
  ),
  // The person answered, or someone did for them. `source`: `person`, they chose; `agent`, they let
  // the agent decide (its proposals were used); `auto`, a host that answers without asking
  // (`--yes`); `memory`, the harness, from an answer a person made standing.
  event(
    "question.answered",
    z.object({
      ...call,
      by: z.string(),
      answers: Answers,
      source: z.enum(["person", "agent", "auto", "memory"]),
    }),
  ),
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
      reason: z.enum(["budget", "max_steps", "invalid_output", "model_stop", "error"]),
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
