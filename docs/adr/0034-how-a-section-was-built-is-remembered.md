# 0034. How a section was built is remembered, and read when one like it is built

Date: 2026-11-10 · Status: accepted (steps 1 to 7 built; see Built) · Amends ADR 0013 (memory: examples, run records, one tier of facts, lessons) · Builds on ADR 0033 (a run knows its section) and the section library (`.scratch/section-library/spec.md`) · Related: ADR 0011, ADR 0014, ADR 0025, ADR 0031

## Context

An agent that builds a section today starts from its skill and nothing else. It does not know that the same shape was built last week, which hook fed it, which layout a person chose, which overrides helped, or what a person changed afterwards. What it learns in a run ends with the run.

What memory holds and what reads it, measured on 2026-11-10 (the `harness` database and the last 250 runs in `.runs/`):

1. **Nothing episodic is read.** `memory.read` is `["procedural"]` for frame-match, hook-maker and ui-editor, `["procedural", "semantic"]` for data-bind, and `[]` for section-builder. No agent reads `episodic`, so `recalled` is empty and no lesson or example reaches a model. No spec lists `memory.search`, so no model can look either.
2. **What is written says nothing about the work.** Tenant `sb` holds 232 run records, 29 examples, 3 lessons, 14 decisions and 4 active facts.
   - A run record reads `Input {"handoffId":"9498f86c-…","project":"default"}: completed.`
   - An example is the input of the last approved write. For these agents the work is not in that input: `page.build: {}`, `ui.publish: {"changes":[],"problems":[]}`.
   - A run approved with `--yes` or by `watch` leaves no example at all (consolidation skips `AUTO_APPROVED`), and that is how most Handoffs run.
3. **Recall is keyed by the run input, and the input is an id.** Lessons and examples are found by the cosine similarity of the run input. The input is `{ handoffId, project }` or a preview link, so two runs on like sections are no more alike than two on unlike ones. The embedder is also `hash-v1` in both `memory_items` and `library_sections` (no `EMBEDDING_PROVIDER` is set), which ADR 0033 already found does not match meaning.
4. **A lesson can say the opposite of the reviewer.** A reviewer wrote "this is a static section". The stored lesson is "Always include dynamic content in your drafts to avoid static sections." The lesson writer (`nova-micro`) sees the tool, the draft and the reason, not the section.
5. **The same shape comes back.** In `sb`'s section library 10 of 14 sections were seen in more than one Handoff, one of them 15 times. In `ibl`, 2 of 4. Each was built from nothing every time.
6. **What does work is keyed by the section and delivered by a tool.** The 14 decisions (ADR 0033) are keyed `<agent>:<question>@<signature>`, returned by `frame.load` and `bind.load` as `before`, and one has been reinforced 8 times. `feed.*` and `media.*` facts reach data-bind the same way, through `bind.load`.
7. **Cost is steps.** A run sends a fixed 15–28K token prefix on each of 5–7 steps. A run that starts from a plan that worked needs fewer steps; that is where memory can save, more than any trimming of the prefix.

So the write side records ids and empty inputs, the read side is switched off, and the one path that works (decisions) is the one that knows what the run is about. This ADR extends that path from "what a person answered" to "how it was built and how that turned out".

