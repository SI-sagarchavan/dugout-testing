# Figma plugin sign-in

Status: built on both sides, not yet tried in real Figma

How the Figma plugin proves who is sending, and how a send is tied to a client.

**The FanXP backend owns all of this**, with one page in the admin app. Not dugout, not Surface Studio: neither
issues or judges an account.

| Piece                                | Repo                 | Branch                                          | Where                                                                                                    |
| ------------------------------------ | -------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Endpoints, token, permission, checks | `wnm-fanxp-backend`  | `feat/surface-plugin-auth` (from `development`) | `src/{routes,controllers,services,models}/surface-auth`, two migrations                                  |
| Approval page                        | `wnm-fanxp-frontend` | `feat/surface-plugin-auth` (from `development`) | `apps/fanxp/src/features/connect-plugin`                                                                 |
| Plugin                               | dugout               |                                                 | `packages/surface-canvas/src/auth/`, `tests/auth.test.ts`, `tests/pkce.test.ts`, `tests/tenants.test.ts` |

Builds on `handoff-flow.md`: the presigned Handoff needs a user and a client on every call, and this is where they come from.

## Decisions

- **One sign-in covers every client the user may send for**, the way the admin panel does. The approval is for the
  person. A client is chosen per file in the plugin and named on every send.
- **The backend never trusts the client a send names.** It looks up the user's current access on every request, so
  removing a user from a client, or taking `SURFACE:SEND` off their role, takes effect on the next send without
  revoking anything.
- **A frame that is not a FanOS design is stopped by the backend** before anything is queued.
- **The plugin token is not the dashboard JWT.** Different scope, different claims, each refused by the other's check.

## The flow

OAuth 2.0 authorization with PKCE, finished by polling. Figma's guide (<https://developers.figma.com/docs/plugins/oauth-with-plugins/>)
says the only way to do OAuth in a plugin is a public HTTPS server, a browser hand-off and polling. The identity
provider here is the admin app and its existing login.

```
plugin UI        make verifier (crypto.getRandomValues), post it to the sandbox
plugin sandbox   POST /surface/auth/sessions {codeChallenge}        -> {sessionId, userCode, loginUrl, ...}
                 figma.openExternal(loginUrl)
browser          admin app (login first if needed): shows userCode and the clients, [Approve] [Decline]
                 POST /surface/auth/sessions/:id/approve            (dashboard JWT)
plugin sandbox   POST /surface/auth/token {sessionId, codeVerifier} -> 202 pending ... 200 tokens
                 figma.clientStorage.setAsync('fanos-studio.auth', credentials)
                 GET  /surface/tenants                              -> the clients to choose from
```

PKCE: the plugin sends only the SHA-256 of its verifier. A leaked session id or login URL cannot be redeemed.
The sandbox does the network and opens the browser, so no token crosses `postMessage`.

## Endpoints

Base `PATH_PREFIX + /api/v1` (`http://localhost:4000/fanxp/api/v1` locally). Every reply is wrapped in
`{ data, meta: { message, code, error_code } }`; the plugin reads `data`, and `meta.message` for errors.

| Endpoint                                                                                    | Auth                            | Answer                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /surface/auth/sessions` `{codeChallenge, codeChallengeMethod: "S256"}`                | none, 60 per minute per address | `201 {sessionId, userCode "KQ7M-4XPD", loginUrl, expiresIn: 600, interval: 3}`                                                                                                                                                                                                                                                      |
| `GET /surface/auth/sessions/:id`                                                            | dashboard JWT                   | `{userCode, status, expiresAt, tenants: [{code, name}]}` for the approval page                                                                                                                                                                                                                                                      |
| `POST /surface/auth/sessions/:id/approve` and `/deny`                                       | dashboard JWT                   | `{status}`. Approve fails if expired, already decided, or the user can send for no client                                                                                                                                                                                                                                           |
| `GET /surface/setup`                                                                        | dashboard JWT + `client` header | The Surface Studio Setup page in one answer: `plugin` (`{canSend, connected, connections}`: this user's live plugin sign-ins and whether their role can send for the client), `mcp.servers` (the registry, each with this client's connection) and `theme` (`{synced, themeId, themeName}`, derived from the client's active theme) |
| `POST /surface/mcp/servers/:id/connect`                                                     | dashboard JWT + `client`        | `{authorizationUrl}`: open it in the browser                                                                                                                                                                                                                                                                                        |
| `GET /surface/mcp/callback`                                                                 | none (browser redirect)         | 302 to the Setup page with `?mcp=<id>&status=connected\|denied\|failed`                                                                                                                                                                                                                                                             |
| `DELETE /surface/mcp/servers/:id/connection`                                                | dashboard JWT + `client`        | `{connected: false}`                                                                                                                                                                                                                                                                                                                |
| `PUT /surface/mcp/servers/:id`                                                              | super admin                     | add or change a registry entry                                                                                                                                                                                                                                                                                                      |
| `POST /surface/auth/token` `{sessionId, codeVerifier}`                                      | none                            | `202 pending`, `200 {accessToken, refreshToken, expiresIn, user}`, `403` declined, `410` expired or already redeemed, `400` wrong verifier                                                                                                                                                                                          |
| `POST /surface/auth/refresh` `{refreshToken}`                                               | none                            | as the `200` above. `401` means sign in again                                                                                                                                                                                                                                                                                       |
| `POST /surface/auth/revoke` `{refreshToken}`                                                | none                            | always `200`                                                                                                                                                                                                                                                                                                                        |
| `GET /surface/tenants`                                                                      | plugin token                    | `{tenants: [{code, name}]}`: the clients this user may send for now                                                                                                                                                                                                                                                                 |
| `POST /surface/handoffs/check` `{client, frames: [{frameId, name, slots: {total, bound}}]}` | plugin token                    | `200 {ok}`, `403` client not allowed, `422` not a FanOS design (the reason is in `message`)                                                                                                                                                                                                                                         |

`loginUrl` is `<SURFACE_ADMIN_URL>/#/connect-plugin?session=<id>` (the admin app uses a hash router). The plugin
opens it only if its origin is the API's own or is in `LOGIN_ORIGINS` (`src/api/origin.ts`).

