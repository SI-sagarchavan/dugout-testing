# Dugout (FanOS agent harness)

Thin TypeScript agent harness: loop, tools, guardrails, event stream, durability, memory. Agents are a spec plus typed tools on top. Plan and task IDs (H*, M*, S*, E*): `docs/PLAN.md`.

## Layout

- `packages/contracts` — zod contracts (AgentSpec, Tool, RunEvent, Steps, ModelClient). No framework types cross these.
- `packages/core` — loop over `Steps`, tool pipeline, redactor, Bedrock model client (ADR 0012), run log, `runLocal`; stop reasons, model retries and when `final` is accepted (ADR 0018); run hooks, the per-turn rules the harness and an agent plug in (ADR 0023)
- `packages/db` — Postgres pool, `withTenant` (row-level security), SQL migrations
- `packages/memory` — semantic/episodic store, hybrid search, skills loader, context builder (stable memory in the system prompt, lessons and approved examples in the first user message; ADR 0013), consolidation
- `packages/mcp` — typed `cast.*` tools over the Cast MCP server, per-tenant OAuth grants (ADR 0022); `card-match` uses its read tools
- `packages/evals` — graders, model judge, suite runner and pass-rate gate
- `packages/tracing` — run events → OpenTelemetry spans → Langfuse
- `packages/sdk` — `defineAgent` (what agent packages are written with), live deps, seeding, agent discovery (ADR 0007); `@dugout/sdk/testing` is the `drafter` test agent that the worker's, the terminal's and the SDK's tests run against
- `packages/tokens` — token compiler: raw theme export to normalized vocabulary, lint, CSS and types
- `packages/dsl` — the SDUI vocabulary: flat tree format, validator, agent JSON Schema
- `packages/surface-canvas` — the Figma plugin: Health, Layout, Send, and the Frame IR schema
- `packages/compile` — Frame IR to DSL tree
- `packages/conform` — the geometry gate: a compiled tree against its IR
- `packages/renderer` — the rendering SDK (React Server Components) and the Playwright pixel harness
- `agents/sitemap` — first agent: club brief to import-ready pages plus header menu; ported importer rules, skill, eval cases
- `agents/card-match` — matches a compiled Figma frame to its screenshot, from a Send stored in the control plane (ADR 0019). Code fixes what needs no judgement, the model adds overrides, and each is measured and undone if it doesn't help. It also says what each container is (ADR 0024): a carousel the frame shows is applied, and what the frame cannot show is asked of a person through `frame.layout`
- `apps/worker` — runs agents (ADR 0009): claims queued, decided and orphaned runs from Postgres, holds a lease per run, saves its working memory (ADR 0006), writes events to the Valkey stream + Postgres record, hands runs over on SIGTERM; no port; `Dockerfile` for ECS. Also the queue a host uses to hand it runs. Temporal replaces the claiming before production (H7)
- `apps/cli` — the terminal host for the worker, doing what wnm-fanxp-backend will: queues a run, follows its events, asks at each approval and queues the decision
- `apps/api` — the control plane (:4100): artifact store, Sends, surface versions, pipeline runs, fidelity gate; its own database (`fanos`, ADR 0021) and job worker
- `apps/surface-studio` — Studio (:3001): the page board and the plugin's API; stores nothing. Reached through the site on :3000, the plugin's only allowed origin, which forwards `/v1/*` and the board to it
- `apps/web` — the site (:3000), Next.js: `/preview/<project>/<run or dsl_tree id>` renders a Send with the renderer's client components running (a carousel swipes). `card-match`'s preview link points here (`FANOS_WEB_URL`); Studio's `/v1/preview` stays the static page. Both build the page with `@fanos/renderer` `preparePage`

## Commands

