import type { z } from "zod";

/** Built from the run's verified context, never from model output. */
export interface ToolContext {
  readonly tenantId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  /** The host's parsed run input, when the run has one. Never taken from the model. */
  readonly input?: unknown;
}

export interface Tool<I = unknown, O = unknown, R = I> {
  /** Dotted lower camel case, e.g. `fixtures.get`. */
  name: string;
  description: string;
  input: z.ZodType<I>;
  effect: "read" | "write";
  timeoutMs: number;
  /** Extra attempts after a failure or timeout. Defaults to 0; only safe for idempotent tools. */
  retries?: number;
  /** Output is never swapped for a reference, however long: the model needs all of it (a skill). */
  alwaysInline?: boolean;
  /**
   * Replaces the parsed arguments before the gate and the approval. The model still sees `input`.
   * Use it when the host already holds the payload and the model must not send it back.
   */
  resolve?(input: I, ctx: Pick<ToolContext, "tenantId" | "runId" | "input">): R;
  /**
   * Sync check after the schema and before approval. A string denies the call.
   * Use it for a gate that needs the verified run input, such as a file the host named.
   */
  block?(input: R, ctx: Pick<ToolContext, "tenantId" | "runId" | "input">): string | undefined;
  run(input: R, ctx: ToolContext): Promise<O>;
}

export function defineTool<I, O, R = I>(tool: Tool<I, O, R>): Tool<I, O, R> {
  return tool;
}

export type ToolOutcome = { ok: true; content: string } | { ok: false; error: string };

export type DenialStage = "registry" | "spec" | "policy";
