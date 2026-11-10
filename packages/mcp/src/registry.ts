import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
/** Where the registry is: one `<server>.json` per MCP server, with its `<server>.lock.json`. */
export const REGISTRY_DIR = join(REPO_ROOT, "config", "mcp");

/** A value written in the entry, or read from the environment (a secret is never in the file). */
const Value = z.union([
  z.string(),
  z.object({ env: z.string(), default: z.string().optional() }).strict(),
]);
export type Value = z.infer<typeof Value>;

/** How the harness treats one of the server's tools. A tool the entry does not list is unreachable. */
const ToolPolicy = z
  .object({
    /** What the call does to the world. Required: nothing is a read by default. */
    effect: z.enum(["read", "write"]),
    /** Our name for it; `<server>.<camelCase>` of the server's name otherwise. */
    name: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/)
      .optional(),
    timeoutMs: z.number().int().positive().default(30_000),
    /** Extra attempts after a failure. Only for a call that is safe to repeat. */
    retries: z.number().int().min(0).max(3).default(0),
    /** A read that still waits for a person. A write always does. */
    approval: z.literal("always").optional(),
    /**
     * Why a tool the server does not mark read-only is a read here. Required for that case, so
     * the reading is a decision someone wrote down, not a default.
     */
    reason: z.string().min(10).optional(),
    /**
     * The write changes something other runs and people use (a connector every hook can call): a
     * person approves it, whatever approves the run as a whole. Default: the server's
     * `destructiveHint`. Say `false` for a tool that only touches what the agent made itself.
     */
    shared: z.boolean().optional(),
    /** A check from the server's adapter, run before every call: it can refuse the call. */
    guard: z.string().optional(),
  })
  .strict();
export type ToolPolicy = z.infer<typeof ToolPolicy>;

/** One tool as a capability grants it. */
const Grant = z
  .object({
    /** Argument name → a pattern its value must match: what an agent holding this may touch. */
    arguments: z.record(z.string(), z.string()).optional(),
    /**
     * Arguments the call must leave out (or send as null): `["id"]` on an upsert makes the grant
     * create-only, since a call that names an `id` would update what exists.
     */
    absent: z.array(z.string()).optional(),
    /**
     * Arguments the harness passes itself, on every call: the model never sees them in the tool's
     * schema and cannot change them. A list filtered to a namespace (`idPrefix: "dugout_"`).
     */
    set: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type Grant = z.infer<typeof Grant>;

const Capability = z
  .object({
    description: z.string(),
    /** The server's tool names this capability grants, each with its limits. */
    tools: z.record(z.string(), Grant),
    /** The server's resources (URIs) an agent holding this may read, from the lock. */
    resources: z.array(z.string()).optional(),
  })
  .strict();
export type Capability = z.infer<typeof Capability>;

const Auth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  /** One token for every tenant, from the environment. */
  z.object({ type: z.literal("bearer"), token: Value }).strict(),
  /**
   * A grant per tenant, from a person's OAuth login. The run's tenant picks it; the model never
   * does. By default the grants are in a file (`pnpm agent mcp login`). With `surface` set, and
   * both of its values present, they are the ones a person connected in Surface Studio's Setup
   * page, kept by the backend, and the tenant id is the FanXP client code.
   */
  z
    .object({
      type: z.literal("oauth-per-tenant"),
      grants: Value,
      scope: z.string(),
      surface: z.object({ url: Value, key: Value }).strict().optional(),
    })
    .strict(),
]);
export type Auth = z.infer<typeof Auth>;

export const ServerEntry = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]*$/),
    title: z.string(),
    description: z.string(),
    owner: z.string(),
    /** The server's environment this entry points at: dev, staging, prod. */
    environment: z.string(),
    transport: z.object({ type: z.literal("streamable-http"), url: Value }).strict(),
    auth: Auth,
    /** Extra request headers. `{grant.<field>}` is filled from the tenant's grant. */
    headers: z.record(z.string(), z.string()).optional(),
    /** Server-specific code the harness may use for this server (`packages/mcp/src/adapters`). */
    adapter: z.string().optional(),
    tools: z.record(z.string(), ToolPolicy),
    capabilities: z.record(z.string(), Capability),
  })
  .strict();
