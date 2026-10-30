-- Every save point of a run, not only its latest (harness 16), so a run can be looked at step by
-- step and forked from any save point. The transcript is append-only already: a save point's
-- transcript is the first `checkpoint.messages` of it, so only checkpoints are kept here.
create table run_checkpoint_history (
  run_id text not null references runs (id) on delete cascade,
  version integer not null,
  tenant_id text not null,
  checkpoint jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (run_id, version)
);
alter table run_checkpoint_history enable row level security;
create policy tenant_isolation on run_checkpoint_history
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, delete on run_checkpoint_history to dugout_app;

-- The latest save point's version. Runs saved before this keep 0 and have no history.
alter table run_checkpoints add column version integer not null default 0;

-- A fork names its parent and the save point it started from, and can run on another model.
alter table runs add column parent_run_id text references runs (id) on delete set null;
alter table runs add column parent_version integer;
alter table runs add column model text;

-- Save points older than `keep` go, except each run's latest, which stays as long as the run. It
-- looks across tenants, like claim_runs, so it is a function the app role may only call.
create function prune_run_history(keep interval)
returns integer
language sql
security definer
set search_path = public
as $$
  with pruned as (
    delete from run_checkpoint_history h
    using run_checkpoints c
    where c.run_id = h.run_id and h.version < c.version and h.saved_at < now() - keep
    returning 1
  )
  select count(*)::integer from pruned;
$$;

revoke all on function prune_run_history(interval) from public;
grant execute on function prune_run_history(interval) to dugout_app;
