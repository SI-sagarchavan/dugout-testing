/**
 * The calls the plugin makes to sign in, stay signed in, sign out, learn which
 * clients it may send for, and ask whether a frame may go to one of them.
 *
 * The contract is in `.scratch/surface-studio-fanxp/plugin-auth.md`. Like the rest
 * of the API client, nothing here throws into the session: every call returns a
 * value the caller can branch on, and a network failure is a value too.
 *
 * PURE: `fetch` is injected.
 */
import { z } from "zod";
import { describeError } from "../api/describe-error.js";
import type { ApiFetch } from "../api/types.js";
import type { Tenant } from "./credentials.js";

export const AUTH_TIMEOUT_MS = 10_000;

const startResponse = z.object({
  sessionId: z.string().min(1),
  /** What the person compares between the plugin and the browser page. */
  userCode: z.string().min(1),
  loginUrl: z.string().min(1),
  /** Seconds until the session is dead. */
  expiresIn: z.number().positive(),
  /** Seconds between polls. */
  interval: z.number().positive().optional(),
});

const tokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().positive(),
  user: z.object({ id: z.string(), name: z.string() }),
});

const tenantsResponse = z.object({
  tenants: z.array(z.object({ code: z.string().min(1), name: z.string() })),
});

export type StartedSession = z.infer<typeof startResponse>;
export type IssuedTokens = z.infer<typeof tokens>;

export type StartResult =
  | { ok: true; session: StartedSession }
  | { ok: false; message: string };

export type RedeemResult =
  | { kind: "pending" }
  | { kind: "approved"; tokens: IssuedTokens }
  | { kind: "denied" }
  | { kind: "expired" }
  /** `retryable`: the network or the server blinked; the session may still be fine. */
  | { kind: "error"; message: string; retryable: boolean };

export type RefreshResult =
  | { ok: true; tokens: IssuedTokens }
  /** `rejected`: the server said no. The refresh token is dead; sign in again. */
  | { ok: false; rejected: boolean; message: string };

/** What a frame looks like to the backend's check: how much of its design is bound to tokens. */
export interface FrameSummary {
  frameId: string;
  name: string;
  slots: { total: number; bound: number };
}

export type TenantsResult =
  | { ok: true; tenants: Tenant[] }
  /** `unauthorized`: the access token is dead. Refresh once, then sign in again. */
  | { ok: false; unauthorized: boolean; message: string };

export type HandoffCheckResult =
  | { ok: true }
  | {
      ok: false;
      /** The backend looked and said no: not this client, or not a FanOS design. Do not retry. */
      refused: boolean;
      /** 401: the access token is dead. */
      unauthorized: boolean;
      /** 403: the user can no longer send for this client. */
      forbidden: boolean;
      message: string;
    };

export interface AuthClient {
  start(codeChallenge: string): Promise<StartResult>;
  redeem(sessionId: string, codeVerifier: string): Promise<RedeemResult>;
  refresh(refreshToken: string): Promise<RefreshResult>;
  /** Best effort. Signing out locally must never wait on the network. */
  revoke(refreshToken: string): Promise<void>;
  /** The clients this user may send for right now. */
  tenants(accessToken: string): Promise<TenantsResult>;
  /** May these frames go to this client. The answer is the backend's, whatever the plugin believes. */
  checkHandoff(accessToken: string, client: string, frames: FrameSummary[]): Promise<HandoffCheckResult>;
}

export const AUTH_PATHS = {
  sessions: "/surface/auth/sessions",
  token: "/surface/auth/token",
  refresh: "/surface/auth/refresh",
  revoke: "/surface/auth/revoke",
  tenants: "/surface/tenants",
  checkHandoff: "/surface/handoffs/check",
} as const;

