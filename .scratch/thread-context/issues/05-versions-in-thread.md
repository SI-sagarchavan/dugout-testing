# 05 · Versions in the thread

Status: ready-for-agent
Type: task

## What

Each `ui.publish` and each bind saves a new tree, so earlier versions exist. But a thread note keeps only the latest id for each name (`made.previewUrl`), so neither the next run nor a person can see the history or undo to a version.

## Fix

- A note records what it replaced: `tree t3 ← t2`, from the input's preview and the output's.
- `## This thread so far` lists the versions, newest first, within its budget.
- A host can start a run from an earlier version (Studio: "Go back to this version", which republishes that tree).

## Done when

- Three edits in a thread give versions v1 to v3 in the rendered thread, each naming what it changed.
- Going back to v1 publishes it as v4, and the thread says so.
