-- What a person answers when a run asks goes into memory as it is (ADR 0033): an answer about one
-- section is a decision, an episode of its own type keyed `<agent>:<question id>@<section>`; an
-- answer true for the club is a fact. Both keep the typed answer in `value`, which a later run's
-- question is proposed (or, for an active fact, answered) with. `content` stays the sentence a
-- person and a model read.
alter table memory_items drop constraint memory_items_episode_type_check;
alter table memory_items add constraint memory_items_episode_type_check
  check (episode_type in ('run', 'lesson', 'example', 'decision'));

alter table memory_items add column value jsonb;

create index memory_items_decision_key on memory_items (tenant_id, key, last_seen_at desc)
  where episode_type = 'decision';
