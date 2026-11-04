# 03 · MCP servers as configured tool sources

Status: done (2026-11-04), ADR 0026. Built with capabilities on top: agents ask for a capability, the registry grants tools with argument limits. The connection is the official MCP SDK.
Type: design + task
Blocked by: none

## What

Tools from any MCP server, as typed tools, from two files per server:

- **`config/mcp/<server>.json`, written by a person:** url, auth (`oauth-per-tenant`, `header-from-env`, `none`), and the allow-listed tools with our name, effect, timeout and retries. An unlisted tool is unreachable; a listed tool with no effect is refused at load.
- **`config/mcp/<server>.lock.json`, written by `pnpm agent mcp sync <server>`:** each allowed tool's JSON Schema and description, plus a hash. Run time loads the lock and never the live list. If the live list no longer matches, those tools are refused until sync is run and the diff reviewed.

`z.fromJSONSchema` (zod 4.6.7) turns each schema into the zod input the `Tool` contract takes, so
the whole pipeline applies unchanged. Cast moves onto this with the same tool names, and
`packages/mcp/src/cast.ts` goes. Spec: section C.

## Done when

- Tests written first, against a fake MCP server in the test:
  - a read tool listed in a spec runs, and its result is redacted and stored by reference when long;
  - a write tool waits for approval;
  - an unlisted server tool is unreachable;
  - a tool with no effect fails the load;
  - a changed description or schema on the server refuses that tool, naming the sync command;
  - the tenant's credentials are picked by the run's tenant, never from input.
- The sync command flags a `read` tool whose name or description says create, update, delete, publish, send or run.
- card-match's Cast tools come from `config/mcp/cast.json`; its tests and `pnpm eval card-match --scripted` pass.
- An ADR "MCP servers as configured tool sources", superseding the "no generic passthrough" line of ADR 0022 and keeping the rest.
- Harness issue 10 resolved with a pointer here.

## Pointers

- `packages/mcp/src/client.ts` (add `tools/list` and the other auth kinds), `src/cast.ts`, `src/tokens.ts`
- `packages/core/src/tools.ts` (registry, `toolDefinition`), `packages/contracts/src/tools.ts`
- ADR 0022
