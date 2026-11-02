import { defineTool, type Tool } from "@dugout/contracts";
import { z } from "zod";
import type { McpClient } from "./client.ts";

/** The Cast MCP tool names the harness may call. Anything else on the server is unreachable. */
export const CAST_TOOLS = {
  listHooks: "cast_list_hooks",
  describeHook: "cast_describe_hook",
  listApis: "cast_list_apis",
  describeApi: "cast_describe_api",
  getTemplateBinding: "cast_get_template_binding",
  createHook: "cast_create_hook",
} as const;

const READ = { effect: "read", timeoutMs: 30_000, retries: 1 } as const;

/**
 * Typed tools over the Cast MCP server (ADR 0022). The model sees only these inputs; the tenant
 * comes from the run, the credentials from the token store. Creating a hook is a write, so it
 * always waits for a person's yes.
 */
export function castTools(client: McpClient): Tool[] {
  const call = (tool: string, input: object, tenantId: string, signal: AbortSignal) =>
    client.callTool(tenantId, tool, input as Record<string, unknown>, signal);

  const tools = [
    defineTool({
      ...READ,
      name: "cast.listHooks",
      description:
        "List the tenant's Cast workflows (hooks): id, name and status. Start here to find the data a card can bind to.",
      input: z.object({
        status: z.enum(["draft", "published", "any"]).optional(),
        nameContains: z.string().optional(),
      }),
      run: (input, ctx) => call(CAST_TOOLS.listHooks, input, ctx.tenantId, ctx.signal),
    }),
    defineTool({
      ...READ,
      name: "cast.describeHook",
      description:
        "Show one Cast hook: its steps, its input schema and every reference path that resolves.",
      input: z.object({ hookId: z.string().min(1), includeSamples: z.boolean().optional() }),
      run: (input, ctx) => call(CAST_TOOLS.describeHook, input, ctx.tenantId, ctx.signal),
    }),
    defineTool({
      ...READ,
      name: "cast.listApis",
      description: "List the tenant's Cast API connectors and the inputs each one needs.",
      input: z.object({
        providerId: z.string().optional(),
        nameContains: z.string().optional(),
      }),
      run: (input, ctx) => call(CAST_TOOLS.listApis, input, ctx.tenantId, ctx.signal),
    }),
    defineTool({
      ...READ,
      name: "cast.describeApi",
      description: "Show one Cast API connector, with its stored sample response when asked.",
      input: z.object({
        apiId: z.string().min(1),
        includeSample: z.boolean().optional(),
        maxChars: z.number().int().positive().max(20_000).optional(),
      }),
      run: (input, ctx) => call(CAST_TOOLS.describeApi, input, ctx.tenantId, ctx.signal),
    }),
    defineTool({
      ...READ,
      name: "cast.getTemplateBinding",
      description: "Show which hook feeds a template, and how its inputs are mapped.",
      input: z.object({ templateId: z.string().uuid() }),
      run: (input, ctx) => call(CAST_TOOLS.getTemplateBinding, input, ctx.tenantId, ctx.signal),
    }),
    defineTool({
      name: "cast.createHook",
      description:
        "Create an empty Cast hook (draft). Never overwrites. Needs a person's approval.",
      effect: "write",
      timeoutMs: 30_000,
      input: z.object({
        id: z
          .string()
          .regex(/^[a-z0-9_]+$/)
          .max(64),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        inputs: z
          .array(
            z.object({
              key: z.string().min(1),
              type: z.enum(["string", "number", "boolean", "object", "array"]).optional(),
              required: z.boolean().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
      }),
      run: (input, ctx) => call(CAST_TOOLS.createHook, input, ctx.tenantId, ctx.signal),
    }),
  ];
  return tools as Tool[];
}
