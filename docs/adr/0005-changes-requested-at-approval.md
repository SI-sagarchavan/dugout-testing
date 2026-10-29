# 0005 — A reviewer can send a write back for changes in the same run

Date: 2026-10-29 · Status: accepted

## Context

An approval used to have two answers: approve, or reject and end the run. Asking for a small change (a page path, a sentence) meant rejecting and starting over, or agent-specific code that fed the old output back in as input. The sitemap agent briefly had that code (`revise` input, `renamePath`, a CLI state machine).

How other harnesses handle it, from their docs (checked 2026-10-29):

- LangChain `HumanInTheLoopMiddleware` and deepagents `interrupt_on`: approve, edit, reject, respond. Reject skips the call and returns the feedback as a `ToolMessage`; the graph state is checkpointed and the run resumes. Edit replaces the arguments before execution. <https://docs.langchain.com/oss/python/langchain/human-in-the-loop>
- LangGraph: `interrupt()` and `Command(resume=...)`; the meaning of the resume value is up to the graph. <https://docs.langchain.com/oss/python/langgraph/interrupts>
- OpenAI Agents SDK: approve or reject a pending call on `RunState`; a rejection can carry a message for the model. No argument editing. <https://openai.github.io/openai-agents-python/human_in_the_loop/>
- Claude Agent SDK: `canUseTool` returns allow (optionally with `updatedInput`) or deny with a message the model sees. <https://code.claude.com/docs/en/agent-sdk/user-input>
- Vercel AI SDK and Mastra: a denial reason goes back in the tool result. <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>, <https://mastra.ai/docs/agents/agent-approval>

So "send back with feedback and keep the run going" is the common pattern. All of them put the feedback in the tool result, and none stops the run from finishing while feedback is outstanding.

## Decision

- `ApprovalDecision` gets a third answer, `{ approved: false, by, changes }`, next to approve and reject. The API takes `{ approved: false, changes }`.
- On `changes`, the loop logs `approval.changes_requested`, answers the call with "not run", and skips the rest of that turn, `final` included, since it was planned before the request.
- The reviewer's request goes in as a **user** message after the turn's tool results, not inside the tool result. Agents here are told never to take instructions from tool results (that is the prompt-injection guard), and live runs showed the model doing exactly that with feedback in a tool result: it refused the change in 2 of 3 attempts. The reviewer is the person the run works for, so the user role is the honest channel.
- While a change is outstanding for a tool, the run cannot finish: `final`, or a turn with no tool calls, gets the request again and counts as an invalid output. Before this, a model could end the run with the unapproved result. Approval of a call to that tool clears it.
- Change rounds count against `maxSteps` and the budget like any other step.

## Consequences

- Agents need no code for it. The sitemap agent's own edit code was removed; its `maxSteps` went from 12 to 20 so a few rounds fit.
- Unlike the frameworks above, we put feedback in a user message and block finishing. Both are deliberate and covered by tests in `packages/core/tests/loop.test.ts`.
- Not done: editing the arguments directly (LangChain's and the Claude SDK's "edit"). It is cheaper for small fixes, but the model doesn't know its input changed, and the OpenAI and Mastra docs warn against swapping arguments after review. Revisit if reviewers ask for it; it would be a fourth answer, `{ approved: true, input }`, re-validated by preflight.
- In-process runs still lose a pending approval on restart (ADR 0004). Save-and-resume should store the pending change requests with the transcript.
