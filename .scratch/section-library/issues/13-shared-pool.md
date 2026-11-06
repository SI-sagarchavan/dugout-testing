# 13 · The shared pool across tenants

Status: resolved
Type: task
Blocked by: 02

## What

Every tenant reads the previewed sections of every tenant that shares; each still writes only its own.

- Migration 014: `library_sections` gets `previewed_at` and `previews`; `library_tenants (tenant_id, shares)`, no row meaning it shares; row-level security per command (read: own, or previewed and the owner shares; write: own).
- `SectionLibrary.search({ …, scope: "shared" })`; `get` reads a shared section of another tenant.
- Another tenant's section comes without which tenant it is, its picture key, layer name, sources and previews (`own: false`).
- `sharing`, `setSharing`; `pnpm agent library share --tenant <t> [--on | --off]`; `pnpm agent library search --shared`.

## Done when

- A section is in no other tenant's search until it is previewed, and in every other's after.
- Turning sharing off takes the tenant's sections out of others' searches; on puts them back.
- No tenant can change another's section or another's sharing, through the store or a raw query.

## Comments

2026-11-06: done (`packages/db/migrations/014_library_sharing.sql`, `packages/library/src/store.ts`, `tests/sharing.test.ts`). Tried live: `sb`'s previewed video section found from `demo-cricket` with `--shared`, as another club's.
