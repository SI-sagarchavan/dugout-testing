# Pages with several sections (deferred)

Status: designed 2026-11-04, **not built**. Deferred by the user until one section binds end to end perfectly (mapping, binding, calling and creating hooks, shipped templates functional). Do not start before that.

## The problem, seen live

A page is one frame with several sections that share a background and have separate data. The squad page (`Team` frame) holds a player row (five `organism_web_cricket_playercard`) and a `fixtures` block under one root. A `bind` run holds one data source at a time (`bind.source` replaces the last one), so the run built the squad hook, then switched back to fixtures and published fixtures only. The model said so: "the run holds one data sample at a time". The missing piece is not "multi-source" but a step that finds out which sections a page has.

## Where identification lives

Not a new agent and not inside bind: which sections a frame has is a fact about the design. It belongs with the layer that already says what each container is (frame-match, ADR 0024), and bind reads it.

1. A code function lists candidate sections from the structure: repeat groups, component names, headings, layer names (`fixtures`, `LATEST NEWS`; most frames are auto-named `Frame 1984…`, so names alone are not enough), where subtrees split. A designer convention (`section/<name>` layer) overrides it.
2. When ambiguous, a model proposes sections (name, Figma ids, what data) and code validates: ids exist, sections do not overlap, every repeat group and placeholder text is in exactly one section or marked static.
3. Still unclear: a person, through the approval mechanism. The result is stored with the frame so a correction stays.

## Orchestration shape (code-led, per the spec's R5: "prefer a program whenever the steps are known")

1. find sections; 2. per section, in parallel and read-only, the researcher: a hook that fits, or none; 3. build the missing hooks, one approval for the whole list (each build keeps its three-try escalation); 4. per section, in parallel and read-only, source and plan for its own nodes only; 5. merge the plans (they touch different nodes), check the page, publish once: a data map of sources with each section's hook and `workflowId`.

Only the orchestrator asks a person for anything, which avoids approvals passing through two levels of child runs.

Hosting: ADR 0017 programs (`map` with a concurrency limit, resume) are the long-term home but do not run in the worker yet. The smaller route is a code-driven fan-out inside the `bind` run over the child-run machinery (ADR 0025). The model calling children does not parallelise: the loop runs one tool call at a time.

## Risks to plan for

- Cast's live-run budget is 25 per hour per person, shared by all agents. A build spends several, and parallel sections spend them faster: cap concurrency and stop with a clear message before it is gone.
- A page of N sections is N+ runs: cents on haiku, but slower.