### Rules on the token endpoints

- The verifier's hash is compared with the stored challenge in constant time. A session is redeemed once. After 5 wrong
  verifiers it is locked.
- Refresh tokens rotate. Showing a spent one revokes the whole sign-in (the old and the new holder both lose it).
  Only the last 20 spent hashes are kept.
- Only hashes of refresh tokens are stored (`surface_plugin_grants`). Pending sign-ins are `surface_auth_sessions`.
- A refresh also fails, and cuts the grant, when the user is gone or inactive.

## Which clients, and who decides

A user may send for a client when **their role holds `SURFACE:SEND` and they are mapped to that client**, or when they
are a super admin (every client, as in the dashboard). `SURFACE:SEND` is created by migration and given to every role
that holds `PAGE:UPDATE`; seed 01 creates it on a fresh database. Roles in this system are per user, and clients come
from `site_user_role_mapper`.

The backend answers this in `GET /surface/tenants` (to fill the picker) and again in `POST /surface/handoffs/check`
(to decide). The plugin's list is a convenience, never the gate.

## The plugin token

- Access token: a JWT, 1 hour, claims `sub` (user), `gid` (grant), `scope: "surface:plugin"`, `sst`.
  It has no `id` and no `role`, so the dashboard's `authenticate` refuses it. `authenticatePlugin` refuses anything
  without the plugin scope, checks force logout (`sst`), and looks the grant up on every call, so **revoking a sign-in
  works immediately**.
- Refresh token: random, 30 days, rotating.
- Stored by the plugin in `figma.clientStorage`: local and **not encrypted**. That is why the scope and lifetime are small.
- Env: `SURFACE_ADMIN_URL`, `SURFACE_ACCESS_TOKEN_TTL_SECONDS`, `SURFACE_REFRESH_TOKEN_TTL_DAYS`.

## Stopping a design that is not a FanOS design

Two layers.

1. **Plugin, for feedback.** After walking a frame, the plugin asks the backend before anything is uploaded. A refusal
   shows in Runs as that frame's failure, with the backend's sentence, for example:
   `This does not look like a FanOS design. "Shop product page" binds 2% of its values to tokens (needs 20%).`
2. **Backend, for enforcement.** `POST /surface/handoffs/check` rejects a frame that binds fewer than
   `SURFACE_MIN_BOUND_RATIO` (default 0.2) of its design values to tokens, or has fewer than `SURFACE_MIN_SLOTS`
   (default 10) values to judge.

**Limits to know about.**

- "Bound" means bound to a Figma variable or style, not specifically to a FanOS token. A design that carries its own
  variables passes this rule. The plugin does not yet send which tokens, and the backend has no token list to compare to.
- The counts come from the plugin, so this guards against mistakes, not against a modified client.
- Studio still accepts a send directly and carries no token today. Until Handoff moves onto the backend (the presigned
  Handoff in `handoff-flow.md`), the check is advisory in the sense that nothing downstream demands it. When it moves, the
  backend validates the uploaded IR itself, against the FanOS token vocabulary, and queues a run only for a send
  that passed. That also makes the client authoritative: the run's client comes from the verified token and the
  looked-up access, never from the plugin.

## Plugin behaviour

