# 01 · How dugout reaches FanOS code

Status: ready-for-human
Type: decision

## What

The agent's code steps and tools need FanOS code that lives in the `trial` repo:

- `@fanos/compile`: Figma IR → DSL
- `@fanos/dsl`: primitives, validator, patch ops, subtree signatures, binding refs
- `@fanos/renderer`: render and diff harness
- `@fanos/conform` and the fidelity gate

Decide how dugout gets at it. Three options:

1. **Call the FanOS control plane over HTTP.** It already has compile, preview and the gate. Dugout stays independent, but every step is a network call, and missing endpoints have to be added in `trial`.
2. **Install the `@fanos/*` packages.** The backend already installs `@fanos/cast` from CodeArtifact. This is installing FanOS packages, not publishing dugout's, which stays ruled out. Needs the packages built and released from `trial`.
3. **Move the packages into this monorepo.** One repo, one CI, no versioning between them, but it changes who owns the code.

## Why

Tickets 04, 05, 06 and 07 can't start without it. The choice also decides whether render and diff run in the worker or behind a service (ticket 05).

## Done when

- The option is chosen and written down: an ADR, or a line in `spec.md` under "Decided".
- A smallest proof works from dugout: compile one Figma export to DSL and validate it.

## Pointers

- `trial/packages/{compile,dsl,renderer,conform}`, `trial/apps/api/src/modules/fidelity`
- Memory note: dugout packages are never published to CodeArtifact.
