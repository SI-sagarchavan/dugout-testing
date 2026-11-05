# Section library: search sections, generate UI from a description

Status: planned 2026-11-06. No ADR yet; ticket 12 writes one once production placement is settled.

Every published Handoff leaves a frame we matched to its screenshot: Frame IR, a DSL tree that renders it, and the screenshot. Today those are used once. This feature keeps them, cut into sections, as a searchable library, and uses it for two things:

1. **Search.** A person searches sections by words ("fixtures carousel with crests and kick-off time") or by an image, and gets UI samples back: rendered sections with their tags and the Handoff they came from.
2. **Generate.** A person describes a UI, optionally adds a screenshot as inspiration, and gets a DSL tree in their own tokens, checked and rendered, ready for `data-bind`.

Both run on one corpus. Search returns sections, and generation is most reliable when it adapts sections that are known to render well instead of writing a tree from nothing.

## Decisions (2026-11-06)

| Question                          | Decision                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit of the library               | A **section**: a DSL subtree, not a whole frame. Whole frames are not entries.                                                                                                                                                                                                                       |
| Where sections come from          | The page frame's top-level children, plus the containers layout detection names (carousel, list, row, grid, tabs; ADR 0024) as sub-sections. A person can mark any other subtree.                                                                                                                    |
| What gets in                      | Only sections of a **published** Handoff whose fidelity score met the gate. Unreviewed or off output would become search results and, worse, examples generation copies.                                                                                                                             |
| Duplicates                        | One entry per DSL subtree signature (`packages/dsl/src/subtree-signature.ts`) per tenant. A repeat sighting adds provenance, not a row. Six cards of one component are one entry.                                                                                                                    |
| What is embedded                  | Two vectors per section: the **image** of its crop, and the **text** of a model-written caption plus tags. Raw IR or DSL JSON is never embedded: embedding models rank nested JSON by ids and numbers, so the same layout with other content lands far apart.                                        |
| Embedding model                   | A multimodal model on Bedrock with text and images in one space, at 1024 dimensions (the column size `packages/memory` already uses). Which one is ticket 01; the hash embedder stands in for tests and dev until then.                                                                              |
| Search                            | Hybrid, as `memory_items` does it: text vector, image vector and full-text over caption and tags, merged by reciprocal rank. A query may be words, an image, or both.                                                                                                                                |
| Who writes the library            | An indexing job after a publish, like consolidation writes memory. No agent tool writes a library entry. People edit tags and hide entries.                                                                                                                                                          |
| Tenancy                           | A section belongs to the tenant whose Handoff it came from, behind row-level security. A run and a search see their own tenant's library only. A shared library is not now.                                                                                                                          |
| Where it lives during development | Its own package, `packages/library` (`@dugout/library`), with tables in the `harness` database (pgvector and RLS are already there). Crops are files under the run's artifacts locally, S3 keys later.                                                                                               |
| Where it lives in production      | Open (ticket 12). ADR 0027 puts people-facing data in the FanXP DB and lets the admin app talk only to the backend, so the likely end state is the FanXP DB (Aurora supports pgvector) with agents reading through a Surface MCP tool. The store is an interface so the move does not touch callers. |
| Generation strategy               | Retrieve, then **adapt** a retrieved section (reorder, restyle, change counts). Writing a tree from nothing is the fallback when nothing retrieved fits.                                                                                                                                             |
| Generated nodes' `src`            | `FlatNode.src` stays mandatory. A node adapted from the library carries `lib:<sectionId>/<nodeId>`; a new node carries `gen:<n>`. Repair and binding accept both (ticket 09).                                                                                                                        |
| Styling generated UI              | Looks only through the tenant's DSL tokens. A section borrowed from elsewhere has its token references mapped by role (primary, surface, heading…), never kept by name.                                                                                                                              |
| An inspiration image              | Taken as structure and intent, not a target to match pixel for pixel. Generation is judged by a model against the description and image, not by `@fanos/conform`'s geometry gate.                                                                                                                    |

## A library entry

| Field                               | Holds                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `id`                                | Stable id                                                                                        |
| `tenant_id`                         | From the verified run that published the Handoff                                                 |
| `signature`                         | DSL subtree signature, with its prefix (`d1…`); unique per tenant                                |
| `kind`                              | hero, fixtures, results, news, standings, nav, promo, footer, … (a closed list, `other` allowed) |
| `layout`                            | carousel, list, row, grid, tabs or none, from layout detection                                   |
| `tree`                              | The section's flat DSL nodes, re-rooted (the root's `parent` is null)                            |
| `ir`                                | The IR slice under the section's root, for later fidelity checks                                 |
| `crop`                              | Where the crop image is: the frame screenshot cut to the root's `renderBbox` (or `bbox`)         |
| `width`, `height`                   | The crop's size in CSS pixels                                                                    |
| `caption`                           | One or two sentences a vision model writes                                                       |
| `tags`                              | Short phrases; each says whether a model or a person added it                                    |
| `text_embedding`, `image_embedding` | `vector(1024)`, with the embedding model's name next to each                                     |
| `tsv`                               | Full text over caption and tags                                                                  |
| `sources`                           | Every sighting: Handoff id, run id, Figma node id, fidelity score, when                          |
| `hidden`                            | A person took it out of search and generation                                                    |

