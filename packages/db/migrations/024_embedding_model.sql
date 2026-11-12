-- Which embedder made each row's vector (ADR 0034, step 1). Vectors from two embedders cannot be
-- compared, so a row whose model is not the configured one is embedded again
-- (`pnpm agent memory embed`). Every row before this was made by the hash embedder.
alter table memory_items add column embedding_model text not null default 'hash-v1';
create index memory_items_embedding_model on memory_items (embedding_model);
