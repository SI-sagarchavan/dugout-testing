/**
 * A real MCP server for the tests, built with the official SDK and served over streamable HTTP on
 * localhost: what the client meets is the protocol, not a mock of it. It checks a bearer token
 * per tenant, can expire one, and answers the OAuth refresh a per-tenant grant makes.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

export const INSTRUCTIONS = "Use demo_list_things first. Saving is a draft until it is published.";
export const GUIDE = "# Things\n\nA thing has an id and a size.";

export interface DemoServer {
  url: string;
  /** Each request's tenant (from its token) and `client` header, in order. */
  seen: Array<{ token: string | undefined; client: string | undefined; tool?: string }>;
  /** Tokens the server accepts, by token; a token not here is answered 401. */
  tokens: Set<string>;
  /** Refreshes it answered, with the refresh token each used. */
  refreshes: string[];
  /** What demo_list_things says it does: change it to make the live tool differ from a lock. */
  description: { listThings: string };
  close(): Promise<void>;
}

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => resolve(text));
  });

function build(state: DemoServer) {
  const server = new McpServer({ name: "demo", version: "1.2.3" }, { instructions: INSTRUCTIONS });
  server.registerTool(
    "demo_list_things",
    {
      title: "List things",
      description: state.description.listThings,
      inputSchema: { prefix: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ prefix }) => ({
      content: [
        { type: "text", text: `things: alpha, beta${prefix ? ` (prefix ${prefix})` : ""}` },
      ],
    }),
  );
  server.registerTool(
    "demo_get_thing",
    {
      description: "One thing, as data.",
      inputSchema: { thingId: z.string().min(1) },
      outputSchema: { id: z.string(), size: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ thingId }) => ({
      content: [{ type: "text", text: `thing ${thingId}` }],
      structuredContent: { id: thingId, size: 3 },
    }),
  );
  server.registerTool(
    "demo_save_thing",
    {
      description: "Save a thing as a draft.",
      inputSchema: { thingId: z.string().min(1), note: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ thingId }) => ({ content: [{ type: "text", text: `saved ${thingId}` }] }),
  );
  server.registerTool(
    "demo_fail",
    { description: "Always refuses.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "no such thing" }], isError: true }),
  );
  server.registerTool(
    "demo_run_thing",
    {
      description: "Runs a thing against live systems.",
      inputSchema: { thingId: z.string() },
      outputSchema: { status: z.enum(["ok", "error"]) },
      annotations: { readOnlyHint: false },
    },
    // a run that fails is answered as a success, its failure in the data
    async ({ thingId }) => ({
      content: [{ type: "text", text: `ran ${thingId}` }],
      structuredContent: { status: thingId === "beta" ? "error" : "ok" },
    }),
  );
  server.registerResource(
    "guide",
    "demo://guide",
    { title: "Things guide", description: "What a thing is.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
  );
  server.registerResource(
    "secrets",
    "demo://secrets",
    { description: "Not granted to anyone." },
    async (uri) => ({ contents: [{ uri: uri.href, text: "nothing to see" }] }),
  );
  server.registerTool(
    "demo_delete_everything",
    {
      description: "Deletes every thing.",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    async () => ({ content: [{ type: "text", text: "deleted" }] }),
  );
  return server;
}

export async function startDemoServer(): Promise<DemoServer> {
  let http!: Server;
  const state: DemoServer = {
    url: "",
    seen: [],
    tokens: new Set(),
    refreshes: [],
    description: { listThings: "List every thing, by name." },
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
  http = createServer(async (req, res) => {
    const text = await body(req);
    if (req.url?.endsWith("/oauth/token")) {
      const params = new URLSearchParams(text);
      const used = params.get("refresh_token") ?? "";
      state.refreshes.push(used);
      // rt-<tenant>-<n> rotates to rt-<tenant>-<n+1>, with a new access token
      const [, tenant, n] = /^rt-(.+)-(\d+)$/.exec(used) ?? [];
      if (!tenant) return void res.writeHead(400).end("{}");
      const next = Number(n) + 1;
      state.tokens.add(`at-${tenant}-${next}`);
      res.setHeader("content-type", "application/json");
      return void res.end(
        JSON.stringify({
          access_token: `at-${tenant}-${next}`,
          refresh_token: `rt-${tenant}-${next}`,
          expires_in: 3600,
        }),
      );
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const json = text ? JSON.parse(text) : undefined;
    state.seen.push({
      token,
      client: req.headers.client as string | undefined,
      ...(json?.method === "tools/call" ? { tool: json.params.name } : {}),
    });
    if (!token || !state.tokens.has(token)) {
      res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' });
      return void res.end();
    }
    // stateless: a server and transport per request, as a horizontally scaled server runs
    const server = build(state);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    // the SDK's own types predate exactOptionalPropertyTypes
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, json);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  return state;
}
