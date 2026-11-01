# 0018 — Stop reasons, retries, and how a run is allowed to finish

Date: 2026-11-01 · Status: accepted · Extends ADR 0002, ADR 0009 and ADR 0015

## Context

A review of the loop on 2026-11-01 reproduced four ways a run was lost or ended wrongly:

- `turn.finishReason` was never read. A reply cut off at `max_tokens` ended as `completed` with half a sentence, and a content filter stop did too.
- `final` was accepted in the same turn as a tool call that had failed. A `pack.save` that returned `ok: false` plus `final` completed a run that saved nothing.
- Any model error ended the run as `failed`. Throttling and a dropped stream are common on Bedrock, and the worker's retry never saw them, so the saved run was lost.
- A model that was stuck repeating a failing call used up every step, and a model near the step limit had no warning and no way to be made to finish.

## Decision

- **Stop reasons.** After the budget check, the loop reads `turn.finishReason`.
  - `guardrail_intervened`, `content_filtered`, `model_context_window_exceeded` and `refusal` fail the run at once with the new reason `model_stop`. The turn's tool calls do not run.
  - `max_tokens`, `malformed_tool_use` and `malformed_model_output` are cut-off replies. Each counts against `invalidOutputs`, the same counter as an invalid `final`. It is per run and never reset, so the third one fails the run with `model_stop`. Before that:
    - With no tool calls, the loop adds a user message asking for a shorter reply.
    - With tool calls, the turn is saved with `cutOff` and `cutOffReason`. Every call in it gets a tool result `Not run: your reply was cut off (<reason>). Send it again, shorter.`, even a call whose JSON parses, because it may be half written. A write call in a cut-off turn never reaches approval or the tool.
  - Every other value (`end_turn`, `tool_use`, `stop`, `tool_calls`, `stop_sequence`) behaves as before.
- **`final` after a failed call.** The saved turn records `failed`, the name of a tool that was denied, returned `ok: false` or has an unknown outcome earlier in the turn. A `final` in that turn is not accepted: the model gets `Not accepted: <tool> failed in this turn. Deal with that before calling final.`, and it counts against `invalidOutputs`. A `final` in a later turn is checked as usual.
- **`verifyFinal`.** `AgentDefinition` and `defineAgent` take an optional `verifyFinal(output, { ctx, messages })`. It is synchronous and has no I/O, like `Tool.block`. It runs after the output schema passes, on the unwrapped value. A returned string becomes the tool result `Not accepted: <string>` and counts against `invalidOutputs`. No agent uses it yet.
- **Transient model errors are retried, then left to the worker.**
  - `TransientModelError` (`packages/core/src/model/errors.ts`) is what `bedrockError` returns, keeping `cause`, for `ThrottlingException`, `ServiceUnavailableException`, `InternalServerException`, `ModelStreamErrorException`, `ModelTimeoutException` and `ModelNotReadyException`. A failure inside the stream is given its service name before it is thrown, so it is classed the same way. A `ValidationException` is not transient.
  - `createLocalSteps` retries only that error, three more times, after about 1s, 2s and 4s, each with ±25% jitter. `retryDelayMs` replaces the delay so tests don't wait. Each attempt has new fragment batches. A retry can send `token` events the log already has (ADR 0002).
  - If it still fails and the run has a checkpoint store, the loop rethrows it. The worker records `last_error` (ADR 0009), the lease runs out, and another claim resumes the run from its last save, up to the worker's `maxAttempts`. Without a store, the run fails with reason `error` as before.
- **A warning, then a forced `final`.**
  - When two model turns are left (`maxSteps - step === 2`), the loop adds one saved user message, `2 model turns left. Finish now.`, followed by `Call final with your result.` if the agent has an output schema. `stepsWarned` is in the checkpoint, and the message is in the transcript, so a resume or fork sends the same request (ADR 0016).
  - On the last allowed step, and on the turn after the `Call the final tool with your result.` nudge, an agent with an output schema asks the model to call `final`: `ModelStepRequest.toolChoice`, sent to Bedrock as `toolConfig.toolChoice`. `createLocalSteps` drops it for a model whose `forcedTools` is not `true`. `forcedTools` is a per-model flag in `config/models.json`, off by default, and the Claude family is the only one allowed to turn it on.
- **Stop a failing call that repeats.** The checkpoint keeps `failedCall` (tool, arguments, count). An identical `ok: false` outcome adds one, any successful tool call clears it, and a different call starts at 1. At 3 the run ends with `invalid_output` and the message `<tool> failed 3 times with the same input`. The last refused call (`refused`) now lives in the checkpoint too, so a resumed run still stops on a copy of it.
- **Errors are marked as errors.** `ToolMessage.isError` is set for a denial, an `ok: false` result, an invalid or refused `final`, a skipped call and an unknown outcome. Bedrock adds `status: "error"` to the `toolResult` only for a model whose `toolErrorStatus` is `true`.
- **New checkpoint fields are optional** (`refused`, `failedCall`, `stepsWarned`, `turn.failed`, `turn.cutOff`, `turn.cutOffReason`), so saved runs still load. `version` stays 1.

## Live checks

Run against Bedrock on 2026-11-01 (si-main), before the flags were set.

- **`forcedTools`:** accepted by `haiku` (low effort) and `sonnet-india` (medium), so both are `true`. Refused by `sonnet`, `sonnet-deep` and `opus`, the `global.*-5-5` ids, with or without effort: `tool_choice: type "tool" and "any" are not supported for this model`. They stay off. `opus-india` and the Nova entries were not tried and stay off.
- **`toolErrorStatus`:** a two-turn call (a tool call, then a result with `status: "error"`) was accepted by every entry in `config/models.json`: `haiku`, `sonnet`, `sonnet-deep`, `opus`, `sonnet-india`, `opus-india`, `nova-micro`, `nova-lite`, `nova-pro` and `nova-2-lite`. It is `true` on all of them. The AWS docs list the field for Nova and Claude 3 and 4 only, so a model added later is checked before the flag is turned on.

## Consequences

- A run can now end as `failed` with reason `model_stop`. Hosts that switch on the reason (`run.failed`) handle one more value.
- A cut-off reply, an invalid `final`, a refused `final` and a `final` after a failure share one allowance: two are tolerated, and the third ends the run. A model that makes the three kinds of mistake once each still fails.
- On the three `global.*-5-5` models the last step is still the model's choice, because they refuse a forced tool. They get the warning and the nudge, and `max_steps` stays the backstop.
- The retry delays (`local.ts`) and the same-failure limit of 3 (`loop.ts`) are constants, not set per agent.
