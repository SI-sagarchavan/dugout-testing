# Cast MCP: what a generic agent client needs

For the Cast team. Status: asks 1–5 and 7 shipped in cast-mcp 0.5.1 (2026-11-04); the 0.5.1 `version` bug below was fixed by wnm-fanxp-backend#849, deployed the same day; ask 6 and the smaller asks at the end are open.

## Fixed (wnm-fanxp-backend#849): cast-mcp 0.5.1 on dev failed its own output schema

Probed 2026-11-04 on dev (`cast` 0.5.1, protocol 2025-11-25) with dugout's client:

| Tool                                                                                                               | Result                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cast_list_hooks`                                                                                                  | `MCP error -32602: Output validation error: Invalid structured content for tool cast_list_hooks: Expected number, received string at hooks[0].version` |
| `cast_describe_hook`                                                                                               | the same, `at version`, for every hook tried (`dugout_hundred_fixture_cards`, `fanxp-seed-hook-cricket-schedule`)                                      |
| `cast_publish_hook`                                                                                                | not tried (it writes); its schema has the same `version: number`                                                                                       |
| `cast_list_apis`, `cast_describe_api`, `cast_lint_hook`, `cast_eval_jsonata`, `cast_run_hook`, `cast_fetch_sample` | fine, structured and whole                                                                                                                             |

The server's SDK checks `structuredContent` against the `outputSchema` and answers an error in its place, so the text is lost too: these tools fail for every client, people's included, not only for code that reads the data.

**Cause:** `wnm-fanxp-backend` `src/models/cast/index.ts:91` maps `version: row.version`, and Postgres returns the bigint column as a string. The same file already does `Number(row.hook_version)` at line 632 for the same reason.

**Fix:** `version: Number(row.version)` there (or `z.coerce.number()` on cast-mcp's `version` fields, which would also cover any other caller). A test that runs each read tool's structured answer through its own `outputSchema`, with a row as Postgres gives it, would have caught it.

dugout's agents are moving to a generic MCP client. The agent declares a capability (`hook-authoring`), and the runtime connects, reads `initialize`, `tools/list` and resources, and runs the tools the registry allows. Everything Cast-specific is meant to live in the Cast MCP. Today it does not: dugout parses Cast's text answers and holds Cast's workflow rules in its own code. This lists what the server would need for that code to go.

Probed against `https://dev-fanxp.sportz.io/fanxp/api/v1/cast/mcp`, server `cast` 0.4.0, protocol `2025-06-18`, with read-only calls. The run and build findings come from live agent runs the same day (`dugout_hundred_fixture_cards` was built by an agent on dev).

## What already works

- **`instructions`** on `initialize` (2,930 chars): the build workflow, drafts versus publish, the run-context shape. That is the right place for it, and a generic client will put it in front of the model.
- **27 tools, each with a title and annotations**, and the hints are accurate: `cast_run_hook` is `readOnlyHint: false`; deletes and connector upserts are `destructiveHint: true`.
- **Errors are `isError: true`**, with a reason a model can act on (`compile error: Expected ":" …`, `404`).
- **Gates:** writes lint before they save, `cast_create_hook` never overwrites, edits save as drafts, and a draft can be run.
- **OAuth discovery** is standard (protected-resource and authorization-server metadata, PKCE, dynamic registration).

## Asks, in order

### 1. Structured results (blocking)

Every tool answers only `content: [{ type: "text" }]`. No tool has an `outputSchema`, and no result has `structuredContent`. So a client that needs the data has to parse prose. dugout does this today:

| Needed                    | Parsed from                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| Did the run succeed       | `status=ok` in the first line of `cast_run_hook`                   |
| The hook's output         | the JSON under the `OUTPUT  (transform applied)` heading           |
| Each step's response      | the JSON under `reads as steps.n1.response:`, ended by indentation |
| Whether a hook only reads | `GET` / `POST` lines in `cast_describe_hook`                       |
| Which hooks exist         | the indented blocks of `cast_list_hooks`                           |
| A transform's result      | the JSON after `Evaluated cleanly. Result:`                        |

