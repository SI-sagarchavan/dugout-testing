# dugout

FanOS agent harness, agents and evals. See `CLAUDE.md` for layout/commands and `docs/PLAN.md` for the build plan.

```sh
nvm use && pnpm install
cp .env.example .env          # set AWS_PROFILE and AWS_REGION for Bedrock
pnpm infra up && pnpm db migrate && pnpm db seed
pnpm build           # the @fanos packages and apps; frame-match loads their dist
pnpm check

pnpm worker                   # terminal 1: runs the agents, as the ECS service does in production

# terminal 2: queue a run, follow it, answer its approvals
pnpm agent                          # menu: run, attach, cancel, list, history, fork
pnpm agent --help
pnpm agent history <runId> --tenant <tenant>
pnpm agent fork <runId> --from <version> --tenant <tenant>
pnpm agent frame-match --tenant demo-cricket --export <exportId>
pnpm agent sitemap --tenant demo-cricket --sport cricket --brief "T20 club: news, fixtures, squad, standings"
pnpm agent <id> --tenant <tenant> --<input field> <value>   # any agent in agents/
# at an approval: Approve, Reject, or Request a change
# a pipe answers y, n, or the change ("change the Fan Zone path to /fanzone")
# Ctrl-C leaves the run going in the worker; attach again with:
pnpm agent attach --run <runId> --tenant <tenant>

pnpm eval sitemap
pnpm eval frame-match
```

`pnpm agent` does what wnm-fanxp-backend will do in production (ADR 0009): it queues the run in Postgres, follows its events from Valkey as the worker writes them, and queues your decision at each approval for a worker to resume the run. The worker and the CLI never talk to each other directly.

A worker that gets SIGTERM hands its runs to another worker, which resumes them from their last save; one that dies has its runs picked up once their lease (60 seconds) runs out (ADR 0006, ADR 0009). The worker image is `apps/worker/Dockerfile` (`docker build -f apps/worker/Dockerfile .`).

New agents are written with `defineAgent` from `@dugout/sdk` (ADR 0007); `agents/sitemap` is a compact example. Add one to the list in `apps/worker/scripts/work.ts` for the worker to run it.

## The Figma-to-SDUI pipeline

The Figma plugin, compiler, DSL, renderer, control plane (:4100), preview site (Next.js, :3000) and Studio (:3001, behind the site) are the `@fanos/*` packages and apps, in `packages/` and `apps/` beside dugout's (ADR 0020), so one checkout runs everything. It keeps its own `@fanos/*` toolchain; `docs/pipeline.md` describes it. Docker runs only the databases (ADR 0021): one Postgres with a `harness` database for dugout and a `fanos` one for the pipeline, and one Valkey. `pnpm infra up pipeline`. Then `cp apps/api/.env.example apps/api/.env` (once), `pnpm build`, `pnpm db migrate fanos` and `pnpm dev`; `pnpm worker` and `pnpm agent watch` run the agents. To bring across the old `trial` stack's data: `pnpm db import`.
