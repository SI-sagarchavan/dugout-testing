-- Episodes (ADR 0013) are a record of one run or a lesson from a reviewer. A repeated lesson
-- strengthens the one already there instead of adding a copy; retrieval ranks by relevance, how
-- recently an episode was last seen, and its strength. Episodes so far were all lessons.
alter table memory_items add column episode_type text check (episode_type in ('run', 'lesson'));
alter table memory_items add column strength integer not null default 1;
alter table memory_items add column last_seen_at timestamptz not null default now();
update memory_items set episode_type = 'lesson', last_seen_at = created_at where kind = 'episodic';
alter table memory_items add constraint memory_items_episode_type
  check (kind <> 'episodic' or episode_type is not null);
