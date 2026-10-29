# 0001 — OpenAI-compatible model client

Date: 2026-10-29 · Status: accepted · Replaces the "Models" locked decision in the build plan

## Context

The plan locked "official provider SDKs behind `ModelClient`; Anthropic direct or Bedrock". The team wants to build on the OpenAI API standard, and the key available for testing is DeepSeek's.

## Decision

- One `ModelClient` adapter for **Chat Completions** (`/chat/completions`), built on the official `openai` npm SDK. `baseURL` and `apiKey` come from config, so DeepSeek, OpenAI or a local server only differ in config.
- Not the Responses API: fewer providers implement it, and DeepSeek's version is stateless and Codex-oriented.
- Transcript types in `@dugout/contracts` are **shaped like** Chat Completions (`system`/`user`/`assistant`/`tool`, `toolCalls` with JSON-string arguments) but are our own zod types; SDK types stay inside the adapter.
- Tiers map to a model plus thinking settings in config, never in specs. Defaults: both tiers use `deepseek-flash` with thinking, `fast` at effort `low` and `smart` at effort `high` (changed from `deepseek-v4-pro` for `smart` on 2026-10-29, to keep runs and evals cheap). `deepseek-v4-pro` stays in the price table for overrides.
- Env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL_FAST`, `LLM_MODEL_SMART`.

## Consequences

- DeepSeek requires every earlier assistant turn's `reasoning_content` to be sent back when tools are present, so assistant messages carry an optional `reasoning` field and the adapter replays it when `replayReasoning` is set.
- Tool names are dotted (`fixtures.get`) but function names may not contain dots; the adapter encodes `.` as `__`, and tool names may not contain `_`.
- DeepSeek has no `json_schema` response format, so structured output goes through a `final` tool validated with zod in the loop.
- Model ids are not version-pinned (DeepSeek upgrades `deepseek-flash` in place). Every `step.completed` records the served model and fingerprint so eval results can be compared.
- Pricing is per provider in config (cache-hit, cache-miss, output; DeepSeek off-peak is half price). Budgets are enforced at the list rate.
- An Anthropic or Bedrock adapter, if needed later, translates to and from these types at its edge.
