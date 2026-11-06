# Prompt for `wnm-fanxp-backend-surface-auth`: runs, live events, and answers

Paste this into a Claude Code session started in `/Users/sagarchavan/si/build/wnm-fanxp-backend-surface-auth` (branch `feat/surface-plugin-auth`). It has uncommitted work on the Handoff stack (`queueRunFor`, `harness-run` model, service-key route): build on it, do not revert or reformat it.

---

## Goal

Dugout (`/Users/sagarchavan/si/build/dugout`) runs AI agents in a worker. This backend already queues a run when a Handoff completes (`src/services/surface-handoff/index.ts` `queueRunFor` -> `src/models/harness-run/index.ts` `queueRun`). It does nothing else with runs. Make it the **host** of those runs: list them, read one, stream its events live, answer the questions it asks, and cancel it. The admin app (`wnm-fanxp-frontend-surface-auth/apps/surface-studio`, page `#/<client>/surface-studio/queue`) is already written against these routes and runs on mocks until they exist. Another session builds the admin app side at the same time from the same contract, so do not change the wire shapes below.

## Read first (the source of truth)

- `/Users/sagarchavan/si/build/dugout/packages/contracts/src/questions.ts`: `AskedQuestion`, `Answer`, `Answers`, `Decision`, `checkAnswers` (the validator, copy its logic exactly), `reviewQuestion`.
- `/Users/sagarchavan/si/build/dugout/packages/contracts/src/events.ts`: `RunEvent`, especially `question.asked` and `question.answered`.
- `/Users/sagarchavan/si/build/dugout/packages/contracts/src/runtime.ts`: `RunCheckpoint.waiting`.
- `/Users/sagarchavan/si/build/dugout/docs/adr/0029-asking-a-person.md` (the design).
- Reference implementations to port (the same SQL and the same stream reading, written for the CLI):
  - `/Users/sagarchavan/si/build/dugout/apps/worker/src/queue.ts`: `decide` (queues an answer), `cancel`, `follow`.
  - `/Users/sagarchavan/si/build/dugout/apps/worker/src/event-log.ts`: `createValkeyEventLog` (`read`, `follow`, `lastSeq`), `readStoredEvents`.
  - `/Users/sagarchavan/si/build/dugout/apps/worker/src/records.ts`: `appendEnding`, `cancelledEvent`.
  - `/Users/sagarchavan/si/build/dugout/apps/surface-studio/server/runs.ts`: a working dev version of the list, one-run and SSE routes (Fastify-free: copy the logic, not the framework).
  - `/Users/sagarchavan/si/build/dugout/docs/architecture/handoff-flow.md` ("Events, reloads and live updates").

## The contract (do not deviate)

**One kind of pause.** A run that needs a person is `runs.status = 'waiting'` with `run_checkpoints.checkpoint -> 'waiting'`:

```ts
waiting: {
  step: number; callId: string; tool: string; input: unknown;
  questions: AskedQuestion[];        // always at least one
  from: string[];                    // run ids it came up from, nearest first; [] if this run asked
  subject?: { input: unknown };      // present only for a write waiting for a yes
}
type AskedQuestion = {
  id: string; question: string; why: string;
  kind: "choice" | "multi" | "text" | "confirm" | "number" | "review";
  options: { value: string; label: string; description: string }[];
  allowOther: boolean;
  proposed: string[];                // the agent's best answer, or what memory learned; [] if none
  learned?: { times: number; lastAt: string }; // "answered this way in N earlier runs"
};
```

`kind: "review"` is a write waiting for a yes (the old "approval"): `id` is `"review"`, `options` are approve / change / reject, and `subject.input` is the call under review. There is no separate approval concept any more.

**Answers.** `type Answer = string | number | boolean | string[] | { decision: "approve"|"change"|"reject"; comment?: string }`; `type Answers = Record<string, Answer>` by question id. Per kind: choice -> option `value` (or any text if `allowOther`); multi -> `string[]`; text -> string; confirm -> boolean; number -> number; review -> `{decision, comment}` where `change` and `reject` need a non-empty `comment`.

