/**
 * One sign-in, start to finish, with every side effect injected.
 *
 *   start      send the challenge, get a session and a short code
 *   open       send the person to the browser to approve it
 *   poll       present the verifier until the session is approved, refused,
 *              expired, or the person gives up
 *
 * It is a loop, not a callback, so it reads as the sequence it is, and so the
 * tests can drive it with a fake clock and a scripted server instead of waiting
 * on real timers.
 *
 * PURE: the client, the browser, the clock and the sleep are all passed in.
 */
import type { AuthClient, IssuedTokens } from "./client.js";
import { codeChallenge } from "./pkce.js";

export const DEFAULT_POLL_MS = 3_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 10_000;
/** Consecutive blips tolerated before giving up. A flaky wifi is not a denial. */
const MAX_CONSECUTIVE_ERRORS = 5;

export interface WaitingInfo {
  userCode: string;
  loginUrl: string;
  /** ms since epoch. */
  expiresAt: number;
}

export type LoginOutcome =
  | { kind: "signed-in"; tokens: IssuedTokens }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export interface LoginDeps {
  client: AuthClient;
  /** Open the login page. The plugin passes `figma.openExternal`. */
  open(url: string): void;
  /** Whether a login URL is one the plugin will open. */
  allowUrl(url: string): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  onWaiting(info: WaitingInfo): void;
  cancelled(): boolean;
}

export async function runLogin(verifier: string, deps: LoginDeps): Promise<LoginOutcome> {
  const started = await deps.client.start(codeChallenge(verifier));
  if (!started.ok) return { kind: "failed", message: started.message };

  const { session } = started;
  // The server picks the URL, so the server must not be able to pick where the
  // browser goes. A response that points anywhere unexpected is a broken or
  // hostile server, and the plugin opens nothing.
  if (!deps.allowUrl(session.loginUrl)) {
    return { kind: "failed", message: "The sign-in page isn’t on a host this plugin trusts." };
  }

  const expiresAt = deps.now() + session.expiresIn * 1000;
  deps.onWaiting({ userCode: session.userCode, loginUrl: session.loginUrl, expiresAt });
  deps.open(session.loginUrl);

  const interval = clamp((session.interval ?? DEFAULT_POLL_MS / 1000) * 1000, MIN_POLL_MS, MAX_POLL_MS);
  let errors = 0;

  while (deps.now() < expiresAt) {
    await deps.sleep(interval);
    if (deps.cancelled()) return { kind: "cancelled" };

    const result = await deps.client.redeem(session.sessionId, verifier);
    // Checked again after the round trip: a Cancel pressed while the request was
    // in flight must win, or the plugin signs in a person who just said no.
    if (deps.cancelled()) return { kind: "cancelled" };

    switch (result.kind) {
      case "approved":
        return { kind: "signed-in", tokens: result.tokens };
      case "denied":
        return { kind: "denied" };
      case "expired":
        return { kind: "expired" };
      case "pending":
        errors = 0;
        break;
      case "error":
        if (!result.retryable) return { kind: "failed", message: result.message };
        errors++;
        if (errors >= MAX_CONSECUTIVE_ERRORS) return { kind: "failed", message: result.message };
        break;
    }
  }
  return { kind: "expired" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
