import type { z } from "zod";

/** Built from the run's verified context, never from model output. */
export interface ToolContext {
  readonly tenantId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}

export interface Tool<I = unknown, O = unknown> {
  /** Dotted lower camel case, e.g. `fixtures.get`. */
  name: string;
  description: string;
  input: z.ZodType<I>;
  effect: "read" | "write";
  timeoutMs: number;
  /** Extra attempts after a failure or timeout. Defaults to 0; only safe for idempotent tools. */
  retries?: number;
  run(input: I, ctx: ToolContext): Promise<O>;
}

export function defineTool<I, O>(tool: Tool<I, O>): Tool<I, O> {
  return tool;
}

export type ToolOutcome = { ok: true; content: string } | { ok: false; error: string };

export type DenialStage = "registry" | "spec" | "policy";