- Signed out: Handoff says **Connect to send**. Check, History and Export ZIP still work.
- After sign-in the plugin loads the client list. One client is preselected. With several, the Handoff tab has a
  Client picker, remembered on the file (`figma.root` plugin data `fanos-studio.client`), and dropped if the backend
  no longer lists it. With none, Handoff says to ask an admin for Surface access.
- Per frame, before upload: session refreshed if within 60 s of expiry, client chosen, then the backend check.
  A `403` reloads the client list. A `401` signs the plugin out with a reason.
- A refresh the server **refuses** signs out. A refresh that **could not reach** the server does not.
- A token minted for another backend (dev vs production) is treated as signed out here.
- The verifier must be 43 to 128 URL-safe characters or the sandbox refuses to start.

## Running it locally

1. Backend (`wnm-fanxp-backend`): migrate (`npm run migrate:up`), then `npm run dev` (port 4000). The migration
   `20261105100000_add_surface_permissions` needs an existing user, so migrate after the seed on a fresh database.
2. Admin app (`wnm-fanxp-frontend`, `apps/fanxp`): port 5555. Set `SURFACE_ADMIN_URL=http://localhost:5555` for the backend.
3. Plugin: base URL and login origin are the defaults in `src/api/origin.ts` and in `manifest.json`.
4. Log in to the admin app with a user whose role has `SURFACE:SEND` and who is mapped to at least one client, then
   press Connect in the plugin.

There is no fake approver. The flow tested locally is the flow that ships.

CORS: Figma's sandbox sends `Origin: null`. `src/plugins/cors-origin.ts` accepts it on `/surface/` routes only.

## Tested

- Backend unit tests: tokens, the whole flow with an in-memory store, route wiring, CORS decision, the MCP registry,
  connect, callback, grants for dugout, and the Cast MCP authorization (account-wide grants).
- The migrations and the sign-in flow were run against a real Postgres: a throwaway database first, then `fanxp_dev`.
- Plugin tests: PKCE vectors, client, login loop, client choice.
- **Live, on the local backend against `fanxp_dev`:** the plugin signed in through the admin app; Cast connected from the
  Setup page on the admin login (no second sign-in); dugout read that grant from the backend, called `cast.listHooks` through
  its MCP host (drift guard on), and a forced refresh rotated the token and saved it back. `pnpm agent mcp sync cast --check`
  reports "The lock matches the server" (Cast MCP 0.5.1).
- **Not yet done:** the flow in the Figma desktop app and in a browser plugin, and `crypto.getRandomValues` in the plugin
  iframe on current Figma builds.

## Running everything locally (what is set up)

