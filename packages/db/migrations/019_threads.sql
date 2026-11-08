-- Threads: the top level a person sees. A thread holds invocations, the runs a host started, one
-- after the other; each invocation is one stream, its child runs' events in it (018). A Handoff
-- starts a thread, and every later run about that section joins it: the comments sent to the
-- agent, a re-bind, a retry. `subject` says what it is about ({ "handoffId": … }).
create table threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  subject jsonb not null default '{}',
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index threads_tenant_updated on threads (tenant_id, updated_at desc);
create index threads_subject on threads using gin (subject jsonb_path_ops);

alter table threads enable row level security;
create policy tenant_isolation on threads
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on threads to dugout_app;

alter table runs add column thread_id uuid references threads (id) on delete cascade;
create index runs_thread on runs (thread_id, created_at);

-- What a run's input says it is about: the Handoff or export it works on, or the preview.
create function thread_subject(input jsonb) returns jsonb language sql immutable as $$
  select coalesce(
    case
      when input ? 'handoffId' then jsonb_build_object('handoffId', input -> 'handoffId')
      when input ? 'exportId' then jsonb_build_object('exportId', input -> 'exportId')
      when input ? 'preview' then jsonb_build_object('preview', input -> 'preview')
    end,
    '{}'::jsonb)
$$;

-- The published tree a preview link shows: `/preview/<project>/<tree>?…`. Only the backfill below
-- reads it: a host names a run's thread, it is never guessed from a link.
create function preview_tree(url text) returns text language sql immutable as $$
  select substring(url from '/preview/[^/?#]+/([^/?#]+)')
$$;

-- Every run is in a thread, whoever inserts it (the worker's queue, a child's record, the
-- backend). The host names the thread a run joins (the backend: the section's, for the comments
-- sent on it); a child, a follow-up and a fork are in their parent's; any other run starts one.
create function runs_thread() returns trigger language plpgsql as $$
begin
  if new.thread_id is null and new.parent_run_id is not null then
    select thread_id into new.thread_id from runs where id = new.parent_run_id;
  end if;
  if new.thread_id is null then
    insert into threads (tenant_id, subject) values (new.tenant_id, thread_subject(new.input))
      returning id into new.thread_id;
  else
    update threads set updated_at = now() where id = new.thread_id;
  end if;
  return new;
end
$$;
create trigger runs_thread before insert on runs for each row execute function runs_thread();

-- Runs from before threads: each chain of runs (a run, its children, follow-ups and forks) one
-- thread, in the order they were made.
do $$
declare r record;
declare t uuid;
begin
  for r in select id, tenant_id, input, created_at from runs where parent_run_id is null
    order by created_at
  loop
    insert into threads (tenant_id, subject, created_at, updated_at)
      values (r.tenant_id, thread_subject(r.input), r.created_at, r.created_at)
      returning id into t;
    with recursive chain as (
      select id from runs where id = r.id
      union all
      select c.id from runs c join chain on c.parent_run_id = chain.id
    )
    update runs set thread_id = t where id in (select id from chain);
  end loop;
  -- runs from before threads named none: a chain on a preview joins the thread of the run that
  -- published it, oldest first, so a preview made inside a thread that just joined another
  -- follows it there. Best effort, once: a tree published twice goes to the first
  for r in select id, tenant_id, thread_id, preview_tree(input ->> 'preview') as tree from runs
    where parent_run_id is null and input ? 'preview' order by created_at
  loop
    select p.thread_id into t from runs p
      where p.tenant_id = r.tenant_id and p.status = 'completed' and p.id <> r.id
        and p.created_at <= (select created_at from runs where id = r.id)
        and preview_tree(p.result -> 'output' ->> 'previewUrl') = r.tree
      order by p.created_at limit 1;
    if t is not null and t <> r.thread_id then
      update runs set thread_id = t where thread_id = r.thread_id;
      delete from threads where id = r.thread_id;
    end if;
  end loop;
  update threads set updated_at = coalesce(
    (select max(updated_at) from runs where runs.thread_id = threads.id), threads.updated_at);
end
$$;
