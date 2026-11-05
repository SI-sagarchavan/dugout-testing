import type { Grant, TokenStore } from "./tokens.ts";

export class McpAuthError extends Error {}

type Fetch = typeof fetch;

export interface AuthOptions {
  /** The server's MCP endpoint: also the OAuth resource a grant is for. */
  url: string;
  auth:
    | { type: "none" }
    | { type: "bearer"; token: string | undefined }
    | { type: "oauth-per-tenant"; grants: TokenStore };
  /** Extra headers; `{grant.<field>}` is filled from the tenant's grant. */
  headers?: Record<string, string>;
  /** Refresh this long before the access token expires. */
  skewMs?: number;
  fetch?: Fetch;
}

/** Refreshes in flight, by grant file and tenant: a refresh token used twice revokes the grant. */
const refreshing = new Map<string, Promise<Grant>>();

/**
 * The `fetch` the MCP transport sends every request through, for one tenant: it adds the
 * credentials, so neither the transport nor the model ever holds them. With a per-tenant OAuth
 * grant it refreshes before expiry and once after a 401, one refresh at a time per tenant, each
 * rotation saved before the new token is used.
 */
export function authFetch(tenantId: string, opts: AuthOptions): Fetch {
  const base = opts.fetch ?? fetch;
  const skewMs = opts.skewMs ?? 60_000;
  const filled = (grant?: Grant) =>
    Object.fromEntries(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [
        k,
        v.replace(/\{grant\.([a-zA-Z]+)\}/g, (_, field: string) =>
          String((grant as unknown as Record<string, unknown> | undefined)?.[field] ?? ""),
        ),
      ]),
    );
  const send = (
    input: Parameters<Fetch>[0],
    init: RequestInit | undefined,
    extra: Record<string, string>,
  ) => {
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return base(input, { ...init, headers });
  };

  if (opts.auth.type === "none") {
    return ((input, init) => send(input, init, filled())) as Fetch;
  }
  if (opts.auth.type === "bearer") {
    const { token } = opts.auth;
    return (async (input, init) => {
      if (!token) throw new McpAuthError(`no token for ${opts.url}: its variable is not set`);
      return send(input, init, { ...filled(), authorization: `Bearer ${token}` });
    }) as Fetch;
  }

  const grants = opts.auth.grants;
  const key = `${tenantId}\0${opts.url}`;
  const current = async (): Promise<Grant> => {
    const grant = await grants.read(tenantId);
    if (!grant) {
      throw new McpAuthError(
        `no grant for tenant ${tenantId} on ${opts.url}; connect it in Surface Studio's Setup page, or log in once with \`pnpm agent mcp login\``,
      );
    }
    const fresh = grant.accessToken && (grant.expiresAt ?? 0) - skewMs > Date.now();
    return fresh ? grant : refresh(grant);
  };
  const refresh = (seen: Grant): Promise<Grant> => {
    const running = refreshing.get(key);
    if (running) return running;
    const job = (async () => {
      const latest = (await grants.read(tenantId)) ?? seen;
      // another caller may have rotated it since this one read it
      if (
        latest.accessToken &&
        latest.accessToken !== seen.accessToken &&
        (latest.expiresAt ?? 0) - skewMs > Date.now()
      ) {
        return latest;
      }
      const response = await base(latest.tokenEndpoint ?? `${opts.url}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: latest.refreshToken,
          client_id: latest.clientId,
          resource: opts.url,
        }),
      });
      if (!response.ok) {
        throw new McpAuthError(
          `${opts.url} refused to refresh the grant for ${tenantId} (${response.status}); log in again`,
        );
      }
      const body = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      const next: Grant = {
        ...latest,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? latest.refreshToken,
        expiresAt: Date.now() + body.expires_in * 1000,
      };
      await grants.write(tenantId, next);
      return next;
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, job);
    return job;
  };

  return (async (input, init) => {
    let grant = await current();
    const once = () =>
      send(input, init, { ...filled(grant), authorization: `Bearer ${grant.accessToken}` });
    let response = await once();
    if (response.status === 401) {
      grant = await refresh(grant);
      response = await once();
    }
    return response;
  }) as Fetch;
}
