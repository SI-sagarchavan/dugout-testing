# Harness: tools from any MCP server, and orchestration

Status: planning, revised 2026-11-02 (second pass, after the requirements questions). Nothing here is built yet. Branch: `feature/harness-orchestration`.

What the harness needs next, from the 2026-11-02 review against the anatomy of an agent harness:

- **Tools, APIs and MCP:** MCP works for Cast only, through hand-written tools. There is no way to point the harness at an MCP server and get its tools.
- **Orchestration:** an agent can't start another agent inside its run (`maxDepth > 0` is refused), there is no planning tool, and there is no second model to fall back to.
- **Underneath both:** there is no single place where per-turn checks plug in, and nothing keeps a long transcript small.

Each piece below says what it is in plain words, then how it fits the harness, then what could go wrong. One ticket per piece is in `issues/`.

## Requirements, settled

| #   | Question                                     | Decision                                                                                                                                                                                                                                 | State   |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| R1  | Do we need web search?                       | **Deferred.** frame-match and sitemap work on owned data (a Figma Handoff, our page catalogue, Cast). Open-web results are stale or unlicensed for sports facts. A narrow `site.fetch` for a club's own site may come later (ticket 04). | decided |
| R2  | When does the fallback model run?            | Only when a model is **unavailable** after its retries. Never because an answer was poor. Pairs below.                                                                                                                                   | decided |
| R3  | Automatic model choice by task difficulty?   | **Not now.** Models stay fixed per agent or task (exists). Per-turn switching is rejected. Escalation (cheap first, stronger on a measured failure) waits for evals to show a gap (ticket 09).                                           | decided |
| R4  | Who writes the plan, and what if it changes? | The **model** writes it and replaces the whole list on every change. The harness stores, shows and enforces small rules. Plan-first approval is a later option.                                                                          | decided |
| R5  | Subagents or a swarm?                        | **Supervisor-style subagents** (and code-led programs). A peer-to-peer swarm is out of scope.                                                                                                                                            | decided |
| R6  | Intent classifier?                           | **Not building it.** If a free-text host ever exists it would be a host-layer router, not part of the loop (ticket 10). Nothing is reserved in code.                                                                                     | decided |
| R7  | First real subagent                          | **`bind` → `hook-finder`** (2026-11-04; was skipped on 2026-11-02). Ticket 07 is built (ADR 0025); 08, children that write, is still deferred.                                                                                           | decided |

Fallback pairs (R2), decided: `sonnet` → `sonnet-india`, `sonnet-deep` → `sonnet-india`, `opus` → `opus-india`. `haiku`, the Nova models and `terra` have none: they are cheap or another family, and the worker already resumes a failed run later. Ticket 05 starts by checking live that the `in.*` profile really has capacity when the `global.*` one is throttled.

## The rules every piece keeps

These come from accepted ADRs. A design that breaks one of them is wrong, however convenient.

1. **The loop is pure** (ADR 0002). `loop.ts` does no I/O and reads no clock. Anything that touches the world goes through `Steps` (model, tool, approval, checkpoint) or the run log. That is what lets Temporal take over later (H7) with the loop unchanged.
2. **A run can stop and resume anywhere** (ADR 0006, 0016). Anything that changes what the model sees next is in the checkpoint, so a resume or a fork sends the same request. New checkpoint fields are optional; `version` stays 1.
3. **The transcript only grows** (ADR 0016). A save point's transcript is the first `checkpoint.messages` of it, and Claude's signed reasoning was signed against that exact prefix (ADR 0015). Nothing rewrites a saved message.
4. **Tenant and credentials come from the run** (CLAUDE.md, ADR 0022). Never from the model or tool input.
5. **Typed tools only; writes wait for a person** (CLAUDE.md). Every tool has a schema, an effect and a timeout, and goes through the pipeline: allow-list, policy, schema, approval, timeout, retries, redaction, output store.
6. **Tool output is data, never instructions.** That matters more as tools reach outside: MCP servers and web pages.

## The pieces

### A. Hooks: one place for per-turn rules (foundation)

**In plain words.** Today every rule the loop applies (the "2 turns left" warning, the nudge to call `final`, stopping a call that keeps failing, `verifyFinal`) is written straight into `loop.ts`. Adding compaction, a plan reminder or a self-check would mean more special cases in the same 700 lines. Hooks give those rules one shape and one place to plug in.

**Design.**

