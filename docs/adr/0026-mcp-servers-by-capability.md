# 0026 — MCP servers from a registry, resolved by capability

Date: 2026-11-04 · Status: accepted · Supersedes ADR 0022's hand-written tools and its "no generic passthrough" line, keeping the rest · Resolves harness-orchestration ticket 03

## Context

Each Cast tool was written by hand in `packages/mcp` (ADR 0022), and agents named them (`spec.tools: ["cast.listHooks", …]`). Cast's guidance lived in our skills and in tool code that read Cast's text answers. Adding a server, or a tool on one, meant code in this repo, and an agent was tied to a server by name. We want the agent to say what it needs and the platform to supply it, and Cast's knowledge to travel with Cast's MCP server.

## Decision

**Agents ask for capabilities.** A spec lists `requires` and `optional` capabilities (`hooks.choose`, `hooks.author`), never servers. When the agent is created, the registry resolves them into tools, which join `spec.tools` like any other tool. A required capability no server has stops the load. An optional one whose server is not configured here is left out.

**The registry is `config/mcp/<server>.json`, written by a person.** It holds the server's URL and auth (`none`, `bearer` from the environment, or `oauth-per-tenant`), extra headers, and each tool agents may reach:

- **effect** is required, so nothing is a read by default. A tool the server does not mark read-only may be a read only with a written `reason`.
- timeout, retries, `approval: "always"` for a read that still needs a person, and an adapter `guard` run before each call.
- **Capabilities** name the tools they grant, each with argument patterns (`hookId` must match `^dugout_`) and arguments the harness sets itself (`idPrefix: "dugout_"`), which the model's schema leaves out and every call carries. Grants from several capabilities add up: a call any of them allows is allowed, and an argument only some of them set is the model's. A capability can also grant the server's resources, by URI.

A server tool the entry does not list is unreachable.

**The lock is `config/mcp/<server>.lock.json`, written by `pnpm agent mcp sync <server> --tenant <t>`.** It holds the server's `instructions`, each listed tool's title, description, input and output schemas and annotations, and each granted resource's text, all hashed. Agents get their tools' descriptions and schemas, and the server's guidance, from the lock, not the live server: what the model reads changes only through a reviewed diff. Before each call, the live `tools/list` (checked once per process every ten minutes) is compared with the lock. A tool that changed or went away is refused, naming the sync command. Sync fails on a tool the entry lists that the server lacks, a read the server says writes and the entry gives no reason for, or a schema the harness cannot take. It flags a read whose name says it changes something.

