-- Memory belongs to the tenant (ADR 0013): every agent of the tenant reads all of it. agent_id now
-- records which agent's run produced an item, not who may read it, so one fact per tenant and key
-- is active. Where several agents had one, the tenant-wide fact is kept, else the newest.
with ranked as (
  select id, row_number() over (
    partition by tenant_id, key order by (agent_id is null) desc, created_at desc
  ) as r
  from memory_items
  where kind = 'semantic' and status = 'active'
)
update memory_items set status = 'retired' where id in (select id from ranked where r > 1);

drop index memory_items_one_active_fact;
create unique index memory_items_one_active_fact
  on memory_items (tenant_id, key)
  where kind = 'semantic' and status = 'active';
