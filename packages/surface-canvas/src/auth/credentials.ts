/**
 * What the plugin keeps after a login, and when it stops being usable.
 *
 * Stored in `figma.clientStorage`: local to this machine, scoped to this user and
 * this plugin, and not encrypted. That is the best place a plugin has, and it is
 * why the token is a scoped, expiring, revocable plugin token and never the
 * designer's own admin session.
 *
 * PURE.
 */

/** A client the signed-in user may send for. */
export interface Tenant {
  code: string;
  name: string;
}

/**
 * A sign-in belongs to a person, not to a client. Which clients it may send for
 * is the backend's answer, asked for after sign-in and checked again on every send.
 */
export interface Credentials {
  /** The API the token is for. A token is never sent to any other host. */
  origin: string;
  accessToken: string;
  refreshToken: string;
  /** ms since epoch. */
  expiresAt: number;
  user: { id: string; name: string };
}

export const CLIENT_STORAGE_AUTH_KEY = "fanos-studio.auth";

/** Refresh this far ahead of expiry, so a send never starts with a token that dies mid-walk. */
export const REFRESH_SKEW_MS = 60_000;

export function isExpiring(credentials: Credentials, now: number): boolean {
  return credentials.expiresAt - now <= REFRESH_SKEW_MS;
}

/**
 * Whatever clientStorage hands back, as credentials for THIS origin, or null.
 *
 * A token minted for another API (the designer switched from dev to production) is
 * not an error to repair; it is simply not signed in here. Anything malformed is
 * dropped the same way, so a bad value can never stop the plugin from opening.
 */
export function parseCredentials(raw: unknown, origin: string): Credentials | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const user = r["user"] as Record<string, unknown> | undefined;
  if (
    r["origin"] !== origin ||
    typeof r["accessToken"] !== "string" ||
    typeof r["refreshToken"] !== "string" ||
    typeof r["expiresAt"] !== "number" ||
    !user ||
    typeof user["id"] !== "string" ||
    typeof user["name"] !== "string"
  ) {
    return null;
  }
  return {
    origin,
    accessToken: r["accessToken"],
    refreshToken: r["refreshToken"],
    expiresAt: r["expiresAt"],
    user: { id: user["id"], name: user["name"] },
  };
}
