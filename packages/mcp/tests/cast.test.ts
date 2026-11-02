import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { castTools, fileTokenStore, McpClient } from "../src/index.ts";

let server: Server;
let url: string;
let seen: {
  auth?: string | undefined;
  client?: string | undefined;
  tool?: string;
  args?: unknown;
}[];
let refreshes: number;

beforeEach(async () => {
  seen = [];
  refreshes = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url?.endsWith("/oauth/token")) {
        refreshes++;
        const used = new URLSearchParams(body).get("refresh_token");
        res.setHeader("content-type", "application/json");
        if (used !== "rt-1") return void res.writeHead(400).end("{}");
        return void res.end(
          JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
        );
      }
      const rpc = JSON.parse(body);
      seen.push({
        auth: req.headers.authorization,
        client: req.headers.client as string,
        tool: rpc.params.name,
        args: rpc.params.arguments,
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: "1 hook(s)" }] },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/fanxp/cast/mcp`;
});
afterEach(() => new Promise((r) => server.close(r)));

async function setup() {
  const path = join(await mkdtemp(join(tmpdir(), "cast-mcp-")), "grants.json");
  const store = fileTokenStore(path);
  await store.write("demo-cricket", { site: "site-a", clientId: "c1", refreshToken: "rt-1" });
  const tools = castTools(new McpClient({ url, tokens: store }));
  return {
    path,
    tool: (name: string) => {
      const found = tools.find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    },
  };
}

const ctx = (tenantId: string) => ({ tenantId, runId: "r1", signal: new AbortController().signal });

it("calls a read tool as the run's tenant and rotates the refresh token once", async () => {
  const { tool, path } = await setup();
  const list = tool("cast.listHooks");
  const out = await Promise.all([
    list.run({ status: "published" }, ctx("demo-cricket")),
    list.run({}, ctx("demo-cricket")),
  ]);
  expect(out).toEqual(["1 hook(s)", "1 hook(s)"]);
  expect(refreshes).toBe(1);
  expect(seen.find((call) => (call.args as { status?: string }).status)).toMatchObject({
    auth: "Bearer at-2",
    client: "site-a",
    tool: "cast_list_hooks",
    args: { status: "published" },
  });
  expect(JSON.parse(await readFile(path, "utf8"))["demo-cricket"].refreshToken).toBe("rt-2");
});

it("has no grant for another tenant", async () => {
  const { tool } = await setup();
  await expect(tool("cast.listHooks").run({}, ctx("demo-football"))).rejects.toThrow(
    /no Cast grant/,
  );
});

it("declares writes as writes and reads as reads", async () => {
  const { tool } = await setup();
  expect(tool("cast.createHook").effect).toBe("write");
  expect(tool("cast.listHooks").effect).toBe("read");
  expect(tool("cast.createHook").input.safeParse({ id: "Bad Id", name: "x" }).success).toBe(false);
});
