import { defineTool, type Tool } from "@dugout/contracts";
import { z } from "zod";
import type { ServerAdapter } from "./adapter.ts";
import { castAdapter } from "./adapters/cast.ts";
import { createMcpHub, type HubOptions, type McpHub, type ToolResult } from "./hub.ts";
import {
  type Lock,
  lockPath,
  readLock,
  resourceHash,
  sha256,
  toolHash,
  writeLock,
} from "./lock.ts";
import {
  type Grant,
  loadRegistry,
  REGISTRY_DIR,
  type Registry,
  resourceToolName,
  type ServerEntry,
  toolName,
} from "./registry.ts";
import { zodOf } from "./schema.ts";
import { McpConfigError, serverTools } from "./tools.ts";

/** Server code the registry's entries may name. */
export const ADAPTERS: Record<string, ServerAdapter> = { cast: castAdapter };

/** What an agent says it needs, by capability, never by server. */
export interface CapabilityRequest {
  /** Without one of these the agent cannot load. */
  requires?: string[];
  /** Used when a server that has it is configured here. */
  optional?: string[];
}

export interface Resolution {
  tools: Tool[];
  /** The servers' own guidance about their tools, from their locks, for the instructions. */
  instructions: string;
  /** Tools a person approves though they only read. */
  approvals: string[];
  /** The servers the tools come from. */
  servers: string[];
}

/**
 * The registry's MCP servers in one process: what agents resolve their capabilities against, and
 * what tools and code call through. Built from `config/mcp` and the environment.
 */
