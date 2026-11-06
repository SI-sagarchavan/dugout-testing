-- The section library across tenants (`.scratch/section-library/spec.md`, tickets 13–15).
-- A section is the owner's. Every other tenant reads it once it has reached a preview (a frame
-- built from it was published) and its owner shares, which every tenant does unless it says not
-- to. What another tenant is shown of it is its skeleton: boxes from the IR, no content, drawn in
-- the viewer's colours. Its picture, layer name and sources stay the owner's; the store hands
-- them only to the owner.
alter table library_sections
  add column skeleton jsonb,
  add column previewed_at timestamptz,
  -- every preview built from it: { runId, agentId, handoffId, previewUrl, at }
  add column previews jsonb not null default '[]';

create index library_sections_previewed on library_sections (previewed_at)
  where previewed_at is not null;

-- A tenant's say over its own sections. No row: it shares.
create table library_tenants (
  tenant_id text primary key,
  shares boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table library_tenants enable row level security;
-- whether a tenant shares is read by every tenant's search; only the tenant itself changes it
create policy library_tenants_read on library_tenants for select using (true);
create policy library_tenants_insert on library_tenants for insert
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy library_tenants_update on library_tenants for update
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on library_tenants to dugout_app;

-- one policy per command: a tenant reads its own sections and others' shared ones, and writes
-- only its own
drop policy tenant_isolation on library_sections;
create policy library_read on library_sections for select using (
  tenant_id = current_setting('app.tenant_id', true)
  or (
    previewed_at is not null
    and not exists (
      select 1 from library_tenants t
      where t.tenant_id = library_sections.tenant_id and not t.shares
    )
  )
);
create policy library_insert on library_sections for insert
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy library_update on library_sections for update
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy library_delete on library_sections for delete
  using (tenant_id = current_setting('app.tenant_id', true));
