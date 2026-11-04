// pnpm agent mcp login <server> --tenant <tenant> --site <code> — one browser login per tenant
// for a server whose auth is oauth-per-tenant. Standard OAuth for MCP, through the SDK: the
// server's protected-resource metadata names its authorization server, the client registers
// itself, the person approves in a browser (PKCE), and the grant is saved for that tenant.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { fileTokenStore, loadRegistry, pathOf, readValue } from "../src/index.ts";
import { loadRepoEnv } from "./env.ts";

loadRepoEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tenant: { type: "string" }, site: { type: "string" } },
});
const serverId = positionals[0];
const server = serverId ? loadRegistry().get(serverId) : undefined;
if (!server || !values.tenant || !values.site) {
  console.error("usage: pnpm agent mcp login <server> --tenant <tenant> --site <code>");
  process.exit(2);
}
if (server.auth.type !== "oauth-per-tenant") {
  console.error(`${server.id} does not log in per tenant (auth: ${server.auth.type})`);
  process.exit(2);
}
const url = readValue(server.transport.url, process.env)?.replace(/\/$/, "");
const grantsPath = pathOf(server.auth.grants, process.env);
if (!url || !grantsPath) {
  console.error(`${server.id} is not configured here: set its url and grants path`);
  process.exit(2);
}

const callback = await new Promise<{ port: number; code: Promise<string>; state: string }>(
  (resolve) => {
    const state = randomBytes(16).toString("base64url");
    let done!: (code: string) => void;
    const code = new Promise<string>((r) => {
      done = r;
    });
    const listener = createServer((req, res) => {
      const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      res.end("Connected. You can close this tab.");
      if (query.get("state") === state && query.get("code")) {
        done(query.get("code") as string);
        listener.close();
      }
    });
    listener.listen(0, "127.0.0.1", () =>
      resolve({ port: (listener.address() as { port: number }).port, code, state }),
    );
  },
);

const redirectUrl = `http://127.0.0.1:${callback.port}/callback`;
const { authorizationServerUrl, authorizationServerMetadata: metadata } =
  await discoverOAuthServerInfo(url);
const clientInformation = await registerClient(authorizationServerUrl, {
  ...(metadata ? { metadata } : {}),
  clientMetadata: {
    client_name: "Dugout",
    redirect_uris: [redirectUrl],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  },
  scope: server.auth.scope,
});
const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
  ...(metadata ? { metadata } : {}),
  clientInformation,
  redirectUrl,
  scope: server.auth.scope,
  state: callback.state,
  resource: url,
});
console.log(`Open this URL and approve:\n\n${authorizationUrl}\n`);
const tokens = await exchangeAuthorization(authorizationServerUrl, {
  ...(metadata ? { metadata } : {}),
  clientInformation,
  authorizationCode: await callback.code,
  codeVerifier,
  redirectUri: redirectUrl,
  resource: url,
});
if (!tokens.refresh_token) throw new Error("the server gave no refresh token");
await fileTokenStore(grantsPath).write(values.tenant, {
  site: values.site,
  clientId: clientInformation.client_id,
  refreshToken: tokens.refresh_token,
  accessToken: tokens.access_token,
  expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  tokenEndpoint:
    metadata?.token_endpoint ?? new URL("token", `${authorizationServerUrl}/`).toString(),
});
console.log(`Saved the grant for ${values.tenant} (site ${values.site}) in ${grantsPath}.`);
