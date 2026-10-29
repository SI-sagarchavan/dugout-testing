-- Workers run agents; a host (the CLI here, wnm-fanxp-backend in production) only queues runs and
-- approval decisions (ADR 0009). A queued run (new, or with an approval just decided) waits for a
-- worker to claim it.

alter table runs drop constraint runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('queued', 'running', 'waiting', 'completed', 'rejected', 'failed'));
-- The decision a queued run resumes with. Cleared by the first save after the worker applies it, so
-- a worker that dies before then leaves it for the next one.
alter table runs add column decision jsonb;
-- Claims since the run was queued. A run that keeps crashing is given up on instead of retried forever.
alter table runs add column attempts integer not null default 0;
-- Why the last invocation crashed, for the message when the run is given up on.
alter table runs add column last_error text;
create index runs_queued on runs (updated_at) where status = 'queued';

-- Replaced by claim_runs, which also claims queued runs.
drop function claim_expired_runs(text, interval, integer);

-- Finding runs to claim looks across tenants, which row-level security rightly stops the app role
-- from doing. This function does only that: it claims up to `max_runs` runs of the given agents that
-- are queued or whose lease ran out, gives them to `claimer` for `lease_for`, and returns their ids,
-- tenants and attempts. Everything after that goes through the tenant-scoped connection as usual.
create function claim_runs(claimer text, lease_for interval, max_runs integer, agent_ids text[])
returns table (run_id text, tenant_id text, attempts integer)
language sql
security definer
set search_path = public
as $$
  update runs r
  set status = 'running', lease_owner = claimer, lease_until = now() + lease_for,
      attempts = r.attempts + 1, updated_at = now()
  where r.id in (
    select id from runs
    where agent_id = any(agent_ids)
      and (status = 'queued' or (status = 'running' and lease_until < now()))
    order by updated_at
    limit max_runs
    for update skip locked
  )
  returning r.id, r.tenant_id, r.attempts;
$$;

revoke all on function claim_runs(text, interval, integer, text[]) from public;
grant execute on function claim_runs(text, interval, integer, text[]) to dugout_app;