- `pnpm check` — lint + typecheck + test (what CI runs)
- `pnpm format` — Biome autofix
- `pnpm infra up|down|reset` — Postgres+pgvector (:55432) and Valkey (:56379). Tests need these up. `pnpm infra up pipeline` adds the pipeline's Electric. `reset` deletes dugout's volumes
- `pnpm db migrate [harness|fanos|all]` / `pnpm db seed` — apply migrations (harness by default; `fanos` is the pipeline's); load each tenant's house facts (`config/tenants/<tenant>/facts.json`) into memory. Every agent of a tenant reads all of its memory (ADR 0013)
- `pnpm worker` — runs the agents; `pnpm agent` needs one running. `AGENTS=sitemap` limits it to some agents
- `pnpm agent` — menu of commands when a terminal is attached; `pnpm agent --help` lists them. `pnpm agent <id> --tenant <tenant> --<input field> <value> [--input json] [--model <name>] [--effort <level>] [--yes]` queues a run and follows it (flags left off are asked; `--yes` approves each approval without asking, recorded as made by you, auto). `--model` is a name in `config/models.json` and `--effort` is low, medium, high, xhigh or max, as far as the model takes it: `sonnet@high` is also a model name. A terminal asks for both in the menu. At an approval, a terminal offers Approve, Reject, or Request a change; a pipe answers `y`, `n`, or the change. Ctrl-C leaves the run going; `pnpm agent attach --run <runId> --tenant <tenant>` (or `--run`) attaches again; `pnpm agent cancel <runId> --tenant <tenant> [--reason <why>]` (or `--cancel`) stops it. `pnpm agent runs --tenant <tenant>` lists recent runs; `pnpm agent history [run] --tenant <tenant>` (or `--history`) lists a run's save points; `pnpm agent fork [run] --from <version> --tenant <tenant>` (or `--fork`) starts a new run from one. `pnpm agent agents` lists agents
- `pnpm build` — build every `@fanos/*` package and app (the agents load their `dist`). The site builds to `apps/web/.next-build`, so it can run while `pnpm dev` serves from `.next`. `pnpm infra up pipeline` — Electric (:3010) and the `fanos` database; `pnpm db migrate fanos`; `pnpm dev` — Studio, web, API and its worker
- Databases run in Docker, apps on the host (ADR 0021). `pnpm infra up` is one Postgres (:55432, databases `harness` for dugout and `fanos` for the pipeline) and one Valkey (:56379; the pipeline's job queue is its database 1). `pnpm infra up pipeline` adds Electric (:3010) and creates `fanos` on an existing server. `pnpm db import` copies the old trial stack's database into `fanos`
- `pnpm agent memory review --tenant <id>` — approve or reject proposed facts; `--shared` for proposed shared memory
- `pnpm agent memory promote` — propose facts and lessons that several tenants hold as shared memory, for their sport or for every tenant (ADR 0014)
- `pnpm eval sitemap [--scripted] [--model <name>] [--only id,id]` — eval suite; exits non-zero below the 90% gate (`pnpm eval card-match` likewise). `--model` runs the agent on another model in `config/models.json`
- `pnpm agent sitemap --tenant demo-cricket --brief "..." [--sport cricket]` — `pnpm agent sitemap`
- `pnpm eval measure [--write [--all]]` — the code-only result for each eval frame and each held-out design (no model), next to `agents/card-match/evals/baseline.json`; `pnpm eval vision` — breaks frames in known ways and measures whether `frame.look` finds them, against the score; `CARD_MATCH_VISION=off pnpm eval card-match` — the same eval with `frame.look` answering "not available"
- `pnpm agent watch --tenant demo-cricket [--project default] [--latest] [--model <name>] [--effort <level>] [--ask]` — press Send in the Figma plugin and a `card-match` run starts, followed here and published without asking (`--ask` brings the prompt back). Needs `pnpm worker` and the trial stack (control plane :4100, the site :3000 with Studio :3001 behind it). `pnpm agent card-match --tenant <t> --export <id>` runs one export
- `pnpm --filter @dugout/mcp cast:login --tenant <tenant> --site <code>` — one browser login per tenant for the Cast MCP (ADR 0022); needs `CAST_MCP_URL` in `.env`. The grant is kept in `CAST_MCP_TOKENS` (default `.runs/cast-mcp.json`). `card-match` gets its read-only `cast.*` tools only when `CAST_MCP_URL` is set; without it the agent runs as before. Run one worker per token file
- `pnpm eval layout` — what each container of the eval frames is (carousel, list, row, grid, tabs), from the IR alone, against `agents/card-match/evals/layouts.ts`; exits non-zero on any miss (ADR 0024)
- `pnpm eval smoke [--model <name>]` — one minimal live run, on `nova-lite` unless named
- `pnpm agent schemas` — write each agent's input and output JSON Schema to `schemas/` for hosts; a test fails when they are out of date

## Rules

- Two families share `apps/` and `packages/`, told apart by npm scope. `@dugout/*` is the harness. `@fanos/*` is the Figma-to-SDUI pipeline (formerly the `trial` repo, ADR 0020): it has its own toolchain (tsup, vitest 2, TypeScript 5, `tsconfig.fanos.json`), builds to `dist`, and is not yet linted by Biome (the exclusions are in `biome.json`). The agents load its built `dist`, so run `pnpm build` after install and after changing it.
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