**Ask:** an `outputSchema` and `structuredContent` on the read tools, keeping the text for people (the spec allows both). Priority: `cast_run_hook` (status, error, each step's request, status and response, the output), `cast_eval_jsonata` (result or compile/eval error), `cast_list_hooks`, `cast_describe_hook` (inputs, steps with kind, api id and method, the output), `cast_describe_api`, `cast_lint_hook`.

### 2. The public flow id (blocking for render time)

`/cast/api/flow/<id>` takes the hook's `hook_uuid`. No tool returns it: not list, describe or publish. The backend's hook mapper (`mapHookRow`) drops the column, and the UI does not show it. It is a random UUID, so it cannot be derived. The only way to it today is a page schema for a template bound to the hook.

**Ask:** `workflowId` (the `hook_uuid`) in `cast_list_hooks`, `cast_describe_hook` and the `cast_publish_hook` result. Without it, a tree built by an agent can bind a hook's sample but cannot fetch the hook live.

### 3. Real data without a hook, and whole data with one

- Many connectors have no stored sample (`fanxp-seed-api-cricket-schedule` has none), and `cast_describe_api` gives a shape summary past `maxChars`. The only way to see a connector's real answer is to create a draft hook, add a step and run it. That means three writes just to read.
- `cast_run_hook` gives the whole data only when `maxCharsPerStep` is raised far enough (dugout passes 400,000). It then prints every step whole, the raw 80 KB response included, to return a 6 KB output.

**Ask:** `cast_fetch_sample(apiId, input)`, read-only and refused for a connector that is not `GET`, returning the response as `structuredContent`. On `cast_run_hook`, return the output whole in `structuredContent`, with step responses whole only when asked (`includeSteps`).

### 4. `cast_validate` (new)

An agent checks its own work against the target the design sets: the fields a frame binds, as a JSON Schema.

**Ask:** `cast_validate({ hookId, input } | { output }, schema)` → `{ ok, differences: [{ path, expected, got }] }`, read-only. Free when given an `output`.

### 5. Resources

`resources/list` and `prompts/list` both answer `-32601 Method not found`.

**Ask:** resources for what a model needs to read once and does not need in every prompt:
- the output contract: the `{ data: { "<page>": [items] }, meta: { pagination } }` envelope, and that `"1"` is a page number;
- a JSONata cheat sheet for the run context `{ input, steps.nX.response }`;
- two or three example hooks: a listing, a detail, one with a dependent call.

### 6. A credential for agents, with scopes

Today there is one scope (`cast:mcp`) and two grant types (`authorization_code`, `refresh_token`). Every call runs as the person who logged in. Refresh tokens rotate, and a reused one revokes the grant, so dugout must run one process per token file and one refresh at a time. The live-run budget (25 an hour) is per person, and agents share it with the person.

**Ask:**
- `client_credentials` for a service client, per tenant (site);
- scopes narrower than `cast:mcp`: `cast:read`, `cast:run`, and writes limited to hooks in a namespace (`cast:write:dugout_*`), so the server enforces "an agent writes only its own hooks" (dugout enforces it in its own code today);
- a run budget of its own for the service client.

### 7. Smaller

- **Search:** `cast_list_hooks` and `cast_list_apis` match a name substring only. A `query` over name, description, path and input names would let an agent find a connector by what it gives ("live score").
- **Filter by id prefix** on `cast_list_hooks` (`idPrefix: "dugout_"`). dugout filters the text answer today.
- **`listChanged: true`** with a stateless server: no client can receive the notification. Fine if documented; dugout will pin the tool list by hash and review changes.

## What dugout does meanwhile

dugout keeps its Cast code in one adapter in `packages/mcp`, not in agents. With 0.5.1 the text parsing (ask 1) and the list filter (ask 7, now `idPrefix`, set by the registry) are gone, and the agents read the resources (ask 5) and use `cast_fetch_sample` and `cast_validate` (asks 3, 4). What is left:

- **Run safety:** dugout runs a hook only when `cast_describe_hook` says `readOnly`. `cast_run_hook` could refuse such a hook itself on request (`readOnly: true` argument), as `cast_validate` already does.
- **A failed run answered as a success:** `cast_run_hook` answers a run with `status: "error"` without `isError`, so a client that does not read the data takes it for a result. Setting `isError` on it (keeping the structured answer) would let this go.
- **Ask 6** (a service credential and scoped writes) is open: dugout still runs one process per token file, and enforces "writes only `dugout_` hooks" in its own registry.

## New (2026-11-04): the output contract and examples assume one envelope

`cast://contract/output` says "every listing hook answers the same envelope" (`{ data: { "<page>": [items] }, meta: { pagination } }`), and two of the three examples in `cast://examples/hooks` wrap their output in it. That is the template flow's convention. Pages bound by the new DSL read any shape a hook answers (grouped by day, a list in a list, one object, several lists), so the envelope is one option, not the contract.

**Ask:** say so in both documents (the envelope is what the template flow expects; a hook for another page may answer any JSON), and show one example with a grouped answer. Until then dugout does not grant `cast://contract/output` to its agents, and its builder skill says the examples' envelope is optional. The server `instructions` still name the contract in a sentence ("The output contract, a JSONata cheat sheet and example hooks are resources"), which an agent without that grant reads as a dangling reference.
