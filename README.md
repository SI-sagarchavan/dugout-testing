# dugout

FanOS agent harness, agents and evals. See `CLAUDE.md` for layout/commands and `docs/PLAN.md` for the build plan.

```sh
nvm use && pnpm install
cp .env.example .env          # add LLM_API_KEY
pnpm infra:up && pnpm db:migrate && pnpm seed
pnpm check

pnpm preview --tenant demo-cricket --fixture c-101
pnpm eval match-preview

pnpm sitemap:seed
pnpm sitemap --tenant demo-cricket --sport cricket --brief "T20 club: news, fixtures, squad, standings"
pnpm eval sitemap
# at the sitemap prompt: y to save, n to reject, or type a change ("change the Fan Zone path to /fanzone")
```

API:

```sh
pnpm api
TOKEN=$(pnpm -s token demo-cricket)
curl -s -X POST localhost:8787/runs -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"agent":"match-preview","input":{"fixtureId":"c-101"}}'
curl -N localhost:8787/runs/<runId>/stream -H "authorization: Bearer $TOKEN"
curl -X POST localhost:8787/runs/<runId>/approvals/<callId> -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"approved":true}'
```