**Decision** (what you store in `runs.decision`): `{ by: string; answers?: Answers }`.
- Keys left out of `answers` are skipped: the agent decides those and says so.
- `answers` absent = "let the agent decide": the agent's proposals are used. Not allowed when the pause has a `review` question (a write always needs its explicit answer).
- A pause ends only by answering it, or by cancelling the run. There is no "reject the questions". (Rejecting a write is a `review` answer with `decision: "reject"`.)

**Events** (the stream, `run:<runId>:events` in Valkey, and the `run_events` table). The `approval.*` events no longer exist. The pause is:

```ts
{ type: "question.asked",    data: { step, callId, tool, questions: AskedQuestion[], from: string[], subject?: { input } } }
{ type: "question.answered", data: { step, callId, tool, by, answers: Answers, source: "person"|"agent"|"auto"|"memory" } }
```

Every event is `{ runId, seq, at, type, data }`; `seq` only goes up. Everything else (`run.started`, `token`, `step.completed`, `tool.started`, `tool.completed`, `tool.denied`, `run.completed`, `run.failed`, `run.cancelled`, ...) is as in `events.ts`. Treat unknown event types as pass-through.

## Routes to build

All under the existing surface prefix, mounted like the other surface modules (`src/routes/index.ts`). Auth for every route: admin JWT (`fastify.authenticate`) plus the `client` header (`validateClientHeader`, then the client-access check `routePermission` / `validateClientAccess` the other surface admin routes use). The client code is the dugout tenant id (`request.headers['client']`, e.g. `sb`). Every harness query runs through `withTenant`-style scoping (`set_config('app.tenant_id', …)` in a transaction), as `queueRun` does.

1. `GET /surface/runs?limit=&agent=`: the client's runs, newest first, with each run's Handoff (`surface_handoffs.run_id` joins to `runs.id`). Include child runs (`parent_run_id`, `parent_call_id`) marked as children. Add `pendingInterrupt` (the open pause, see 2) so the Needs-you page can list them without fetching each run.
2. `GET /surface/runs/:id`: one run, shaped as the admin app's `RunDetail` (look at `apps/surface-studio/src/shared-validation/surface.schema.ts` in the frontend repo and keep that shape where it exists; rename its `Approval` to `Interrupt` as below), built from `runs`, its child runs, `run_events`, and `run_checkpoints`:
   - `steps`/tool calls from `tool.started` / `tool.completed` / `tool.denied`,
   - `interrupts[]`: every `question.asked` paired with its `question.answered` (state `open` or `answered`; for answered ones include `answers`, `answeredBy`, `source`). The open one is the last `question.asked` with no answer **and** `checkpoint.waiting.callId` equal to its `callId` (the checkpoint is authoritative),
   - `children[]`: runs with `parent_run_id = :id`, each with the `parent_call_id` of the call that started it.
