-- A run cancelled while a worker held it is ended by that worker at its next save (008). If the
-- worker dies first, nothing would write its `run.cancelled`, and anyone following it would wait for
-- ever. So once its lease runs out, claim_runs hands it to another worker, still cancelled, only so
-- that worker writes `run.cancelled` and lets it go. It is never run again.
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
      and (status = 'queued'
        or (status = 'running' and lease_until < now())
        or (status = 'cancelled' and lease_owner is not null and lease_until < now()))
    order by updated_at
    limit max_runs
    for update skip locked
  )
  returning r.id, r.tenant_id, r.attempts;
$$;
