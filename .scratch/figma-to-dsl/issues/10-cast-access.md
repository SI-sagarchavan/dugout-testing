# 10 · Cast access for the binding step

Status: ready-for-human
Type: decision
Later: after the repair agent works

## What

The binding step decides which nodes take which API data. Data comes from Cast workflows. Decide how the agent reaches Cast:

- the Cast MCP server, through MCP tools in the harness (harness 10);
- or typed tools over Cast's HTTP API, like the rest of the harness.

Creating a Cast workflow is a write and always needs a person's yes. Finding and reading workflows is a read. Bindings are checked by rendering with a sample payload, using `@fanos/dsl`'s binding refs.

## Why

Binding is the step after repair. Its access route, and the approval it needs, should be settled before the binding agent is designed.

## Done when

- The route is chosen and written down, with the approval rule for creating workflows.
- One proof: read a workflow's fields for a tenant and render one bound node with sample data.

## Pointers

- `trial/packages/dsl/src/{binding,cast,bind,suggest}.ts`
- `trial/apps/surface-studio/server/bindings.ts` (refs, suggestions and a render against a sample payload)
- `wnm-fanxp-backend` routes `cast/` (Cast MCP auth)
