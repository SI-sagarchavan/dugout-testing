# Human in the loop: a run asks, a person answers

ADR: `docs/adr/0029-asking-a-person.md`.

## Goal

When an agent finds a gap (relative image paths with no domain, a design that shows videos while the only hook returns articles, a container that could be a carousel or a row), the run stops and asks a person. The questions are written for this frame and this data. The person answers each one, submits once, and the run carries on with the answers. A run can come back with more questions.

People answer in the FanXP admin app, on `/#/<client>/surface-studio/queue`, through the FanXP backend. The CLI answers too.

## Decisions so far

- The run stops and waits (no "guess now, ask after").
- Several questions per ask, answered one by one, submitted together; several rounds per run.
- `frame.layout` moves from an approval card to an ask, so its questions reach a person inside `section-builder`.
- The question and answer shapes live in `@dugout/contracts`; backend and frontend mirror them.

## Slices

1. `issues/01-ask-in-the-harness.md`: dugout: `ask`, tools that ask, child runs that ask, the CLI.
2. `issues/02-backend-run-routes.md`: wnm-fanxp-backend: the run routes the queue page is written against, answers, and the live event stream.
3. `issues/03-admin-app-live-queue.md`: wnm-fanxp-frontend: the queue page on live data, with a question card.
4. `issues/04-agents-ask.md`: frame-match and data-bind ask at their gaps.
