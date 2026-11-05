/**
 * Signing in: the client, the login loop, and what is kept afterwards.
 *
 * The server is a script and the clock is a counter, so every ending a login can
 * have, and the ones a flaky network can force, run in microseconds.
 */
import { describe, expect, it } from "vitest";
import { createAuthClient, type AuthClient, type IssuedTokens } from "../src/auth/client.js";
import {
  isExpiring,
  parseCredentials,
  REFRESH_SKEW_MS,
  type Credentials,
} from "../src/auth/credentials.js";
import { runLogin, type LoginDeps, type WaitingInfo } from "../src/auth/login.js";
import { isAllowedLoginUrl, resolveAuthBaseUrl, DEFAULT_AUTH_BASE_URL } from "../src/api/origin.js";
import type { ApiFetch } from "../src/api/types.js";

const TOKENS: IssuedTokens = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresIn: 3600,
  user: { id: "u1", name: "Sagar" },
};

const ORIGIN = "https://api.example.test/fanxp/api/v1";

function fakeFetch(script: Array<{ status: number; json?: unknown } | { throws: unknown } | Error>): {
  fetch: ApiFetch;
  calls: Array<{ url: string; method: string; authorization?: string; body: unknown }>;
} {
  const calls: Array<{ url: string; method: string; authorization?: string; body: unknown }> = [];
  let i = 0;
  const fetch: ApiFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      authorization: init.headers?.["Authorization"],
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const step = script[Math.min(i++, script.length - 1)]!;
    if (step instanceof Error) throw step;
    if ("throws" in step) throw step.throws;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      statusText: "",
      json: async () => step.json ?? null,
      text: async () => "",
    };
  };
  return { fetch, calls };
}

describe("the auth client", () => {
  it("starts a session with only the challenge, never the verifier", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 201,
        json: { sessionId: "s1", userCode: "ABCD-1234", loginUrl: `${ORIGIN}/connect?s=s1`, expiresIn: 600 },
      },
    ]);
    const result = await createAuthClient({ origin: ORIGIN, fetch }).start("challenge-xyz");
    expect(result).toMatchObject({ ok: true, session: { sessionId: "s1", userCode: "ABCD-1234" } });
    expect(calls[0]).toMatchObject({
      url: `${ORIGIN}/surface/auth/sessions`,
      method: "POST",
      body: { codeChallenge: "challenge-xyz", codeChallengeMethod: "S256" },
    });
    expect(calls[0]!.authorization).toBeUndefined();
  });

  it("reads the backend's { status, message, data } envelope", async () => {
    const wrapped = fakeFetch([
      {
        status: 200,
        json: { status: "success", message: "OK", statusCode: 200, data: { status: "approved", ...TOKENS } },
      },
    ]);
    const result = await createAuthClient({ origin: ORIGIN, fetch: wrapped.fetch }).redeem("s1", "v");
    expect(result).toMatchObject({ kind: "approved", tokens: { accessToken: "at-1" } });

    const failed = fakeFetch([
      { status: 400, json: { status: "error", message: "codeVerifier does not match." } },
    ]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: failed.fetch }).redeem("s1", "v")).toMatchObject({
      kind: "error",
      message: "codeVerifier does not match.",
    });
  });

  it("reads the real { data, meta } envelope, payload and error text both", async () => {
    const ok = fakeFetch([
      {
        status: 201,
        json: {
          data: { sessionId: "s1", userCode: "ABCD-1234", loginUrl: `${ORIGIN}/c`, expiresIn: 600 },
          meta: { message: "Resource created successfully", code: 201 },
        },
      },
    ]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: ok.fetch }).start("c")).toMatchObject({
      ok: true,
      session: { sessionId: "s1" },
    });

    const refused = fakeFetch([
      {
        status: 422,
        json: {
          data: {},
          meta: { error_code: "SURF_10", message: "This does not look like a FanOS design.", code: 422 },
        },
      },
    ]);
    expect(
      await createAuthClient({ origin: ORIGIN, fetch: refused.fetch }).checkSend("at", "pbks", [
        { frameId: "1", name: "Shop", slots: { total: 100, bound: 1 } },
      ]),
    ).toMatchObject({ ok: false, refused: true, message: "This does not look like a FanOS design." });
  });

  it("says what it could not reach, and why, when the network fails", async () => {
    // Figma's fetch can reject with a plain object, not an Error.
    const { fetch } = fakeFetch([{ throws: { message: "blocked domain" } }]);
    const result = await createAuthClient({ origin: ORIGIN, fetch }).start("c");
    expect(result).toEqual({
      ok: false,
      message: `Couldn’t reach ${ORIGIN} (blocked domain). Is the backend running?`,
    });
  });

  it("says so when the server's answer is not what it expects", async () => {
    const { fetch } = fakeFetch([{ status: 200, json: { nope: true } }]);
    const result = await createAuthClient({ origin: ORIGIN, fetch }).start("c");
    expect(result.ok).toBe(false);
  });

  it("reads every status the token endpoint can answer with", async () => {
    const outcomes = [
      [{ status: 202 }, "pending"],
      [{ status: 200, json: { status: "pending" } }, "pending"],
      [{ status: 403 }, "denied"],
      [{ status: 410 }, "expired"],
      [{ status: 200, json: { status: "approved", ...TOKENS } }, "approved"],
    ] as const;
    for (const [step, kind] of outcomes) {
      const { fetch } = fakeFetch([step]);
      const result = await createAuthClient({ origin: ORIGIN, fetch }).redeem("s1", "v");
      expect(result.kind).toBe(kind);
    }
  });

  it("treats a 5xx and a dead network as worth retrying, and a 4xx as final", async () => {
    const down = fakeFetch([new Error("fetch failed")]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: down.fetch }).redeem("s", "v")).toMatchObject({
      kind: "error",
      retryable: true,
    });
    const flaky = fakeFetch([{ status: 503 }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: flaky.fetch }).redeem("s", "v")).toMatchObject({
      retryable: true,
    });
    const bad = fakeFetch([{ status: 400, json: { message: "bad verifier" } }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: bad.fetch }).redeem("s", "v")).toMatchObject({
      kind: "error",
      retryable: false,
      message: "bad verifier",
    });
  });

  it("tells a dead refresh token from a server that is merely down", async () => {
    const dead = fakeFetch([{ status: 401 }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: dead.fetch }).refresh("rt")).toMatchObject({
      ok: false,
      rejected: true,
    });
    const down = fakeFetch([{ status: 502 }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: down.fetch }).refresh("rt")).toMatchObject({
      ok: false,
      rejected: false,
    });
  });
});

