/**
 * The Cast MCP adapter: the Cast rules dugout keeps that the server does not enforce itself. It
 * reads only the server's `structuredContent` (cast-mcp 0.5, each tool's `outputSchema` in the
 * lock), never its text. Each part maps to an ask filed with the Cast team
 * (`.scratch/generic-mcp/cast-asks.md`):
 *
 *   - `readOnlyHook`  a hook is run only when it changes nothing at a partner (`readOnly` from
 *                     `cast_describe_hook`). Goes when `cast_run_hook` can refuse such a hook itself.
 *   - `failed`        `cast_run_hook` answers a run that failed as a success, with `status: "error"`
 *                     in its data. Goes when the server sets `isError` on it.
 *   - `hookOutput`    a hook's live output for code. Goes when the page fetches the published hook
 *                     by its `workflowId` at render time.
 */
import type { ServerAdapter, ServerCall } from "../adapter.ts";
import type { ToolResult } from "../hub.ts";

export class NotSampled extends Error {}

/** The parts of `cast_run_hook`'s `structuredContent` read here (cast-mcp's `runOutputSchema`). */
interface RunData {
  status: "ok" | "error";
  error?: { code: string; message: string; stepId?: string };
  outputComputed: boolean;
  output?: unknown;
}

/** The parts of `cast_describe_hook`'s `structuredContent` read here. */
export interface HookData {
  id: string;
  name: string;
  status: "draft" | "published";
  /** The public flow id, what `/cast/api/flow/<id>` takes. Absent before the backend has it. */
  workflowId?: string;
  readOnly: boolean;
  callsHooks: boolean;
}

/** The result's structured data, or a failure naming the tool: code never reads the text. */
function dataOf<T>(tool: string, result: ToolResult): T {
  if (result.isError) throw new NotSampled(result.text || `${tool} failed`);
  if (result.structured === undefined || result.structured === null) {
    throw new NotSampled(
      `${tool} answered without structured data: the Cast server is older than cast-mcp 0.5`,
    );
  }
  return result.structured as T;
}

/** Why a run did not succeed, or undefined. */
function runFailure(run: RunData): string | undefined {
  if (run.status === "ok") return undefined;
  const at = run.error?.stepId ? ` at step ${run.error.stepId}` : "";
  return run.error
    ? `the run failed${at}: ${run.error.code}: ${run.error.message}`
    : "the run failed, and the server said no more";
}

/** A hook as `cast_describe_hook` gives it. */
export async function describeHook(call: ServerCall, hookId: string): Promise<HookData> {
  return dataOf<HookData>("cast_describe_hook", await call("cast_describe_hook", { hookId }));
}

/** Why the hook may not be run, or undefined: a run must change nothing at a partner. */
export function unsafeToRun(hook: HookData): string | undefined {
  if (hook.callsHooks) return "it calls another hook, whose connectors cannot be checked from here";
  if (!hook.readOnly)
    return "a connector it calls is not a GET, and a run could change partner data";
  return undefined;
}

/** Refuses a run of a hook that could change partner data. */
async function readOnlyHook(args: Record<string, unknown>, call: ServerCall) {
  const hookId = String(args.hookId ?? "");
  let hook: HookData;
  try {
    hook = await describeHook(call, hookId);
  } catch (err) {
    return `${hookId} cannot be described: ${(err as Error).message}`;
  }
  const unsafe = unsafeToRun(hook);
  return unsafe ? `${hookId} is not run: ${unsafe}` : undefined;
}

/**
 * A hook's live output, whole, as `/cast/api/flow/<workflowId>` would serve it, with the hook it
 * came from: for code that binds data (bind.source), never for the model. Read-only hooks only.
 */
export async function hookOutput(
  call: ServerCall,
  hookId: string,
  input: Record<string, string> = {},
): Promise<{ hook: HookData; output: unknown }> {
  const hook = await describeHook(call, hookId);
  const unsafe = unsafeToRun(hook);
  if (unsafe) throw new NotSampled(`${hookId} is not run: ${unsafe}`);
  const run = dataOf<RunData>(
    "cast_run_hook",
    await call("cast_run_hook", { hookId, input, applyTransform: true }),
  );
  const failure = runFailure(run);
  if (failure) throw new NotSampled(failure);
  if (!run.outputComputed || run.output === undefined) {
    throw new NotSampled("the run returned no output");
  }
  return { hook, output: run.output };
}

export const castAdapter: ServerAdapter = {
  guards: { readOnlyHook },
  failed(tool, result) {
    if (tool !== "cast_run_hook" || result.structured === undefined) return undefined;
    return runFailure(result.structured as RunData);
  },
};
