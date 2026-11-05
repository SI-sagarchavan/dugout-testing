/**
 * The outbound client. Pure: fetch is a fake, so a down dashboard cannot
 * make these fail, and they do not need Figma.
 */
import { describe, expect, it, vi } from "vitest";
import {
  API_TIMEOUT_MS,
  createApiClient,
  DEFAULT_API_ORIGIN,
  EVENTS_PATH,
  normalizeOrigin,
  resolveOrigin,
  type ApiFetchResponse,
  type StudioEvent,
} from "../src/api/index.js";

function jsonResponse(status: number, body: unknown): ApiFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const event: StudioEvent = {
  type: "page.checked",
  at: 1,
  page: {
    fileKey: "abc",
    fileName: "Southern Brave",
    pageName: "Home",
    rootNodeId: "1:2",
    rootName: "Home",
  },
  payload: { percent: 53.9 },
};

describe("resolveOrigin", () => {
  it("defaults when nothing is stored", () => {
    expect(resolveOrigin(undefined)).toBe(DEFAULT_API_ORIGIN);
    expect(resolveOrigin("")).toBe(DEFAULT_API_ORIGIN);
  });

  it("ignores a host that is not on the allowlist", () => {
    expect(resolveOrigin("http://127.0.0.1:3000")).toBe(DEFAULT_API_ORIGIN);
    expect(resolveOrigin("https://evil.example")).toBe(DEFAULT_API_ORIGIN);
  });

  it("strips a trailing slash before comparing", () => {
    expect(normalizeOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
  });
});

describe("createApiClient", () => {
  it("POSTs the event envelope to /v1/events", async () => {
    const fetch = vi.fn(async () => jsonResponse(202, { id: "e1" }));
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch });
    const result = await client.postEvent(event);
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(`${DEFAULT_API_ORIGIN}${EVENTS_PATH}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  });

  it("turns a 4xx into a result, not a throw", async () => {
    const fetch = vi.fn(async () => jsonResponse(400, { message: "unknown page" }));
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch });
    await expect(client.postEvent(event)).resolves.toEqual({
      ok: false,
      status: 400,
      message: "unknown page",
    });
  });

  it("turns a network failure into a result, not a throw", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch });
    await expect(client.postEvent(event)).resolves.toEqual({
      ok: false,
      status: null,
      message: "Failed to fetch",
    });
  });

  it("times out rather than wait on a hung dashboard", async () => {
    const fetch = vi.fn(() => new Promise<ApiFetchResponse>(() => {}));
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch, timeoutMs: 20 });
    const result = await client.postEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/timed out/);
  });

  it("uses the default timeout when none is passed", () => {
    expect(API_TIMEOUT_MS).toBe(4000);
  });
});

describe("describeError", () => {
  // Figma's fetch can reject with a plain object, and String({}) is the useless
  // "[object Object]" a designer once saw where the reason should have been.
  it("never turns a thrown value into [object Object]", async () => {
    const { describeError } = await import("../src/api/describe-error.js");
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain")).toBe("plain");
    expect(describeError({ message: "blocked domain" })).toBe("blocked domain");
    expect(describeError({ error: "net::ERR_FAILED" })).toBe("net::ERR_FAILED");
    expect(describeError({ code: 7 })).toBe('{"code":7}');
    expect(describeError({})).toBe("no reason was given");
    expect(describeError(undefined)).toBe("no reason was given");
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(describeError(circular)).toBe("no reason was given");
  });
});
