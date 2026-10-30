# 0008 — A request chooses whether its response streams; structured output streams too

Date: 2026-10-30 · Status: tool-call arguments streaming stands; the request modes (`stream`, wait, `background`) and the per-agent default left with the API (ADR 0009). wnm-fanxp-backend chooses how it answers its own clients

## Context

`POST /runs` always answered `202 { runId }` at once. A client then opened `GET /runs/:id/stream` (SSE) or polled `GET /runs/:id`. There was no way to get the result back in the same request, and none to receive the stream on the request that started the run. The same applied to approval decisions.

What streamed was the model's text, one event per provider chunk (a few characters each). Tool-call arguments, which hold an agent's real output, were collected and never streamed. So a structured-output agent like the sitemap had nothing useful to stream.

How others do it (official docs, checked 2026-10-30):

- **OpenAI APIs.** Chat Completions and the Responses API use a per-call `stream` flag. Responses adds `background: true`: you poll by id, and a background stream resumes from `starting_after=<sequence_number>`. <https://developers.openai.com/api/docs/guides/background>
- **OpenAI Agents SDK.** One run, read either way: `run(agent, input, { stream: true })` in JS, or `Runner.run_streamed` in Python. A run that needs approval ends with `interruptions` in both modes; when streaming, the approval event is sent and the stream closes. <https://openai.github.io/openai-agents-js/guides/streaming/>
- **Separate methods over one loop.** Vercel AI SDK `generateText`/`streamText`, Mastra `generate`/`stream`, Pydantic AI `run`/`run_stream`, Strands `invoke_async`/`stream_async`, Microsoft Agent Framework `run`/`run(stream=True)`. Google ADK serves `/run`, which collects the events, and `/run_sse`. <https://adk.dev/runtime/api-server/>
- **LangGraph Agent Server.** Three endpoints: `/runs/wait`, `/runs/stream`, and background `/runs` plus join. A disconnect lets the run continue by default. A stream can be rejoined with `Last-Event-ID`. <https://docs.langchain.com/langsmith/streaming>
- **Per-agent settings.** CrewAI (`Crew(stream=True)`) and LlamaIndex (`streaming=False` on the agent) choose per agent.
- **Tool-call arguments stream as raw JSON fragments everywhere:** `response.function_call_arguments.delta`, `tool-input-delta`, Anthropic's `input_json_delta`. That is also how structured output streams. Partial objects are not validated anywhere except Pydantic AI; only the finished value is.

## Decision

- **Streaming is a property of the response, not of the run.** A run always records the same events. The request chooses how to receive them, as ADK's `/run` and Microsoft's `Collect()` do: not streaming means "wait until it's done".
- **`POST /runs` and `POST /runs/:id/approvals/:callId` take `stream` and `background`:**
  - **`stream: true`**: this invocation's events as SSE in the response. The response ends when the run completes, fails or waits for an approval, so its last event is `run.completed`, `run.failed` or `approval.requested`. The next decision continues where it stopped: `seq` carries on with no gaps.
  - **`stream: false`**: JSON once the invocation ends:
    - `completed` / `rejected` with `output`;
    - `failed` with `reason` and `message`;
    - `waiting` with `approval: { callId, tool, input }`.

    Each includes `usage`. If the run is still going after `MAX_WAIT_MS` (120 s), the answer is `202 { runId, status: "running" }`.
  - **`background: true`**: `202 { runId, status: "running" }` at once, the old behaviour. `stream` and `background` together are refused.
- **Each agent has a default.** `defineAgent({ stream })` sets it. It defaults to true for agents that answer in text and false for agents with an `output` schema, whose callers usually want the checked result whole. A request's flag overrides it.
- **A disconnect doesn't cancel the run.** That is LangGraph's default too; runs are durable (ADR 0006). `GET /runs/:id/stream` with `Last-Event-ID` rejoins the run and spans all of it, waits included.
- **Tool-call arguments stream** as `tool.input.delta { step, index, callId, tool, text }`. Because `final` is a tool call, an agent's structured output streams too.
  - Fragments are the model's raw JSON, not valid until the call ends.
  - The validated value arrives in `approval.requested`, `tool.started` or `run.completed`. Its key order can differ from the raw fragments.
- **Fragments are batched.** Text and tool arguments go out as one event per 50 ms (`FRAGMENT_MS`), not one per provider chunk. All of a model call's fragments are out before its `step.completed`. On a live sitemap run this cut 354 fragment events to 19.
- **Fragments are live only.** Like tokens, they are kept in Valkey and never in the Postgres record, which has the finished messages.
- **What a waited response holds** passes through the same redactor as events.
- **In-process callers don't change.** `await run(...)` is the non-streaming form, and sinks receive events as they happen (the CLI's form).

## Consequences

- A client can run a whole review with plain JSON requests. For the sitemap: start (waiting, with the sitemap), send a change (waiting, with the changed sitemap), approve (completed, with the output).
- A chat-style client gets the stream on the request it makes, with no second connection.
- `POST /runs` no longer answers 202 by default. Clients that start a run and then follow its stream route pass `background: true`.
- Behind a load balancer or CDN with a 60 s idle timeout, a waited request can be cut before `MAX_WAIT_MS`. Use `stream` (heartbeats keep it open) or `background`, or raise the timeout.
- If a model call is retried after its stream started, that step's fragments are sent again. Clients should treat the validated value as the truth.
- Not yet:
  - an async-iterator form for in-process callers (OpenAI's `StreamedRunResult`);
  - a helper that turns fragments into partial objects for UIs;
  - an endpoint to cancel a run.
