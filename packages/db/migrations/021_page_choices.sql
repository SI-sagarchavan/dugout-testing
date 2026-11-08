-- The choices a published section writes to its page (ADR 0032): a tab bar, a toggle, a filter
-- row, each option setting `_page.<key>` for any section on the page to read. frame-match records a
-- section's choices when it publishes it (one row per key per section, replaced on each publish);
-- data-bind reads the tenant's, so a section built later (the squad strip) can show what another
-- (the header's WOMEN | MEN toggle) chose.
create table page_choices (
  tenant_id text not null,
  project text not null,
  -- the section: the Handoff (or export) the tree was built from
  section text not null,
  -- what a person calls it: the frame's name
  section_name text,
  key text not null check (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  -- [{ value, label }], in the order drawn
  options jsonb not null,
  initial text not null,
  tree_artifact_id text not null,
  run_id text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, project, section, key)
);

create index page_choices_key on page_choices (tenant_id, project, key);

alter table page_choices enable row level security;
create policy tenant_isolation on page_choices
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update, delete on page_choices to dugout_app;
