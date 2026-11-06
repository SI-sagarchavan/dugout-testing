-- What people answered when a run stopped to ask (ADR 0029). One row per tenant, question and
-- answer: the same answer to a question asked again, in other words, adds to `times` instead of
-- adding a row. A person's answers only: an answer a host gave without asking is not learned.
-- A row is a proposal for the next run's question until a person makes it `standing`
-- (`pnpm agent memory answers`), and only a standing row ever answers a question for them.
create table answer_memory (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  -- the agent whose run asked; every agent of the tenant reads every row (ADR 0013)
  agent_id text,
  question text not null,
  kind text not null check (kind in ('choice', 'multi', 'text', 'confirm', 'number')),
  answer jsonb not null,
  times integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  standing boolean not null default false,
  approved_by text,
  source_run_id text,
  -- of the question's words, to find the same question asked differently
  embedding vector(1024) not null
);

create index answer_memory_tenant on answer_memory (tenant_id, kind);
create index answer_memory_embedding on answer_memory using hnsw (embedding vector_cosine_ops);

alter table answer_memory enable row level security;
create policy tenant_isolation on answer_memory
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update, delete on answer_memory to dugout_app;