/** A server that answers a script, and a clock that only moves when the loop sleeps. */
function loginHarness(options: {
  redeems: Array<Awaited<ReturnType<AuthClient["redeem"]>>>;
  expiresIn?: number;
  loginUrl?: string;
  cancelAfterSleeps?: number;
}): { deps: LoginDeps; opened: string[]; waiting: WaitingInfo[]; redeemCalls: () => number } {
  let now = 1_000_000;
  let sleeps = 0;
  let redeemed = 0;
  const opened: string[] = [];
  const waiting: WaitingInfo[] = [];
  const client: AuthClient = {
    async start() {
      return {
        ok: true,
        session: {
          sessionId: "s1",
          userCode: "ABCD-1234",
          loginUrl: options.loginUrl ?? `${ORIGIN}/connect?s=s1`,
          expiresIn: options.expiresIn ?? 600,
          interval: 3,
        },
      };
    },
    async redeem() {
      return options.redeems[Math.min(redeemed++, options.redeems.length - 1)]!;
    },
    async refresh() {
      return { ok: false, rejected: true, message: "" };
    },
    async revoke() {},
    async tenants() {
      return { ok: true, tenants: [] };
    },
    async checkSend() {
      return { ok: true };
    },
  };
  return {
    opened,
    waiting,
    redeemCalls: () => redeemed,
    deps: {
      client,
      open: (url) => opened.push(url),
      allowUrl: (url) => isAllowedLoginUrl(url, ORIGIN),
      sleep: async (ms) => {
        sleeps++;
        now += ms;
      },
      now: () => now,
      onWaiting: (info) => waiting.push(info),
      cancelled: () => options.cancelAfterSleeps !== undefined && sleeps >= options.cancelAfterSleeps,
    },
  };
}

