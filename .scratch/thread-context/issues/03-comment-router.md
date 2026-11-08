# 03 · Comment router

Status: ready-for-agent
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
