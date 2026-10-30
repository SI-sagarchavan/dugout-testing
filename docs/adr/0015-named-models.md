# 0015 — Specs name a model from a model list

Date: 2026-10-30 · Status: accepted · Supersedes the models and pricing of ADR 0012

## Context

A spec picked one of two tiers, `fast` or `smart`, and both pointed at Nova (ADR 0012). The Figma-to-DSL agent wants Opus where judgement matters and Sonnet for the repair tasks inside its run, each at its own effort. Two tiers can't say that. Effort also only means something per model family: Claude, Nova 2 and Nova v1 each take it differently or not at all. Claude 5.x models also sign their reasoning, and that reasoning has to go back to them unchanged on later turns.

## Decision

- **`config/models.json` lists the models by name.** Each name has:
  - the Bedrock id, an inference profile;
  - an optional effort;
  - the context window;
  - the output limit, sent as `maxTokens`;
  - whether tools go to it as strict;
  - the price per 1M tokens: input, cache read, cache write and output.

  The same model at two efforts is two names (`sonnet` at medium, `sonnet-deep` at high), so specs never carry a vendor setting.
- **A spec names a model** (`model: "nova-lite"`). A host can run an agent on another name (`AgentDeps.model`, `pnpm eval --model`), and judges and the lesson writer name their own (`JUDGE_MODEL`, `LESSON_MODEL`). A task inside a run (harness 04) will name its own the same way.
- **Requests carry the name.** `createBedrockClient({ models })` turns a name into the id, effort, output limit and strict flag, so one client serves every model.
- **The family comes from the id,** not from a field: `anthropic.claude-*` is `claude`, `amazon.nova-2-*` is `nova-2`, and other `amazon.nova-*` ids are `nova`. A family field could disagree with its id. Loading the list refuses:
  - an id of no known family;
  - an effort its family doesn't take;
  - strict tools on Nova;
  - a missing price, or a key the list doesn't know.
- **What each family takes.** Tried on si-main in ap-south-1 on 2026-10-30, with `@aws-sdk/client-bedrock-runtime` 3.1160:

  |                  | `claude`                                             | `nova-2`                                                          | `nova`                    |
  | ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- |
  | Effort           | `outputConfig.effort`: low, medium, high, xhigh, max | `additionalModelRequestFields.reasoningConfig`: low, medium, high | none; rejects both fields |
  | Output limit     | 128,000                                              | 65,535; refused at high effort, so not sent                       | 10,000                    |
  | Signed reasoning | returned, sent back                                  | not sent back                                                     | none                      |
  | Strict tools     | yes, with every object `additionalProperties: false` | rejects `strict`                                                  | rejects `strict`          |
  | Cache points     | after the system prompt, and in any turn             | after the system prompt, and only in a turn of text alone         | same as `nova-2`          |

- **Signed reasoning goes back unchanged.** `AssistantMessage.reasoningBlocks` keeps each block as the model streamed it: the text with its signature, or encrypted content as base64. The client sends them first in their assistant turn, for `claude` only. Reasoning text with no signature stays in `reasoning`, for people to read. The transcript is append-only, so the prefix a block was signed against never changes. The model list sets effort and output limit outside the transcript, so changing them doesn't change it.
- **Cache points.** A run's requests ask for the cache (`ModelRequest.cache`). The client then puts one cache point after the system prompt and one at the end of the newest turn that takes one, so each turn reads the transcript so far from the cache. One-off calls (judges, lessons, promotion) don't ask: Claude charges 1.25 times the input price to write the cache.
- **Strict tools.** For a model with `strictTools`, every object in a tool's schema is closed. Constraints strict mode can't express (lengths, bounds, item counts) are left out, and zod still checks them when the call arrives. A tool with an open object (a record), or a schema that refers to itself, goes without strict.
- **Pricing.** `priceTokens(price, tokens)` prices uncached input, cache reads, cache writes and output. A cache write with no price of its own costs the input price. Bedrock charges the same at every hour, so `rateAt` is gone and the cost equals the budget cost. `TokenUsage` gains `cacheWriteInputTokens`, with a default of 0 for runs recorded before it.

## Consequences

- **Removed:** `ModelTier`, `LLM_MODEL_FAST` and `LLM_MODEL_SMART`, `BEDROCK_PRICING`, `rateAt`, and `--fast` on the eval and smoke scripts (`--model <name>` replaces it). `MEMORY_PROMOTE_MODEL` is now a name, `sonnet-india` by default.
- **The existing agents name `nova-lite`,** which they used before. Tests and the scripted model use the same names: `scriptedModelConfig()` holds every name in the list, at $1 per 1M tokens.
- **Prices come from the AWS Price List API.** Nova's are from the AmazonBedrock offer, published 2026-10-29. Claude's are from the AmazonBedrockFoundationModels offer, published 2026-10-12. `global.*` profiles may process in any commercial region; `in.*` stays in India.
- **Not yet:**
  - compaction that keeps signed reasoning valid (memory 04);
  - cache points between the shared and per-run parts of the prompt (harness 05).