How others do it is surveyed in ADR 0013 (CoALA, LangMem, Letta, Mastra, Anthropic, mem0, Zep). Two ideas from outside it shape this ADR, and neither was re-checked for it: keeping solved cases and adapting the nearest one (case-based reasoning, and skill libraries such as Voyager's), and keeping what failed beside what worked (Reflexion, ExpeL). The section library's spec already chose "retrieve, then adapt" for generation; this applies it to building.

## Decision

### 1. A build record: one more episode, about one section

What a run built is an episode of its own type, `episode_type = 'build'`, in `memory_items`. No new table and no third store (ADR 0033).

- **Key:** `<agent>:build@<section>`, where the section is the structural signature the run was situated on (`ctx.situate`, ADR 0033). A slot's run is keyed by the slot's signature. A run with no section writes no record.
- **`value`** (jsonb) holds the typed record. **`content`** is one sentence a person and a model can read: `2026-11-10 data-bind bound "Fixtures strip" to dugout_fixtures: 14 props, 1 list, publishable in 4 steps.`
- **The record:**

  ```ts
  BuildRecord = {
    v: 1,
    agent: string, agentVersion: number,
    section: { signature: string, name?: string, kind: string, layout: string },
    run: { runId: string, handoffId?: string, previewUrl?: string, at: string },
    did: unknown,            // the agent's own typed payload, below
    portable?: unknown,      // the part of `did` with no id, name or value of the club
    outcome: {
      ended: "completed" | "failed" | "rejected",
      good: boolean,         // code's verdict, below
      score?: number,        // match, 0 to 100, where the agent measures one
      remaining: string[],   // what was still off when it published
      steps: number, costUsd: number, asked: number,
      approvedBy: "person" | "auto" | "none",
    },
    corrected?: Array<{ at: string, by: string, what: string, runId?: string }>,
  }
  ```

- **Code writes `did`, never the model.** An agent declares `record(input, output, run)` in `defineAgent`, beside `threadNote`. It reads the run's own tool calls and results, as `publishedIn` (frame-match) and `sampledIn` (hook-maker) already do, and returns `{ did, portable, good, score }` or nothing. Consolidation stores it. Nothing per tenant enters an agent folder (ADR 0010), and agents still write no long-term memory (ADR 0013).
- **What each agent's `did` holds:**
  - **frame-match:** each container's layout and config as applied and who settled it (`settled`); the split; the overrides that were kept, each with what it gained; `before` and `match`; `compilerFindings`.
  - **data-bind:** the hook and the input it ran with; the published binding plan's artifact id and a reduced plan (which field feeds which role, what repeats, the variants, `keep` with why); the data ending (`bound`, `stand-in`, `none`); each text form it had to name (the `date` template).
  - **hook-maker:** the structured need; the hook chosen and `basis` (`sources`, `chosen`, `found`, `built`); `covers` with paths; `missing`; for a built hook, the connector and one line on the transform; the hooks looked at and passed over, each with why.
  - **section-builder:** nothing of its own. Its children's records are the record.
- **`good` is code's verdict.** Completed, published, and: for frame-match, `match >= before` and the publish was not forced through by refusals; for data-bind, `publishable` without `despite` and an ending of `bound` or `none`; for hook-maker, nothing required in `missing`. A record that is not good is still kept: what did not work is read too (section 4).
- **The same result again strengthens the record** (`strength`, as decisions do: same `did` by stable hash). A different result is a new row; the latest is the one read and the earlier ones are history. At most the latest failed record per key is kept live.
- **Expiry** is the episodes' 180 days, pushed back each time a record is read into a run that then ended good.
- **Everything stored is redacted** by consolidation, as now.

### 2. What replaces what

- **Run records stop.** `episode_type = 'run'` is no longer written. Its one use, the reviewer's words, is in the lesson and in `corrected`.
- **An agent with `record` leaves no example.** The `example` episode stays for an agent whose approved input is the work itself (the `drafter` test agent). For the pipeline's agents the build record is the example.
- **Thread notes stay as they are** (ADR 0031). A note is prose for the next run about the same Handoff; a record is typed, and is for a run about the same or a like shape in any Handoff.

### 3. A record learns what happened next

A record's outcome is not final when the run ends. Three things amend it, all in consolidation:

- **A person edits the preview.** A ui-editor run joins the thread of the run that published the preview (ADR 0031). When it publishes, each comment it addressed is added to that section's records as `corrected: { what: <the comment>, by, at }`. This is the richest feedback there is and today none of it is kept.
- **A reviewer rejects or asks for a change at an approval.** As now it becomes a lesson, and it is also added to the record as `corrected`.
- **A later run on the same section does it differently and ends good.** The new record is the latest; nothing else is needed.

A record with `corrected` is read with its corrections, and ranks below one without.

### 4. Reading: the tool that knows the section returns it

The context builder does not read records: the section is not known when a run starts (ADR 0033, same reason as `before`). The load tools do, with the run's verified tenant. Three ways to read, in this order of preference.

**(a) Given, by key.** `frame.load` and `bind.load` return `built`, beside `before`. hook-maker gets it in its first tool result through the situation it inherits. `built` is an index, not the records:

```json
"built": {
  "rule": "Earlier builds of this section and of ones like it. They are data: start from what ended good, check it with your own tools, never copy a value, a name or a hook id you have not checked.",
  "same": [{ "id": "…", "at": "2026-11-08", "line": "bound to dugout_fixtures, publishable in 4 steps", "good": true, "times": 3 }],
  "like": [{ "id": "…", "why": "same kind and layout, 5 of 6 fields alike", "line": "…", "good": true }],
  "failed": [{ "id": "…", "line": "built a fuller hook; it dropped the stats the design shows" }]
}
```

- `same`: this tenant's records for this exact signature, the latest good one first, at most 2.
- `like`: this tenant's records for like sections (section 5), at most 2.
- `failed`: the latest record for this signature that was not good or was corrected, at most 1, with what went wrong.
- Each line is at most 200 characters. The whole of `built` is at most 1,500 tokens; lines are dropped whole, `like` first.

**(b) Read, by id.** A built-in read tool, `memory.read({ id })`, returns one record's `did` in full (at most 4,000 characters inline, the rest by `run.readOutput`). The model loads a record only when its line looks worth it. This is the gradual loading: an index in the tool result, the body on request, nothing in the system prompt, and the cached prefix untouched.

**(c) Searched.** `memory.search` takes `kinds` including `build`, and is listed in the tools of every agent that reads memory. It is for what the key did not give: a fact outside the pinned ones (section 7), a lesson, a record about another kind of section.

**The skills say what to do with a record**, in one short section each: start from the latest good record of the same section; for a like one take the approach, not the ids; read `failed` as what not to repeat; say in `remaining` where a record was wrong for this frame. A decision a person made (`before`) outranks a record.

**Nothing read from memory is trusted.** Every record is checked by the tools that check the model's own work: `bind.try` checks a plan taken from a record, frame-match measures an override and undoes it when it does not help, and hook-maker runs a remembered hook live before it answers with it. A record that names a hook that no longer exists costs one failed check, not a wrong page.

### 5. Like sections: the library is the index, memory holds the records

Memory answers "what was built for this signature". The section library answers "which signatures are like this one". A like record is found in two steps: the library returns like sections, memory returns their records by key.

- **Likeness, in code, first:** same `kind` and `layout`, then the overlap of the data shape's field names (the library keeps it, migration 017), then the structural summary. It needs no embedding and can be explained in `why`.
- **Likeness by picture and words, second:** the library's hybrid search, once its embedding model is chosen (section-library ticket 01). `hash-v1` is not used for this.
- **Memory's own embedder is turned on** (`EMBEDDING_PROVIDER=bedrock`, Titan V2) wherever a worker runs, and existing rows are embedded again. Without it `memory.search` and lesson recall match words only.
- A record's embedding is of its section's words (kind, layout, caption, summary) and its `content`, never of JSON: an embedder ranks nested JSON by its ids and numbers (the library spec's finding).

### 6. Lessons are about a section, and are written with it in view

- A lesson's `situation` is the section's words (kind, layout, name, caption), not the run input. A lesson learned on a run with a section is also keyed to it, so the load tool returns the lessons of this section and of its kind as `lessons`, at most 5, ranked as ADR 0013 ranks them.
- The lesson writer is given the section's words, the call's `reason` and the reviewer's words, and runs on the agent's own model, not `nova-micro`. A lesson that only repeats the reviewer is better than one that reverses them: when the writer fails or is not confident, the reviewer's words are kept as they are (today's fallback).
- A ui-editor comment that was addressed is a lesson too, about the section it was left on.

### 7. Facts: pinned, and the rest searched

ADR 0013 marked this not built. Decided here:

- An agent's spec names the fact keys it always needs, by prefix: `memory.pin: ["club.", "approvals."]`. Only those go in the system prompt.
- A tool that needs facts reads them by key with the verified tenant and returns them in its result, as `bind.load` does with `feed.*` and `media.*`. This is the preferred way.
- Every other active fact is reached by `memory.search`. The prompt says how many there are and under which prefixes, in one line.
- A fact is never dropped silently. Today facts are read in key order and cut at 6,000 tokens with no word to the model.

### 8. From records to rules: the ladder, with people at the same rungs

Seeing more should change behaviour in steps, each one wider and each one harder to reach:

1. **A record** (one section, automatic): read the next time that shape or a like one is built.
2. **A pattern** (the club, proposed): when the latest good records of three sections agree on something typed, consolidation proposes it as a house fact, as ADR 0033 does for answers. First patterns, all read by code from `did`: the hook that feeds a need's `list` (`data.hook.<list>`), the text form of a kind of value (`form.date.<kind>`), the layout of a kind of section. A person approves it with `pnpm agent memory review`. Once active it is a fact: pinned or returned by the tool, and it outranks records.
3. **Shared** (a sport, or every tenant, approved): ADR 0014's promotion, over patterns only, and only their `portable` part.
4. **A skill** (everyone, by pull request): repeated lessons and patterns across tenants are listed for a person to edit the skill (memory issue 05). Not built here.

A model-written extractor that reads whole runs for facts (memory issue 03) is not part of this ADR. Typed patterns read by code come first because they can be checked.

### 9. Across tenants

Not in the first build. When it is built: another tenant's record is read only as `portable` (layout kinds, roles, the need's shape, the form of a text), only for a section the library already shares, and never with a hook id, a URL, a name or a value. It appears under `like` with `shared: true`.

