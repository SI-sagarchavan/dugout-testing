# Thread context: what each run reads

Status: needs-triage
Related: ADR 0031 (threads, one stream per invocation), ADR 0013 (memory), ADR 0025 (subagents)

## Why

An audit on 2026-11-07 checked six common practices for agent context:

1. A thread is a database record with a running summary and links to what it made.
2. Big things are stored and the model gets a reference.
3. A sub-agent gets a clean context and returns a short result.
4. Older turns are compacted at 60–70% of the window.
5. Comments go through a router: layout or style to `ui-editor`, data to `data-bind`.
6. A comment loads only what it is on, and each edit is a new version.

| #   | Status             | What we have                                                                                                                                                                                                                           |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mostly             | `threads` and `thread_notes` (migrations 019, 020). The next invocation reads `## This thread so far`, within 1,500 tokens. No record of versions of what a run made: a later id replaces an earlier one.                              |
| 2   | Partly             | The Figma frame data, plates and trees are stored in the control plane. Tool outputs over 16k characters are stored and read back with `output.read` (`packages/core/src/tools.ts:149`). Seven tools skip that limit (`alwaysInline`). |
| 3   | Yes                | A child run gets only its input and returns `{ runId, output }`. Children read no thread.                                                                                                                                              |
| 4   | No                 | Nothing is compacted. A full window ends the run (`model_context_window_exceeded`, `packages/core/src/loop.ts:85`).                                                                                                                    |
| 5   | No                 | The backend always queues `ui-editor` (`EDITOR_AGENT`). A data comment comes back "not addressed".                                                                                                                                     |
| 6   | Mostly, with a bug | `ui.publish` saves a new tree, so an edit can be undone. But `ui.load` sends an element's props unchanged, including `data:` pictures.                                                                                                 |

Measured on 2026-11-07:
- stored comment contexts average 620 KB, up to 995 KB;
- one tool result is about 50k characters;
- transcripts reach 353k characters for card, 179k for card-match, 70k for frame-match and 47k for data-bind.

## Tickets

- [01](issues/01-ui-load-pictures.md) · `ui.load` sends pictures to the model (bug)
- [02](issues/02-compaction.md) · Compaction in the core loop
- [03](issues/03-comment-router.md) · Comment router
- [04](issues/04-large-results-by-reference.md) · Large tool results by reference
- [05](issues/05-versions-in-thread.md) · Versions in the thread
- [06](issues/06-comment-screenshot.md) · Screenshot on a comment

Order: 01, then 02. 04 builds on 01. 06 helps 03 but does not block it.

## Not doing

A message log for each thread. It would repeat what each run records and what the notes already hold.