The caption is written from the crop and a **structural summary** that code derives from the tree: for example "horizontal carousel, 4 cards; each card: image, crest, crest, score, date, button". Content props (`CONTENT_PROPS` in `subtree-signature.ts`) are left out of the summary, so the caption describes the component, not this week's match.

## Flow

```
publish (frame.publish / page.build)
  └─ index job: split → crop → summarise → caption → embed → upsert by signature

search: query (words | image | both)
  └─ embed query → three rankers → reciprocal rank → filters (kind, layout) → sections + crops

generate: description (+ inspiration image)
  └─ library.search → adapt / compose a flat tree in tenant tokens
     → validate + token lint → render → look (against description and image)
     → repair, a few rounds at most → publish preview (approval) → data-bind
```

## Generation: the `section-composer` agent

`agents/section-composer`, written with `defineAgent`, added to the worker's list.

- **Input:** `description` (required), `inspiration` (optional image: an uploaded file's key, or a path from the terminal), `kind` (optional hint).
- **Tools:**
  - `library.search` (read): the search above, over the run's tenant.
  - `library.get` (read): one section's flat tree, tokens used, structural summary.
  - `compose.check` (read): validates a flat tree, lints its tokens, renders it with `@fanos/renderer` and returns the render's issues and an image the model reads.
  - `compose.publish` (write, approval): saves the tree and its preview, and returns the preview link `data-bind` takes.
- **Skill:** how to adapt a section (what may change, what may not), token roles, when to write from nothing.
- **Stops** when `compose.check` passes and the model's look at the render agrees with the description, or after the repair limit, reporting what is still off (as frame-match does).

## Tickets

| #   | Ticket                                                                              | Status          | Blocked by |
| --- | ----------------------------------------------------------------------------------- | --------------- | ---------- |
| 01  | [Pick the multimodal embedding model](issues/01-embedding-model.md)                 | ready-for-human |            |
| 02  | [Library package, schema and store](issues/02-library-store.md)                     | ready-for-agent |            |
| 03  | [Split a published frame into sections](issues/03-section-splitter.md)              | ready-for-agent | 02         |
| 04  | [Structural summary and caption](issues/04-caption.md)                              | ready-for-agent | 03         |
| 05  | [Index after publish, and backfill](issues/05-indexer.md)                           | ready-for-agent | 02, 03, 04 |
| 06  | [Search: words, image, both](issues/06-search.md)                                   | ready-for-agent | 02         |
| 07  | [People edit tags and hide sections](issues/07-tag-review.md)                       | ready-for-agent | 02         |
| 08  | [Retrieval eval](issues/08-retrieval-eval.md)                                       | ready-for-agent | 05, 06     |
| 09  | [Generated sources and token roles in the DSL](issues/09-generated-src-tokens.md)   | ready-for-agent |            |
| 10  | [The `section-composer` agent](issues/10-section-composer.md)                       | ready-for-agent | 06, 09     |
| 11  | [Composer eval](issues/11-composer-eval.md)                                         | ready-for-agent | 10         |
| 12  | [Production placement: FanXP DB and Surface MCP](issues/12-production-placement.md) | ready-for-human |            |

01 and 12 do not block development: the hash embedder and the `harness` tables carry everything until they are settled.

## Related

- `.scratch/figma-to-dsl/issues/07-reuse-approved-subtrees.md` keys approved subtrees by the same signature, for frame-match to reuse. The library's rows can serve that lookup; keep one table, not two.
- ADR 0013/0014 (memory, shared memory): the model for who writes, who approves, and how a shared layer would be added later.
- ADR 0024 (layout detection): where sub-section boundaries and `layout` come from.
- ADR 0027 (two databases): why production placement is open.

## Not now

- A shared library across tenants (by sport or global, as ADR 0014 does for memory).
- Generating whole pages. A page is sections; one section per run first.
- Search and generation in the admin app's UI. The terminal and agent tools first; the backend's routes come with ticket 12.
- Re-embedding on a model change beyond a command that does it in batch.
- Near-duplicate merging beyond exact signatures.
