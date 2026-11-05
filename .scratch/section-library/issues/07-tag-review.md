# 07 · People edit tags and hide sections

Status: ready-for-agent
Type: task
Blocked by: 02

## What

- `pnpm agent library review --tenant <t>` walks recently indexed sections: shows the crop path, caption and tags, and lets a person add or remove tags, change the kind, or hide the section.
- A person can mark a subtree of a published Handoff as a section by node id (`pnpm agent library add --tenant <t> --handoff <id> --node <figma id>`); it is indexed like any other.
- Editing tags re-embeds the text vector.

## Done when

- A person's tags survive a re-index of the same Handoff.
- A hidden section is gone from search and from `section-composer`'s results.
