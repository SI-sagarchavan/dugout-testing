-- Runs, their permanent event record, and long-term memory. Every table is tenant-scoped by
-- row-level security keyed on the `app.tenant_id` setting; the app connects as `dugout_app`, which
-- is not a superuser and not the table owner, so the policies always apply.

create extension if not exists vector;

do $$
begin
  if not exists (select from pg_roles where rolname = 'dugout_app') then
    create role dugout_app login password 'dugout_app';
  end if;
end
$$;

create table runs (
  id text primary key,
  tenant_id text not null,
  agent_id text not null,
  status text not null check (status in ('running', 'completed', 'rejected', 'failed')),
  input jsonb not null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Token events are live-only (Valkey); everything else is kept here.
create table run_events (
  run_id text not null references runs (id) on delete cascade,
  seq integer not null,
  tenant_id text not null,
  type text not null,
  data jsonb not null,
  at timestamptz not null,
  primary key (run_id, seq)
);

create table memory_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  agent_id text not null,
  kind text not null check (kind in ('episodic', 'semantic')),
  -- Semantic facts are versioned by key; episodes have no key.
  key text,
  version integer not null default 1,
  content text not null,
  embedding vector(1024) not null,
  tsv tsvector generated always as (to_tsvector('english', content)) stored,
  status text not null check (status in ('proposed', 'active', 'retired')),
  confidence real not null check (confidence between 0 and 1),
  source_run_id text,
  reviewed_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  check (kind = 'episodic' or key is not null)
);

create unique index memory_items_one_active_fact
  on memory_items (tenant_id, agent_id, key)
  where kind = 'semantic' and status = 'active';
create index memory_items_scope on memory_items (tenant_id, agent_id, kind, status);
create index memory_items_tsv on memory_items using gin (tsv);
create index memory_items_embedding on memory_items using hnsw (embedding vector_cosine_ops);

alter table runs enable row level security;
alter table run_events enable row level security;
alter table memory_items enable row level security;

create policy tenant_isolation on runs
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on run_events
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on memory_items
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update, delete on runs, run_events, memory_items to dugout_app;
