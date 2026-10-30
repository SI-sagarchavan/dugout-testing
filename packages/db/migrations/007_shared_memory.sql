-- Shared memory (ADR 0014): facts and lessons every tenant reads ('global') or every tenant of one
-- sport reads ('sport:<sport>'). They have no tenant. The promotion job proposes them and a person
-- approves them, both as the admin role; the app role can read approved ones and write none.
alter table memory_items alter column tenant_id drop not null;
alter table memory_items add column shared_scope text
  check (shared_scope ~ '^(global|sport:[a-z0-9-]+)$');
alter table memory_items add constraint memory_items_owner
  check ((tenant_id is null) = (shared_scope is not null));
-- the tenant items a shared one was promoted from
alter table memory_items add column sources uuid[] not null default '{}';

create unique index memory_items_one_active_shared_fact
  on memory_items (shared_scope, key)
  where tenant_id is null and kind = 'semantic' and status = 'active';
create index memory_items_shared on memory_items (shared_scope, kind, status)
  where tenant_id is null;

-- one policy per command: a run reads its tenant's rows and approved shared rows, and writes only
-- its tenant's rows
drop policy tenant_isolation on memory_items;
create policy memory_read on memory_items for select
  using (
    tenant_id = current_setting('app.tenant_id', true)
    or (tenant_id is null and status = 'active')
  );
create policy memory_insert on memory_items for insert
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy memory_update on memory_items for update
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy memory_delete on memory_items for delete
  using (tenant_id = current_setting('app.tenant_id', true));
