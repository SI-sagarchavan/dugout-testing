-- One stream per invocation (ADR 0025): a child run's events are written to the run a host
-- started, under its id and in its `seq`, and `child` says which child they came from
-- ({ runId, agentId, parentRunId, callId }). Null for the run's own events. A child's ending
-- updates the child's `runs` row, never the run's.
alter table run_events add column child jsonb;
