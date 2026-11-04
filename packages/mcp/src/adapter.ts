import type { ToolResult } from "./hub.ts";

/** Calls one of the same server's tools, under the run's tenant. */
export type ServerCall = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Code for one server that the harness may use, named by its registry entry's `adapter`. Kept for
 * what the server cannot say for itself yet; each part goes when the server does. A server that
 * speaks plain MCP needs none.
 */
export interface ServerAdapter {
  /** Checks a registry entry can put before a tool (`guard`). A string refuses the call. */
  guards?: Record<
    string,
    (args: Record<string, unknown>, call: ServerCall) => Promise<string | undefined>
  >;
  /**
   * Why a result the server sent as a success is a failure, or undefined: for a server that
   * reports some failures in its data rather than with `isError`. The call then fails.
   */
  failed?(tool: string, result: ToolResult): string | undefined;
}