- A `RunHook` is a plain object with optional, **pure, synchronous** functions. The loop calls them at fixed points:
  - `beforeModel(view, state)`: returns the messages to send this turn. This is where compaction and the plan reminder go. It returns a _view_: the saved transcript is not touched (rule 3).
  - `afterModel(turn, state)`: can add a user message after a turn (the nudges).
  - `afterTool(call, outcome, state)`: can annotate a result or end the run (the repeated-failure stop).
  - `beforeFinal(value, state)`: can refuse a `final` (what `verifyFinal` does today).
- Hooks never do I/O. A rule that needs I/O (run the tests, ask a judge model) is a tool or a `Steps` call. That keeps rule 1.
- Hook state lives in one optional checkpoint field, `hooks: Record<hookId, unknown>`, so a resume or fork rebuilds the same view (rule 2).
- **Order:** the harness's own hooks first, then the agent's (`defineAgent({ hooks })`), in list order.
- **First step is a refactor with no change in behaviour.** The existing rules move onto hooks, and the 1,928 tests stay green unchanged. Only then do new hooks arrive.

**Risks.** A hook that isn't deterministic breaks resume: same checkpoint, different request. Hooks get the clock or randomness only through state written by a step, and a test runs every built-in hook twice on the same state and checks the result is identical.

**Decision record:** new ADR, "Run hooks", extending ADR 0002 and 0018. Ticket 01.

### B. Context view: old tool results cleared, the transcript kept

**In plain words.** A run keeps every message until it hits the model's context limit and fails (`model_context_window_exceeded`). No run is near that yet (the longest, frame-match, peaked around 25 steps), but runs that check their own work grow fast. The first step needs no model: once a request gets big, old tool results are replaced by a one-line stub. Their full text is still in the output store and still readable with `run.readOutput`.

**Design.**

- A built-in `beforeModel` hook. When the request passes a share of the model's context window (default 50%, `contextWindow` is already in `config/models.json`), every tool result older than the last N turns becomes `[cleared: 4,210 chars, read it with run.readOutput ref out-7]`. A result that isn't already stored is stored first, through the tool step, so the reference always works.
- **It clears in batches, not every turn.** Each clearing changes the prefix and costs a cache write, so it clears down to a low-water mark and leaves the prefix alone until the next threshold.
- The checkpoint keeps `hooks.context.clearedThrough` (a message index). The same checkpoint gives the same view on resume and fork. The saved transcript keeps everything, so traces, evals and reviews still see each round.
- Images in old results (when harness issue 01 adds them) are dropped the same way.
- **Later (v2): summarising,** a model call that writes a summary of the cleared part. It goes through `steps.model` with its own purpose, priced against the run's budget. Not in the first slice.

**Open question to test first.** Claude signs its reasoning (ADR 0015). Is a replayed signed block still accepted when an earlier tool result in the prefix has changed? Anthropic's own context editing clears tool results server-side, which suggests it is, but nobody has tried it on Bedrock. Ticket 02 starts with that live check. If it fails, clearing skips turns before the newest signed reasoning, or drops the old reasoning blocks along with the results.

**Decision record:** new ADR, "The request is a view of the transcript". Ticket 02. Supersedes harness issue 05's "old rounds trimmed" part. 05's prefix-order part (shared context first) stays where it is.

### C. MCP servers from a manifest (generic MCP)

**In plain words.** Today each Cast tool is written by hand in `packages/mcp/src/cast.ts`. The goal is to point the harness at any MCP server, list the tools we allow, and have them appear as normal typed tools, with the same safety as a hand-written one.

**This changes ADR 0022.** 0022 says "there is no generic MCP passthrough", because a passthrough would skip our allow-list, effects and approvals. The new design keeps everything 0022 cares about. The only change is where a tool's details come from: a manifest checked into the repo, plus the server's own JSON Schema, instead of a hand-written zod schema.

**Design.**

- **One manifest per server**, `config/mcp/<server>.json`:
  - `url`;
  - auth: `oauth-per-tenant` (the existing Cast token store), `header-from-env` (a secret named in `.env`, never in the file) or `none`;
  - `tools`, mapping each server tool to our name, effect, timeout and retries, e.g. `"cast_list_hooks": { "name": "cast.listHooks", "effect": "read", "timeoutMs": 30000, "retries": 1 }`.

  A server tool that isn't listed is unreachable. A tool without an `effect` is refused at load, so nothing is "read" by default.
