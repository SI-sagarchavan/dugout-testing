# 0012 — Amazon Bedrock is the model provider

Date: 2026-10-30 · Status: accepted · Supersedes ADR 0001

## Context

ADR 0001 built the model client on Chat Completions so DeepSeek could be used for testing, and a Bedrock adapter was later added beside it, chosen with `LLM_PROVIDER`. Bedrock is now the provider the team runs on, and keeping DeepSeek meant a second adapter, its config and its pricing, with nothing using them.

## Decision

- **One model client: `createBedrockClient`**, over ConverseStream from `@aws-sdk/client-bedrock-runtime`. The worker, CLI, evals and smoke run all build it directly.
- **AWS auth.** Requests are SigV4-signed with the AWS SDK's default credentials: `AWS_PROFILE` locally and the task role on ECS, with no API key. The region comes from `AWS_REGION`, then the profile's region, then ap-south-1.
- **Models.** Tiers map to models in config, never in specs. The defaults are `apac.amazon.nova-micro-v1:0` (fast) and `apac.amazon.nova-lite-v1:0` (smart), and `LLM_MODEL_FAST` and `LLM_MODEL_SMART` override them. ap-south-1 accepts only inference profile ids, not bare ids such as `amazon.nova-micro-v1:0`.
- **Pricing.** Prices are Bedrock's ap-south-1 list prices. `rateAt` stays and returns 1, so cost and budget cost are equal.
- **Kept from ADR 0001:**
  - Transcript types in `@dugout/contracts` are shaped like Chat Completions, with no SDK type past the adapter.
  - Tool names are encoded as `.` to `__`.
  - Structured output goes through the `final` tool.
  - Every `step.completed` records the served model.

## Consequences

- **Removed:** the OpenAI-compatible chat client, `DEEPSEEK_PRICING`, `LLM_PROVIDER`, `LLM_API_KEY` and `LLM_BASE_URL`, and `reasoningEffort` and `extraBody` on `ModelRequest`. Reasoning a model streams is kept in the transcript but never sent back.
- **The eval judge** no longer has a JSON mode to ask for, so it reads the first JSON object in the reply.
- **The `openai` package** stays only for OpenAI-compatible embeddings (`EMBEDDING_BASE_URL`). `EMBEDDING_PROVIDER=bedrock` uses Titan Text Embeddings V2.
- **On ECS,** the worker's task role needs Bedrock invoke permissions.
