# Dugout (FanOS agent harness)

Thin TypeScript agent harness: loop, tools, guardrails, event stream, durability, memory. Agents are a spec plus typed tools on top. Plan and task IDs (H*, M*, S*, E*): `docs/PLAN.md`.

## Layout

- `packages/contracts` — zod contracts (AgentSpec, Tool, RunEvent, Steps, ModelClient). No framework types cross these.
- `packages/core` — loop over `Steps`, tool pipeline, redactor, Bedrock model client (ADR 0012), run log, `runLocal`; stop reasons, model retries and when `final` is accepted (ADR 0018)
- `packages/db` — Postgres pool, `withTenant` (row-level security), SQL migrations
- `packages/memory` — semantic/episodic store, hybrid search, skills loader, context builder (stable memory in the system prompt, lessons and approved examples in the first user message; ADR 0013), consolidation
- `packages/evals` — graders, model judge, suite runner and pass-rate gate
- `packages/tracing` — run events → OpenTelemetry spans → Langfuse
- `packages/sdk` — `defineAgent` (what agent packages are written with), live deps, seeding, agent discovery (ADR 0007)
- `agents/match-preview` — sample agent: tools, skill, spec, demo data, eval cases
- `agents/sitemap` — second agent: club brief to import-ready pages plus header menu; ported importer rules, skill, eval cases
- `agents/matchday` — matchday pack for one fixture: preview plus any of social, push and headline; always-on skill, channel skills loaded with `skill.load`
- `agents/card` — one SDUI card in the trial repo's flat DSL. The host keeps the tree. With a Figma file, `pnpm agent card` is one attempt: `card.figma`, `card.check`, `card.edit`, `card.diff` and `card.save`. Without one, it generates from the brief, reads an optional screenshot with `card.see` (a vision model), does not call `card.save`, and the host writes the checked card to the preview when `final` succeeds. `pnpm card` is a graph: code loads, checks, diffs and saves, and a failed check or diff calls repair for edits only
- `agents/card-match` — matches a compiled Figma frame to its screenshot, from a Send stored in the control plane (ADR 0019). Code fixes what needs no judgement, the model adds overrides, and each is measured and undone if it doesn't help
- `apps/worker` — runs agents (ADR 0009): claims queued, decided and orphaned runs from Postgres, holds a lease per run, saves its working memory (ADR 0006), writes events to the Valkey stream + Postgres record, hands runs over on SIGTERM; no port; `Dockerfile` for ECS. Also the queue a host uses to hand it runs. Temporal replaces the claiming before production (H7)
- `apps/cli` — the terminal host for the worker, doing what wnm-fanxp-backend will: queues a run, follows its events, asks at each approval and queues the decision

## Commands

- `pnpm check` — lint + typecheck + test (what CI runs)
- `pnpm format` — Biome autofix
- `pnpm infra:up` / `infra:down` / `infra:reset` — Postgres+pgvector (:55432) and Valkey (:56379). Tests need these up.
- `pnpm db:migrate` / `pnpm seed` — apply migrations; load each tenant's house facts (`config/tenants/<tenant>/facts.json`) into memory. Every agent of a tenant reads all of its memory (ADR 0013)
- `pnpm worker` — runs the agents; `pnpm agent` needs one running. `AGENTS=sitemap` limits it to some agents
- `pnpm agent` — menu of commands when a terminal is attached; `pnpm agent --help` lists them. `pnpm agent <id> --tenant <tenant> --<input field> <value> [--input json] [--model <name>] [--effort <level>] [--yes]` queues a run and follows it (flags left off are asked; `--yes` approves each approval without asking, recorded as made by you, auto). `--model` is a name in `config/models.json` and `--effort` is low, medium, high, xhigh or max, as far as the model takes it: `sonnet@high` is also a model name. A terminal asks for both in the menu. At an approval, a terminal offers Approve, Reject, or Request a change; a pipe answers `y`, `n`, or the change. Ctrl-C leaves the run going; `pnpm agent attach --run <runId> --tenant <tenant>` (or `--run`) attaches again; `pnpm agent cancel <runId> --tenant <tenant> [--reason <why>]` (or `--cancel`) stops it. `pnpm agent runs --tenant <tenant>` lists recent runs; `pnpm agent history [run] --tenant <tenant>` (or `--history`) lists a run's save points; `pnpm agent fork [run] --from <version> --tenant <tenant>` (or `--fork`) starts a new run from one. `pnpm agent agents` lists agents
- `pnpm preview --tenant demo-cricket --fixture c-101` — `pnpm agent match-preview`
- `pnpm memory:review --tenant <id>` — approve or reject proposed facts; `--shared` for proposed shared memory
- `pnpm memory:promote` — propose facts and lessons that several tenants hold as shared memory, for their sport or for every tenant (ADR 0014)
- `pnpm eval match-preview [--scripted] [--model <name>] [--only id,id]` — eval suite; exits non-zero below the 90% gate (`pnpm eval sitemap`, `pnpm eval matchday`, `pnpm eval card` and `pnpm eval card-match` likewise). `--model` runs the agent on another model in `config/models.json`
- `pnpm sitemap --tenant demo-cricket --brief "..." [--sport cricket]` — `pnpm agent sitemap`
- `pnpm matchday --tenant demo-cricket --fixture c-101 [--channel social] [--brief "..."]` — `pnpm agent matchday`
- `pnpm card --tenant demo-cricket --card agent-card --brief "..." [--figma <dsl.json> --screenshot <card.png>] [--attempts 3] [--yes] [--resume]` — a graph in this process, not the worker. Load, check, diff and save are code. Repair returns edits for the nodes the report names, at most `--attempts` times (default 3). A brief with no Figma file uses `card-draft`, which returns the first tree. `pnpm agent card` is still one full attempt, and the host keeps that tree. The saved card is on http://localhost:3415
- `pnpm card-match:measure [--write [--all]]` — the code-only result for each eval frame and each held-out design (no model), next to `agents/card-match/evals/baseline.json`; `pnpm card-match:vision` — breaks frames in known ways and measures whether `frame.look` finds them, against the score; `CARD_MATCH_VISION=off pnpm eval card-match` — the same eval with `frame.look` answering "not available"
- `pnpm card:watch --tenant demo-cricket [--project default] [--latest] [--model <name>] [--effort <level>] [--ask]` — press Send in the Figma plugin and a `card-match` run starts, followed here and published without asking (`--ask` brings the prompt back). Needs `pnpm worker` and the trial stack (control plane :4100, Studio :3000). `pnpm agent card-match --tenant <t> --export <id>` runs one export
- `pnpm round --tenant demo-cricket [--fixture c-101 ...] [--channel social] [--brief "..."] [--yes] [--resume]` — a program: matchday for each fixture, two at a time with `--yes`
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
