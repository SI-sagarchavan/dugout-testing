# 0007 — Agents are written with `defineAgent`; hosts run them

Date: 2026-10-29 · Status: accepted; the terminal runner moved to `apps/cli`, the API is gone, and the stream default with it (ADR 0009); house facts and seeding left the agent folder (ADR 0010)

## Context

Each agent wired itself by hand. `agents/match-preview/src/agent.ts` and `agents/sitemap/src/agent.ts` each built the memory hooks, merged the tool list and called `runLocal` with about 12 options inside a closure. Each package also had its own copy of `liveDeps`, house-fact seeding, a terminal script (approval prompt, event display), and in the sitemap evals, a copy of the model judge. The two terminal scripts had already drifted: only the sitemap one could send a change back (ADR 0005). The API served only match-preview, because each agent had to be wired into it by hand. For a teammate, "the API for building an agent" was a file to copy.

How others shape it (checked 2026-10-29):

- LangChain `createAgent({ model, tools, systemPrompt, responseFormat, middleware, checkpointer })`, deepagents `createDeepAgent(...)`: one call; the result is invoked with input and a per-run config (thread id, context). <https://docs.langchain.com/oss/javascript/langchain/agents>
- OpenAI Agents SDK `new Agent({ name, instructions, tools, outputType })`, run by a separate `run(agent, input)`. <https://openai.github.io/openai-agents-js/guides/agents/>
- Mastra `new Agent({ name, instructions, model, tools, memory })`, registered on a `Mastra` instance that serves it. <https://mastra.ai/docs/agents/overview>

The common shape: what an agent _is_ (instructions, tools, output schema) is declared once; what it _runs on_ (model client, storage, the run's identity) is supplied by whoever runs it.

## Decision

- **A new package, `@dugout/sdk`**, above `core` and `memory`: what an agent package imports. It holds `defineAgent`, `liveDeps`, the terminal runner and agent discovery.
- **`defineAgent({ spec, input, output?, dir, tools, maxInlineChars?, cli? })`** returns an `Agent`.
  - `spec` stays the `AgentSpec` contract: the instructions, the tool allow-list, skills, model name (ADR 0015), memory scopes, budget and approvals. It is checked when the agent is defined.
  - `dir` is the agent's folder, which gives the conventions: skills in `skills/`, house facts in `data/<tenant>/style.json`.
  - `tools(options)` builds the agent's own tools. `options` is whatever else the host passes to `create`, typed, e.g. a folder for tests to write into.
- **Definition and deps are separate.** `agent.create(deps)` takes what only the host has: the model client and config, the memory store, a lesson writer, tracing, and where run folders go. It returns the function that runs the agent. Each run takes the tenant, input and approver, plus `store` and `resume` for runs that outlive their process (ADR 0006). The CLI, API, evals and tests differ only in the deps and approver they pass.
- **What every agent gets without writing it:**
  - memory: skills, house facts, lessons, the memory tools and consolidation;
  - input checked against its schema;
  - a check that every tool in `spec.tools` was given;
  - the host's tracing sink;
  - a default runs folder;
  - seeding (`agent.seed`).
- **One terminal runner:** `pnpm agent <id> --tenant <tenant> --<field> <value>`.
  - The flags come from the input schema's top-level fields (strings, enums, numbers, booleans, lists of strings). `--input '<json>'` covers anything else. `cli.flags` adds aliases such as `--fixture`.
  - `cli.present` shows an approval request to a reviewer. Every agent gets the same prompt: `y`, `n`, or type a change.
  - `pnpm agent match-preview` and `pnpm agent sitemap` are this runner with the agent filled in.
  - `pnpm db seed` seeds every agent.
- **Finding agents.** Dev tools find agents by folder, the way `pnpm eval <id>` already did: the folder name is the id, and `src/index.ts` exports `agent`. The API lists the agents it serves explicitly, `hostAgents(deps, matchPreview, sitemap)` in `apps/api/scripts/serve.ts`, so a deploy never serves a half-built folder.
- **Evals share one model judge:** `createModelJudge(client, model, rubric)`. The sports-copy judge and the sitemap's brief-fit judge are each a rubric on top of it.

## Consequences

- A new agent is a folder:
  - `src/agent.ts` with `defineAgent`;
  - `src/index.ts` exporting `agent`;
  - `skills/`, optionally `data/<tenant>/style.json`;
  - `evals/suite.ts`.

  The CLI, seeding and evals pick it up by convention. Serving it over HTTP is one argument to `hostAgents`.
- Both agents moved over with no change in behaviour. Their tests and scripted evals are unchanged.
- match-preview's terminal prompt now takes change requests too, since the prompt is shared.
- The API serves the sitemap agent. A test runs it over HTTP with a change sent back into the run.
- Agents no longer depend on `@dugout/tracing` or call `runLocal` themselves.
- A run result's `output` is still `unknown`; callers cast it to the agent's output type.
- Not yet:
  - **`defineWorkflow`**, for fixed-step tasks where a model doesn't need to pick the next step. The API's entry shape (`{ input, run }`) is what a workflow would provide too.
  - **An approval presenter for the API**: `present` is terminal-only, and API clients render the raw input.
  - **A scaffold command** for a new agent folder.
