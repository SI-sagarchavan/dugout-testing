# 0022 · Cast MCP behind typed tools

Status: superseded in part by ADR 0026 (2026-11-04). The tools now come from the registry and its lock, not from hand-written code, and `cast.sampleHook` and the `build.*` tools are gone. What stays: OAuth per tenant, one refresh at a time, every write behind approval, the tenant from the run.

## Decision

Agents reach Cast through typed tools (`cast.*`, `packages/mcp`) that call the Cast MCP server's
tools. There is no generic MCP passthrough. Each Cast tool the harness may call is written out with
a zod input, an effect and a timeout, so the allow-list, schema check, approval and redactor of the
tool pipeline apply as they do to any tool.

- **Reads** (`cast.listHooks`, `describeHook`, `listApis`, `describeApi`, `getTemplateBinding`) run
  without approval and retry once.
- **Writes** (`cast.createHook`) are `effect: "write"`, so they always wait for a person's yes. The
  server's other write tools (update, publish, delete) are not exposed. Add one by writing its tool.
- **Sampling** (`cast.sampleHook`, amended 2026-11-04) runs a published hook once through
  `cast_run_hook`, transform applied, and returns its whole output: the only way to see a hook's
  real data by its id, since the MCP does not give the public flow id. It is a read because it runs
  only a hook whose connectors all `GET` (checked on `cast_describe_hook` first; a hook that calls
  another hook is refused too). It spends partner quota and the server's live-run budget (25 an
  hour per person), so it does not retry, and a sample is kept ten minutes per tenant, hook and
  input: the researcher that chose a hook and `bind` read one live call. Inputs are strings, as a
  page sends them.
- **dugout's namespace** (amended 2026-11-04). The hooks dugout's agents choose from and build have
  ids that start `dugout_` (`DUGOUT_HOOKS`; a hook id is lower_snake_case, so not `dugout:`) and
  names that start `dugout: `. `castTools(client, { namespace })` lists only those, and refuses to
  describe or sample any other: `hook-finder` never picks a hook people made. frame-match reads
  every hook, as before.
- **Building** (`hook-maker`, amended 2026-11-04) writes through `build.*` tools over the server's
  create, add_step, set_transform and publish. They write one hook: the one the run created, whose
  id starts `dugout_`. Other hooks are only read, to copy the values they pass a connector. A
  transform is tried locally (`cast_eval_jsonata`) and saved checked against a live run of the new
  hook (`validateAgainst`). The person approves the build as one call (ADR 0025). Updating, deleting
  or re-binding an existing hook stays out of reach.
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

- One worker process per token file. Two processes refreshing the same grant can revoke it. In a
  process, `castClientFromEnv` returns one client per server and token file, so agents that use
  Cast (frame-match, hook-finder, bind) share its one-refresh-at-a-time rule.
- The public flow id (`hook_uuid`, what `/cast/api/flow/<id>` takes) is not in any MCP answer. A
  tree that fetches its data at render time needs it; asked of the Cast team.
- Registered clients expire after 90 days and refresh tokens after 30; log in again then.
- A service credential in `wnm-fanxp-backend` would remove the per-person grant; not done.
