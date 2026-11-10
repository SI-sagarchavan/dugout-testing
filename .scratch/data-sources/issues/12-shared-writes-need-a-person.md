# 12 · A write to something shared is shown to a person, even under one approval

Status: resolved (2026-11-10, after review; the review's wording is ticket 11)
Type: task
Blocked by: none

## What

A child's writes go through under the approval of the parent's call
(`packages/sdk/src/subagents.ts:64-71`, "the call that started this run … (auto)"). In watch mode
nobody approves even that. In run `f77d8a76`, hook-maker created two Cast providers and two API
connectors with no person seeing them. Connectors and providers are shared: every hook in the
workspace can call them, and Cast marks `cast_upsert_api` and `cast_upsert_provider`
`destructiveHint: true`.

This is not about Cast alone. Any MCP server can have writes whose effect reaches beyond the run.

## Change

1. Registry: a tool's policy can say `shared: true` (default: the server's `destructiveHint`). It
   means the write changes something other runs and other people use.
2. A shared write is never covered by a parent's approval or by `--yes` / watch mode on its own.
   It goes to the person through the approval gate. Its explanation is the model's, as ticket 11
   makes every approval: the call's stated reason, the input (name, URL, query parameters; never a
   secret) and, for an update, the hooks the tool reports already use it.
   - With `--yes`, or Surface Studio's "publish without asking", the person can opt in per tenant
     with a house fact (`approvals.shared-writes: auto`). Then the write goes through and is listed
     in the run's result and thread note under `created`.
3. Whatever a run created in a shared space (connectors, providers, hooks) is listed in the
   section-builder output (`created`), so Surface Studio can show it.

## Done when

- `pnpm agent mcp list` shows which tools are shared.
- An SDK test: a child's shared write under an approved parent call raises a `review` question.
  With the opt-in fact it goes through and is in `created`.
- section-builder's output and thread note list `created`.

## Pointers

- `packages/sdk/src/subagents.ts` (`approvedWithCall`), `packages/mcp/src/registry.ts` (tool
  policy), `config/mcp/cast.json`, `agents/section-builder/src/agent.ts` (output, note)

## Comments

2026-11-09: done. `shared` on a tool policy (default: the server's `destructiveHint`; `cast_remove_step` is `false`: it only touches the agent's own hook); `pnpm agent mcp list` marks them. The loop's `review` question carries `shared: true`; a child's responder (`approvedWithCall`) holds it for a person unless the tenant has the active house fact `approvals.shared-writes: auto`; the terminal host's `--yes` / watch mode does not auto-approve a shared review. `created` (hook-maker's answer, read by code) is in data-bind's result, section-builder's output and thread note. The review's words are still the harness's fixed sentence plus "shared"; the model's reason for each write is ticket 11.

2026-11-09 review, reopened:
- **The opt-in matches "auto" anywhere in the fact's sentence** (`packages/sdk/src/agent.ts:351-353`, `/\bauto\b/i` on `content`). An approved fact "Shared writes are never auto-approved" opts in. Confirmed. Compare the fact's typed `value` exactly (`"auto"`).
- **`--yes` ignores the opt-in for a top-level shared write** (`apps/cli/src/session.ts:104`): the terminal never reads the fact, so an opted-in tenant is asked at every shared write under `--yes`. Read it with the verified tenant.
- **`cast.json` relies on Cast's `destructiveHint`.** Mark `cast_upsert_api` and `cast_upsert_provider` `shared: true` explicitly, so a hint dropped by the server cannot make them auto-approved through a quiet sync; `mcp list` also shows the `absent: id` rule.
- **`created` is the model's word.** Code builds it from the child's transcript (each completed `cast.upsertProvider` / `cast.upsertApi` / `cast.createHook` call and its result's id), not from hook-maker's answer.
- Thread note summary with one stand-in and one bound slot counts the bound slot's props as stand-in props (`agents/section-builder/src/agent.ts`, `fanOut`).
- Still open, and ticket 11's: the review's words are the fixed sentence.

2026-11-10, review fixed: `sharedWritesAuto` (`packages/sdk/src/subagents.ts`) compares the active fact's typed value to `"auto"` exactly, verified tenant only (`pnpm agent memory fact --value auto` sets it); the terminal's `--yes` reads the same opt-in (`apps/cli/src/session.ts`, `sharedWrites`); `cast_upsert_api` / `cast_upsert_provider` are `shared: true` in `config/mcp/cast.json`; `mcp list` shows `absent: id`; hook-maker's `created` is built by code from its completed `cast.upsertProvider` / `cast.upsertApi` / `cast.createHook` calls (`createdIn`), the model's is overwritten; section-builder's note counts stand-in and bound props apart. Tests: sdk, mcp, `apps/cli/tests/shared-writes.test.ts`, section-builder.
