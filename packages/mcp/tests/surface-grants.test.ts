import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRunState, type Tool, type ToolContext } from "@dugout/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMcpHost,
  loadRegistry,
  SurfaceGrantError,
  surfaceTokenStore,
  syncServer,
} from "../src/index.ts";
import { type DemoServer, startDemoServer } from "./server.ts";

const API = "http://surface.test/fanxp/api/v1";
const KEY = "service-key";

/** The backend's `{ data, meta }` reply. */
const reply = (status: number, data: unknown, message = "") =>
  new Response(JSON.stringify({ data, meta: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Stored {
  userId: string;
  resource?: string;
  site: string;
  clientId: string;
  tokenEndpoint?: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

/** A stand-in for the backend's two grant routes, with its compare-and-swap. */
function fakeBackend(initial: Record<string, Stored>) {
  const grants = new Map(Object.entries(initial));
  const calls: Array<{
    method: string;
    url: string;
    key: string | null;
    body?: Record<string, unknown>;
  }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(API)) return fetch(input, init);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({
      method,
      url,
      key: headers.get("x-surface-service-key"),
      ...(body ? { body } : {}),
    });
    if (headers.get("x-surface-service-key") !== KEY)
      return reply(401, {}, "Surface service key invalid");
    const parsed = new URL(url);
    if (method === "GET") {
      const grant = grants.get(parsed.searchParams.get("client") ?? "");
      return grant ? reply(200, grant) : reply(404, {}, "Surface MCP connection not found");
    }
    const entry = [...grants.entries()].find(([, g]) => g.userId === body?.userId);
    if (!entry || entry[1].refreshToken !== body?.previousRefreshToken) {
      return reply(409, {}, "Surface MCP grant changed");
    }
    grants.set(entry[0], {
      ...entry[1],
      accessToken: String(body?.accessToken),
      refreshToken: String(body?.refreshToken),
      expiresAt: Number(body?.expiresAt),
    });
    return reply(200, { saved: true });
  };
  return { grants, calls, fetchFn };
}

const stored = (overrides: Partial<Stored> = {}): Stored => ({
  userId: "7",
  site: "club-a",
  clientId: "c",
  refreshToken: "rt-1",
  accessToken: "at-1",
  expiresAt: Date.now() + 3_600_000,
  ...overrides,
});

describe("the Surface token store", () => {
  it("reads the grant a person connected, with the service key", async () => {
    const backend = fakeBackend({ "club-a": stored() });
    const store = surfaceTokenStore({ url: API, key: KEY, server: "cast", fetch: backend.fetchFn });
    await expect(store.read("club-a")).resolves.toMatchObject({
      site: "club-a",
      clientId: "c",
      refreshToken: "rt-1",
      accessToken: "at-1",
    });
    expect(backend.calls[0]).toMatchObject({
      method: "GET",
      url: `${API}/surface/mcp/grants/cast?client=club-a`,
      key: KEY,
    });
  });

  it("answers nothing, not an error, when nobody has connected it for the tenant", async () => {
    const backend = fakeBackend({});
    const store = surfaceTokenStore({ url: API, key: KEY, server: "cast", fetch: backend.fetchFn });
    await expect(store.read("club-z")).resolves.toBeUndefined();
  });

  it("refuses a grant that is for another backend's MCP, by name", async () => {
    const backend = fakeBackend({
      "club-a": stored({ resource: "http://localhost:4000/fanxp/api/v1/cast/mcp" }),
    });
    const store = surfaceTokenStore({
      url: API,
      key: KEY,
      server: "cast",
      resource: "https://dev-fanxp.sportz.io/fanxp/api/v1/cast/mcp",
      fetch: backend.fetchFn,
    });
    await expect(store.read("club-a")).rejects.toThrow(
      /is for http:\/\/localhost:4000.*calls https:\/\/dev-fanxp/,
    );
  });

  it("says why when the backend refuses", async () => {
    const backend = fakeBackend({});
    const store = surfaceTokenStore({
      url: API,
      key: "wrong",
      server: "cast",
      fetch: backend.fetchFn,
    });
    await expect(store.read("club-a")).rejects.toThrow(/Surface service key invalid/);
  });

  it("hands a rotation back with the refresh token it replaced", async () => {
    const backend = fakeBackend({ "club-a": stored() });
    const store = surfaceTokenStore({ url: API, key: KEY, server: "cast", fetch: backend.fetchFn });
    const grant = await store.read("club-a");
    if (!grant) throw new Error("no grant");
    await store.write("club-a", {
      ...grant,
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: 9,
    });
    expect(backend.calls[1]).toMatchObject({
      method: "PUT",
      body: {
        userId: "7",
        previousRefreshToken: "rt-1",
        accessToken: "at-2",
        refreshToken: "rt-2",
        expiresAt: 9,
      },
    });
    // the next rotation is swapped against the one just saved
    await store.write("club-a", {
      ...grant,
      accessToken: "at-3",
      refreshToken: "rt-3",
      expiresAt: 10,
    });
    expect(backend.calls[2]?.body).toMatchObject({ previousRefreshToken: "rt-2" });
    expect(backend.grants.get("club-a")).toMatchObject({ refreshToken: "rt-3" });
  });

  it("does not overwrite a newer rotation made elsewhere", async () => {
    const backend = fakeBackend({ "club-a": stored() });
    const store = surfaceTokenStore({ url: API, key: KEY, server: "cast", fetch: backend.fetchFn });
    const grant = await store.read("club-a");
    if (!grant) throw new Error("no grant");
    backend.grants.set("club-a", stored({ refreshToken: "rt-elsewhere" }));
    await expect(
      store.write("club-a", { ...grant, accessToken: "at-2", refreshToken: "rt-2", expiresAt: 9 }),
    ).rejects.toThrow(SurfaceGrantError);
    expect(backend.grants.get("club-a")?.refreshToken).toBe("rt-elsewhere");
  });

  it("refuses to write a grant it never read", async () => {
    const backend = fakeBackend({ "club-a": stored() });
    const store = surfaceTokenStore({ url: API, key: KEY, server: "cast", fetch: backend.fetchFn });
    await expect(
      store.write("club-a", { site: "club-a", clientId: "c", refreshToken: "x", accessToken: "y" }),
    ).rejects.toThrow(/before it was read/);
  });
});

let demo: DemoServer;
beforeAll(async () => {
  demo = await startDemoServer();
});
afterAll(() => demo.close());

describe("an MCP server reached with a grant from Surface Studio", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-surface-"));
    demo.tokens.clear();
    demo.seen.length = 0;
    demo.refreshes.length = 0;
  });

  const entry = {
    id: "demo",
    title: "Demo",
    description: "Things, for the tests.",
    owner: "tests",
    environment: "test",
    transport: { type: "streamable-http", url: { env: "DEMO_MCP_URL" } },
    auth: {
      type: "oauth-per-tenant",
      grants: "unused.json",
      scope: "demo",
      surface: { url: { env: "SURFACE_API_URL" }, key: { env: "SURFACE_SERVICE_KEY" } },
    },
    headers: { client: "{grant.site}" },
    tools: { demo_list_things: { effect: "read" } },
    capabilities: {
      "things.read": { description: "Read things", tools: { demo_list_things: {} } },
    },
  };
  const ctx = (tenantId: string): ToolContext => ({
    tenantId,
    runId: "r",
    signal: new AbortController().signal,
    state: memoryRunState(),
  });
  const run = async (tool: Tool | undefined, tenantId: string) => {
    if (!tool) throw new Error("no such tool");
    return tool.run(tool.input.parse({}), ctx(tenantId));
  };

  const hostFor = (backend: ReturnType<typeof fakeBackend>, env: Record<string, string> = {}) => {
    writeFileSync(join(dir, "demo.json"), JSON.stringify(entry));
    return createMcpHost({
      dir,
      env: { DEMO_MCP_URL: demo.url, SURFACE_API_URL: API, SURFACE_SERVICE_KEY: KEY, ...env },
      fetch: backend.fetchFn,
    });
  };

  it("loads the registry entry that names the Surface backend", () => {
    writeFileSync(join(dir, "demo.json"), JSON.stringify(entry));
    expect(loadRegistry(dir).get("demo")?.auth).toMatchObject({
      surface: { key: { env: "SURFACE_SERVICE_KEY" } },
    });
  });

  it("calls the server as the connected person: their token, the tenant as the client", async () => {
    demo.tokens.add("at-1");
    const backend = fakeBackend({ "club-a": stored() });
    const host = hostFor(backend);
    await syncServer(host, "demo", "club-a", { write: true, dir });
    const list = host
      .resolve({ requires: ["things.read"] })
      .tools.find((t) => t.name === "demo.listThings");
    await run(list, "club-a");
    expect(
      demo.seen.filter((s) => s.tool === "demo_list_things").map((s) => [s.token, s.client]),
    ).toEqual([["at-1", "club-a"]]);
    await host.close();
  });

  it("refreshes a revoked token once and gives the rotation back to the backend", async () => {
    // the demo server's token endpoint rotates `rt-<tenant>-N` to `rt-<tenant>-(N+1)`
    demo.tokens.add("at-club-a-1");
    const backend = fakeBackend({
      "club-a": stored({ accessToken: "at-club-a-1", refreshToken: "rt-club-a-1" }),
    });
    const host = hostFor(backend);
    await syncServer(host, "demo", "club-a", { write: true, dir });
    const list = host
      .resolve({ requires: ["things.read"] })
      .tools.find((t) => t.name === "demo.listThings");
    demo.tokens.delete("at-club-a-1");
    await run(list, "club-a");
    expect(demo.refreshes).toEqual(["rt-club-a-1"]);
    expect(backend.grants.get("club-a")).toMatchObject({
      accessToken: "at-club-a-2",
      refreshToken: "rt-club-a-2",
    });
    expect(backend.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    await host.close();
  });

  it("falls back to the grants file when the worker is not set up for Surface", async () => {
    const backend = fakeBackend({ "club-a": stored() });
    const host = hostFor(backend, { SURFACE_API_URL: "", SURFACE_SERVICE_KEY: "" });
    await expect(syncServer(host, "demo", "club-a", { write: true, dir })).rejects.toThrow();
    expect(backend.calls).toHaveLength(0);
    await host.close();
  });
});
