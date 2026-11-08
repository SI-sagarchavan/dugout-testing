# Prompt for `wnm-fanxp-frontend-surface-auth`: the live queue and the question card

Paste this into a Claude Code session started in `/Users/sagarchavan/si/build/wnm-fanxp-frontend-surface-auth` (branch `feat/surface-plugin-auth`, clean).

---

## Goal

Dugout runs AI agents. Its runs stop and ask a person things: a design shows videos but the only data is articles; the CMS domain for relative image paths is unknown; a container could be a carousel or a row; a write needs a yes. Today the queue page (`http://localhost:5555/#/sb/surface-studio/queue`, code in `apps/surface-studio`) runs on mock data, shows nothing live, and can only approve, reject or send a one-line change. Build the live version:

1. The queue and the run inspector run on the real backend (HTTP transport) and **follow a run live over SSE**.
2. When a run stops for a person, show **one card with one or more questions**, built from what the agent asked: a field for each question by kind, the agent's proposed answer preselected, the evidence (`why`) shown, **one Submit for all of them**. A run can ask again later: each round is its own card. A write waiting for a yes is the same card with a `review` question (approve / request a change / reject).
3. The person can also **let the agent decide** (no answers sent: the agent's proposals are used) or **skip** individual questions, or cancel the run. There is no "reject the questions".

Another session is building the backend routes at the same time from the same contract. Do not change the wire shapes below. Until the backend routes exist, keep developing against the mock transport (update it, see below).

## Read first (the source of truth)

- `/Users/sagarchavan/si/build/dugout/packages/contracts/src/questions.ts`: `AskedQuestion`, `Answer`, `Answers`, `Decision`, `checkAnswers`, `invalidAnswer`, `reviewQuestion`, `proposedAnswers`. **Port the validation (`invalidAnswer`/`checkAnswers`) exactly** so the form and the backend agree.
- `/Users/sagarchavan/si/build/dugout/packages/contracts/src/events.ts`: `RunEvent`, especially `question.asked` / `question.answered`.
- `/Users/sagarchavan/si/build/dugout/apps/surface-studio/src/run-thread.ts` (`applyEvent`, `fold`): a tested reducer from run events to a thread (text, tool calls with state, interrupts). Port it into this app (the surface app cannot import dugout) and its tests (`/Users/sagarchavan/si/build/dugout/apps/surface-studio/tests/run-thread.test.ts`).
- `/Users/sagarchavan/si/build/dugout/apps/surface-studio/src/pages/Runs.tsx` and `src/runs.ts`: a working but plain version of the live run view and its stream hook, for behaviour (batching events per animation frame, `Last-Event-ID` resume, connection states). Do not copy its styling.
- `/Users/sagarchavan/si/build/dugout/docs/adr/0029-asking-a-person.md` (the design).

## The contract (do not deviate)

A run that needs a person is **waiting** with questions:

```ts
type AskedQuestion = {
  id: string;
  question: string;
  why: string;
  kind: "choice" | "multi" | "text" | "confirm" | "number" | "review";
  options: { value: string; label: string; description: string }[];
  allowOther: boolean;
  proposed: string[]; // the agent's best answer, or what memory learned; [] if none
  learned?: { times: number; lastAt: string }; // "answered this way in N earlier runs"
};
type Answer =
  | string
  | number
  | boolean
  | string[]
  | { decision: "approve" | "change" | "reject"; comment?: string };
type Answers = Record<string, Answer>;
```

Per kind: `choice` -> one option `value` (radio/select; if `allowOther`, an "Something else" text); `multi` -> `string[]` (checkboxes); `text` -> string; `confirm` -> boolean (yes/no); `number` -> number; `review` -> `{decision, comment}` where `change` and `reject` need a non-empty comment. `proposed` is `string[]`: one option value (several for multi), `"yes"`/`"no"` for confirm, the text, or the number as text (see `proposedValue` in the contract).

A **review** question (id `review`) is a write waiting for a yes. It comes with `subject.input`, the tool call under review: show it (JSON, collapsible) above the three actions. It replaces the old Approve / Reject / Request-a-change card: there is no separate approval concept.

**Events** (stream and run detail): `question.asked { step, callId, tool, questions, from, subject? }` and `question.answered { step, callId, tool, by, answers, source: "person"|"agent"|"auto"|"memory" }`. `from` is the chain of child run ids a question came up through (empty when the run itself asked); show "asked by <agent> (child run)" when non-empty. `source: "memory"` renders as "answered from memory", `"auto"` as "answered automatically", and `"agent"` as "the agent decided (the person let it)".

**Sending answers:** `POST /fanxp/api/v1/surface/runs/:id/answers` body `{ callId: string, answers?: Answers }`:
- `answers` with a value for each question the person answered; **a question left out is skipped** (the agent decides it and says so).
- `answers` **absent** = "Let the agent decide": use the agent's proposals. Not allowed when the card has a `review` question: that always needs its explicit answer, so hide the button then.
- Responses: `200 { run, interrupt }`; `409` already answered (refresh and show the card as answered); `422` with a message (show it on the card).
- Cancel: `POST /fanxp/api/v1/surface/runs/:id/cancel` `{ reason? }` (exists in the app already as `useCancelRunMutation`).

**Reading:**
- `GET /surface/runs` -> `{ runs }` each with `pendingInterrupt` (the open pause or null) so the Needs-you list needs no per-run fetch.
- `GET /surface/runs/:id` -> `RunDetail` with `interrupts[]` (each `{ callId, tool, subject?, questions, from, state: "open"|"answered", answers?, answeredBy?, source? }`), steps, children.
- `GET /surface/runs/:id/events` -> SSE. Frames `id: <seq>`, `data: <RunEvent JSON>` (no `event:` name), `: heartbeat`, and a final `event: end`. Resume with the `Last-Event-ID` header. **Use `fetch` with a stream reader, not `EventSource`:** the route needs `Authorization: Bearer …` and `client: <code>` headers.

## What to build (in this order)

1. **Schemas** in `apps/surface-studio/src/shared-validation/surface.schema.ts`: replace `Approval`, `DecisionRequest`, `DecisionResponse` (kinds `frame.layout|hook.build|page.build`, approve/reject/request_change) with `AskedQuestion`, `Answer(s)`, `Interrupt`, `AnswersRequest`, `AnswersResponse`; `Run.pendingApproval` becomes `pendingInterrupt`. Put `invalidAnswer`/`checkAnswers`/`proposedValue` beside them with tests.
2. **Transport** (`entities/surface/api/transport.ts`, `http-transport.ts`, `surface-api.ts`): `answerRun`, replacing `decideRun`; keep `cancelRun`; a streaming `followRun(runId, { after, signal })` built on the shared axios client the way the host's `apps/fanxp/src/shared/api/ai/aiGateway.api.ts` `openJobStream` does it (`adapter: 'fetch'`, `responseType: 'stream'`, `Accept: text/event-stream`, so Bearer, `client` and the 401 refresh all apply), with the incremental parser pattern of `apps/fanxp/src/shared/api/ai/aiSse.ts` (copy it; the surface app cannot import host modules) and the stall watchdog / reconnect-with-`Last-Event-ID` of `runAiJob.ts`. Reconnect on drop, stop on `end`.
3. **Reducer + hook:** port dugout's `run-thread.ts` as `entities/surface/lib/run-thread.ts`; `useRunStream(runId)` applies events batched once per animation frame (a streamed token is an event) and exposes `{ thread, connection: connecting|live|reconnecting|ended|failed }`. React Query stays for the lists; when a stream event changes a run's status or opens/answers an interrupt, invalidate `['surface','runs']` and the run query so the list, the badge and Needs-you update without polling.
4. **Run inspector** (`features/queue/ui/run-inspector.tsx`, `run-timeline.tsx`): the timeline follows the stream: streamed text with a caret while the model writes, tool calls with state (writing arguments / running / done / failed / needs you), child runs nested and live, cost/steps/elapsed in the header, a connection badge. An open interrupt shows its card **inline in the timeline at the point it was asked**, and answered ones show read-only with the answers, who answered, and the source.
5. **The question card** (new, `features/needs-you/ui/interrupt-card.tsx` or `features/interrupts/`): used in the inspector and on the Needs-you page. One form (react-hook-form + Zod via `use-zod-form`), one control per question by kind; `proposed` preselected and marked "proposed" (or "answered this way N times, last <date>" when `learned`); `why` shown under each question; a **Skip** toggle per non-review question; one **Submit answers** button that validates everything with `checkAnswers` and shows field errors; a secondary **Let the agent decide** (omits `answers`; hidden with a `review`); the review question renders as three buttons (Approve / Request a change / Reject) with a required comment for the last two and the `subject.input` JSON shown above. After Submit the card turns into its answered form. A `409` refreshes; a `422` shows the message. Multiple questions are answered in any order and submitted together; later rounds appear as new cards.
6. **Needs-you page and sidebar badge:** now built from `pendingInterrupt` on the runs list. Delete `approval-card.tsx`, `request-change-dialog.tsx` and `use-approval-actions.ts` once the new card covers them (a review question is the old approval).
7. **Mock transport** (`entities/surface/api/mock/`): update fixtures and `applyDecision` to the new shapes, including a run waiting on a multi-question ask, one waiting on a review, one with a second round after the first is answered, and a scripted event stream for `followRun` that emits a few tokens, a tool call, a `question.asked`, and continues after `question.answered`. The app must be fully usable in `mock` mode.
8. **HTTP mode:** set `VITE_SURFACE_STUDIO_API` so the transport is `http`, and make the dev proxy for the events route not buffer: in `apps/fanxp/vite.config.ts` the `/fanxp` proxy needs the same `configure` hook the `/fanos-surface` entry has (`x-accel-buffering: no`, `cache-control: no-cache, no-transform` on `proxyRes`).
9. **Styles:** the surface app's CSS is compiled separately and scoped (`.surface-studio-scope`): run `pnpm build:surface-studio-styles` after style changes and commit the regenerated `apps/fanxp/public/surface-studio-embed.css`.

Match the existing UI conventions: `@fanxp/ui` (shadcn) components, `cn`, `toast` from `@fanxp/ui/lib/toast`, lucide icons, `text-sm`/`text-xs` sizing with `text-muted-foreground`/`border-border`/`bg-muted`, `role="alert"` error blocks with a "Try again" button, `PageEmptyState` for empty lists. FSD layout (`entities`, `features`, `shared-validation`), features export through `index.ts`, tests in `__tests__/` on the app's Vitest.

## UX details that matter

- The point of this card is clarity: show the evidence (`why`) next to each question, not behind a click, and use the option `description` as help text. A question about "videos vs articles" should read as a decision with the consequence stated.
- Keyboard: Enter submits only from the Submit button; each control is reachable and labelled (a11y), the form is usable on a laptop width in the 3-pane layout's right pane (it can open as a wider sheet/dialog from the inspector too).
- Do not lose typed answers when a new event arrives or the list refetches (the form state is local to the card, keyed by `callId`).
- A run that has several interrupts over time shows them in order; only the last unanswered one is actionable.
- Never auto-submit. "Let the agent decide" and "Skip" are explicit, and say what they do ("The agent will use its own proposals").

## Acceptance

- Vitest: the reducer (events -> thread, repeats ignored, interrupts opened and answered), the SSE parser (split chunks, heartbeat, `end`), `checkAnswers`/`invalidAnswer` against the same cases as dugout's `packages/core/tests/ask.test.ts`, and the card (each kind renders and validates, proposals preselected, Skip, Let-the-agent-decide hidden for a review, one submit sends one request with only the answered keys).
- In `mock` mode: open the queue, watch a run stream, answer a three-question card (choice + text + number) and see the run continue and a second round appear.
- In `http` mode against the real backend once its routes exist: with dugout's `pnpm worker` running, press Handoff (or `pnpm agent section-builder --tenant sb --handoff <id>` in dugout), watch it stream in the inspector, answer its questions on the page, and see it resume. Until the routes exist, use dugout's `pnpm fixture waiting-run --tenant sb` for data.
- Lint, typecheck and the surface-studio tests pass; run `pnpm build:surface-studio-styles`.

Do not modify the backend repo. If the backend shape you need is missing from the contract above, stop and say so instead of inventing one.
