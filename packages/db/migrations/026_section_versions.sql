-- A section's versions (thread-context 05): each preview a section has had after it was built, one
-- row each, newest last. The section is the run Studio opens for it (the run that built it, as
-- `ui_comments.section_run_id`), and its first version is that run's own preview, which has no row.
-- A row is written by whoever made the preview: ui-editor for each set of edits it published, a
-- person for edits made by hand in Studio, a person going back to an earlier version (a new row
-- that copies it, `restored_from`). The section's preview now is its newest row's.
create table section_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  section_run_id text not null,
  thread_id uuid references threads (id) on delete cascade,
  project text not null,
  -- the preview's parts: the tree, and the binding plan, data and surfaces drawn over it
  tree text not null,
  plan text,
  data text,
  surfaces text,
  preview text not null,
  -- the tree this one was made from
  from_tree text,
  -- `agent:<id>` for a run's, else the person's name
  by text not null,
  run_id text,
  -- what changed, in a line
  what text not null,
  restored_from uuid references section_versions (id),
  created_at timestamptz not null default now()
);
create index section_versions_section on section_versions (tenant_id, section_run_id, created_at);
create index section_versions_thread on section_versions (thread_id, created_at);

alter table section_versions enable row level security;
create policy tenant_isolation on section_versions
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert on section_versions to dugout_app;
