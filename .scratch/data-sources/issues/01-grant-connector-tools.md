# 01 · Grant Cast's connector tools, create-only

Status: resolved
Type: task
Blocked by: none

## What

Cast's live server has `cast_list_providers`, `cast_upsert_provider` and `cast_upsert_api`, and
`config/mcp/cast.json` does not list them, so no agent can reach them. Add a capability
`connectors.author` that grants them, and give it to hook-maker (`requires` in
`agents/hook-maker/src/agent.ts`).

- `cast_list_providers`: `effect: read`.
- `cast_upsert_provider`, `cast_upsert_api`: `effect: write` (behind approval, as every write).
- **Create only.** Both upserts update by `id`, and a connector or provider is shared: an update
  changes every hook that calls it. Grant creates only: `id` must be absent, and `name` must match
  `^dugout: `. Grant `arguments` today can only match a pattern on a value
  (`packages/mcp/src/registry.ts:45`), so add a way to say an argument must be absent (for
  example the pattern `null` or an `absent: ["id"]` list) and enforce it where grant arguments are
  checked. Not in the adapter: it is a rule of the registry, any server can use it.
- Delete tools, template binding, duplicate and revert stay unlisted.

Then `pnpm agent mcp sync cast --tenant sb` and review the lock's diff (it is what agents read).

## Done when

- `pnpm agent mcp list` shows `connectors.author` with the three tools.
- A call to `cast_upsert_api` with an `id`, or with a name not starting `dugout: `, is refused
  before it reaches the server, with a reason the model can act on (test with the fake hub,
  `@dugout/mcp/testing`).
- The lock is synced and `--check` passes.
- CLAUDE.md's `packages/mcp` and `agents/hook-maker` lines say hook-maker may create connectors
  and providers in dugout's namespace.

## Pointers

- `config/mcp/cast.json` (capabilities `hooks.read`, `hooks.author`: the pattern to copy)
- `packages/mcp/src/registry.ts` (grant schema), `packages/mcp/src/host.ts` `syncServer`
- The tools' input schemas: `pnpm agent mcp sync cast --check` lists them as unreachable; their
  definitions are on the live server (`hub.listTools`)
