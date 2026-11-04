/**
 * `@dugout/mcp/testing`: an MCP hub that answers from code, for agent tests. Used with the real
 * registry and lock (`createMcpHost({ hub: fakeHub(...) })`), so an agent's tests run against the
 * grants, schemas and adapter this repo ships, and only the server is stood in for.
 */
import type { McpHub, ToolResult } from "./hub.ts";
import { readLock } from "./lock.ts";

export type FakeAnswer =
  | string
  | ToolResult
  | ((args: Record<string, unknown>) => string | ToolResult | Promise<string | ToolResult>);

export interface FakeHub extends McpHub {
  /** Every call, in order, with its tenant. */
  calls: Array<{ server: string; tenantId: string; tool: string; args: Record<string, unknown> }>;
}

/** A hub whose server tools answer from `answers`, by the server's tool name; others throw. */
export function fakeHub(answers: Record<string, FakeAnswer>): FakeHub {
  const calls: FakeHub["calls"] = [];
  return {
    calls,
    configured: () => true,
    async call(server, tenantId, tool, args) {
      calls.push({ server, tenantId, tool, args });
      const answer = answers[tool];
      if (answer === undefined)
        throw new Error(`the fake ${server} server has no answer for ${tool}`);
      const value = typeof answer === "function" ? await answer(args) : answer;
      return typeof value === "string" ? { text: value, isError: false } : value;
    },
    // the live server is the locked one: no drift
    listTools: async (server) =>
      Object.entries(readLock(server)?.tools ?? {}).map(([name, t]) => ({ name, ...t })),
    listResources: async (server) =>
      Object.entries(readLock(server)?.resources ?? {}).map(([uri, r]) => ({ uri, ...r })),
    readResource: async (server, _tenant, uri) => {
      const text = readLock(server)?.resources?.[uri]?.text;
      if (text === undefined) throw new Error(`the fake ${server} server has no resource ${uri}`);
      return text;
    },
    info: async (server) => ({ serverInfo: { name: server, version: "test" } }),
    drifted: async () => new Map(),
    close: async () => undefined,
  };
}
