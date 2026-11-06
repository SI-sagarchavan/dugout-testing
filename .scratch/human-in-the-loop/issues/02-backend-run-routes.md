# 02. Backend run routes and the live stream

Status: needs-triage
Blocked by: 01

Repo: `wnm-fanxp-backend-surface-auth`. The admin app's surface-studio transport (`entities/surface/api/http-transport.ts`) is already written against these routes; they do not exist yet. Today the backend only inserts the queued run (`src/models/harness-run/index.ts`).

## What

- `GET /surface/runs`: the client's runs from the harness DB (`withTenant` on the `client` header), newest first, with their Handoff.
- `GET /surface/runs/:id`: one run as the app's `RunDetail` (steps, child runs, approvals, open questions), built from `run_events`.
- `POST /surface/runs/:id/decisions`: approve, reject, request a change, or answer questions. Writes the decision the way dugout's `queue.decide` does: `update runs set status='queued', decision=… where status='waiting' and checkpoint.waiting.callId = …`.
- `POST /surface/runs/:id/cancel`.
- `GET /surface/runs/:id/events`: Server-Sent Events from Valkey `run:<id>:events` after `Last-Event-ID` (or `?after=`), falling back to `run_events` once the stream has expired. Its own Valkey connection (the shared client times out commands after 2 s). Heartbeats. Same wire format as dugout's dev route (`apps/surface-studio/server/runs.ts`).
- Auth: admin JWT plus the `client` header and client access (`validateClientAccess`). The app reads the stream with fetch, not `EventSource`, so headers work.
- CloudFront compresses `/fanxp*`: the events route needs its own behaviour with compression off before it ships.
