# dugout

FanOS agent harness, agents and evals. See `CLAUDE.md` for layout/commands and `docs/PLAN.md` for the build plan.

```sh
nvm use && pnpm install
cp .env.example .env          # add LLM_API_KEY
pnpm infra:up && pnpm db:migrate && pnpm seed
pnpm check

pnpm preview --tenant demo-cricket --fixture c-101
pnpm eval match-preview

pnpm sitemap --tenant demo-cricket --sport cricket --brief "T20 club: news, fixtures, squad, standings"
pnpm eval sitemap
# at an approval prompt: y to approve, n to reject, or type a change ("change the Fan Zone path to /fanzone")

pnpm agent <id> --tenant <tenant> --<input field> <value>   # any agent in agents/
```

API:

```sh
pnpm api
TOKEN=$(pnpm -s token demo-cricket)

# wait for the result as JSON (the sitemap agent's default): it comes back "waiting" with the sitemap
curl -s -X POST localhost:8787/runs -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"agent":"sitemap","input":{"brief":"T20 club: news, fixtures, squad","sports":["cricket"]}}'
# decide; the answer is the run's next state: waiting again after a change, or completed with the output
curl -s -X POST localhost:8787/runs/<runId>/approvals/<callId> -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"approved":false,"changes":"Use /fanzone for the Fan Zone."}'
curl -s -X POST localhost:8787/runs/<runId>/approvals/<callId> -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"approved":true}'

# or stream the events in the response (match-preview's default), up to the approval or the end
curl -N -X POST localhost:8787/runs -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"agent":"match-preview","input":{"fixtureId":"c-101"},"stream":true}'

# or start in the background and follow the run's stream, from any event id
curl -s -X POST localhost:8787/runs ... -d '{"agent":"match-preview","input":{"fixtureId":"c-101"},"background":true}'
curl -N localhost:8787/runs/<runId>/stream -H "authorization: Bearer $TOKEN"
```

Every request that starts or resumes a run takes `stream` (SSE) or `background`; without them the agent's default applies (ADR 0008). Tool-call arguments stream as `tool.input.delta` events, so structured output streams too.

New agents are written with `defineAgent` from `@dugout/sdk` (ADR 0007); `agents/sitemap` is a compact example.

A run waiting for approval has status `waiting` and is saved in Postgres, so the API can restart in between; the decision resumes it. A run whose API process died is picked up again once its lease (60 seconds) runs out (ADR 0006).
