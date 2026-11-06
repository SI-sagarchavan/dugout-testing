# 05 · A section's surfaces are its own

Status: needs-triage
Type: task
Blocked by: none

## What

frame-match run `ec5e237e` (tenant `sb`, Handoff `39778d36`) published tree `31110167` with surface set
`f82cafe2`, which a `demo-cricket` `card-match` run wrote on 1 Nov for another export. It draws because
the three surface names this tree uses happen to be in it. Find why frame-match linked a set it did not
write (likely "the project's newest `surface_set`", as `apps/web/lib/control-plane.ts` `latest()` does for
a bare tree) and make every run publish and link its own.

Then decide whether a section keeps a surface set at all, or the compiler writes each surface's layers,
radius and borders into the node it styles (in tenant token refs), so a section is a tree, a plan and data.
The renderer handles both: `prepareSection` takes `surfaces`, and node-level fills already resolve.

## Done when

- No run links an artifact written for another tenant (a test over frame-match's publish).
- The decision on surface sets vs nodes is recorded in `spec.md`.
