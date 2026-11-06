-- Comments a person leaves on one element of a preview, for the agent that changes the UI to
-- read. A comment is about one node of one Handoff's tree (`node_id`, with its Figma id `src`),
-- carries a snapshot of what the person was looking at (`context`: the node's type, props and the
-- edits they had drafted), and is `open` until it is sent to an agent run, then `sent` (with the
-- run), then `done` or `dismissed`. Written by the host (Studio's /v1/ui-comments, later the
-- backend); read by the ui-editor agent through its tools, with the tenant of the run.
create table ui_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  project text not null,
  -- what the preview was opened by: a pipeline run or a dsl_tree artifact id
  ref text not null,
  node_id text not null,
  src text,
  node_type text,
  -- names from the root down to the node, so a person can find it
  path text,
  body text not null check (length(body) between 1 and 4000),
  status text not null default 'open' check (status in ('open', 'sent', 'done', 'dismissed')),
  author text,
  context jsonb not null default '{}'::jsonb,
  run_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ui_comments_ref on ui_comments (tenant_id, project, ref, status);

alter table ui_comments enable row level security;
create policy tenant_isolation on ui_comments
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update, delete on ui_comments to dugout_app;
