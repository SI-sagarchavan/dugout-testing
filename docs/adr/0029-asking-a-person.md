# 0029. A run stops for a person, with typed questions, and waits for the answers

Date: 2026-11-06 · Status: accepted · Replaces the approval events and decision shape of ADR 0005 (the pause itself, ADR 0006 and ADR 0009, stays) · Related: ADR 0025, ADR 0030

## Context

An agent finds gaps it cannot settle alone. The images in a hook's output are relative paths and the page needs the CMS domain. The design shows videos and the only hook returns articles. A container could be a carousel or a row, and the frame cannot say whether it autoplays. Before this, a run had three ways to deal with that, and none of them asked:

- It guessed, and said so in `remaining`. The person read it after the preview was built.
- It put the question on an approval card (`frame.layout`), where the only answers were approve, reject, or a change request typed as free text.
- Inside `section-builder` the approval was granted by the parent's call (ADR 0025), so a child's question never reached a person at all.

And a write waiting for a yes was a different thing from a question: two event families, two decision shapes, two cards in every host. LangGraph has one primitive here, `interrupt(payload)`: pause, show a payload, resume with a value; its human-in-the-loop approval is an interrupt whose payload is the tool call and whose allowed answers are approve, edit or reject.

## Decision

**One kind of pause.** A run that needs a person is saved as waiting, exactly as before (ADR 0006, ADR 0009), holding one or more questions and, when the pause is a write, the call under review. The person answers each question and submits them together. The run may ask again later: every ask is a round of its own.

**Questions** (`@dugout/contracts`, `questions.ts`; the FanXP backend and the admin app mirror them, they do not invent their own):

- `kind`: `choice`, `multi`, `text`, `confirm`, `number`, and `review`.
- `id`, `question`, `why` (what the agent found that makes it ask), `options` (a `value`, a `label` and a `description` each), `allowOther`, and `proposed` (the agent's guess, which a person can accept as it is).
- `learned`: when a person answered the same question before, `proposed` is that answer and `learned` says how many times and when.
- `review` is the harness's own: a write waiting for a yes. Its answer is `{ decision: approve | change | reject, comment }`, a comment is needed for the last two, and the pause carries `subject.input`, the call under review. There is no separate approval concept any more.

**Who stops a run:**

1. **The model**, through `ask`, a built-in tool every agent has, like `final`. It writes the questions from what it found.
2. **A tool**, whose code writes the questions from what it measured, by throwing `AwaitingAnswers`; the call runs again with `ctx.answered`. `frame.layout` asks this way, so its questions come from the layout's own evidence, not from the model's account of it.
3. **A child run**. A child that waits stops its parent's call with the same questions, and so on up to the run the host follows; `from` names the runs they came up through. The answers go back down to the child that asked. A child's write is still approved by its parent's call (ADR 0025): only questions travel up.
4. **The loop**, for a write that needs a yes (`effect: write`, or a tool in the spec's `approvals`): one `review` question and the call.

**Events.** `question.asked { step, callId, tool, questions, from, subject? }` and `question.answered { step, callId, tool, by, answers, source }`. `approval.requested`, `.granted`, `.rejected` and `.changes_requested` no longer exist: a rejection is a review answered `reject`, a change request one answered `change`. `source` says who answered: `person`, `agent` (the person let the agent decide), `auto` (a host that does not ask), `memory` (the harness, from an answer a person made standing).

**Decision.** A host sends `{ by, answers? }`:

- Answers it leaves out are skipped: the agent decides those, and says so in its result.
- With no `answers` at all the person lets the agent decide: each question's `proposed` is used.
- A `review` has no proposal and no skip: it always needs its own answer.
- **A pause for questions is never ended by the person.** There is no "reject the questions". Only cancelling the run ends it, which is the host's own action on the run. (Rejecting a write is a `review` answer, and ends the run as it always did.)

**Learning from answers.** What a person answers is the best evidence of what to propose next time, and it is already the kind of thing memory holds (ADR 0013), so it is built there, per tenant:

- **Learn.** After a run, consolidation records each answer a person *chose* (`source: person`). An answer a host gave, or the agent's own proposal taken because the person let it decide, is not learned, or the agent's guesses would come back as if people had said them. The same answer to the same question, asked in other words (cosine 0.88 or more), adds to a count.
- **Prefill.** When a run asks, the harness looks for the person's latest answer to the same question that fits it (its options, its kind) and makes it the proposal, with `learned` saying so.
- **Stand.** A person can make an answer *standing* (`pnpm agent memory answers --tenant <id>`, which lists them to decide, the way `memory review` lists proposed facts). Only then does the harness stop asking and answer by itself, as `source: memory`, visible in the run. It only does so while the standing answer is still the person's latest: a newer, different answer ends it, and the question is asked again.
- Only consolidation writes (ADR 0013). A learned answer is never used without asking before a person has approved it.

**Unattended.** A host that answers without asking (`--yes`, `pnpm agent watch` without `--ask`) answers each question with its `proposed` value and approves writes, as `<who> (auto)`.

## Consequences

- One pause, one event pair, one decision shape, one route for the backend (`POST /surface/runs/:id/answers`) and one card in the admin app. The approval card is the `review` case of it.
- `frame.layout` is no longer an approval and no longer a write. It asks, inside `section-builder` too, so layout questions reach a person for the first time. `bind` and `hook-maker` ask at their gaps (the image domain, content that is not what the design shows, a different number of items).
- Breaking: the `approval.*` events, `Approver`/`ApprovalDecision` (now `Responder`/`Decision`), `RunResult.approval` (now `waiting`), `run.resumed`'s reason `approval` (now `answered`), and `checkpoint.waiting` (now always `questions`; a checkpoint saved before is read as the review it was). Consumers changed with it: the CLI, Studio's run view, the worker's stream end, the eval graders, tracing and consolidation.
- With Temporal (ADR 0028) the answers become a signal, as a decision does. The question and answer shapes do not change.
- The host needs a way to submit answers: the CLI now, then the FanXP backend's run routes and the admin app's queue page (`.scratch/human-in-the-loop/`).
