# 03 · Facts: pinned and searchable, extracted after runs

Status: ready-for-agent
Type: task
Blocked by: 01

## What

- **Two tiers.** A fact is `pinned` (always in the prompt) or searchable (found with `memory.search`). Seeded house rules are pinned; the reviewer chooses when approving. The context builder stops loading every fact.
- **Extraction after the run.** From reviewer feedback and lessons, the fast model drafts candidate facts. Each is checked against the most similar active facts and proposals of the tenant: a new key is proposed as new; a match proposes an update to that key (a new version); a duplicate is skipped. Nothing is activated.
- **Review shows the context:** the current version, the proposed one, where it came from (run, lesson, agent), and its scope.

## Done when

- The same reviewer feedback in two runs yields one proposal, not two.
- Feedback that contradicts an active fact yields a proposed new version of that fact's key.
- A searchable fact is absent from the prompt but found by `memory.search`.
