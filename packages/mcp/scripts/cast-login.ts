// One-time browser login for a tenant's Cast grant: pnpm --filter @dugout/mcp cast:login --tenant <id> --site <code>
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { castTokenPath } from "../src/index.ts";
import { fileTokenStore } from "../src/tokens.ts";

// pnpm runs this from packages/mcp; the repo's .env is two levels up
try {
  process.loadEnvFile(join(import.meta.dirname, "..", "..", "..", ".env"));
} catch {
  // no .env: the variables may already be set
}

const { values } = parseArgs({
  options: { tenant: { type: "string" }, site: { type: "string" } },
});
const url = process.env.CAST_MCP_URL?.replace(/\/$/, "");
if (!url || !values.tenant || !values.site) {
  console.error("needs CAST_MCP_URL, --tenant and --site");
  process.exit(1);
}
const path = castTokenPath();

const callback = await new Promise<{ port: number; code: Promise<string>; state: string }>(
  (resolve) => {
    const state = randomBytes(16).toString("base64url");
    let done!: (code: string) => void;
    const code = new Promise<string>((r) => {
      done = r;
    });
    const server = createServer((req, res) => {
      const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      res.end("Connected. You can close this tab.");
      if (query.get("state") === state && query.get("code")) {
        done(query.get("code") as string);
        server.close();
      }
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as { port: number }).port, code, state }),
    );
  },
);

const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
const registered = await fetch(`${url}/oauth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Dugout",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
if (!registered.ok) throw new Error(`register failed: ${registered.status}`);
const { client_id: clientId } = (await registered.json()) as { client_id: string };

const verifier = randomBytes(48).toString("base64url");
const authorize = new URL(`${url}/oauth/authorize`);
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
  state: callback.state,
  resource: url,
  scope: "cast:mcp",
}).toString();
console.log(`Open this URL and approve:\n\n${authorize}\n`);

const token = await fetch(`${url}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: await callback.code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    resource: url,
  }),
});
if (!token.ok) throw new Error(`token failed: ${token.status}`);
const body = (await token.json()) as {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};
await fileTokenStore(path).write(values.tenant, {
  site: values.site,
  clientId,
  refreshToken: body.refresh_token,
  accessToken: body.access_token,
  expiresAt: Date.now() + body.expires_in * 1000,
});
console.log(`Saved the grant for ${values.tenant} in ${path}`);