describe("a login", () => {
  it("opens the browser, shows the code, and signs in once approved", async () => {
    const h = loginHarness({ redeems: [{ kind: "pending" }, { kind: "pending" }, { kind: "approved", tokens: TOKENS }] });
    const outcome = await runLogin("verifier", h.deps);
    expect(outcome).toEqual({ kind: "signed-in", tokens: TOKENS });
    expect(h.opened).toEqual([`${ORIGIN}/connect?s=s1`]);
    expect(h.waiting[0]).toMatchObject({ userCode: "ABCD-1234" });
    expect(h.redeemCalls()).toBe(3);
  });

  it("stops at a refusal", async () => {
    const h = loginHarness({ redeems: [{ kind: "pending" }, { kind: "denied" }] });
    expect(await runLogin("v", h.deps)).toEqual({ kind: "denied" });
  });

  it("gives up when the session runs out, not before", async () => {
    // 600s at a 3s interval is 200 polls; never approved, so it must stop on time.
    const h = loginHarness({ redeems: [{ kind: "pending" }], expiresIn: 30 });
    expect(await runLogin("v", h.deps)).toEqual({ kind: "expired" });
    expect(h.redeemCalls()).toBe(10);
  });

  it("lets a person cancel, including mid-request", async () => {
    const h = loginHarness({ redeems: [{ kind: "approved", tokens: TOKENS }], cancelAfterSleeps: 1 });
    // Cancel is true by the time the first answer arrives: approval must not win.
    expect(await runLogin("v", h.deps)).toEqual({ kind: "cancelled" });
  });

  it("rides out a few network blips but not a dead network", async () => {
    const blip = { kind: "error", message: "offline", retryable: true } as const;
    const ok = loginHarness({ redeems: [blip, blip, { kind: "approved", tokens: TOKENS }] });
    expect((await runLogin("v", ok.deps)).kind).toBe("signed-in");

    const dead = loginHarness({ redeems: [blip] });
    expect(await runLogin("v", dead.deps)).toEqual({ kind: "failed", message: "offline" });
  });

  it("fails at once on an error the server will not change its mind about", async () => {
    const h = loginHarness({ redeems: [{ kind: "error", message: "bad verifier", retryable: false }] });
    expect(await runLogin("v", h.deps)).toEqual({ kind: "failed", message: "bad verifier" });
    expect(h.redeemCalls()).toBe(1);
  });

  it("opens nothing when the server names a host the plugin does not trust", async () => {
    const h = loginHarness({ redeems: [{ kind: "pending" }], loginUrl: "https://evil.example/phish" });
    const outcome = await runLogin("v", h.deps);
    expect(outcome.kind).toBe("failed");
    expect(h.opened).toEqual([]);
  });
});

describe("where a sign-in page may be", () => {
  it("allows the API's own host and nothing that merely looks like it", () => {
    expect(isAllowedLoginUrl(`${ORIGIN}/connect`, ORIGIN)).toBe(true);
    expect(isAllowedLoginUrl("https://api.example.test.evil.com/connect", ORIGIN)).toBe(false);
    expect(isAllowedLoginUrl("https://api.example.test@evil.com/connect", ORIGIN)).toBe(false);
    expect(isAllowedLoginUrl("javascript:alert(1)", ORIGIN)).toBe(false);
    expect(isAllowedLoginUrl("http://api.example.test/connect", ORIGIN)).toBe(false);
  });
});

describe("sign-in lives on the FanXP backend", () => {
  it("defaults to the local backend and ignores an origin it was not built for", () => {
    expect(resolveAuthBaseUrl(undefined)).toBe(DEFAULT_AUTH_BASE_URL);
    expect(resolveAuthBaseUrl("")).toBe(DEFAULT_AUTH_BASE_URL);
    expect(resolveAuthBaseUrl("http://localhost:4000/fanxp/api/v1/")).toBe("http://localhost:4000/fanxp/api/v1");
    expect(resolveAuthBaseUrl("https://evil.example/fanxp/api/v1")).toBe(DEFAULT_AUTH_BASE_URL);
  });

  it("opens the admin app's sign-in page, which is not on the backend's host", () => {
    expect(isAllowedLoginUrl("http://localhost:5555/#/connect-plugin?session=x", DEFAULT_AUTH_BASE_URL)).toBe(true);
    expect(isAllowedLoginUrl("http://localhost:4000/anything", DEFAULT_AUTH_BASE_URL)).toBe(true);
    expect(isAllowedLoginUrl("http://localhost:3000/connect", DEFAULT_AUTH_BASE_URL)).toBe(false);
  });
});

