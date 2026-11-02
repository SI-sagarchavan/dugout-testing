# 06 · A planning tool the model keeps

Status: ready-for-agent
Type: task
Blocked by: 01

## What

A built-in `plan.update` tool: `{ items: [{ text, status: "todo" | "doing" | "done" | "dropped" }] }`.

- **The model writes the plan and rewrites it whenever it learns something.** Every call replaces the whole list, so a change in plan is just a new call.
- The loop handles it like `final`: no I/O, no approval.
- The plan is stored in the checkpoint (`hooks.plan`), with a version that goes up on each change.
- A `beforeModel` hook adds a short reminder of the current plan at the end of each request. It's part of the view, not the transcript.
- Each change is a `plan.updated` event (the new list, and what was added, finished or dropped), and the CLI prints it with the current item marked.
- Rules a hook enforces: at most one "doing"; at most 20 items; a `final` is refused while any item is "todo" or "doing", unless the model marks it "dropped".
- Only agents whose spec lists `plan.update` get it.

Spec: section F. Plan-first approval (Cursor-style plan mode) is a later option.

## Done when

- Tests written first:
  - the plan survives a crash and a fork;
  - a replaced plan (an item added mid-run, another dropped) is the one in the next request and the event says what changed;
  - the reminder is in the request and not in the saved transcript;
  - an agent that doesn't list the tool can't call it;
  - more than 20 items, or two "doing", is refused with a message;
  - `final` with an open item is refused, and accepted once the item is "dropped";
  - the CLI shows the plan as it changes.
- CLAUDE.md: one line under `packages/core`.
