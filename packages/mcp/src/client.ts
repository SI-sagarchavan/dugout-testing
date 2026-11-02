import type { Grant, TokenStore } from "./tokens.ts";

export interface McpClientOptions {
  /** The MCP endpoint, e.g. https://host/fanxp/cast/mcp. Also the OAuth resource. */
  url: string;
  tokens: TokenStore;
  fetch?: typeof fetch;
  /** Refresh this long before the access token expires. */
  skewMs?: number;
}

export class McpError extends Error {}

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/**
 * A minimal client for a stateless streamable-HTTP MCP server that answers in JSON (Cast's does).
 * Credentials are looked up by the tenant id of the run, never taken from tool input.
 */
export class McpClient {
  private readonly url: string;
  private readonly tokens: TokenStore;
  private readonly fetchFn: typeof fetch;
  private readonly skewMs: number;
  private readonly refreshing = new Map<string, Promise<Grant>>();
  private nextId = 1;

  constructor(options: McpClientOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.tokens = options.tokens;
    this.fetchFn = options.fetch ?? fetch;
    this.skewMs = options.skewMs ?? 60_000;
  }

  /** Calls one tool and returns its text. A tool-reported error throws `McpError`. */
  async callTool(
    tenantId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    let grant = await this.grantFor(tenantId);
    let response = await this.post(grant, name, args, signal);
    if (response.status === 401) {
      grant = await this.refresh(tenantId, grant);
      response = await this.post(grant, name, args, signal);
    }
    if (!response.ok) throw new McpError(`${name}: server answered ${response.status}`);
    const result = await readResult(response);
    const text = (result.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    if (result.isError) throw new McpError(text || `${name} failed`);
    return text;
  }

  private post(grant: Grant, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.fetchFn(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${grant.accessToken}`,
        client: grant.site,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      ...(signal ? { signal } : {}),
    });
  }

  private async grantFor(tenantId: string): Promise<Grant> {
    const grant = await this.tokens.read(tenantId);
    if (!grant) {
      throw new McpError(
        `no Cast grant for tenant ${tenantId}; run \`pnpm --filter @dugout/mcp cast:login --tenant ${tenantId}\``,
      );
    }
    const fresh = grant.accessToken && (grant.expiresAt ?? 0) - this.skewMs > Date.now();
    return fresh ? grant : this.refresh(tenantId, grant);
  }

  /** One refresh at a time per tenant: a refresh token used twice revokes the grant. */
  private refresh(tenantId: string, seen: Grant): Promise<Grant> {
    const running = this.refreshing.get(tenantId);
    if (running) return running;
    const job = (async () => {
      const current = (await this.tokens.read(tenantId)) ?? seen;
      // another caller may have rotated it since this one read the grant
      if (
        current.accessToken &&
        current.accessToken !== seen.accessToken &&
        (current.expiresAt ?? 0) - this.skewMs > Date.now()
      ) {
        return current;
      }
      const response = await this.fetchFn(`${this.url}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: current.clientId,
          resource: this.url,
        }),
      });
      if (!response.ok) {
        throw new McpError(
          `Cast refused to refresh the grant for ${tenantId} (${response.status}); log in again`,
        );
      }
      const body = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      const next: Grant = {
        ...current,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + body.expires_in * 1000,
      };
      await this.tokens.write(tenantId, next);
      return next;
    })().finally(() => this.refreshing.delete(tenantId));
    this.refreshing.set(tenantId, job);
    return job;
  }
}

async function readResult(response: Response): Promise<ToolResult> {
  const raw = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? (raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .pop() ?? "")
    : raw;
  const message = JSON.parse(json) as { result?: ToolResult; error?: { message: string } };
  if (message.error) throw new McpError(message.error.message);
  return message.result ?? {};
}
