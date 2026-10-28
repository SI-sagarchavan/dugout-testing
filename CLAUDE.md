# Dugout (FanOS agent harness)

Thin TypeScript agent harness: loop, tools, guardrails, event stream, durability, memory. Agents are a spec plus typed tools on top. Plan and task IDs (H*, M*, S*, E*): `docs/PLAN.md`.

## Layout

- `packages/contracts` — zod contracts (AgentSpec, Tool, RunEvent, AgentRuntime, ModelClient). No framework types cross these.
- `packages/core` — loop, tool pipeline, model client, event log
- `packages/memory` — working / episodic / semantic / procedural memory
- `packages/evals` — graders, judge, runner
- `agents/*` — one package per agent (`match-preview` first)
- `apps/api`, `apps/worker` — HTTP/SSE API; Temporal worker

## Commands

- `pnpm check` — lint + typecheck + test (what CI runs)
- `pnpm format` — Biome autofix
- `pnpm infra:up` / `infra:down` / `infra:reset` — Postgres+pgvector, Valkey, Temporal dev (UI :8233)

## Rules

- Internal packages export `src/index.ts` directly; no build step. Run TS with `tsx`.
- Tenant id comes from verified run context, never from the model or tool input.
- Typed tools only — no generic shell. Write-effect tools go behind approval.
- Only the consolidation workflow writes long-term memory; agents propose.
- Config is read live through a tool, never copied into memory.
- Public npm registry is pinned in `.npmrc` (the global CodeArtifact token expires).

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
