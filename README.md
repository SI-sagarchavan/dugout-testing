# dugout

FanOS agent harness, agents and evals. See `CLAUDE.md` for layout/commands and `docs/PLAN.md` for the build plan.

```sh
nvm use && pnpm install
cp .env.example .env          # set AWS_PROFILE and AWS_REGION for Bedrock
pnpm infra:up && pnpm db:migrate && pnpm seed
pnpm check

pnpm worker                   # terminal 1: runs the agents, as the ECS service does in production

# terminal 2: queue a run, follow it, answer its approvals
pnpm preview --tenant demo-cricket --fixture c-101
pnpm sitemap --tenant demo-cricket --sport cricket --brief "T20 club: news, fixtures, squad, standings"
pnpm agent <id> --tenant <tenant> --<input field> <value>   # any agent in agents/
# at an approval prompt: y to approve, n to reject, or type a change ("change the Fan Zone path to /fanzone")
# Ctrl-C leaves the run going in the worker; attach again with:
pnpm agent --run <runId> --tenant <tenant>

pnpm eval match-preview
pnpm eval sitemap
```

`pnpm agent` does what wnm-fanxp-backend will do in production (ADR 0009): it queues the run in Postgres, follows its events from Valkey as the worker writes them, and queues your decision at each approval for a worker to resume the run. The worker and the CLI never talk to each other directly.

A worker that gets SIGTERM hands its runs to another worker, which resumes them from their last save; one that dies has its runs picked up once their lease (60 seconds) runs out (ADR 0006, ADR 0009). The worker image is `apps/worker/Dockerfile` (`docker build -f apps/worker/Dockerfile .`).

New agents are written with `defineAgent` from `@dugout/sdk` (ADR 0007); `agents/sitemap` is a compact example. Add one to the list in `apps/worker/scripts/work.ts` for the worker to run it.
