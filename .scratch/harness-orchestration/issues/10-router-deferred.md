# 10 · A router (intent classifier) in the host layer (deferred)

Status: wontfix

Not building it (2026-11-02). Reopen when a host has a free-text entry.
Type: design + task
Blocked by: a host with a free-text entry

## What

`route(text, caller, thread?)` returns a start (`{ agent, input, confidence }`), a continue
(`{ thread, runId }`), an answer about a finished run, a clarifying question, or a refusal. It lives
in the host, in front of `queue.start`, not in the loop. Spec: section I.

Built as a small agent (no tools, an output schema, a cheap model), so evals, tracing, cost and
events come free.

## Rules

- The classifier proposes and the host decides. The tenant and the caller's permissions come from the session.
- It picks only among agents this caller may run: the schema's agent list is built per call.
- The extracted input is untrusted and checked against the target agent's input schema.
- Low confidence asks. An agent that writes never starts on a guess.
- Deterministic where the trigger already names the agent (a Send, a button).
- Each decision is a `route.decided` event.

## Trigger to build

A host that takes free text (a chat box in Studio or Cast admin, a Slack command), or more than
about five agents, or threads (harness 15) so that follow-ups need routing.

## Done when

- A labelled set of requests with the expected route, as an eval with the 90% gate, including requests that must be refused or must ask.
- A request that tries to reach an agent the caller may not run is refused, whatever the text says.
- Tenant never comes from the classifier's output (test).
