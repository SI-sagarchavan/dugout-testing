# 07 · Shared memory for every tenant and each sport

Status: resolved
Type: task
Blocked by: 01, 02

## What

Knowledge many tenants hold is shared, and each tenant's own variation stays its own (ADR 0014).

- Three layers: global, sport (the tenant's `sport` in `config/tenants.json`), tenant. A run reads all three; the more specific wins.
- Shared facts and lessons, never run records.
- `pnpm memory:promote` proposes what two or more tenants hold, rewritten to name none of them; `pnpm memory:review --shared` approves.
- Row-level security: runs read approved shared rows and write none.

## Done when

- A run reads approved shared memory of its sport and global, and none of another sport's or any proposal.
- The app role can neither add nor change a shared row.
- Promotion proposes for a sport when the tenants share one and globally when they span sports, skips rewrites that name a tenant, and never proposes the same items twice.
- Live: the promotion model shares instructions and refuses clubs' own facts and differing values.