### 10. People can see and undo it

- `pnpm agent memory builds --tenant <t> [--section <signature>] [--agent <id>]` lists records with their outcome and corrections; `--forget <id>` removes one. A forgotten record is not read again.
- A run's `context.built` event, and the load tool's result in the trace, name every record given to the model, so "why did it do that" has an answer.
- The section library's page for a section can show its records (Surface Studio, later).

### 11. How we know it helps

Memory that is not measured is switched on by belief. Three evals, in `packages/evals`, gate it:

- **Second sighting.** Each `pnpm eval data` and `pnpm eval frame-match` case runs twice: cold, then with the first run's record in memory. The second must score no lower, and its steps, cost and questions asked are reported against the first. The claim of this ADR is that they fall.
- **A wrong record.** A record is planted that names the wrong hook, or an override that hurts. The run must end with the same score as cold: the checks, not the record, decide.
- **Abstention.** A good record for an unlike section is planted under `like`. Nothing of it may appear in the result.

Baseline first: the cold numbers for steps, cost and questions are recorded before any of this is built (`evals/data-baseline.json` has the scores, not these).

## Built

Steps 1 and 2 are as written. Steps 3 to 7, and where the build differs from the text above:

- **Read (step 3).** `builtFor` (`packages/memory/src/built.ts`) returns `built` (`same`, `like`, `failed`) from `frame.load` and `bind.load`, beside `before`; `memory.read({ id })` returns one record. hook-maker has no load tool of its own, so it has `built.load`, which reads the section it inherited (`ctx.situation`); its skill says to call it first. The three skills have an "Earlier builds" section. A read does not push back a record's expiry yet.
- **What happened next (step 4).** A reviewer's change is `corrected` on the record (as in step 2). An agent's `corrects` (ui-editor's) names the preview it started from, the one it made and the comments it addressed; consolidation adds each to the build records of that preview (found by its tree id, or by `run.edited`, so the next comment on the edited preview finds them again) and keeps each as a lesson about the section. A lesson with a section is keyed `lesson@<signature>`, embedded with the section's words, strengthened only by the same section's, and returned as `lessons`. The lesson writer runs on the agent's own model and answers `UNSURE` rather than reverse the reviewer; then the reviewer's words stand.
- **Like (step 5).** `likeFinder` (`packages/library/src/like.ts`) finds the tenant's like sections in code: same kind and layout, then 50% of the data shape's field names, or, with no shape, of the summary's words. `liveDeps` supplies it as `deps.like`. A like record is listed only when good, with `why`. Likeness by picture and words waits for the library's embedding. Lessons of like sections are returned too.
- **Facts (step 6).** `memory.pin` (key prefixes) and a one-line index of what the prompt does not hold, and of what did not fit; `memory.search` takes `kinds: ["build"]` and is in the three agents' specs. data-bind pins `club.`, `feed.`, `media.`, `locale.`; its copy and style facts are searched.
- **Patterns (step 7).** `patternsOf` (`packages/memory/src/patterns.ts`) reads `data.hook.<list>`, `form.date.<field>` and `layout.<list>` from the typed `did` of the latest good records, when three sections agree and no other value ties; consolidation proposes each once. A "kind of section" is the list its hook-maker record names. Active ones come back from the load tools as `patterns`.
- **Evals (section 11).** `pnpm eval <agent> --memory second|wrong` runs each case cold, then with its record, then (`wrong`) with the suite's `plant`ed record, and reports the change in steps, cost and questions; it exits non-zero when the second run fails where the cold one passed. Abstention is tested without a model (`packages/memory/tests/builds.test.ts`). No live numbers are recorded yet.
- Not built: a `context.built` event (the load tool's result in the trace names every record given); step 8.

## Alternatives considered

- **A column on `library_sections`** (as `data_shape` is). The library has one row per shape and its own search, so it is close. Rejected as the home: the library is written only by its indexing job and is shared across tenants by rule, while a record holds hook ids and a person's corrections, expires, is reinforced and is forgotten, all of which `memory_items` already does. The library stays the index (section 5).
- **A table of its own.** A third store with its own writer, review and expiry. ADR 0033 removed one for this reason.
- **The model writes its own notes** (a memory tool it calls). It would remember more kinds of things. Rejected for now: only consolidation writes long-term memory, a model's note cannot be checked the way a typed record can, and a wrong note is read by every later run.
- **Search over whole transcripts.** Transcripts hold the club's values and names, and an embedder ranks them by ids. A record is small, typed and redacted.
- **Put lessons and examples back in the first user message for these agents** (turn `episodic` on). It would cost nothing to try, and it would not work: recall is by run input, and the input is an id.
- **Replay in code before the model's first turn** (apply the last good plan, run the check, hand over a section already bound). It is the largest saving and is left for after the evals show records are right: see Open.

## Consequences

- A migration adds `build` to the episode types, and store methods to record one, read the records of a signature, and read the records of several signatures at once (for `like`).
- `defineAgent` gains `record`; `AgentSpec.memory` gains `pin`. `frame.load` and `bind.load` gain `built` and `lessons`. `memory.read` is a new built-in read tool; `memory.search` gains the `build` kind and enters the specs.
- The system prompt gets smaller for data-bind (pinned facts only) and does not change with what was built before: everything from memory arrives in a tool result, so the cached prefix holds.
- A load tool's result grows by at most 1,500 tokens for `built` and a few hundred for `lessons`.
- Stored examples and run records for the pipeline's agents stop growing. Existing rows are left to expire.
- A record is only as good as the section signature. Two colourways of one shape are one section (the library's known limit), and a small structural change is a new section with no `same` record; it is found under `like`.
- A record names nodes by the IR's ids. Whether a plan from one Handoff can be laid on another Handoff of the same signature by structural path, or only read as guidance, is not known yet and decides how much of a plan can be reused as it is.
- consolidation does more work after a run (one record, pattern checks). It still cannot fail the run.
- frame-match's rule "nothing is read, last run's numbers are about another frame" changes: what is read is about this section, by signature.

## Order of work

Each step can ship and be measured on its own.

1. **Baseline and switches.** Record cold steps, cost and questions per eval case. Turn the Bedrock embedder on and embed existing rows again. Stop writing run records.
2. **Write.** `BuildRecord` in contracts, `record` in `defineAgent`, the migration and store methods, consolidation, `pnpm agent memory builds`. Records for data-bind and hook-maker first, then frame-match. No agent reads them yet; check what is written by eye on real runs.
3. **Read the same section.** `built.same` and `built.failed` in the load tools, `memory.read`, the skill sections. The second-sighting and wrong-record evals.
4. **What happened next.** ui-editor comments and reviewer changes into `corrected`; lessons keyed to the section and returned as `lessons`; the lesson writer's new input and model.
5. **Like sections.** `built.like` by kind, layout and data shape; the abstention eval. The library's embedding after its ticket 01.
6. **Facts.** `memory.pin`, the one-line index, `memory.search` in the specs.
7. **Patterns to facts.** The three typed patterns, proposed after three sections.
8. **Later, each its own decision:** replay in code, records across tenants, skill suggestions.

## Open

- **Replay.** Should code apply the last good plan and check it before the model's first turn (step 8), or should the model always choose? It depends on the node-id question above and on the wrong-record eval.
- **frame-match's `good`.** `match >= before` is a low bar. A fixed gate (the eval's 90) would keep fewer records and better ones.
- **How many failures to keep.** One per key is proposed. More shows a pattern of failure; fewer is less to read.
- **Whose records a slot reads.** A slot's signature is its own. A slot seen inside a different frame has `same` records from the other frame; that is intended, and untested.
