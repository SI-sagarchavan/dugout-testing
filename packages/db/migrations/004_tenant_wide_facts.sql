-- A fact can hold for the whole tenant (ADR 0013): its agent_id is null. Episodes still belong to
-- one agent. One active fact per tenant, scope and key, with null counted as one scope.
alter table memory_items alter column agent_id drop not null;
alter table memory_items add constraint memory_items_episode_agent
  check (kind <> 'episodic' or agent_id is not null);

drop index memory_items_one_active_fact;
create unique index memory_items_one_active_fact
  on memory_items (tenant_id, agent_id, key) nulls not distinct
  where kind = 'semantic' and status = 'active';
