-- A section's comments outlive the tree they were written on. Each edit the agent publishes is a
-- new tree, so `ref` (the tree a comment was written on) changes under a section, while the
-- section (the run that built it, the `:id` Studio opens) stays. A comment is found by its
-- section; `ref` says which tree it was on, and moves to the current one when the comment is sent.
-- Comments made before this have no section and are found by `ref`, as before.
alter table ui_comments add column section_run_id text;

create index ui_comments_section on ui_comments (tenant_id, section_run_id, status);
