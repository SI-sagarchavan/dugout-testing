-- What a thread knows (ADR 0031): after each invocation, a note of what it did, what it made,
-- what a person decided and what is still open. The next invocation in the thread starts with
-- them, within a budget, so a comment or a data request finds the section's story already told
-- without its transcripts. One note per invocation; its child runs are in it.
create table thread_notes (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads (id) on delete cascade,
  tenant_id text not null,
  run_id text not null unique references runs (id) on delete cascade,
  agent_id text not null,
  note jsonb not null,
  created_at timestamptz not null default now()
);
create index thread_notes_thread on thread_notes (thread_id, created_at);

alter table thread_notes enable row level security;
create policy tenant_isolation on thread_notes
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on thread_notes to dugout_app;
