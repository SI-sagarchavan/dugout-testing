# 10 · Tools from MCP servers

Status: needs-triage
Type: design + task

## What

PLAN.md names MCP as the tool contract, but the harness has no MCP client. Agents can only use tools written in this repo. Add a way for an agent to use tools from an MCP server, such as Cast's, without giving up the rules:

- **Allow-listed tools only.** An agent's spec lists which MCP tools it may call, and each one is checked against its JSON Schema before the call, like our zod-typed tools.
- **Effects declared per tool:** read or write. Writes go behind an approval. For Cast, creating a workflow always needs a person's yes.
- **Tenant and credentials from the run.** The model never passes them. Server credentials come from config or secrets.
- **Timeouts and retries** through the existing tool pipeline. Results go through the redactor and the output store like any tool result.

To settle: a generic MCP client in the harness, or typed tools written over each service's HTTP API. The second is safer and simpler for one or two services.

## Why

Complex agents need FanOS services (Cast now, more later). Writing a typed wrapper for every tool of every service doesn't scale, but generic access mustn't weaken typed tools, approvals or tenant rules.

## Done when

- The choice is recorded in an ADR.
- One agent calls one read tool from an MCP server (or its typed equivalent) in a test.
- A write tool waits for approval.

## Pointers

- `docs/PLAN.md` (stack line: "MCP as tool contract"), `packages/core/src/tools.ts` (pipeline: registry, spec, policy, approval)
- Cast MCP auth in `wnm-fanxp-backend/src/routes/cast/`

## Comments

- 2026-11-02: planned in `.scratch/harness-orchestration/issues/03-mcp-manifests.md`: servers configured by a manifest plus a pinned lock of their schemas, superseding the "no generic passthrough" line of ADR 0022.
