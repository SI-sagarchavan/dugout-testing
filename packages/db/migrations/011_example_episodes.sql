-- An example (ADR 0013) is the input of a write call an editor approved in a completed run: past work
-- a later run can use for style and structure. It is an episode of its own type, left out of search.
alter table memory_items drop constraint memory_items_episode_type_check;
alter table memory_items add constraint memory_items_episode_type_check
  check (episode_type in ('run', 'lesson', 'example'));
