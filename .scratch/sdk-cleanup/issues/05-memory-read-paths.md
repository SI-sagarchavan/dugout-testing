# 05 — Memory that is written and not read, or read more than once

Status: ready-for-human

From a read-only audit on 2026-11-10 (spot-checked: no agent's spec reads `episodic`; frame-match, data-bind and hook-maker read build records through `builtFor`). Check each line reference before acting on it.

- **The recalled-memory path runs for no real agent.** No spec reads `episodic`; only the test `drafter` does. So `<recalled_memory>` (lessons, approved examples, today's date) is never built. ui-editor is the only agent that can write an approved example, and nothing reads it; it never calls `situate` and has no `memory.search`, so its rejection lessons (and the model call that writes each) are never read back. Decide: delete the recall path and example writing, or give ui-editor a section and a way to read them. Decide where an agent gets the date.
- **Approved lesson facts are in no prompt.** A lesson seen three times becomes a `lesson.<hash>` fact. frame-match and hook-maker read no `semantic` memory, and data-bind's `pin` leaves `lesson.` out, so only `memory.search` finds them.
- **House facts reach data-bind twice.** `feed.` and `locale.` are pinned in its system prompt and returned again by `bind.load` as `feeds` and `locale`. Drop the two prefixes from `pin`; the tool's copy carries the rule.
- **`activeFacts` is read up to five times a data-bind run** (`buildContext`, `patternsFor`, `bind.load`, `bind.source`, every `bind.try`), and again per slot in a fan-out. Read it once per run. It does not fit run state as it is (a tenant's facts can pass 32,000 characters): a cache on the run, or the keys a tool needs.
- **Declared and unused**: `spec.memory.write` is read nowhere; `memory.propose` is listed by no agent, so its consolidation branch is dead; `EpisodeType` still has `"run"`; about twenty memory constants are exported only for tests.
- A host-started run with a load tool can read the same decision twice, in its thread notes and in the load tool's `before`. Minor.

Sound, leave alone: consolidation as the only writer, with redaction, and auto-approvals not learned; `builtFor` as a capped index with `memory.read` for the body; decision memory answering only from an active fact.

## Comments

2026-11-11 (ADR 0036): done: every run is told the date; an agent's approved `lesson.` facts are in its instructions; ui-editor situates on the preview's section and reads its lessons in `ui.load`. Left, on purpose: the `feed.` and `locale.` pins in data-bind (the tool returns only the URL, the zone and the date order, so dropping the pin would lose any other words in those facts); `activeFacts` read several times a run (three indexed reads, and a cache would serve a fact approved during a pause stale). Left to decide: delete the recalled-memory path (lessons and examples by input), which runs for no agent; the dead declarations.
