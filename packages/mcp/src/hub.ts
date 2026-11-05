import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { authFetch } from "./auth.ts";
import { drift, type Lock, type RemoteResource, type RemoteTool } from "./lock.ts";
import { pathOf, type Registry, readValue, type ServerEntry } from "./registry.ts";
import { surfaceTokenStore } from "./surface-tokens.ts";
import { fileTokenStore, type TokenStore } from "./tokens.ts";

/** A tool call's answer, as the model or a tool reads it. */
export interface ToolResult {
  /** The text parts, joined; a note in place of each part that is not text. */
  text: string;
  /** The server's `structuredContent`, when it sends one. */
  structured?: unknown;
  isError: boolean;
}

export interface ServerInfo {
  serverInfo: { name: string; version: string };
  protocolVersion?: string;
  instructions?: string;
}

/**
 * The connections to the registry's MCP servers, one per server and tenant: each tenant has its
 * own credentials. Every call an agent makes to an MCP server goes through here, so this is where
 * credentials are added and where a server's tools are checked against their lock.
 */
export interface McpHub {
  /** Whether the server can be reached from here: its URL is set. */
  configured(server: string): boolean;
  call(
    server: string,
    tenantId: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ToolResult>;
  /** Every tool the server lists, all pages. */
  listTools(server: string, tenantId: string): Promise<RemoteTool[]>;
  /** Every resource the server lists, all pages, without its contents. */
  listResources(server: string, tenantId: string): Promise<Omit<RemoteResource, "text">[]>;
  /** A resource's text: its text parts, joined. A server without resources answers none. */
  readResource(server: string, tenantId: string, uri: string): Promise<string>;
  info(server: string, tenantId: string): Promise<ServerInfo>;
  /** Locked tools the live server no longer matches, by tool, with what changed. */
  drifted(server: string, tenantId: string): Promise<Map<string, string>>;
  close(): Promise<void>;
}

export class McpUnavailable extends Error {}

export interface HubOptions {
  registry: Registry;
  /** The server's lock, for the drift check. */
  lock: (server: string) => Lock | undefined;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Where a server's per-tenant grants are kept; the registry's path otherwise. */
  grants?: (server: ServerEntry) => TokenStore;
  /** How long a drift check is trusted before the server is asked again. */
  driftTtlMs?: number;
}

const CLIENT = { name: "dugout", version: "1.0.0" };

/** One token store per file in a process: its writes are queued, and rotations must not race. */
const stores = new Map<string, TokenStore>();
const surfaceStores = new Map<string, TokenStore>();
/** One per backend and server in a process, for the same reason: a rotation is swapped, never raced. */
const surfaceStoreFor = (opts: Parameters<typeof surfaceTokenStore>[0]) => {
  // A caller that brings its own `fetch` (a test) gets a store of its own, not a shared one.
  if (opts.fetch) return surfaceTokenStore(opts);
  const key = `${opts.url}\0${opts.server}\0${opts.resource ?? ""}`;
  let store = surfaceStores.get(key);
  if (!store) {
    store = surfaceTokenStore(opts);
    surfaceStores.set(key, store);
  }
  return store;
};
const storeFor = (path: string) => {
  let store = stores.get(path);
  if (!store) {
    store = fileTokenStore(path);
    stores.set(path, store);
  }
  return store;
};

/** The parts of a tool result a model can read: text, and a note for anything else. */
export function resultOf(raw: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}): ToolResult {
  const parts = Array.isArray(raw.content) ? (raw.content as Array<Record<string, unknown>>) : [];
  const text = parts
    .map((part) =>
      part.type === "text" ? String(part.text ?? "") : `[${String(part.type)} content omitted]`,
    )
    .join("\n");
  return {
    text,
    ...(raw.structuredContent !== undefined ? { structured: raw.structuredContent } : {}),
    isError: raw.isError === true,
  };
}

