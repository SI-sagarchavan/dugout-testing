# 11 · Agents' input and output schemas for hosts

Status: resolved
Type: task

## What

A host (the plugin, Studio, wnm-fanxp-backend) should check a request's input before queueing a run, and know the shape of the result, without importing our code. Nothing is published to CodeArtifact.

So: a command (`pnpm schemas`, for example) writes each agent's input schema and, where it has one, output schema as JSON Schema files, using `z.toJSONSchema`. Hosts copy them, or fetch them from wherever they get the ADR 0009 contract. CI fails if the committed files are out of date.

## Why

Today only the CLI checks input before queueing. The worker refuses bad input at once, but a host can then only report the failure after the run has started.

## Done when

- The command writes JSON Schema for every agent's input and output, and CI checks the files are current.
- ADR 0009's host contract points at them.

## Pointers

- `packages/sdk/src/agent.ts` (`input`, `output`), `packages/sdk/src/registry.ts` (`agentIds`, `loadAgent`)
- `packages/core/src/tools.ts` (already uses `z.toJSONSchema` for tool definitions)
