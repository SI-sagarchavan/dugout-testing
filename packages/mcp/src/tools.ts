import { defineTool, type Tool } from "@dugout/contracts";
import type { ServerAdapter, ServerCall } from "./adapter.ts";
import type { McpHub, ToolResult } from "./hub.ts";
import type { Lock } from "./lock.ts";
import { observe } from "./observations.ts";
import { type Grant, isSharedWrite, type ServerEntry, toolName } from "./registry.ts";
import { zodOf } from "./schema.ts";

export class McpConfigError extends Error {}

/**
 * The arguments every grant sets alike. Grants add up, so an argument one grant sets and another
 * leaves to the model is the model's.
 */
export function pinnedArguments(grants: Grant[]): Record<string, unknown> {
  const [first, ...rest] = grants;
  const shared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(first?.set ?? {})) {
    const same = rest.every((g) => JSON.stringify(g.set?.[key]) === JSON.stringify(value));
    if (same) shared[key] = value;
  }
  return shared;
}

/** The tool's input schema without the arguments the harness sets: the model does not see them. */
export function withoutPinned(
  schema: Record<string, unknown>,
  pinned: Record<string, unknown>,
): Record<string, unknown> {
  const names = Object.keys(pinned);
  if (names.length === 0) return schema;
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  for (const name of names) delete properties[name];
  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((name) => !names.includes(name))
    : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

/**
 * What the model reads of a result: the text, which the server writes for a model. Its
 * `structuredContent` is for code (the adapter, a tool that binds data); the model reads it only
 * when there is no text.
 */
const forModel = (result: ToolResult): unknown =>
  result.text.trim() || result.structured === undefined ? result.text : result.structured;

/**
 * Why a call's arguments are outside every grant of the tool, or undefined. Grants add up: a call
 * one of them allows is allowed. A limited argument the call leaves out is not checked; a forbidden one (`absent`) must be.
 */
export function outsideGrants(grants: Grant[], args: Record<string, unknown>): string | undefined {
  const failures: string[] = [];
  for (const grant of grants) {
    const named = (grant.absent ?? []).find((arg) => args[arg] !== undefined && args[arg] !== null);
    const failed = Object.entries(grant.arguments ?? {}).find(([arg, pattern]) => {
      const value = args[arg];
      return value !== undefined && !(typeof value === "string" && new RegExp(pattern).test(value));
    });
    if (!failed && !named) return undefined;
    if (named)
      failures.push(`${named} must be left out (this only creates; it never changes what exists)`);
    else if (failed) failures.push(`${failed[0]} must match ${failed[1]}`);
  }
  return `outside what this agent may touch: ${[...new Set(failures)].join(", or ")}`;
}

export interface ServerToolsOptions {
  server: ServerEntry;
  lock: Lock | undefined;
  /** The server's tools the agent was granted, by the server's name, each with its grants. */
  grants: Map<string, Grant[]>;
  hub: McpHub;
  adapter?: ServerAdapter;
}

/**
 * The granted tools of one server, as typed tools: the name, description and input schema the
 * lock pinned; the effect, timeout and retries the registry says; the grants' limits checked
 * before approval; and a call refused when the live tool is no longer the one locked.
 */
export function serverTools(opts: ServerToolsOptions): Tool[] {
  const { server, lock, hub, adapter } = opts;
  const where = `config/mcp/${server.id}`;
  return [...opts.grants].map(([remote, grants]) => {
    const policy = server.tools[remote];
    if (!policy)
      throw new McpConfigError(`${where}.json grants ${remote}, which tools does not list`);
    const locked = lock?.tools[remote];
    if (!locked) {
      throw new McpConfigError(
        `${remote} is not in ${where}.lock.json: run \`pnpm agent mcp sync ${server.id}\` and review the lock`,
      );
    }
    if (policy.effect === "read" && locked.annotations?.readOnlyHint === false && !policy.reason) {
      throw new McpConfigError(
        `${where}.json says ${remote} reads, and the server says it does not: give the reason, or make it a write`,
      );
    }
    const guard = policy.guard ? adapter?.guards?.[policy.guard] : undefined;
    if (policy.guard && !guard) {
      throw new McpConfigError(
        `${where}.json guards ${remote} with ${policy.guard}, which no adapter has`,
      );
    }
    const name = toolName(server, remote);
    const pinned = pinnedArguments(grants);

    return defineTool<Record<string, unknown>, unknown>({
      name,
      description: locked.description,
      input: zodOf(withoutPinned(locked.inputSchema, pinned)),
      effect: policy.effect,
      ...(isSharedWrite(policy, locked.annotations) ? { shared: true } : {}),
      timeoutMs: policy.timeoutMs,
      retries: policy.retries,
      block: (args) => {
        const outside = outsideGrants(grants, args);
        return outside ? `${name}: ${outside}` : undefined;
      },
      async run(args, ctx) {
        const changed = (await hub.drifted(server.id, ctx.tenantId)).get(remote);
        if (changed) {
          throw new Error(
            `${name} is refused: on ${server.title}, ${changed} since ${where}.lock.json was written. Run \`pnpm agent mcp sync ${server.id}\` and review the diff.`,
          );
        }
        const call: ServerCall = (tool, a) =>
          hub.call(server.id, ctx.tenantId, tool, a, {
            signal: ctx.signal,
            timeoutMs: policy.timeoutMs,
          });
        const sent = { ...args, ...pinned };
        const refused = guard ? await guard(sent, call) : undefined;
        if (refused) throw new Error(refused);
        const result = await call(remote, sent);
        if (result.isError) throw new Error(result.text || `${remote} failed`);
        const failed = adapter?.failed?.(remote, result);
        if (failed) throw new Error(`${failed}\n\n${result.text}`.trim());
        const seen = adapter?.observe?.(remote, sent, result);
        if (seen) observe(ctx.runId, seen.key, seen.value);
        return forModel(result);
      },
    }) as Tool;
  });
}