- **Schemas from the server, pinned.** At build time a command (`pnpm agent mcp sync <server>`) calls `tools/list` and writes `config/mcp/<server>.lock.json`: each allowed tool's input schema and description, with a hash. At run time the harness loads the lock, not the live list. If the server's list no longer matches the lock, those tools are refused with a clear error until someone runs sync and reviews the diff in a PR. That defends against a server changing a description to steer the model ("tool poisoning") and against a schema changing under a running agent.
- **Typed tools from the lock.** `z.fromJSONSchema` (zod 4.6.7 has it; checked) turns each schema into the zod input our `Tool` contract already takes, so the pipeline treats it like any other tool: policy, schema check, approval for writes, timeout, retries, redaction, output store. No new dependency.
- **One client.** `McpClient` (`packages/mcp/src/client.ts`) already does streamable HTTP and per-tenant OAuth. It gains `tools/list` and the other auth kinds. `castTools` becomes `config/mcp/cast.json` plus its lock, keeping the same tool names, so frame-match doesn't change.
- **Agents still list tools by name** in `spec.tools`. `cast.listHooks` is allowed only where a spec names it, as today.
- **Results are untrusted.** Same as any tool output: redacted, stored by reference when long, data never instructions (rule 6). An optional per-server `maxResultChars` caps them.

**Risks.**

- A manifest marks a write tool as `read`. That's a human error a review has to catch. The sync command flags any tool whose name or description says create, update, delete, publish, send or run while its manifest says `read`.
- One worker per token file (ADR 0022) still applies to OAuth servers.

**Decision record:** new ADR, "MCP servers as configured tool sources", superseding the "no generic passthrough" line of 0022 and keeping the rest. Ticket 03. Resolves harness issue 10.

### D. Web search: deferred

**Why not now.** Both agents work on data we own: frame-match on a Figma Handoff and our pipeline, sitemap on a brief and our page catalogue. For sports content the open web is often the wrong source: scores, fixtures and injuries should come from the tenant's feeds, and a web page can be stale, wrong or unlicensed. Nothing in the evals or the run history asks for it.

**What may come later.** A narrow, read-only `site.fetch` limited to a tenant's own domain, so sitemap could propose pages from what a club's site really has. It would be added through C (an MCP manifest, or a small typed tool), with the same rules: query through the policy and redactor, results untrusted and capped, off unless a spec lists it. It needs a decision on whether a tenant's requests may leave India.

Ticket 04, deferred.

### E. A fallback model

**In plain words.** When the model fails for a reason that may pass (throttling, the service unavailable) and the retries are used up, try a second model for that turn instead of giving up.

**How it flows.**

```
turn N: call sonnet
  ├─ OK ───────────────────────────────▶ continue
  └─ throttled / unavailable / network drop
       retry after 1s → 2s → 4s                         (exists today)
         └─ still failing
              ask the fallback (sonnet-india) for THIS turn only      (ticket 05)
                ├─ OK ──▶ continue; the event says a fallback answered
                └─ fails ─▶ the run pauses; the worker resumes it later   (exists today)
turn N+1: tries sonnet again
```

A wrong answer, a refusal or a bad input never triggers it.

**Design.**

- **`config/models.json` gets an optional `fallback`** on a model: the name of another model. One level, no chains.
- **The switch happens inside `steps.model`** (`local.ts`), after `MODEL_RETRIES`, only for a `TransientModelError`.
- **Loading the list refuses a fallback that isn't compatible:** it must not leave the region (`in.*` only falls back to `in.*`), and it can't be a chain.
- **Signed reasoning blocks are dropped** from the request to a different model, since a block is signed for the model that wrote it. Forced tools follow the fallback's own entry.
- **Priced and recorded as the model that answered.** `servedModel` and pricing already work this way. `step.completed` says it was a fallback.
- **Per turn, not sticky.**

**Risk.** Quality changes mid-run when a different model answers a turn. The event marks it, and evals can measure it.

**Decision record:** amend ADR 0015. Ticket 05. Needs no hook.

#### How a model is chosen: three levels, and which we do

| Level                       | How                                                                                            | State                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fixed per agent or task** | The spec names a model. A host can override per run (`--model`). A program task names its own. | ✅ built (ADR 0015)                                                                                                                                             |
| **Escalation**              | Start cheap. If the answer fails a check, redo that task on a stronger model.                  | ⏸ ticket 09, waits for evidence                                                                                                                                 |
| **A router per request**    | A classifier or Bedrock's prompt routing guesses difficulty and picks a model each turn.       | ❌ rejected. Claude's signed reasoning is lost on a switch, and each model has its own prompt cache, so a switch pays full price for the whole transcript again |

