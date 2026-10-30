# 0001 — OpenAI-compatible model client

Date: 2026-10-29 · Status: superseded by ADR 0012 (Bedrock is the model provider) · Replaces the "Models" locked decision in the build plan

## Context

The plan locked "official provider SDKs behind `ModelClient`; Anthropic direct or Bedrock". The team wants to build on the OpenAI API standard, and the key available for testing is DeepSeek's.

## Decision

- One `ModelClient` adapter for **Chat Completions** (`/chat/completions`), built on the official `openai` npm SDK. `baseURL` and `apiKey` come from config, so DeepSeek, OpenAI or a local server only differ in config.
- Not the Responses API: fewer providers implement it, and DeepSeek's version is stateless and Codex-oriented.
- Transcript types in `@dugout/contracts` are **shaped like** Chat Completions (`system`/`user`/`assistant`/`tool`, `toolCalls` with JSON-string arguments) but are our own zod types; SDK types stay inside the adapter.
- Tiers map to a model plus thinking settings in config, never in specs. Defaults: both tiers use `deepseek-flash` with thinking, `fast` at effort `low` and `smart` at effort `high` (changed from `deepseek-v4-pro` for `smart` on 2026-10-29, to keep runs and evals cheap). `deepseek-v4-pro` stays in the price table for overrides.
- Env: `LLM_PROVIDER` (`deepseek`, the default, or `bedrock`), `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL_FAST`, `LLM_MODEL_SMART`. `createModelClient` builds the client for the provider; the worker, CLI, evals and smoke run all use it.

## Consequences

- DeepSeek requires every earlier assistant turn's `reasoning_content` to be sent back when tools are present, so assistant messages carry an optional `reasoning` field and the adapter replays it when `replayReasoning` is set.
- Tool names are dotted (`fixtures.get`) but function names may not contain dots; the adapter encodes `.` as `__`, and tool names may not contain `_`.
- DeepSeek has no `json_schema` response format, so structured output goes through a `final` tool validated with zod in the loop.
- Model ids are not version-pinned (DeepSeek upgrades `deepseek-flash` in place). Every `step.completed` records the served model and fingerprint so eval results can be compared.
- Pricing is per provider in config (cache-hit, cache-miss, output; DeepSeek off-peak is half price). Budgets are enforced at the list rate.
- `LLM_PROVIDER=bedrock` uses a second adapter, `createBedrockClient`, over ConverseStream from `@aws-sdk/client-bedrock-runtime`.
  - It translates to and from these types at its edge, with no SDK type past it, and encodes tool names the same way.
  - Requests are SigV4-signed with the AWS SDK's default credentials (`AWS_PROFILE` locally), so there is no `LLM_API_KEY`. That is also why it doesn't use Bedrock's OpenAI-compatible URL, which takes a bearer token.
  - The region comes from `AWS_REGION`, then the profile's region, then ap-south-1. ap-south-1 accepts only inference profile ids, so the defaults are `apac.amazon.nova-micro-v1:0` (fast) and `apac.amazon.nova-lite-v1:0` (smart).
  - It never sends DeepSeek's thinking fields or replays reasoning. Bedrock prices are flat, with no off-peak rate.
  - Memory embeddings can use Bedrock too (`EMBEDDING_PROVIDER=bedrock`, Titan Text Embeddings V2 at 1024 dimensions).
