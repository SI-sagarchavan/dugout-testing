import type { Grant, TokenStore } from "./tokens.ts";

export interface SurfaceTokenStoreOptions {
  /** The backend's API root, `…/fanxp/api/v1`. */
  url: string;
  /** SURFACE_SERVICE_KEY: how the worker proves it may read and rotate grants. */
  key: string;
  /** The registry id of the server, as the backend knows it. */
  server: string;
  /**
   * The MCP endpoint this worker calls. A grant is only valid for the endpoint whose own
   * sign-in issued it, so one for another backend is refused here, by name, not as a 401.
   */
  resource?: string;
  fetch?: typeof fetch;
}

/** What `GET /surface/mcp/grants/:server` answers, inside the backend's `{ data, meta }` envelope. */
interface ServedGrant {
  userId: string;
  site: string;
  clientId: string;
  tokenEndpoint: string;
  resource?: string;
  refreshToken: string | null;
  accessToken: string;
  expiresAt: number;
}

interface Envelope<T> {
  data?: T;
  meta?: { message?: string };
}

export class SurfaceGrantError extends Error {}

/**
 * Grants a person connected in Surface Studio's Setup page, kept by the backend.
 *
 * The tenant id is the FanXP client code, which the backend turns into "the most recent
 * sign-in of someone who can use that client". The worker refreshes the tokens itself
 * (`authFetch`), and every rotation comes back here with the refresh token it replaced:
 * the backend swaps only if that is still the one on file, so two workers can never leave
 * a dead token behind. One store per process, so the last-read token is the one swapped.
 */
export function surfaceTokenStore(opts: SurfaceTokenStoreOptions): TokenStore {
  const base = opts.fetch ?? fetch;
  const root = opts.url.replace(/\/+$/, "");
  const path = `${root}/surface/mcp/grants/${encodeURIComponent(opts.server)}`;
  const headers = { "x-surface-service-key": opts.key, accept: "application/json" };
  /** What was last read or written for a tenant: whose grant it is, and its refresh token. */
  const held = new Map<string, { userId: string; refreshToken: string | null }>();

  const reason = async (response: Response): Promise<string> => {
    const body = (await response.json().catch(() => ({}))) as Envelope<unknown>;
    return body.meta?.message ?? `status ${response.status}`;
  };

  return {
    async read(tenantId) {
      const response = await base(`${path}?client=${encodeURIComponent(tenantId)}`, { headers });
      // Nobody has connected it for this client: the caller says how to fix that.
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new SurfaceGrantError(
          `Surface would not give the ${opts.server} grant for ${tenantId}: ${await reason(response)}`,
        );
      }
      const served = ((await response.json()) as Envelope<ServedGrant>).data;
      if (!served) throw new SurfaceGrantError("Surface answered without a grant.");
      if (opts.resource && served.resource && served.resource !== opts.resource) {
        throw new SurfaceGrantError(
          `The ${opts.server} grant in Surface is for ${served.resource}, but this worker calls ${opts.resource}. Point the server's URL and SURFACE_API_URL at the same backend.`,
        );
      }
      held.set(tenantId, { userId: served.userId, refreshToken: served.refreshToken });
      const grant: Grant = {
        site: served.site,
        tokenEndpoint: served.tokenEndpoint,
        clientId: served.clientId,
        refreshToken: served.refreshToken ?? "",
        accessToken: served.accessToken,
        expiresAt: served.expiresAt,
      };
      return grant;
    },

    async write(tenantId, grant) {
      const previous = held.get(tenantId);
      if (!previous?.refreshToken) {
        throw new SurfaceGrantError(`A grant for ${tenantId} was written before it was read.`);
      }
      const response = await base(path, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          userId: previous.userId,
          previousRefreshToken: previous.refreshToken,
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
          expiresAt: grant.expiresAt,
        }),
      });
      if (!response.ok) {
        throw new SurfaceGrantError(
          `Surface would not save the rotated ${opts.server} grant for ${tenantId}: ${await reason(response)}`,
        );
      }
      held.set(tenantId, { userId: previous.userId, refreshToken: grant.refreshToken });
    },
  };
}
