# 09 · Generated sources and token roles in the DSL

Status: ready-for-agent
Type: task
Blocked by: none

## What

Two changes in `packages/dsl` so a tree that did not come from a Figma frame is still a valid tree.

- **Sources.** `FlatNode.src` stays mandatory. `validate` accepts `lib:<sectionId>/<nodeId>` and `gen:<n>` besides Figma ids. Code that maps a node back to Figma (repair, the diff regions, `dataRef` attachment) treats these as having no Figma node, and says so rather than failing.
- **Token roles.** A function that maps a tree's token references from one tenant's tokens to another's by role (primary, surface, on-surface, heading, body, …) using `packages/tokens`' vocabulary. A reference with no role match is reported, not guessed.

## Done when

- A tree of `gen:` nodes validates, renders and goes through `data-bind` in a test.
- A section from one demo tenant remapped to another uses only the second tenant's tokens, and the test lists what had no match.