describe("kept credentials", () => {
  const creds: Credentials = {
    origin: ORIGIN,
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: 5_000_000,
    user: { id: "u1", name: "Sagar" },
  };

  it("round-trips through clientStorage", () => {
    expect(parseCredentials(JSON.parse(JSON.stringify(creds)), ORIGIN)).toEqual(creds);
  });

  it("is not signed in against a different API than the token was minted for", () => {
    expect(parseCredentials(creds, "https://other.example.test")).toBeNull();
  });

  it("drops anything malformed instead of refusing to open", () => {
    expect(parseCredentials(null, ORIGIN)).toBeNull();
    expect(parseCredentials("nope", ORIGIN)).toBeNull();
    expect(parseCredentials({ ...creds, accessToken: 7 }, ORIGIN)).toBeNull();
    expect(parseCredentials({ ...creds, user: undefined }, ORIGIN)).toBeNull();
  });

  it("refreshes ahead of expiry, so a send never starts on a dying token", () => {
    expect(isExpiring(creds, creds.expiresAt - REFRESH_SKEW_MS - 1)).toBe(false);
    expect(isExpiring(creds, creds.expiresAt - REFRESH_SKEW_MS)).toBe(true);
    expect(isExpiring(creds, creds.expiresAt + 1)).toBe(true);
  });
});

describe("the clients a sign-in may send for", () => {
  const ACCESS = "at-9";

  it("asks with the access token and reads the list from the envelope", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        json: {
          status: "success",
          data: { tenants: [{ code: "pbks", name: "Punjab Kings" }, { code: "kkr", name: "KKR" }] },
        },
      },
    ]);
    const result = await createAuthClient({ origin: ORIGIN, fetch }).tenants(ACCESS);
    expect(result).toEqual({
      ok: true,
      tenants: [
        { code: "pbks", name: "Punjab Kings" },
        { code: "kkr", name: "KKR" },
      ],
    });
    expect(calls[0]).toMatchObject({
      url: `${ORIGIN}/surface/tenants`,
      method: "GET",
      authorization: `Bearer ${ACCESS}`,
    });
  });

  it("tells a dead token from a server problem", async () => {
    const dead = fakeFetch([{ status: 401, json: { message: "Surface plugin token invalid" } }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: dead.fetch }).tenants(ACCESS)).toMatchObject({
      ok: false,
      unauthorized: true,
    });
    const down = fakeFetch([{ status: 500 }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: down.fetch }).tenants(ACCESS)).toMatchObject({
      ok: false,
      unauthorized: false,
    });
    const offline = fakeFetch([{ throws: { message: "blocked domain" } }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: offline.fetch }).tenants(ACCESS)).toMatchObject({
      ok: false,
      unauthorized: false,
    });
  });

  const frames = [{ frameId: "1:2", name: "Home", slots: { total: 100, bound: 90 } }];

  it("asks the backend before a send, naming the client and the frames", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { status: "success", data: { ok: true } } }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch }).checkSend(ACCESS, "pbks", frames)).toEqual({
      ok: true,
    });
    expect(calls[0]).toMatchObject({
      url: `${ORIGIN}/surface/sends/check`,
      method: "POST",
      authorization: `Bearer ${ACCESS}`,
      body: { client: "pbks", frames },
    });
  });

  it("carries the backend's reason when it refuses a design, and does not call that a hiccup", async () => {
    const { fetch } = fakeFetch([
      {
        status: 422,
        json: { status: "error", message: "This does not look like a FanOS design. \"Shop\" binds 2% of its values." },
      },
    ]);
    const result = await createAuthClient({ origin: ORIGIN, fetch }).checkSend(ACCESS, "pbks", frames);
    expect(result).toMatchObject({ ok: false, refused: true, forbidden: false, unauthorized: false });
    expect(result.ok ? "" : result.message).toContain("does not look like a FanOS design");
  });

  it("marks a client the user can no longer send for as forbidden", async () => {
    const { fetch } = fakeFetch([{ status: 403, json: { message: "Surface client not allowed" } }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch }).checkSend(ACCESS, "kkr", frames)).toMatchObject({
      ok: false,
      refused: true,
      forbidden: true,
    });
  });

  it("does not treat a dead token or a dropped network as a refusal of the design", async () => {
    const dead = fakeFetch([{ status: 401 }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: dead.fetch }).checkSend(ACCESS, "pbks", frames)).toMatchObject({
      ok: false,
      refused: false,
      unauthorized: true,
    });
    const offline = fakeFetch([{ throws: new Error("offline") }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch: offline.fetch }).checkSend(ACCESS, "pbks", frames)).toMatchObject({
      ok: false,
      refused: false,
      unauthorized: false,
    });
  });

  it("keeps polling when the backend asks the address to slow down", async () => {
    const { fetch } = fakeFetch([{ status: 429, json: { message: "Surface rate limited" } }]);
    expect(await createAuthClient({ origin: ORIGIN, fetch }).redeem("s1", "v")).toMatchObject({
      kind: "error",
      retryable: true,
    });
  });
});
