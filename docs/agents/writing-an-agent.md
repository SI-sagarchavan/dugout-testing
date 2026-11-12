# Writing an agent

An agent is a spec and typed tools. The harness gives it the loop, approvals, pauses for a person, saving and resuming, memory and the event stream.

## The smallest agent

`agents/<id>/src/agent.ts`:

```ts
import { defineState, defineTool } from "@dugout/contracts";
import { defineAgent } from "@dugout/sdk";
import { z } from "zod";

const SAVED = defineState<{ id: string }>("memo.saved");

const save = defineTool({
  name: "memo.save",
  description: "Saves the memo and returns its id.",
  input: z.object({ title: z.string(), body: z.string() }),
  effect: "write", // a person approves it
  timeoutMs: 10_000,
  async run({ title, body }, ctx) {
    const id = await store(ctx.tenantId, title, body); // the tenant comes from ctx, never from input
    ctx.state.set(SAVED, { id }); // for the check on `final`
    return { id };
  },
});

export const agent = defineAgent({
  spec: {
    id: "memo",
    instructions: "Write one memo on the topic, save it with memo.save, then call final.",
    model: "haiku",
  },
  input: z.object({ topic: z.string() }),
  output: z.object({ id: z.string(), summary: z.string() }),
  tools: [save],
  completeFinal: (output, { state }) => ({ ...(output as object), ...state.get(SAVED) }),
  verifyFinal: (_output, { state }) => (state.get(SAVED) ? undefined : "Call memo.save first."),
});
```

`agents/<id>/src/index.ts` exports `agent`. Add it to the list in `apps/worker/scripts/work.ts` for the worker to run it. Copy `package.json`, `tsconfig.json` and `vitest.config.ts` from `agents/ui-editor`.

What the spec defaults to: version 1, `memory.read: ["procedural"]`, `budget: { usdPerRun: 1, maxSteps: 30, maxDepth: 0 }`, `approvals: ["effect:write"]`. Say only what differs.

## Agent or workflow

- **Agent**: the model decides what to do next. `defineAgent`, as above.
- **Workflow**: the path is known, so code decides what runs next and a model is called inside a step. `defineWorkflow`, below.
- A child the model may call when it judges it needs to: `agents: [child]` on an agent (`agents/data-bind` calls `hook-maker`). Set `budget.maxDepth` to 1 or more.

## A workflow

```ts
import { defineStep, defineWorkflow } from "@dugout/sdk";
import { z } from "zod";

const Text = z.object({ text: z.string() });

// a step is one model call with a typed answer
const draft = defineStep({
  id: "draft",
  model: "haiku",
  instructions: "Write a match preview for the fixture you are given.",
  input: z.object({ fixture: z.string() }),
  output: Text,
});
const grade = defineStep({
  id: "grade",
  model: "haiku",
  instructions: "Say whether the preview names both teams and the venue, and what to fix.",
  input: Text,
  output: z.object({ good: z.boolean(), feedback: z.string() }),
});
const revise = defineStep({
  id: "revise",
  model: "sonnet",
  instructions: "Rewrite the preview as the feedback asks.",
  input: z.object({ text: z.string(), feedback: z.string() }),
  output: Text,
});

export const agent = defineWorkflow({
  id: "preview",
  description: "Writes a match preview, grades it, and rewrites it until it passes.",
  input: z.object({ fixture: z.string() }),
  output: z.object({ text: z.string(), passes: z.number() }),
  steps: [draft, grade, revise],
  async run(ctx, { fixture }) {
    let { text } = await ctx.run(draft, { fixture });
    for (let pass = 1; pass <= 3; pass++) {
      // a second call to one step needs a key: it is how a resumed run finds each result
      const verdict = await ctx.run(grade, { text }, { key: `${pass}` });
      if (verdict.good) return { text, passes: pass };
      text = (await ctx.run(revise, { text, feedback: verdict.feedback }, { key: `${pass}` })).text;
    }
    return { text, passes: 3 };
  },
});
```

The patterns are code:

