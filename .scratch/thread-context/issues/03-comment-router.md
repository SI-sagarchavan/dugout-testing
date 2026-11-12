# 03 · Comment router

Status: done (2026-11-11)
Type: design + task

## What

The backend always queues `ui-editor` for a section's comments (`EDITOR_AGENT`, `wnm-fanxp-backend-surface-auth/src/services/surface-comment/index.ts:111`). `ui-editor` edits props only, so a comment about data ("show the last five results", "this should be the away team") comes back "not addressed".

## Fix

Route each comment before queuing:
- layout, style or copy → `ui-editor`;
- data (which field, what repeats, how many) → `data-bind`, on the same preview;
- a new element → reported to the person, as now.

Rules first, from the element's type and props, a bound prop on it (from the binding plan) and the comment's words. A cheap model only when the rules can't decide. One Send can queue both agents. Every run joins the section's thread, so each reads what the other did.

`data-bind` needs to take a comment as input: the element, what the person asked, and the current plan.

## Done when

- A Send with one style comment and one data comment queues `ui-editor` and `data-bind` in the section's thread, each with only its own comments.
- A test set of about 30 real comments is routed correctly by the rules, or sent to the model.

## Done differently (2026-11-11)

No router in the backend. `ui-editor` is the section's editor and takes every comment, as Claude Design's one agent does: a comment about the data goes to `data-bind` as a child run (`agent.dataBind`, input `request`: the comments' words with their nodes), which starts from the plan the preview binds now. The model routes, from the element's history (what data-bind binds on it) and the words. A comment that needs frame-match again (the design itself) is not routed: frame-match has no mode for one node, and running it again would drop the edits.
