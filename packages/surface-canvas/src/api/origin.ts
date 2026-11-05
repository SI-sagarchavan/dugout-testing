/**
 * Where the plugin is allowed to call.
 *
 * The list is the same set as `devAllowedDomains` in the manifest. A stored
 * origin that is not on it is ignored, so clientStorage cannot point the
 * plugin at an unexpected host. Production hosts land here and in
 * `allowedDomains` together, when there is one.
 *
 * PURE.
 */

export const DEFAULT_API_ORIGIN = "http://localhost:3000";

export const API_ORIGINS = [DEFAULT_API_ORIGIN] as const;

export type ApiOrigin = (typeof API_ORIGINS)[number];

/** Strip a trailing slash. Anything else is left for the allowlist to reject. */
export function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * A stored value, or the default. Unknown hosts fall back rather than fail
 * closed: a bad string in clientStorage should not disable a localhost
 * dashboard the designer is actually running.
 */
export function resolveOrigin(raw: unknown): ApiOrigin {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_API_ORIGIN;
  const origin = normalizeOrigin(raw);
  return (API_ORIGINS as readonly string[]).includes(origin)
    ? (origin as ApiOrigin)
    : DEFAULT_API_ORIGIN;
}

/**
 * Where sign-in lives: the FanXP backend, which owns users, tenants and
 * permissions. Not Surface Studio and not dugout: neither is allowed to issue or
 * judge an account, so the plugin asks the one service that is.
 *
 * A BASE URL, not an origin, because the backend mounts every route under
 * `PATH_PREFIX + "/api/v1"` (`/fanxp/api/v1`): the host alone reaches nothing. It
 * is a separate service from `DEFAULT_API_ORIGIN` (Studio), so it is a separate
 * setting. The local backend is `npm run dev` in `wnm-fanxp-backend`, port 4000.
 * Production hosts land here and in the manifest's `allowedDomains` together.
 */
export const DEFAULT_AUTH_BASE_URL = "http://localhost:4000/fanxp/api/v1";

export const AUTH_BASE_URLS = [DEFAULT_AUTH_BASE_URL] as const;

export function resolveAuthBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_AUTH_BASE_URL;
  const baseUrl = normalizeOrigin(raw);
  return (AUTH_BASE_URLS as readonly string[]).includes(baseUrl) ? baseUrl : DEFAULT_AUTH_BASE_URL;
}

/**
 * Hosts the plugin will open a sign-in page on.
 *
 * `figma.openExternal` is not limited by `networkAccess`, so without this the
 * server's `loginUrl` would decide where a designer's browser goes. The sign-in
 * page is a page of the FanXP admin app, which is not on the backend's host, so
 * the admin app's origins are listed here, with the backend's own.
 */
export const LOGIN_ORIGINS: readonly string[] = ["http://localhost:5555"];

export function isAllowedLoginUrl(url: string, authBaseUrl: string): boolean {
  const origin = originOf(url);
  if (origin === null) return false;
  return origin === originOf(authBaseUrl) || LOGIN_ORIGINS.includes(origin);
}

/** `scheme://host[:port]` of an http(s) URL, or null. Hand-rolled: the sandbox has no `URL`. */
function originOf(url: string): string | null {
  const match = /^(https?):\/\/([^/?#\s@]+)(?:[/?#]|$)/i.exec(url.trim());
  return match ? `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}` : null;
}
