# 12 · Strict tool schemas where the provider supports them

Status: resolved
Type: task
Blocked by: 03

## What

Some providers can constrain the model so its tool arguments always match the schema: OpenAI, Gemini and Claude, and DeepSeek in beta behind a separate URL. Send `strict: true` on tool definitions, `final` included, for models whose config says they support it.

Strict mode needs every field required and no extra fields. Our optional zod fields would be sent as required but nullable, and turned back into missing values before the zod check. Zod keeps checking everything strict mode can't express: lengths, formats, rules that span fields.

## Why

Fewer turns are spent fixing malformed arguments and outputs. That matters most for agents with big structured inputs to their tools.

## Done when

- Evals or traces show invalid arguments or outputs costing turns (from 07 or Langfuse). This is why it's in tier 3: build it when that's measured.
- Tools are sent strict to a supporting model, and optional fields round-trip correctly, in a test.
- Models without support keep today's behaviour.

## Outcome

Built with harness 03 (ADR 0015) as `strictTools` per model in `config/models.json`, on for the Claude models. Claude takes optional fields, so nothing is turned into required-and-nullable. Every object is closed, and the constraints strict mode can't express are left out for zod to check. A tool with a record, or a schema that refers to itself, goes without strict. Nova rejects `strict`, so the model list refuses it there. Not measured against invalid-argument turns yet; that waits for harness 07.

## Pointers

- `packages/core/src/tools.ts` (`toolDefinition`), `packages/core/src/model/openai-compatible.ts`, `packages/core/src/loop.ts` (`final`)
