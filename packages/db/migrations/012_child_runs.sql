-- A child run (ADR 0025) is started by a tool call of another run and runs inside that call. It
-- has a row of its own, so its events and save points have somewhere to go, and names the call
-- that started it. It is never claimed on its own: when its parent is resumed, the same call
-- starts it again and it carries on from its last save. A fork names its parent too, with the
-- save point it started from (`parent_version`), and is queued like any other run.
alter table runs add column parent_call_id text;

create or replace function claim_runs(claimer text, lease_for interval, max_runs integer, agent_ids text[])
returns table (run_id text, tenant_id text, attempts integer)
language sql
security definer
set search_path = public
as $$
  update runs r
  set status = case when r.status = 'cancelled' then 'cancelled' else 'running' end,
      lease_owner = claimer, lease_until = now() + lease_for,
      attempts = r.attempts + 1, updated_at = now()
  where r.id in (
    select id from runs
    where agent_id = any(agent_ids)
      and parent_call_id is null
      and (status = 'queued'
        or (status = 'running' and lease_until < now())
        or (status = 'cancelled' and lease_owner is not null and lease_until < now()))
    order by updated_at
    limit max_runs
    for update skip locked
  )
  returning r.id, r.tenant_id, r.attempts;
$$;
