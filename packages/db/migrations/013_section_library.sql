-- The section library (`.scratch/section-library/spec.md`): sections of published Handoffs, each a
-- picture, a description and the IR's account of its structure, searchable by words or an image.
-- One row per section shape per tenant: the same header on ten pages is one row with ten sources.
-- The IR itself is not stored; a source names where to read it (an artifact id today, an S3 key
-- later) and the section's root node in it.
create table library_sections (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  -- the IR's structural signature over the whole subtree: shape only, no text, colour or size
  signature text not null,
  -- the root layer's name in Figma, for people; never searched
  name text not null,
  kind text not null default 'other',
  -- carousel, list, row, grid, tabs, or none (ADR 0024)
  layout text not null default 'none',
  -- code's description of the structure, from the IR
  summary text not null,
  -- the model's description of the picture; empty until captioned
  caption text not null default '',
  -- tags a model wrote, tags a person added, and model tags a person took away
  tags text[] not null default '{}',
  person_tags text[] not null default '{}',
  removed_tags text[] not null default '{}',
  -- the frame-relative box of the root node in the first source
  box jsonb not null,
  crop_key text not null,
  crop_width integer not null,
  crop_height integer not null,
  -- every sighting: { handoffId, irRef, nodeId, fileKey, at }
  sources jsonb not null default '[]',
  -- the section's DSL subtree, once the DSL is ready to store
  tree jsonb,
  embedding_model text not null,
  text_embedding vector(1024) not null,
  image_embedding vector(1024) not null,
  -- caption, summary and tags as one text, written by the store, for full-text search
  search_text text not null default '',
  tsv tsvector generated always as (to_tsvector('english', search_text)) stored,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, signature)
);

create index library_sections_tsv on library_sections using gin (tsv);
create index library_sections_text_embedding on library_sections
  using hnsw (text_embedding vector_cosine_ops);
create index library_sections_image_embedding on library_sections
  using hnsw (image_embedding vector_cosine_ops);

alter table library_sections enable row level security;
create policy tenant_isolation on library_sections
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update, delete on library_sections to dugout_app;
