-- A run can be cancelled (harness issue 08): queued, running or waiting. A queued or waiting run is
-- cancelled at once; a running one stops at its worker's next save, which this status fences off,
-- the way it fences off a worker that lost its lease. claim_runs never claims a cancelled run.
alter table runs drop constraint runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('queued', 'running', 'waiting', 'completed', 'rejected', 'failed', 'cancelled'));
alter table runs add column cancelled_by text;
alter table runs add column cancel_reason text;