**Why escalation waits.** Our own measurements say the model rarely moves the result for frame-match: in 13 of 15 runs the model added at most 0.28 points on top of what the code already reached. Escalation only pays where a stronger model wins on a measurable check. Ticket 09 starts by running the sitemap and frame-match evals on `haiku`, `sonnet` and `opus` to find out, and builds nothing unless there is a gap.

### F. A planning tool

**In plain words.** For long tasks the model writes a short checklist and ticks it off. The checklist is shown back to it each turn so it doesn't lose track, and the CLI shows progress, as Cursor and Claude Code do.

**Who writes the plan.** Nobody hard-codes it and the harness doesn't know it in advance. The model reads the task and writes it, and rewrites it whenever it learns something:

```
plan.update [ ] read Handoff  [ ] measure  [ ] fix headers  [ ] publish
plan.update [✓] read Handoff  [▶] measure  [ ] fix headers  [ ] publish
   ... finds the footer is broken too ...
plan.update [✓] read Handoff  [✓] measure  [▶] fix headers  [ ] fix footer  [ ] publish
```

**Design.**

- **A built-in tool, `plan.update`**, with input `{ items: [{ text, status: "todo" | "doing" | "done" | "dropped" }] }`. **Every call replaces the whole list**, so a change in plan is just a new call. The loop handles it the way it handles `final`: no I/O, nothing to approve.
- **Durable:** the plan is stored in the checkpoint (`hooks.plan`), with a version number that goes up on each change.
- **Shown back each turn:** a `beforeModel` hook adds a short reminder of the current plan at the end of the request. It's part of the view, not the transcript.
- **Visible to the host:** each change is a `plan.updated` event with the new list and what changed (added, finished, dropped), and the CLI prints it.
- **Small rules a hook enforces:** at most one item "doing"; at most 20 items; a `final` is refused while any item is still "todo" or "doing" unless the model marks it "dropped" (so a changed plan can't strand the run).
- **Opt-in:** only agents whose spec lists `plan.update` get it.
- **Plan-first approval** (Cursor's "plan mode": show the plan, wait for a yes, then work) would fit our approval step, with the first `plan.update` needing a yes. A later option, not in the first slice.

**Not the same as programs.** A program (ADR 0017) is a plan _written in code_, for when the steps are known in advance. `plan.update` is for when the model has to work the steps out. Prefer a program whenever the steps are known. After the cleanup no agent uses programs, so the engine stays in core for the next one that does.

Ticket 06, blocked by 01.

### G. Subagents: an agent that hands a part to another agent

**In plain words.** Today only code (a program) can run several agents. A subagent lets the model hand a self-contained part ("find which hook feeds this card") to another agent with its own fresh context, and get a short answer back. The child's long working doesn't fill the parent's context.

**Design.**

- **A subagent is a tool.** A spec lists the agents it may call (`agents: ["hook-finder"]`), and each appears as a typed tool, `agent.hookFinder`, whose input is that agent's input schema. The model never names an arbitrary agent.
- **The child is a real run:**
  - its own transcript and checkpoint, written as `runs` rows linked by `parent_run_id` (the column already exists, for forks);
  - the same tenant (rule 4);
  - its id is derived from the parent run and the tool call id. If the parent crashes while the child is running, the resumed tool call finds the child's checkpoint and carries on rather than starting again.
- **Budget is shared.** The child gets what is left of the parent's budget, at most, and its cost is added to the parent's usage. `ToolOutcome` gains an optional `usage` for that. `maxDepth` (already in every spec) is enforced: a child of depth `maxDepth` can't start another.
- **First slice: read-only children.** A child may not list a write tool, so it never waits for an approval, and it runs inside the parent's tool step in the same process.
- **Later slice:** a child that writes asks the parent's reviewer, and the parent waits like it waits for an approval (`waiting: { kind: "child", runId }`). The worker resumes the parent when the child ends. That's when the child gets its own worker lease.
- **Events:** the child's events go to its own stream. The parent gets `tool.started`/`tool.completed` as for any tool, with the child's run id, so the CLI can attach to it.
- **Under Temporal later,** the child becomes a child workflow, as a program task does (ADR 0017).

**Risks.**

- **Cost.** One model call can start a whole run. The shared budget and `maxDepth` cap it.
- **Context.** The child gets only its typed input, not the parent's transcript. That's the point, and a bad brief from the parent gives a bad child run. Evals measure it.

**Decision record:** new ADR, "Subagents are tools that start a child run". Ticket 07 (read-only), ticket 08 (children that write).

#### Subagents and swarms are different things

| Pattern                       | What it is                                                          | Ours                                                          |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Sequential**                | Agents one after another                                            | ✅ programs (ADR 0017, built)                                 |
| **Parallel**                  | Many agents at once                                                 | ✅ programs `all` and `map` under a concurrency limit (built) |
| **Hierarchical / supervisor** | A lead agent hands parts to helpers and combines their answers      | 🔜 subagents (tickets 07, 08)                                 |
| **Peer-to-peer swarm**        | Agents share one conversation and hand control to each other freely | ❌ not planned                                                |

Why not a peer swarm: control passing between peers makes it unclear who owns the budget, who asks for approval and what "resume" means, and a different path every run makes evals (our quality gate) incomparable. Our tasks have known shapes, which programs and supervised subagents cover and keep debuggable. If peer handoffs are ever needed, they'd be a "hand over" tool built on subagents.

### H. Escalation (deferred, measure first)

See "How a model is chosen". If evals show a gap, the smallest design is a model ladder on a program task: `task(id, { agentId, input, models: ["haiku", "sonnet", "opus"], until })`, where attempt _n_ runs on `models[n-1]`. `TaskRequest` already carries `attempt`, and a run already takes a model override (`RunOptions.model`), so the engine change is a `model` field on `TaskRequest`. Ticket 09.

### I. A router (intent classifier): a host-layer feature, interface reserved

**In plain words.** It reads a free-text request and decides which agent should handle it, with what typed input, or whether to ask a question or refuse. It is **not** part of the loop and not something the model inside a run does (a model already picks its own tools from their descriptions). It sits in the host (wnm-fanxp-backend, Cast admin, the CLI), in front of `queue.start`.

**Why it isn't built now.** Every host today already knows the agent: a Figma Handoff starts frame-match, the brief box starts sitemap, the CLI names the agent. There is no free-text entry yet, and two agents don't need routing.

**The interface, reserved so nothing has to change later:**

```
route(text, caller, thread?) →
    { agent, input, confidence }    // start a run
  | { thread, runId }               // continue a thread (harness 15)
  | { answer }                      // a question about a finished run
  | { clarify: "which Handoff?" }      // ask first
  | { refuse: reason }              // out of scope, or an injection attempt
```

**Rules.**

- **The classifier proposes; the host decides.** The tenant and the caller's permissions come from the session, never from the classifier (rule 4). It picks only among agents this caller may run: the output schema's agent list is built per call, so it can't invent or reach a forbidden agent.
- **The input it extracts is untrusted** and checked against the target agent's input schema (`defineAgent` already parses it) before anything starts.
- **Low confidence asks.** An agent that writes never starts on a guess.
- **Deterministic first.** If the trigger already says what it is (a Handoff, a button), there is no classifier.
- **Built as a small agent** (`defineAgent`, no tools, an output schema, a cheap model), so evals, tracing, cost and events come free. A labelled set of requests with the expected route is its eval, with the usual 90% gate. Each decision is a `route.decided` event.
- **Cost:** about $0.0002 and about a second on `haiku`, against up to $0.15 for the run it guards.

Ticket 10, deferred until a host has a free-text entry.

## Order of work

```
01 hooks (refactor, no behaviour change)
 ├─▶ 02 context view: clear old tool results      (starts with a live Bedrock check)
 └─▶ 06 planning tool

03 MCP servers from a manifest (Cast moved onto it)

05 fallback model          (independent: inside steps.model; starts with a live capacity check)

deferred, with a trigger written in each ticket:
  04 site.fetch    09 escalation (waits for eval evidence)    10 router (waits for a free-text host)
  07 subagents read-only, 08 subagents that write (skipped by decision, 2026-11-02)
later: compaction v2 (summaries), images in messages (harness 01), threads (harness 15)
```

**Sequence (decided 2026-11-02):** 01 → 03 → 02 → 05 → 06. Hooks first, because 02 and 06 are built on them. MCP next, because it's the most requested and only lightly coupled to the loop. 05 can run in parallel with 02.

Each ticket ends with `pnpm check` green, its own tests (written first, failing), an ADR where the ticket says so, and CLAUDE.md updated only where a described behaviour changed.

## Not in this work

- **A shell, a code sandbox or a virtual filesystem.** Typed tools only, by rule. If an agent ever needs to run code, that's its own decision.
- **Agents that spawn agents not listed in their spec,** or that write their own tools.
- **A peer-to-peer swarm,** and a model chosen per turn.
- **Parallel tool calls in one turn.** It saves time, not quality, and complicates durable ordering (deferred in the 2026-11-01 review).
- **Agents writing long-term memory directly.** Still only the consolidation workflow (CLAUDE.md).