export function createAuthClient(options: { origin: string; fetch: ApiFetch }): AuthClient {
  const origin = options.origin.replace(/\/+$/, "");

  const call = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    accessToken?: string,
  ): Promise<{ status: number; json: unknown; raw: unknown } | { status: null; message: string }> => {
    try {
      const response = await withTimeout(
        options.fetch(`${origin}${path}`, {
          method,
          headers: {
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        AUTH_TIMEOUT_MS,
      );
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      // Payloads are read through the envelope; error text keeps the raw body,
      // because the backend puts its message beside `data`, not inside it.
      return { status: response.status, json: unwrap(json), raw: json };
    } catch (err) {
      return { status: null, message: describeError(err) };
    }
  };
  const post = (path: string, body: unknown) => call("POST", path, body);

  return {
    async start(codeChallenge) {
      const result = await post(AUTH_PATHS.sessions, {
        codeChallenge,
        codeChallengeMethod: "S256",
      });
      // The most common first-run failure, and the least obvious from a bare
      // "failed to fetch": say what was being reached and what to check.
      if (result.status === null) {
        return { ok: false, message: `Couldn’t reach ${origin} (${result.message}). Is the backend running?` };
      }
      if (result.status < 200 || result.status >= 300) {
        return { ok: false, message: messageOf(result.raw) || `Sign-in unavailable (${result.status})` };
      }
      const parsed = startResponse.safeParse(result.json);
      return parsed.success
        ? { ok: true, session: parsed.data }
        : { ok: false, message: "The server's sign-in answer was not what the plugin expected." };
    },

    async redeem(sessionId, codeVerifier) {
      const result = await post(AUTH_PATHS.token, { sessionId, codeVerifier });
      if (result.status === null) {
        return { kind: "error", message: result.message, retryable: true };
      }
      if (result.status === 202) return { kind: "pending" };
      if (result.status === 403) return { kind: "denied" };
      if (result.status === 410) return { kind: "expired" };
      if (result.status === 200) {
        const status = (result.json as { status?: unknown } | null)?.status;
        if (status === "pending") return { kind: "pending" };
        const parsed = tokens.safeParse(result.json);
        return parsed.success
          ? { kind: "approved", tokens: parsed.data }
          : { kind: "error", message: "The server's token answer was not what the plugin expected.", retryable: false };
      }
      // A 4xx is the server refusing this exact request; asking again will not help.
      return {
        kind: "error",
        message: messageOf(result.raw) || `Sign-in failed (${result.status})`,
        // 429: the backend asked this address to slow down. The session is fine.
        retryable: result.status >= 500 || result.status === 429,
      };
    },

    async refresh(refreshToken) {
      const result = await post(AUTH_PATHS.refresh, { refreshToken });
      if (result.status === null) return { ok: false, rejected: false, message: result.message };
      if (result.status === 200) {
        const parsed = tokens.safeParse(result.json);
        if (parsed.success) return { ok: true, tokens: parsed.data };
        return { ok: false, rejected: false, message: "Unexpected refresh answer." };
      }
      return {
        ok: false,
        rejected: result.status === 400 || result.status === 401 || result.status === 403,
        message: messageOf(result.raw) || `Refresh failed (${result.status})`,
      };
    },

    async revoke(refreshToken) {
      await post(AUTH_PATHS.revoke, { refreshToken });
    },

    async tenants(accessToken) {
      const result = await call("GET", AUTH_PATHS.tenants, undefined, accessToken);
      if (result.status === null) {
        return { ok: false, unauthorized: false, message: `Couldn’t reach ${origin} (${result.message}).` };
      }
      if (result.status === 200) {
        const parsed = tenantsResponse.safeParse(result.json);
        return parsed.success
          ? { ok: true, tenants: parsed.data.tenants }
          : { ok: false, unauthorized: false, message: "The server's client list was not what the plugin expected." };
      }
      return {
        ok: false,
        unauthorized: result.status === 401,
        message: messageOf(result.raw) || `Couldn’t load your clients (${result.status})`,
      };
    },

    async checkHandoff(accessToken, client, frames) {
      const result = await call("POST", AUTH_PATHS.checkHandoff, { client, frames }, accessToken);
      if (result.status === null) {
        return {
          ok: false,
          refused: false,
          unauthorized: false,
          forbidden: false,
          message: `Couldn’t reach ${origin} (${result.message}).`,
        };
      }
      if (result.status === 200) return { ok: true };
      return {
        ok: false,
        // 403 and 422 are decisions, not hiccups.
        refused: result.status === 403 || result.status === 422,
        unauthorized: result.status === 401,
        forbidden: result.status === 403,
        message: messageOf(result.raw) || `The check failed (${result.status})`,
      };
    },
  };
}

/**
 * The backend wraps every reply: `{ data, meta: { message, code, error_code, ... } }`.
 * The contract is the payload inside `data`, so take that when the envelope is
 * there and the body as it came when it is not (a route that opted out). The older
 * `{ status, message, data }` shape is read too.
 */
export function unwrap(json: unknown): unknown {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const body = json as Record<string, unknown>;
    const metaEnvelope = "data" in body && body["meta"] !== null && typeof body["meta"] === "object";
    const statusEnvelope =
      typeof body["status"] === "string" && "data" in body && body["data"] !== null;
    if (metaEnvelope || statusEnvelope) return body["data"];
  }
  return json;
}

/** The backend's sentence for an error: `meta.message`, or a top-level `message`/`error`. */
export function messageOf(json: unknown): string {
  if (json && typeof json === "object") {
    const body = json as { message?: unknown; error?: unknown; meta?: unknown };
    const meta = body.meta && typeof body.meta === "object" ? (body.meta as { message?: unknown }) : null;
    const m = meta?.message ?? body.message ?? body.error;
    if (typeof m === "string") return m;
  }
  return "";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sign-in timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
