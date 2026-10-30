# Dugout (FanOS agent harness)

Thin TypeScript agent harness: loop, tools, guardrails, event stream, durability, memory. Agents are a spec plus typed tools on top. Plan and task IDs (H*, M*, S*, E*): `docs/PLAN.md`.

## Layout

- `packages/contracts` — zod contracts (AgentSpec, Tool, RunEvent, Steps, ModelClient). No framework types cross these.
- `packages/core` — loop over `Steps`, tool pipeline, redactor, Bedrock model client (ADR 0012), run log, `runLocal`
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
- `pnpm db:migrate` / `pnpm seed` — apply migrations; load each tenant's house facts (`config/tenants/<tenant>/facts.json`) into memory. Every agent of a tenant reads all of its memory (ADR 0013)
- `pnpm worker` — runs the agents; `pnpm agent` needs one running. `AGENTS=sitemap` limits it to some agents
- `pnpm agent` — menu of commands when a terminal is attached; `pnpm agent --help` lists them. `pnpm agent <id> --tenant <tenant> --<input field> <value> [--input json]` queues a run and follows it (flags left off are asked). At an approval, a terminal offers Approve, Reject, or Request a change; a pipe answers `y`, `n`, or the change. Ctrl-C leaves the run going; `pnpm agent attach --run <runId> --tenant <tenant>` (or `--run`) attaches again; `pnpm agent cancel <runId> --tenant <tenant> [--reason <why>]` (or `--cancel`) stops it. `pnpm agent runs --tenant <tenant>` lists recent runs; `pnpm agent agents` lists agents
- `pnpm preview --tenant demo-cricket --fixture c-101` — `pnpm agent match-preview`
- `pnpm memory:review --tenant <id>` — approve or reject proposed facts; `--shared` for proposed shared memory
- `pnpm memory:promote` — propose facts and lessons that several tenants hold as shared memory, for their sport or for every tenant (ADR 0014)
- `pnpm eval match-preview [--scripted] [--model <name>] [--only id,id]` — eval suite; exits non-zero below the 90% gate (`pnpm eval sitemap` likewise). `--model` runs the agent on another model in `config/models.json`
- `pnpm sitemap --tenant demo-cricket --brief "..." [--sport cricket]` — `pnpm agent sitemap`
- `pnpm smoke [--model <name>]` — one minimal live run, on `nova-lite` unless named
- `pnpm schemas` — write each agent's input and output JSON Schema to `schemas/` for hosts; a test fails when they are out of date

## Rules

- Internal packages export `src/index.ts` directly; no build step. Run TS with `tsx`.
- Tenant id comes from verified run context, never from the model or tool input.
- Typed tools only — no generic shell. Write-effect tools go behind approval.
- An agent is `agents/<id>/`: `src/agent.ts` calls `defineAgent`, `src/index.ts` exports `agent`, plus `skills/` and `evals/suite.ts`. Add it to the worker's list in `apps/worker/scripts/work.ts` for the worker to run it.
- A skill in `skills/` is in the spec's `skills` (always in the instructions) or `onDemandSkills` (listed by its frontmatter `description`, loaded with `skill.load`; ADR 0011).
- Nothing in an agent folder is per tenant (ADR 0010). What differs by tenant is house facts in memory, or data a tool reads with the verified tenant id. Demo tenants keep theirs in `config/tenants/<tenant>/`.
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
