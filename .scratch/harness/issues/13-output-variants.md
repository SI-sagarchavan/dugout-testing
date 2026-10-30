# 13 · Outputs with variants

Status: ready-for-agent
Type: task

## What

An agent's `output` schema becomes the `final` tool's parameters. Tool parameters must be an object at the top, and `toolDefinition` throws otherwise. So an output that's "one of several shapes" (a `z.discriminatedUnion`) or a list can't be declared today.

Wrap any non-object output as `{ result: <schema> }` when building `final`, and unwrap it after the zod check. The agent author never sees the wrapper.

## Why

Agents whose result can take several forms, chosen by the request, can then declare one output schema with variants, instead of being split into several agents.

## Done when

- An agent with a discriminated-union output runs to completion in a scripted test, and its output arrives unwrapped.
- The tool schema the model sees has an object at the top.

## Pointers

- `packages/core/src/tools.ts` (`toolDefinition`), `packages/core/src/loop.ts` (`parseFinal`, `final`), `packages/sdk/src/agent.ts` (`output`)