export type ServerEntry = z.infer<typeof ServerEntry>;

export type Registry = Map<string, ServerEntry>;

/** `cast_list_hooks` on server `cast` → `cast.listHooks`; `search` on `docs` → `docs.search`. */
export function toolName(server: ServerEntry, remote: string): string {
  const explicit = server.tools[remote]?.name;
  if (explicit) return explicit;
  const bare = remote.startsWith(`${server.id}_`) ? remote.slice(server.id.length + 1) : remote;
  const camel = bare.replace(/[-_.]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
  return `${server.id}.${camel.charAt(0).toLowerCase()}${camel.slice(1)}`;
}

/**
 * A write that changes something other runs and people use: the entry's `shared` when it says,
 * else the server's `destructiveHint`. A read is never one.
 */
export function isSharedWrite(
  policy: Pick<ToolPolicy, "effect" | "shared"> | undefined,
  annotations: { destructiveHint?: boolean | undefined } | undefined,
): boolean {
  return policy?.effect === "write" && (policy.shared ?? annotations?.destructiveHint === true);
}

/** A grant's rules in a line each: `name ~ ^dugout: `, `prefix = "own_"`, `absent: id`. */
export function grantLimits(grant: Grant): string[] {
  return [
    ...Object.entries(grant.arguments ?? {}).map(([arg, p]) => `${arg} ~ ${p}`),
    ...Object.entries(grant.set ?? {}).map(([arg, v]) => `${arg} = ${JSON.stringify(v)}`),
    ...(grant.absent?.length ? [`absent: ${grant.absent.join(", ")}`] : []),
  ];
}

/** The tool an agent reads a server's granted resources with: `cast.readResource`. */
export const resourceToolName = (server: ServerEntry) => `${server.id}.readResource`;

/** Checks what the schema cannot: capabilities name listed tools, and our names do not collide. */
export function checkEntry(server: ServerEntry): string[] {
  const problems: string[] = [];
  for (const [id, capability] of Object.entries(server.capabilities)) {
    for (const [remote, grant] of Object.entries(capability.tools)) {
      if (!server.tools[remote]) {
        problems.push(`capability ${id} grants ${remote}, which tools does not list`);
      }
      for (const arg of Object.keys(grant.set ?? {})) {
        if (grant.arguments?.[arg]) {
          problems.push(`capability ${id} both sets and limits ${remote}'s ${arg}`);
        }
        if (grant.absent?.includes(arg)) {
          problems.push(`capability ${id} both sets and forbids ${remote}'s ${arg}`);
        }
      }
      for (const arg of grant.absent ?? []) {
        if (grant.arguments?.[arg]) {
          problems.push(`capability ${id} both limits and forbids ${remote}'s ${arg}`);
        }
      }
    }
  }
  const names = new Map<string, string>();
  for (const remote of Object.keys(server.tools)) {
    const name = toolName(server, remote);
    const other = names.get(name);
    if (other) problems.push(`${remote} and ${other} are both ${name}`);
    names.set(name, remote);
  }
  const reader = resourceToolName(server);
  if (names.has(reader)) problems.push(`${names.get(reader)} is ${reader}, the resource reader`);
  return problems;
}

/** Every `<server>.json` in the directory, checked. A broken entry stops the load. */
export function loadRegistry(dir: string = REGISTRY_DIR): Registry {
  const registry: Registry = new Map();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".lock.json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return registry;
    throw err;
  }
  for (const file of files.sort()) {
    const path = join(dir, file);
    const parsed = ServerEntry.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) {
      throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
    }
    const server = parsed.data;
    if (`${server.id}.json` !== file) throw new Error(`${path}: its id is ${server.id}`);
    const problems = checkEntry(server);
    if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
    registry.set(server.id, server);
  }
  return registry;
}

/** A `Value` read now: the literal, or the variable (its default when unset). */
export function readValue(value: Value, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value === "string") return value;
  const set = env[value.env]?.trim();
  return set || value.default;
}

/** A path from the registry: relative to the repo root, wherever the process runs from. */
export function pathOf(value: Value, env: NodeJS.ProcessEnv): string | undefined {
  const path = readValue(value, env);
  if (!path) return undefined;
  return isAbsolute(path) ? path : join(REPO_ROOT, path);
}