**The connection is the official MCP SDK** (`@modelcontextprotocol/sdk` 1.32.1, pinned exact): the streamable HTTP client, protocol negotiation, pagination, `instructions`. Credentials go in a `fetch` the transport sends every request through, per tenant. A per-tenant OAuth grant is refreshed one at a time per tenant, with each rotation saved before it is used (ADR 0022's rule, kept). The tenant comes from the run, never from input. Login (`pnpm agent mcp login <server>`) is standard OAuth discovery through the SDK: protected-resource metadata, then authorization-server metadata, dynamic registration and PKCE.

**Tools are typed from the lock.** The server's JSON Schema, with its local `$ref`s inlined, becomes the zod input (`z.fromJSONSchema`), so the pipeline runs unchanged: allow-list, schema, grant check, approval, timeout, retries, redaction, output store. Names are `<server>.<camelCase>` (`cast_list_hooks` → `cast.listHooks`). The server's guidance follows the agent's own instructions, with a line saying which server tool is which tool here.

**The model reads a result's text; code reads its `structuredContent`.** A server writes the text for a model, cut to fit; the structured data, checked against the tool's `outputSchema` by the SDK, is whole, and is what an adapter or a tool that binds data reads. The model gets the structured data only when there is no text.

**Resources are read on demand, from the lock.** The granted resources are listed after the server's guidance, and `<server>.readResource` returns one by URI. Like a tool's description, what the model reads changes only through the lock's diff, and no server is asked.

**Server-specific code is an adapter, and interim.** `packages/mcp/src/adapters/cast.ts` holds the Cast rules the server does not enforce: run a hook only when `cast_describe_hook` says it reads only, and treat a run Cast answers as a success with `status: "error"` as failed. It reads only `structuredContent`, never text. Each part maps to an ask filed with the Cast team (`.scratch/generic-mcp/cast-asks.md`) and goes when Cast ships it. Agents hold no Cast code.

**Bedrock limits are handled in the Bedrock client, for every tool.** A sub-schema that accepts any value gets every JSON type, since Bedrock refuses one with none. Tools stay strict only while, together, their optional parameters fit Bedrock's limit (24). A tool past it, or one with an open object, goes without strict; zod still checks every call on arrival.

## Consequences

- An agent is a prompt, its capabilities and its success check. `hook-finder` (`hooks.choose`) and `hook-maker` (`hooks.author`) have no tools of their own; frame-match has `hooks.read` as optional. The hand-written `cast.*` tools, `cast.sampleHook` and the `build.*` tools are gone.
- A new server is an entry, a sync and a review. Pointing an agent at it is a capability, without new code, unless the server needs an adapter.
- "dugout's own hooks" is a rule in the registry (an argument pattern, an id-prefix option), not in code. It is enforced before approval, so a refused call reaches neither a person nor the server. Cast's scoped credentials (ask 6) would move it to the server.
- The builder may write any `dugout_` hook, not only the one its run created (ADR 0025's tools enforced that). Its writes are still approved as one call, and it runs once per parent run.
- Hook output for code (`bind.source`) goes through the host and the adapter, not through the model.
- Live-tested 2026-11-04 on dev Cast 0.4.0: sync wrote the lock (17 tools, 10 left unreachable); the researcher found `dugout_hundred_fixture_cards` ($0.04); the builder built and published `dugout_hundred_standings` ($0.08).
- Cast 0.5.1 (same day) answered asks 1, 2, 3, 4, 5 and 7: structured results, `workflowId`, `cast_fetch_sample`, `cast_validate`, resources, `idPrefix` and `query`. The text parsing and the list filter went from the adapter, and bind publishes the hook's `workflowId` with its data. The lock was first written from cast-mcp 0.5.1's own code served locally, then matched dev's once deployed. On dev, `cast_list_hooks`, `cast_describe_hook` and `cast_publish_hook` then failed their own output schema (a hook's `version` came as a string), for every client, until wnm-fanxp-backend#849 converted it.
- Live-tested on dev Cast 0.5.1 after #849: the researcher chose `dugout_hundred_fixture_cards` in four steps ($0.035); bind with no data asked it as a child run, bound the hook's live output (16 bound, no problems, $0.084) and published it with its `workflowId`, and the public render edge (`/cast/api/flow/<workflowId>`) served the same three cards.
- Cold start, all on haiku (`--model haiku`, no `dugout_` hook on the site): bind asked the researcher (no hook, three connectors named), then the builder, which built, transformed, validated, linted and published `dugout_cricket_fixture_cards` from the Cricket Schedule connector in 19 tool calls, and bind bound its live output ($0.021 for the tree). This found a bug: a child whose write tools came from a capability (the builder, since the port) was not treated as writing, so its parent's call was not a write and the child's `createHook` was refused. A child's writes are now judged from the spec it serves, with a test.
- A hook's output has no required shape (2026-11-04). The page envelope (`data."1"`, `meta.pagination`) is the template flow's convention; the DSL binds whatever a hook answers (`fromCastFlow` keeps a custom payload's keys). So the registry grants dugout's agents Cast's JSONata guide and examples but not its output contract, the builder shapes the output from how the design repeats and groups, and `covers` are paths from the output's root. The contract document is an ask to the Cast team.