- Tunnel: `aws ssm start-session` to the staging Aurora writer on `localhost:9991` (the reader on 9992 is not used).
- Backend worktree `wnm-fanxp-backend-surface-auth`: a real `npm ci` from the lockfile (Cast MCP `@fanos/cast-mcp` 0.5.1;
  borrowing another checkout's `node_modules` gave 0.4.0 and a dugout lock mismatch). `.env` points at `fanxp_dev`.
- Admin app: `apps/fanxp` on `:5555`, proxying `/fanxp` to the local backend (`VITE_API_PROXY_TARGET=http://localhost:4000`).
- Dugout `.env`: `CAST_MCP_URL`, `SURFACE_API_URL` and `SURFACE_SERVICE_KEY` all on the local backend. A grant is valid only
  for the backend that issued it, so these three must name the same one.
- Studio's request client refreshes an expired token once on a 401 (the host only refreshes when its own calls fail).

## Before this ships

- Production API origin into `networkAccess.allowedDomains` in `manifest.json`, and into `AUTH_BASE_URLS` and
  `LOGIN_ORIGINS` (`src/api/origin.ts`). Today only localhost is listed.
- Check `openExternal` and window focus in both the Figma desktop app and the browser. The plugin cannot refocus
  Figma after approval; the page says "go back to Figma".
- Decide the roles that get `SURFACE:SEND` (today: every role with `PAGE:UPDATE`).
- The in-memory rate limiters count per API task. Starting a session is limited by address (the last `X-Forwarded-For` entry, since the backend has no `trustProxy`), the token poll by session (40 per minute), refresh by address. Move them to Valkey if tasks multiply.
- Move Handoff onto the backend (see above).
- A list of connected plugins per user, with Revoke, in the admin app. The backend can already revoke a grant.

## Open

- Whether `userCode` confirmation is enough against a phished approval, or the page should also show the requesting machine or IP.
- Whether a Figma file should be bound to a client on its first send, so a second client cannot be sent from the same file by mistake.
- How the FanXP client code maps to dugout's tenant id when the backend queues `section-builder` (they may differ).

## MCP servers and the Setup page

The Setup page reads one endpoint, `GET /surface/setup`. Three checks: the Figma plugin, MCP servers, theme. ("Hooks
available" is gone; "Cast connected" became the MCP dropdown.)

- **Registry:** `fanxp_master.mcp_servers`, the same JSON shape as dugout's `config/mcp/<server>.json` (`definition`), seeded
  from `cast.json`. One addition: `transport.publicUrl: {env}` is where this backend reaches the server
  (`CAST_MCP_PUBLIC_URL`), where `transport.url` is the URL dugout's worker uses. Super admins edit it with `PUT`.
- **Connect, for a server whose authorization server is this backend (Cast):** no browser and no second sign-in. The
  person is signed in to the admin app and is the one clicking Connect, so `POST /surface/mcp/servers/:id/connect`
  (dashboard JWT) issues the grant inside that request (`McpAuthorization.issueForSignedInUser`) and answers
  `{connected: true}`. The Cast consent page (email and password) is still there for other MCP clients such as Claude or
  dugout's `mcp login`; Setup does not use it.
- **Connect, for any other server:** the backend is an OAuth client of it: discovery (RFC 9728, 8414), dynamic
  registration (7591), authorization code with PKCE S256 and a single-use `state`, all endpoints on the issuer's origin.
  The answer is `{authorizationUrl}`; the browser goes to the server's own sign-in page and comes back to
  `SURFACE_PUBLIC_API_URL + /surface/mcp/callback`.
- **Either way** the grant is stored in `fanxp_master.mcp_connections`, one per server and **person**, encrypted with the
  Cast credential key (AES-256-GCM, `CAST_CRED_KEY_V1`).
- **Same model as the plugin:** the connection belongs to the account, and the client is named on each call and checked
  against the account's current access. For Cast that is `authenticateMcp`: it takes the site from the `client` header,
  refuses one the account cannot reach (403) or a missing one (400), and re-reads the account's access on every call and
  every refresh. Grants issued before this change stay bound to their one site until they expire.
- **Where it differs from the plugin:** the token is issued by Cast's own OAuth server, not ours, so the change lives in
  `src/services/cast/mcp-auth.ts`. MCP callers must send `client` on every call. Dugout already does: it records the site
  it logged in for and sends it as `client`, so `pnpm agent mcp login --site` keeps working (the flag now only records which
  site dugout sends).
- **Not built yet:** refreshing the stored grant, and dugout reading it. Today dugout still uses its own token file.
- **Theme:** `synced` is "the client has an active, current theme" (`getThemeActivationModel`), the record the platform
  already keeps. Nothing is stored twice.

## Dugout reads the connection

A person connects an MCP server in Surface Studio's Setup page. Dugout's worker then calls that server as them, with no
second login and no local token file.

- **Backend, for the worker only (service key):** `GET /surface/mcp/grants/:server?client=<code>[&user=<id>]` returns the
  grant `{userId, site, clientId, tokenEndpoint, resource, refreshToken, accessToken, expiresAt}`. Whose: the person named
  by `user`, otherwise the newest connection of someone who can use the client (`SURFACE:SEND`). The server still checks
  that person's access to the client on every call, so this picks a sign-in; it never widens what it reaches.
  `PUT /surface/mcp/grants/:server` hands back a rotation `{userId, previousRefreshToken, accessToken, refreshToken,
  expiresAt}`, swapped only if `previousRefreshToken` is still the one on file (`409` otherwise), so a stale writer cannot
  leave a dead token. The key is `x-surface-service-key` = `SURFACE_SERVICE_KEY`. Both are GET and PUT on purpose: the
  request logger records POST bodies.
- **Dugout:** `packages/mcp/src/surface-tokens.ts` is a `TokenStore` over those two routes. `config/mcp/cast.json` names
  where it lives (`auth.surface`: `SURFACE_API_URL`, `SURFACE_SERVICE_KEY`); when both are set the hub uses it instead of the
  grants file. The worker refreshes tokens itself (`authFetch`) and each rotation goes back before the new token is used.
- **Tenant id:** with this store the dugout tenant id is the FanXP client code (`pnpm agent … --tenant ibl`). The demo tenants
  (`demo-cricket`, `demo-football`) are not clients, so they keep using the file.
- **Same backend:** a grant is valid only for the MCP endpoint of the backend that issued it. The store checks the grant's
  `resource` against the server's URL and says so by name. Locally: `CAST_MCP_URL=http://localhost:4000/fanxp/api/v1/cast/mcp`
  and `SURFACE_API_URL=http://localhost:4000/fanxp/api/v1`.
- **Not decided:** which person a run uses once the backend queues runs for a signed-in user. The route takes `user`, so the
  host can pass the person; until then it is the newest connection that can use the client.
