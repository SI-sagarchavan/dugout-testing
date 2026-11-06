# 03. The admin app's queue on live runs, with questions

Status: needs-triage
Blocked by: 01, 02

Repo: `wnm-fanxp-frontend-surface-auth`, `apps/surface-studio` (mounted in `apps/fanxp` at `/#/<client>/surface-studio`).

## What

- HTTP transport for runs (it is mock today: `VITE_SURFACE_STUDIO_API` unset).
- The run inspector follows the run's events live: a fetch stream reader like the host's `shared/api/ai/aiSse.ts` and `runAiJob.ts` (copied, the surface app cannot import host modules), resuming with `Last-Event-ID`.
- A question card in Needs you and in the inspector: one field per question by kind (choice, multi, text, confirm, number), the agent's proposal preselected, `why` shown with each, one Submit for all. A later round shows as a new card.
- `shared-validation/surface.schema.ts`: mirror `Question` and `Answers` from `@dugout/contracts`; `DecisionRequest` takes `answers`.
- The dev proxy for `/fanxp` needs `x-accel-buffering: no` and `cache-control: no-transform` for the events route, as `/fanos-surface` has.
