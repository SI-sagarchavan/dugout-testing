-- Runs' working memory, so a run outlives the process that started it (ADR 0006): its transcript,
-- append-only, and one checkpoint per run. A lease says which process is running a run; a run whose
-- lease ran out is picked up again from its checkpoint.

alter table runs drop constraint runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('running', 'waiting', 'completed', 'rejected', 'failed'));
-- Kept while waiting too, so the process that saved the wait can carry on if its approver answers.
alter table runs add column lease_owner text;
-- Null while waiting: only running runs can be picked up after a crash.
alter table runs add column lease_until timestamptz;
create index runs_expired_leases on runs (lease_until) where status = 'running';

create table run_messages (
  run_id text not null references runs (id) on delete cascade,
  idx integer not null,
  tenant_id text not null,
  message jsonb not null,
  primary key (run_id, idx)
);

create table run_checkpoints (
  run_id text primary key references runs (id) on delete cascade,
  tenant_id text not null,
  checkpoint jsonb not null,
  updated_at timestamptz not null default now()
);

alter table run_messages enable row level security;
alter table run_checkpoints enable row level security;

create policy tenant_isolation on run_messages
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on run_checkpoints
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update, delete on run_messages, run_checkpoints to dugout_app;

-- Finding runs to pick up looks across tenants, which row-level security rightly stops the app role
-- from doing. This function does only that: it claims up to `max_runs` running runs whose lease ran
-- out, gives them to `claimer` for `lease_for`, and returns their ids and tenants. Everything after
-- that goes through the tenant-scoped connection as usual.
create function claim_expired_runs(claimer text, lease_for interval, max_runs integer)
returns table (run_id text, tenant_id text)
language sql
security definer
set search_path = public
as $$
  update runs r
  set lease_owner = claimer, lease_until = now() + lease_for, updated_at = now()
  where r.id in (
    select id from runs
    where status = 'running' and lease_until < now()
    order by lease_until
    limit max_runs
    for update skip locked
  )
  returning r.id, r.tenant_id;
$$;

revoke all on function claim_expired_runs(text, interval, integer) from public;
grant execute on function claim_expired_runs(text, interval, integer) to dugout_app;
