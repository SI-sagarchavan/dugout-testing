// pnpm agent library serve [--port 4200] [--host 127.0.0.1]
// The section library's search, over HTTP: a phrase, a reference picture (a screenshot), or both.
// The tenant's own sections come with their picture and DSL subtree, other clubs' (`shared`) as
// skeletons.
//   POST /api/search   { text?, image? (base64), shared?, kind?, limit? (10), offset? } -> { items, hasMore, nextOffset }:
//                      a page of the sections close enough to the question, fewer than `limit` when few are
//   GET  /api/picture?key=<a result's picture.key> -> its PNG
// With LIBRARY_SERVICE_KEY set it is the service wnm-fanxp-backend calls for Surface Studio: every
// /api call carries `Authorization: Bearer <key>` and `x-tenant: <client code>`, the tenant the
// backend verified, and there is no page. With it unset it is for trying the search on this
// machine: a page at / takes the tenant from a dropdown, so keep it on 127.0.0.1.
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { createMemoryStore, loadEmbeddings } from "@dugout/memory";
import { approvedPalette, NEUTRAL_PALETTE, searchLibrary } from "../src/index.ts";
import { openLibrary } from "./common.ts";

loadEnv();
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4200" },
    host: { type: "string", default: "127.0.0.1" },
  },
});
const serviceKey = process.env.LIBRARY_SERVICE_KEY?.trim() || undefined;
const tenants = loadTenants();
const { pool, library, crops } = openLibrary();
const memory = createMemoryStore({ pool, embeddings: loadEmbeddings() });
const page = readFileSync(join(import.meta.dirname, "search-page.html"), "utf8");
const MAX_BODY = 14 * 1024 * 1024;

/** The caller's tenant: the verified `x-tenant` of a keyed service, else what the local page sent. */
function tenantOf(req: IncomingMessage, claimed: string | null | undefined) {
  if (!serviceKey) return tenants.require(claimed ?? "");
  const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const wanted = Buffer.from(serviceKey);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw Object.assign(new Error("not allowed"), { status: 401 });
  }
  return tenants.require(String(req.headers["x-tenant"] ?? ""));
}

const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const json = (res: ServerResponse, status: number, body: unknown) =>
  send(res, status, "application/json", JSON.stringify(body));

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("the picture is too large (10 MB at most)");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!serviceKey && req.method === "GET" && url.pathname === "/") {
      return send(res, 200, "text/html", page);
    }
    if (!serviceKey && req.method === "GET" && url.pathname === "/api/tenants") {
      return json(
        res,
        200,
        tenants.list().map((t) => t.id),
      );
    }
    if (req.method === "GET" && url.pathname === "/api/picture") {
      // a section's picture, only under its own tenant's directory
      const tenant = tenantOf(req, url.searchParams.get("tenant"));
      const key = url.searchParams.get("key") ?? "";
      if (!key.startsWith(`${tenant.id.replace(/[^a-zA-Z0-9_-]/g, "_")}/`)) {
        return json(res, 404, { error: "not found" });
      }
      return send(res, 200, "image/png", await crops.get(key));
    }
    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = JSON.parse(await readBody(req)) as {
        tenant?: string;
        text?: string;
        image?: string;
        shared?: boolean;
        kind?: string;
        limit?: number;
        offset?: number;
      };
      const tenant = tenantOf(req, body.tenant);
      const palette = (await approvedPalette(memory, tenant.id)) ?? NEUTRAL_PALETTE;
      const page = await searchLibrary(
        library,
        {
          tenantId: tenant.id,
          ...(body.text ? { text: body.text } : {}),
          ...(body.image ? { image: Buffer.from(body.image, "base64") } : {}),
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.limit ? { limit: body.limit } : {}),
          ...(body.offset ? { offset: body.offset } : {}),
          scope: body.shared ? "shared" : "own",
        },
        palette,
      );
      return json(res, 200, page);
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    return json(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
});

const port = Number(values.port);
server.listen(port, values.host, () => {
  console.log(
    `section search: http://${values.host}:${port} (${serviceKey ? "service, key required" : "local page"})`,
  );
});
process.on("SIGINT", () => {
  server.close();
  void pool.end().then(() => process.exit(0));
});
