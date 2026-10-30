# Dugout (FanOS agent harness)

Thin TypeScript agent harness: loop, tools, guardrails, event stream, durability, memory. Agents are a spec plus typed tools on top. Plan and task IDs (H*, M*, S*, E*): `docs/PLAN.md`.

## Layout

- `packages/contracts` — zod contracts (AgentSpec, Tool, RunEvent, Steps, ModelClient). No framework types cross these.
- `packages/core` — loop over `Steps`, tool pipeline, redactor, OpenAI-compatible model client, run log, `runLocal`
- `packages/db` — Postgres pool, `withTenant` (row-level security), SQL migrations
- `packages/memory` — semantic/episodic store, hybrid search, skills loader, context builder, consolidation
- `packages/evals` — graders, model judge, suite runner and pass-rate gate
- `packages/tracing` — run events → OpenTelemetry spans → Langfuse
- `packages/sdk` — `defineAgent` (what agent packages are written with), live deps, seeding, agent discovery (ADR 0007)
- `agents/match-preview` — sample agent: tools, skill, spec, demo data, eval cases
- `agents/sitemap` — second agent: club brief to import-ready pages plus header menu; ported importer rules, skill, eval cases
- `apps/worker` — runs agents (ADR 0009): claims queued, decided and orphaned runs from Postgres, holds a lease per run, saves its working memory (ADR 0006), writes events to the Valkey stream + Postgres record, hands runs over on SIGTERM; no port; `Dockerfile` for ECS. Also the queue a host uses to hand it runs. Temporal replaces the claiming before production (H7)
- `apps/cli` — the terminal host for the worker, doing what wnm-fanxp-backend will: queues a run, follows its events, asks at each approval and queues the decision

## Commands

- `pnpm check` — lint + typecheck + test (what CI runs)
- `pnpm format` — Biome autofix
- `pnpm infra:up` / `infra:down` / `infra:reset` — Postgres+pgvector (:55432) and Valkey (:56379). Tests need these up.
- `pnpm db:migrate` / `pnpm seed [agent...]` — apply migrations; load every agent's house facts for each tenant
- `pnpm worker` — runs the agents; `pnpm agent` needs one running. `AGENTS=sitemap` limits it to some agents
- `pnpm agent <id> --tenant <tenant> --<input field> <value> [--input json]` — queue a run for the worker and follow it, with an approval prompt: `y`, `n`, or type a change (it goes back to the agent in the same run). Ctrl-C leaves the run going; `pnpm agent --run <runId> --tenant <tenant>` attaches again
- `pnpm preview --tenant demo-cricket --fixture c-101` — `pnpm agent match-preview`
- `pnpm memory:review --tenant <id>` — approve or reject proposed facts
- `pnpm eval match-preview [--scripted] [--fast] [--only id,id]` — eval suite; exits non-zero below the 90% gate (`pnpm eval sitemap` likewise)
- `pnpm sitemap --tenant demo-cricket --brief "..." [--sport cricket]` — `pnpm agent sitemap`
- `pnpm smoke [--fast]` — one minimal live run against the configured model

## Rules

- Internal packages export `src/index.ts` directly; no build step. Run TS with `tsx`.
- Tenant id comes from verified run context, never from the model or tool input.
- Typed tools only — no generic shell. Write-effect tools go behind approval.
- An agent is `agents/<id>/`: `src/agent.ts` calls `defineAgent`, `src/index.ts` exports `agent`, plus `skills/`, `data/<tenant>/style.json` and `evals/suite.ts`. Add it to the worker's list in `apps/worker/scripts/work.ts` for the worker to run it.
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
