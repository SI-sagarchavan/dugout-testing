# 12 · Production placement: FanXP DB and Surface MCP

Status: ready-for-human
Type: design
Blocked by: none

## What

ADR 0027 puts people-facing data in the FanXP DB and lets the plugin and admin app talk only to the backend. Search is people-facing, so the `harness` tables are a development home. Decide the production one and write the ADR.

To settle:

- the library's tables in the FanXP DB (Aurora with pgvector) or kept in `harness` with the backend reaching them some other way
- the Surface MCP tools agents use: `surface.searchSections` and `surface.getSection` (read), and whether indexing is a backend job or a worker job writing through `surface.indexSections` (write)
- crops in the client's S3 bucket: under which prefix, and signed URLs in results
- who runs the embedding calls for a person's search in the admin app (the backend needs the same model as the index)
- whether this table also serves frame-match's reuse of approved subtrees (`.scratch/figma-to-dsl/issues/07-reuse-approved-subtrees.md`)

## Done when

- An ADR records the decision, and `spec.md`'s Decisions row is updated.
- The follow-up tickets (backend routes, MCP tools, moving the store) are filed here.
