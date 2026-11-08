-- ADR 0033: what people answered is kept in memory as facts and decisions, so `answer_memory` goes.
-- Its rows name no section, so none can become a decision. The three kinds of answer true for the
-- whole club become proposed facts, for a person to review (`pnpm agent memory review`); the rest
-- (one frame's item count and autoplay, which hook, which card, a badge, a toggle) are dropped.
-- A fact's embedding is the question's, which is what the answer was found by before.

-- the domain in front of relative picture paths: the latest answer per tenant
insert into memory_items
  (tenant_id, agent_id, kind, key, version, content, embedding, status, confidence, source_run_id, value)
select distinct on (a.tenant_id)
  a.tenant_id, 'data-bind', 'semantic', 'media.image-domain', 1,
  'Pictures with a relative path are served from ' || (a.answer #>> '{}') || '.',
  a.embedding, 'proposed', 1, a.source_run_id, a.answer
from answer_memory a
where a.kind = 'text' and a.question ilike '%domain%'
  and jsonb_typeof(a.answer) = 'string' and (a.answer #>> '{}') ilike 'http%'
  and not exists (
    select 1 from memory_items m
    where m.tenant_id = a.tenant_id and m.kind = 'semantic' and m.key = 'media.image-domain'
  )
order by a.tenant_id, a.last_at desc;

-- a player's photo: what a person gave was one player's URL, so a person makes it a pattern
insert into memory_items
  (tenant_id, agent_id, kind, key, version, content, embedding, status, confidence, source_run_id, value)
select distinct on (a.tenant_id)
  a.tenant_id, 'data-bind', 'semantic', 'media.player-photo', 1,
  'Player photos: ' || (a.answer #>> '{}')
    || ' (one player''s picture a person gave: make it a pattern with {id} before approving).',
  a.embedding, 'proposed', 0.5, a.source_run_id, a.answer
from answer_memory a
where a.kind = 'text' and a.question ilike '%photo%'
  and jsonb_typeof(a.answer) = 'string' and (a.answer #>> '{}') ilike 'http%'
  and not exists (
    select 1 from memory_items m
    where m.tenant_id = a.tenant_id and m.kind = 'semantic' and m.key = 'media.player-photo'
  )
order by a.tenant_id, a.last_at desc;

-- carousels wrap around: answered yes, and never no, for the tenant
insert into memory_items
  (tenant_id, agent_id, kind, key, version, content, embedding, status, confidence, source_run_id, value)
select distinct on (a.tenant_id)
  a.tenant_id, 'frame-match', 'semantic', 'layout.carousel.loop', 1,
  'Carousels wrap around to the first item after the last.',
  a.embedding, 'proposed', 1, a.source_run_id, 'true'::jsonb
from answer_memory a
where a.kind = 'confirm' and a.question ilike '%wrap around%' and a.answer = 'true'::jsonb
  and not exists (
    select 1 from answer_memory n
    where n.tenant_id = a.tenant_id and n.kind = 'confirm' and n.question ilike '%wrap around%'
      and n.answer = 'false'::jsonb
  )
  and not exists (
    select 1 from memory_items m
    where m.tenant_id = a.tenant_id and m.kind = 'semantic' and m.key = 'layout.carousel.loop'
  )
order by a.tenant_id, a.last_at desc;

drop table answer_memory;