| Pattern                              | How                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| One step after another, with a check | `await ctx.run(a, …)`, an `if`, `await ctx.run(b, …)`                                                      |
| Several at once                      | `Promise.all(items.map((i) => ctx.run(step, i, { key: i.id })))`; `concurrency` caps how many run together |
| A step picks the branch              | a step whose `output` is an enum, then a `switch`                                                          |
| Plan, then one run for each part     | a planning step, then `Promise.all` over its list, then join in code                                       |
| Write, grade, write again            | a loop, each pass with its own key                                                                         |
| Go another way when a step fails     | `try { … } catch { … }` around `ctx.run`                                                                   |

A step may be an agent with tools (`steps: [frameMatch, draft]`): `ctx.run` runs either. Each step is a run of its own, so it shows in the stream, counts against the workflow's budget, and is not run again after a pause or a crash. A step's question to a person pauses the workflow; when a step writes, a person approves the workflow once before it starts.

## What a tool can do

| To                                             | Use                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep something for a later call or for `final` | `ctx.state.set(KEY, value)`; read with `ctx.state.get(KEY)`. Small facts only (32,000 characters a value). Kept only if the call succeeds                     |
| Say which section the run works on             | `ctx.situate({ section: signature, name })`, in the tool that loads it. A person's answers and a reviewer's words are then kept about that section            |
| Ask a person                                   | The model calls `ask`. A tool reports what is open in its result; it does not ask. Declare the question's id in `spec.questions` and the answer is remembered |
| Stop until something is set up                 | `throw new NeedsSetup("sign in to Cast")`                                                                                                                     |
| Refuse before approval                         | `block(input, ctx)` returns the reason. `ctx.state` is there to read                                                                                          |
| Show the reviewer what code measured           | `resolve(input, ctx)` replaces the arguments the approval shows                                                                                               |
| Keep stale results out of the request          | `latestOnly: true` when each result replaces the last (a plan tried again whole), or a function of the result when only some do                               |
| Keep a long result whole                       | `alwaysInline: true`. Otherwise a result over 16,000 characters becomes a reference the model reads with `run.readOutput`                                     |

A tool that reads another tool's result reads it from state. `answeredCalls(messages, name)` is for calls to tools that are not yours: a server's, a child agent, `ask`.

## What the model reads, and when

1. **System prompt** (the same for every run of a tenant, so it is cached): the instructions, skills (`spec.skills`, from `skills/<name>.md`), house facts (`memory.read` has `semantic`; `memory.pin` keeps it to some key prefixes), and the lessons a person approved as rules for this agent.
2. **First user message**: the thread so far (earlier runs on the same section), the date, then the input.
3. **The load tool's result**, once the section is known: what people decided here before (`before`), how it was built (`built`), what people corrected (`lessons`), what the club's sections agree on (`patterns`). Read them in the tool that loads the section and return them; do not put them in the prompt.
4. **The transcript**: every call and result, until the request passes 150,000 tokens. Then older results become references and older turns a summary.

Put a rule in the instructions, a way of working in a skill, a fact about the club in memory, and a fact about the section in the load tool's result.

## What is remembered after a run

Only consolidation writes long-term memory; an agent proposes. After a run it keeps: what a person answered to a declared question (a decision on the section, or a proposed fact about the club), what a reviewer said when they rejected a write or asked for a change (a lesson, on the section when the run said which), and, for an agent with `record`, how the section was built. A lesson repeated three times is proposed as a rule; a person approves it with `pnpm agent memory review`.

## Testing

- A tool by hand: pass `memoryRunState()` as `ctx.state`, the same one to each call of a run.
- The whole agent: `agent.create({ store, client: createScriptedModel([...]), models: scriptedModelConfig(), runsDir })`, then run it with a responder. `packages/sdk/tests/agent.test.ts` ("the smallest agent") is the pattern.
- A workflow: the same, with a model that answers each step from code. `packages/sdk/tests/workflow.test.ts` has one test for each pattern.
- With a real model: `agents/<id>/evals/suite.ts` and `pnpm eval <id>`.
