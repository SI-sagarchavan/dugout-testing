# 03 · Named models, with effort, per agent and per task

Status: resolved
Type: task

## What

Today a spec picks one of two tiers (`fast`, `smart`) and both point at Nova on Bedrock (ADR 0012). Replace the tiers with a list of named models, each with its own effort, so one agent can use Opus while the tasks inside its run use Sonnet.

- **A model list in config** (`config/models.json`, versioned and reviewed like skills). Each name maps to:
  - the Bedrock id, an inference profile (`global.anthropic.claude-opus-5-5`, `apac.amazon.nova-lite-v1:0`);
  - the family, which decides how effort and reasoning go over the wire: `claude`, `nova-2` or `nova`;
  - the effort level, checked against the family;
  - the context window and the output-token limit;
  - the price, from the AWS Price List API with the date checked.
- **The same model at two efforts is two names**, e.g. `sonnet` (medium) and `sonnet-deep` (high), so specs never carry vendor settings.
- **Specs name a model** (`model: "opus"`). A task launched inside a run (harness 04) names its own, defaulting to the agent's. The existing agents name `nova-lite`.
- **One Bedrock client serves every model;** the model's id and effort are sent per call.

How effort goes over the wire (tried on si-main in ap-south-1, 2026-10-30, `@aws-sdk/client-bedrock-runtime` 3.1160):

| Family                          | Request field                                                                                | Levels                                  | Notes                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `claude` (Opus 5.5, Sonnet 5.5) | top-level `outputConfig: { effort }`                                                         | `low`, `medium`, `high`, `xhigh`, `max` | Opus 5.5 defaults to `medium` and Sonnet 5.5 to `high`, so set it explicitly. Thinking can't be turned off on Opus 5.5 |
| `nova-2` (Nova 2 Lite)          | `additionalModelRequestFields: { reasoningConfig: { type: "enabled", maxReasoningEffort } }` | `low`, `medium`, `high`                 | Rejects `outputConfig`. At `high`, Nova 2 refuses `maxTokens`/temperature                                              |
| `nova` (Micro, Lite, Pro v1)    | none                                                                                         | none                                    | Rejects `outputConfig`. Config refuses an effort for these                                                             |

## Also needed for Claude

- **Send signed reasoning back.** Opus 5.5 returned a reasoning block with a signature and empty text on a plain question. On later turns it must go back unchanged, or the model loses it, and newer accounts get a 400 for edited history. The Bedrock client keeps only the text today and never sends it back:
  - the transcript keeps reasoning blocks with their signature (and redacted content);
  - the client replays them for `claude` models;
  - the run's history stays append-only.

  A task with its own transcript (harness 04) never replays one model's blocks to another.
- **Set `maxTokens`.** Thinking and the reply share it, and Claude's default is lower than its 128K limit.
- **Cache points.** The tasks share a large prefix (DSL primitives, tokens, page rules). Add Converse `cachePoint` blocks after the system prompt and the tools, and price cache reads.

## Why

The Figma-to-DSL agent wants Opus where judgement matters and Sonnet for the repair tasks, at efforts chosen per role. One fixed pair of tiers can't express that, and effort only means something per model family.

## Done when

- `config/models.json` replaces `LLM_MODEL_FAST`/`LLM_MODEL_SMART`, and loading it refuses an effort the family doesn't take, an id without a price, or an unknown family.
- A scripted test shows two agents in one worker on two named models, each request carrying its model's id and effort in the right field.
- A scripted test replays a signed reasoning block across a tool call unchanged.
- Usage and cost are recorded per model.
- A live smoke run on `opus` and on `sonnet` completes a tool call and `final`.

## Outcome

Built as ADR 0015 records, with two changes to the plan above. The family comes from the Bedrock id rather than a field, since a field could disagree with its id. The existing agents name `nova-lite`. Strict tools (issue 12) came with it, as `strictTools` per model.

## Pointers

- `packages/core/src/model/config.ts`, `packages/core/src/model/pricing.ts`, `packages/core/src/model/bedrock.ts`
- `packages/contracts/src/spec.ts` (`model.tier`), `packages/contracts/src/messages.ts` (`AssistantMessage.reasoning`)
- ADR 0012; Bedrock: [adaptive thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html), [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html); Nova 2: [extended thinking](https://docs.aws.amazon.com/nova/latest/nova2-userguide/extended-thinking.html)
