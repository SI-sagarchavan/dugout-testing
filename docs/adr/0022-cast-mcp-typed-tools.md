# 0022 · Cast MCP behind typed tools

Status: accepted

## Decision

Agents reach Cast through typed tools (`cast.*`, `packages/mcp`) that call the Cast MCP server's
tools. There is no generic MCP passthrough. Each Cast tool the harness may call is written out with
a zod input, an effect and a timeout, so the allow-list, schema check, approval and redactor of the
tool pipeline apply as they do to any tool.

- **Reads** (`cast.listHooks`, `describeHook`, `listApis`, `describeApi`, `getTemplateBinding`) run
  without approval and retry once.
- **Writes** (`cast.createHook`) are `effect: "write"`, so they always wait for a person's yes. The
  server's other write tools (update, publish, delete, `cast_run_hook`, which bills a partner API)
  are not exposed. Add one by writing its tool.
- **Tenant and credentials** come from the run. The tenant id picks a grant (`site`, OAuth client,
  refresh token) from a token file; the model never passes either.

## Auth

The Cast MCP is OAuth only (PKCE, `cast:mcp`), and every call runs as the person who approved it,
with that person's Cast permissions. A person logs in once per tenant
(`pnpm --filter @dugout/mcp cast:login --tenant <id> --site <code>`); the grant is kept in
`CAST_MCP_TOKENS` (default `.runs/cast-mcp.json`, mode 0600). The client refreshes the access token
itself. Refresh tokens rotate and a reused one revokes the grant, so refreshes run one at a time per
tenant and each rotation is saved before the new token is used.

## Consequences

- One worker process per token file. Two processes refreshing the same grant can revoke it.
- Registered clients expire after 90 days and refresh tokens after 30; log in again then.
- A service credential in `wnm-fanxp-backend` would remove the per-person grant; not done.
