# 11 · Composer eval

Status: ready-for-agent
Type: task
Blocked by: 10

## What

`pnpm eval section-composer`: cases of a description, sometimes with an inspiration image, and what the result must have.

- Code graders: the tree validates, uses only the tenant's tokens, renders without errors, has the structure the case names (e.g. a carousel of at least 3 cards with two images each).
- The model judge scores the render against the description and image (reports, like the other suites; the code graders gate).
- Cases where the library has a close section and cases where it has none.

## Done when

- At least 15 cases, the 90% gate on code graders, and the first numbers recorded in `spec.md`.