3. `GET /surface/runs/:id/events`: Server-Sent Events. Frames are `id: <seq>\ndata: <RunEvent JSON>\n\n` (no `event:` name for run events, so `onmessage` gets every type), `: heartbeat\n\n` about every 15 s, and a final `event: end\ndata: {"seq":N}\n\n` once the run has ended (`run.completed`, `run.failed` or `run.cancelled`). Resume after `Last-Event-ID` (else `?after=<seq>`, else the start). Read the Valkey stream with `XRANGE (0-<last> +` for the backlog, then `XREAD BLOCK` for the tail; entry id is `0-<seq>`, field `e` holds the JSON. If the stream no longer exists and the run has ended, replay `run_events` instead and still send `end`. Do not close on `question.asked`: the run goes on after it is answered. See `apps/surface-studio/server/runs.ts` in dugout for a tested version of exactly this.
   - It needs **its own Valkey connection** for the blocking read (the shared client's `commandTimeout` of 2 s would cut it off; use `.duplicate()` with no command timeout, and disconnect it when the request closes).
   - Use `reply.hijack()` and copy headers first, as `src/controllers/cast/mcp.ts` does; end on `reply.raw.on('close')`.
   - Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
   - The admin app reads it with `fetch` (not `EventSource`), because it must send `Authorization` and `client`. Nothing special needed here, but keep CORS and the `Authorization`/`client` headers working on this route.
4. `POST /surface/runs/:id/answers` body `{ callId: string, answers?: Answers }`:
   - Load the run's `checkpoint.waiting`. `404` if the run is not this client's; `409` if the run is not `waiting` or `waiting.callId !== callId` (already answered elsewhere, or answered by someone else first).
   - Validate with a TypeScript port of dugout's `checkAnswers(waiting.questions, answers)`. `422` with its message on any problem (unknown question id, a value that does not fit its kind, a `review` missing or lacking its comment). `answers` absent is valid only when there is no `review` question.
   - Store: `by` = the admin user's display name or id (`request.parsed_token`), then exactly dugout's `decide` update: `update runs r set status='queued', decision=$3, attempts=0, last_error=null, lease_owner=null, lease_until=null, updated_at=now() from run_checkpoints c where r.id=$1 and c.run_id=r.id and r.status='waiting' and c.checkpoint->'waiting'->>'callId'=$2`. `rowCount === 0` -> `409`. A worker then claims the run and resumes it.
   - Response `{ run, interrupt }` (the run's new status, and the interrupt with the answers just stored).
5. `POST /surface/runs/:id/cancel` body `{ reason?: string }`: port dugout's `cancel` SQL (a queued or waiting run ends at once and the host appends a `run.cancelled` event; a running one with a live lease is stopped by its worker). Appending an event to the Valkey stream and `run_events` is what `appendEnding`/`cancelledEvent` do: port that too, so the stream ends.

Remove or do not create any `/decisions` route and any approve/reject route: they are replaced by `/answers`.

## Wiring

- Harness DB: extend `src/models/harness-run/index.ts` (it has the lazy pool, `HARNESS_DATABASE_URL`, `queueRun`). Add the reads and the two writes. Connect as `dugout_app` (row-level security needs `app.tenant_id` set inside the transaction). Call `closeHarnessPool` on shutdown (it exists but nothing calls it).
- Valkey: the stream is in **dugout's** Valkey (`VALKEY_URL`, default `redis://localhost:56379`), under the key prefix the worker uses (`VALKEY_KEY_PREFIX`, default empty): the stream key is `${prefix}run:<runId>:events`. Add `HARNESS_VALKEY_URL` and `HARNESS_VALKEY_KEY_PREFIX` to config and `.env.example`; do not use `REDIS_KEY_PREFIX` (default `fanos:local:`) for this. The backend's own cache Valkey and dugout's may be different servers: do not assume they are the same.
- The Handoff row already stores `run_id`; keep using it.
- Follow the repo's conventions: controllers/services/models layering, validators, error codes in `src/errors`, tracing modules in `src/types`, tests next to the existing surface tests.

## Dev environment

`pnpm infra up` in dugout starts Postgres (`:55432`) and Valkey (`:56379`); `pnpm worker` runs the agents. For tests that need a waiting run without running a model, dugout has `pnpm fixture waiting-run --tenant sb` (writes a `waiting` run with a checkpoint, events in `run_events` and in the Valkey stream, with both a `review` and an agent question; add `--answered` for one already answered). Use it for curl and for route tests. A real one: press Handoff, or `pnpm agent section-builder --tenant sb --handoff <id>` in dugout, and answer in the CLI or through your new route.

## Acceptance

- Route tests (the existing Fastify test style) for all five routes: auth and `client` header required, another client's run is a 404, `409` on a stale `callId`, `422` on bad answers, a run answered once cannot be answered twice (concurrent calls: exactly one wins).
- An SSE test: backlog from `Last-Event-ID`, the live tail as events are added to the stream, heartbeat, `end` after a terminal event, replay from `run_events` when the stream is gone, closing the response disconnects the blocking reader.
- A manual end-to-end with dugout: `curl -N -H 'Authorization: Bearer …' -H 'client: sb' …/surface/runs/<id>/events` while a real run streams; answer a waiting run through `/answers` and watch the worker resume it and the stream continue.
- `npm run lint` / typecheck / the surface test suites pass. Do not touch the uncommitted Handoff work except to extend it.

## Notes

- CloudFront compresses `/fanxp*` and buffers `text/event-stream`: before production the events route needs its own behaviour with compression off (an infra change in `si-build-iac`; write the note in the PR description, do not change infra here). Locally the admin app's Vite proxy needs `x-accel-buffering: no` for the route (the frontend session handles that).
- Do not fabricate `by` names; use the verified token's user.