export interface McpHost {
  registry: Registry;
  hub: McpHub;
  lock(server: string): Lock | undefined;
  /** Reads the server's lock again on next use: it was just written. */
  forgetLock(server: string): void;
  resolve(request: CapabilityRequest): Resolution;
  /** A server tool called by code (not offered to a model), under a tenant. */
  call(
    server: string,
    tenantId: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface HostOptions extends Partial<Omit<HubOptions, "registry" | "lock">> {
  dir?: string;
  registry?: Registry;
  hub?: McpHub;
  adapters?: Record<string, ServerAdapter>;
}

export function createMcpHost(opts: HostOptions = {}): McpHost {
  const dir = opts.dir ?? REGISTRY_DIR;
  const registry = opts.registry ?? loadRegistry(dir);
  const adapters = opts.adapters ?? ADAPTERS;
  const locks = new Map<string, Lock | undefined>();
  const lock = (server: string) => {
    if (!locks.has(server)) locks.set(server, readLock(server, dir));
    return locks.get(server);
  };
  const hub =
    opts.hub ??
    createMcpHub({
      registry,
      lock,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.grants ? { grants: opts.grants } : {}),
      ...(opts.driftTtlMs ? { driftTtlMs: opts.driftTtlMs } : {}),
    });

  const providers = (capability: string) =>
    [...registry.values()].filter((server) => capability in server.capabilities);

  return {
    registry,
    hub,
    lock,
    forgetLock: (server) => void locks.delete(server),

    resolve({ requires = [], optional = [] }) {
      // server → tool → the grants that give it
      const granted = new Map<string, Map<string, Grant[]>>();
      // server → the resources granted
      const readable = new Map<string, Set<string>>();
      const add = (capability: string, required: boolean) => {
        const servers = providers(capability).filter((s) => required || hub.configured(s.id));
        if (required && servers.length === 0) {
          throw new McpConfigError(`no MCP server in config/mcp provides ${capability}`);
        }
        for (const server of servers) {
          const tools = granted.get(server.id) ?? new Map<string, Grant[]>();
          for (const [remote, grant] of Object.entries(
            server.capabilities[capability]?.tools ?? {},
          )) {
            tools.set(remote, [...(tools.get(remote) ?? []), grant]);
          }
          granted.set(server.id, tools);
          const uris = readable.get(server.id) ?? new Set<string>();
          for (const uri of server.capabilities[capability]?.resources ?? []) uris.add(uri);
          readable.set(server.id, uris);
        }
      };
      for (const capability of requires) add(capability, true);
      for (const capability of optional) add(capability, false);

      const tools: Tool[] = [];
      const approvals: string[] = [];
      const instructions: string[] = [];
      for (const [serverId, grants] of granted) {
        const server = registry.get(serverId);
        if (!server) continue;
        const adapter = server.adapter ? adapters[server.adapter] : undefined;
        if (server.adapter && !adapter) {
          throw new McpConfigError(
            `config/mcp/${serverId}.json names adapter ${server.adapter}, which does not exist`,
          );
        }
        const locked = lock(serverId);
        tools.push(
          ...serverTools({ server, lock: locked, grants, hub, ...(adapter ? { adapter } : {}) }),
        );
        const uris = [...(readable.get(serverId) ?? [])].sort();
        if (uris.length) tools.push(resourceTool(server, locked, uris));
        for (const remote of grants.keys()) {
          if (server.tools[remote]?.approval === "always") approvals.push(toolName(server, remote));
        }
        if (locked?.instructions || uris.length) {
          // the server's guidance names its tools as the server does; say what they are called here
          const named = [...grants.keys()]
            .map((remote) => `${remote} is ${toolName(server, remote)}`)
            .join(", ");
          instructions.push(
            [
              `## ${server.title}: what its MCP server says about its tools`,
              `Its tools you have are named here as follows: ${named}. A tool it mentions that is not in that list is not yours to call.`,
              ...(locked?.instructions ? [locked.instructions.trim()] : []),
              ...(uris.length ? [resourceList(server, locked, uris)] : []),
            ].join("\n\n"),
          );
        }
      }
      return {
        tools,
        instructions: instructions.join("\n\n"),
        approvals,
        servers: [...granted.keys()],
      };
    },

    call: (server, tenantId, tool, args, signal) =>
      hub.call(server, tenantId, tool, args, signal ? { signal } : {}),

    close: () => hub.close(),
  };
}

/**
 * The tool an agent reads a server's granted resources with, from the lock: what the server keeps
 * out of every prompt (reference material, examples), read when the model needs it.
 */
function resourceTool(server: ServerEntry, lock: Lock | undefined, uris: string[]): Tool {
  const where = `config/mcp/${server.id}`;
  const missing = uris.filter((uri) => !lock?.resources?.[uri]);
  if (missing.length) {
    throw new McpConfigError(
      `${missing.join(", ")} not in ${where}.lock.json: run \`pnpm agent mcp sync ${server.id}\` and review the lock`,
    );
  }
  const name = resourceToolName(server);
  return defineTool<{ uri: string }, string>({
    name,
    description: `Reads one of ${server.title}'s reference documents, by its URI. The instructions list them.`,
    input: z.object({ uri: z.enum(uris as [string, ...string[]]) }),
    effect: "read",
    // answered from the lock: no server is asked
    timeoutMs: 5_000,
    run: async ({ uri }) => lock?.resources?.[uri]?.text ?? "",
  }) as Tool;
}

/** The granted resources, listed for the instructions: what each is, so the model knows to read it. */
function resourceList(server: ServerEntry, lock: Lock | undefined, uris: string[]): string {
  const lines = uris.map((uri) => {
    const r = lock?.resources?.[uri];
    const what = [r?.title ?? r?.name, r?.description].filter(Boolean).join(": ");
    return `- ${uri}${what ? ` — ${what}` : ""}`;
  });
  return [
    `Its reference documents, read with ${resourceToolName(server)} when you need one:`,
    ...lines,
  ].join("\n");
}

let shared: McpHost | undefined;
/** The process's host from `config/mcp` and `process.env`, made once: one connection per server. */
export function defaultMcpHost(): McpHost {
  shared ??= createMcpHost();
  return shared;
}

// ---------------------------------------------------------------------------
// Sync: the lock from the live server, and what a person must look at
// ---------------------------------------------------------------------------

/** Words that say a tool changes something. A tool named so that the registry calls a read is flagged. */
const WRITES =
  /\b(create|update|upsert|delete|remove|publish|send|run|write|set|revert|duplicate)\b/i;

export interface SyncReport {
  lock: Lock;
  path: string;
  /** Problems that stop the sync: the lock is not written. */
  errors: string[];
  /** What a reviewer should look at before committing the lock. */
  warnings: string[];
  /** What differs from the lock there was. */
  changes: string[];
  /** Server tools the registry does not list: unreachable. */
  unlisted: string[];
}

/**
 * Reads the live server under a tenant's credentials and builds its lock: the instructions, and
 * every listed tool's definition and hash. Written only with `write` and no errors.
 */
export async function syncServer(
  host: McpHost,
  serverId: string,
  tenantId: string,
  opts: { write?: boolean; dir?: string; now?: () => Date } = {},
): Promise<SyncReport> {
  const server = host.registry.get(serverId);
  if (!server) throw new McpConfigError(`no MCP server ${serverId} in the registry`);
  const [info, live] = await Promise.all([
    host.hub.info(serverId, tenantId),
    host.hub.listTools(serverId, tenantId),
  ]);
  const byName = new Map(live.map((t) => [t.name.trim(), t]));
  const errors: string[] = [];
  const warnings: string[] = [];
  const tools: Lock["tools"] = {};
  for (const [remote, policy] of Object.entries(server.tools)) {
    const tool = byName.get(remote);
    if (!tool) {
      errors.push(`${remote} is in config/mcp/${serverId}.json, and the server has no such tool`);
      continue;
    }
    const readOnly = tool.annotations?.readOnlyHint;
    if (policy.effect === "read" && readOnly === false && !policy.reason) {
      errors.push(
        `${remote} is a read here, and the server says it is not read-only: give the reason, or make it a write`,
      );
    } else if (
      policy.effect === "read" &&
      !policy.reason &&
      (WRITES.test(remote) || WRITES.test(tool.title ?? ""))
    ) {
      warnings.push(`${remote} is a read here, and its name says it changes something: check`);
    }
    if (policy.effect === "write" && readOnly === true) {
      warnings.push(
        `${remote} is a write here, and the server says it only reads: it waits for a person anyway`,
      );
    }
    try {
      zodOf(tool.inputSchema);
    } catch (err) {
      errors.push(
        `${remote}'s input schema is one the harness cannot take: ${(err as Error).message}`,
      );
      continue;
    }
    tools[remote] = {
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      hash: toolHash(tool),
    };
  }

  // only the resources a capability grants are locked; the rest are not read
  const granted = [
    ...new Set(Object.values(server.capabilities).flatMap((c) => c.resources ?? [])),
  ].sort();
  const resources: NonNullable<Lock["resources"]> = {};
  if (granted.length) {
    const listed = new Map(
      (await host.hub.listResources(serverId, tenantId)).map((r) => [r.uri, r]),
    );
    for (const uri of granted) {
      const meta = listed.get(uri);
      if (!meta) {
        errors.push(
          `${uri} is granted in config/mcp/${serverId}.json, and the server has no such resource`,
        );
        continue;
      }
      const resource = { ...meta, text: await host.hub.readResource(serverId, tenantId, uri) };
      resources[uri] = {
        name: resource.name,
        ...(resource.title ? { title: resource.title } : {}),
        ...(resource.description ? { description: resource.description } : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        text: resource.text,
        hash: resourceHash(resource),
      };
    }
  }
  const lock: Lock = {
    server: serverId,
    syncedAt: (opts.now?.() ?? new Date()).toISOString(),
    serverInfo: info.serverInfo,
    ...(info.protocolVersion ? { protocolVersion: info.protocolVersion } : {}),
    ...(info.instructions
      ? { instructions: info.instructions, instructionsHash: sha256(info.instructions) }
      : {}),
    tools,
    ...(granted.length ? { resources } : {}),
  };

  const before = host.lock(serverId);
  const changes: string[] = [];
  if (!before) changes.push("no lock before: every tool is new");
  else {
    for (const remote of Object.keys(tools)) {
      if (!before.tools[remote]) changes.push(`${remote}: new`);
      else if (before.tools[remote]?.hash !== tools[remote]?.hash)
        changes.push(`${remote}: changed`);
    }
    for (const remote of Object.keys(before.tools))
      if (!tools[remote]) changes.push(`${remote}: gone`);
    for (const uri of Object.keys(resources)) {
      const was = before.resources?.[uri];
      if (!was) changes.push(`${uri}: new`);
      else if (was.hash !== resources[uri]?.hash) changes.push(`${uri}: changed`);
    }
    for (const uri of Object.keys(before.resources ?? {}))
      if (!resources[uri]) changes.push(`${uri}: gone`);
    if (before.instructionsHash !== lock.instructionsHash)
      changes.push("the server's instructions changed");
    if (before.serverInfo.version !== lock.serverInfo.version) {
      changes.push(`server version ${before.serverInfo.version} → ${lock.serverInfo.version}`);
    }
  }
  const unlisted = live.map((t) => t.name).filter((name) => !server.tools[name]);
  const written = opts.write && errors.length === 0;
  const path = written ? writeLock(lock, opts.dir) : lockPath(serverId, opts.dir);
  if (written) host.forgetLock(serverId);
  return { lock, path, errors, warnings, changes, unlisted };
}