export function createMcpHub(opts: HubOptions): McpHub {
  const env = opts.env ?? process.env;
  const clients = new Map<
    string,
    Promise<{ client: Client; transport: StreamableHTTPClientTransport }>
  >();
  const checks = new Map<string, { at: number; value: Promise<Map<string, string>> }>();
  const ttl = opts.driftTtlMs ?? 10 * 60_000;

  const entry = (server: string): ServerEntry => {
    const found = opts.registry.get(server);
    if (!found) throw new McpUnavailable(`no MCP server ${server} in the registry`);
    return found;
  };
  const urlOf = (server: ServerEntry) => readValue(server.transport.url, env);

  const connect = (serverId: string, tenantId: string) => {
    const key = `${serverId}\0${tenantId}`;
    let held = clients.get(key);
    if (!held) {
      held = (async () => {
        const server = entry(serverId);
        const url = urlOf(server);
        if (!url) {
          throw new McpUnavailable(
            `${server.title} (${server.id}) is not configured here: set ${typeof server.transport.url === "string" ? "its url" : server.transport.url.env}`,
          );
        }
        const auth = server.auth;
        const grants = () => {
          if (opts.grants) return opts.grants(server);
          // A person's connection in Surface Studio, when this worker is set up to read them
          if (auth.type === "oauth-per-tenant" && auth.surface) {
            const surfaceUrl = readValue(auth.surface.url, env);
            const key = readValue(auth.surface.key, env);
            if (surfaceUrl && key) {
              return surfaceStoreFor({
                url: surfaceUrl,
                key,
                server: server.id,
                resource: url.replace(/\/$/, ""),
                ...(opts.fetch ? { fetch: opts.fetch } : {}),
              });
            }
          }
          const path = auth.type === "oauth-per-tenant" ? pathOf(auth.grants, env) : undefined;
          if (!path) throw new McpUnavailable(`${server.id}: no grants file`);
          return storeFor(path);
        };
        const transport = new StreamableHTTPClientTransport(new URL(url), {
          fetch: authFetch(tenantId, {
            url: url.replace(/\/$/, ""),
            auth:
              auth.type === "none"
                ? { type: "none" }
                : auth.type === "bearer"
                  ? { type: "bearer", token: readValue(auth.token, env) }
                  : { type: "oauth-per-tenant", grants: grants() },
            ...(server.headers ? { headers: server.headers } : {}),
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
          }),
        });
        const client = new Client(CLIENT, { capabilities: {} });
        // the SDK's own types predate exactOptionalPropertyTypes (`sessionId?: string`)
        await client.connect(transport as unknown as Transport);
        return { client, transport };
      })();
      // a connection that failed is not kept: the next call tries again
      held.catch(() => clients.delete(key));
      clients.set(key, held);
    }
    return held;
  };

  /** Drops a connection whose transport failed, so the next call opens a fresh one. */
  const forget = (serverId: string, tenantId: string) => clients.delete(`${serverId}\0${tenantId}`);

  const hub: McpHub = {
    configured: (server) => {
      const found = opts.registry.get(server);
      return Boolean(found && urlOf(found));
    },

    async call(server, tenantId, tool, args, callOpts = {}) {
      const { client } = await connect(server, tenantId);
      try {
        const raw = await client.callTool({ name: tool, arguments: args }, undefined, {
          ...(callOpts.signal ? { signal: callOpts.signal } : {}),
          // the harness times the call out itself; the SDK's own limit sits just past it
          timeout: (callOpts.timeoutMs ?? 60_000) + 5_000,
        });
        // a server answering the older `toolResult` shape has no content: it reads as empty
        return resultOf(raw as Parameters<typeof resultOf>[0]);
      } catch (err) {
        // a JSON-RPC error is the server's answer; anything else may be a broken connection
        if (!(err instanceof McpError)) forget(server, tenantId);
        throw err;
      }
    },

    async listTools(server, tenantId) {
      const { client } = await connect(server, tenantId);
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const t of page.tools) {
          tools.push({
            name: t.name,
            title: t.title ?? (t.annotations?.title as string | undefined),
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
            outputSchema: t.outputSchema as Record<string, unknown> | undefined,
            annotations: t.annotations as Record<string, unknown> | undefined,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },

    async listResources(server, tenantId) {
      const { client } = await connect(server, tenantId);
      // a server that has none does not have to say so: resources is a capability it declares
      if (!client.getServerCapabilities()?.resources) return [];
      const resources: Omit<RemoteResource, "text">[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listResources(cursor ? { cursor } : {});
        for (const r of page.resources) {
          resources.push({
            uri: r.uri,
            name: r.name,
            title: r.title,
            description: r.description,
            mimeType: r.mimeType,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return resources;
    },

    async readResource(server, tenantId, uri) {
      const { client } = await connect(server, tenantId);
      const { contents } = await client.readResource({ uri });
      return contents
        .map((part) => ("text" in part ? String(part.text) : `[binary ${uri} omitted]`))
        .join("\n");
    },

    async info(server, tenantId) {
      const { client, transport } = await connect(server, tenantId);
      const version = client.getServerVersion();
      const instructions = client.getInstructions();
      return {
        serverInfo: { name: version?.name ?? server, version: version?.version ?? "unknown" },
        ...(transport.protocolVersion ? { protocolVersion: transport.protocolVersion } : {}),
        ...(instructions ? { instructions } : {}),
      };
    },

    drifted(server, tenantId) {
      const now = Date.now();
      const cached = checks.get(server);
      if (cached && now - cached.at < ttl) return cached.value;
      const value = (async () => {
        const lock = opts.lock(server);
        if (!lock) return new Map<string, string>();
        return drift(lock, await hub.listTools(server, tenantId));
      })();
      checks.set(server, { at: now, value });
      value.catch(() => checks.delete(server));
      return value;
    },

    async close() {
      const open = [...clients.values()];
      clients.clear();
      await Promise.all(
        open.map((p) => p.then(({ client }) => client.close()).catch(() => undefined)),
      );
    },
  };
  return hub;
}
