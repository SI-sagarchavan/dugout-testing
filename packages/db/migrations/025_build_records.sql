-- How a section was built (ADR 0034): an episode of its own type, keyed `<agent>:build@<section>`,
-- with the typed record in `value` and one sentence in `content`. Read by key, by the load tools.
alter table memory_items drop constraint memory_items_episode_type_check;
alter table memory_items add constraint memory_items_episode_type_check
  check (episode_type in ('run', 'lesson', 'example', 'decision', 'build'));

create index memory_items_build_key on memory_items (tenant_id, key, last_seen_at desc)
  where episode_type = 'build';
