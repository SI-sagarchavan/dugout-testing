# 05 · Index after publish, and backfill

Status: ready-for-agent
Type: task
Blocked by: 02, 03, 04

## What

A job, not an agent tool, the way consolidation writes memory.

- After a run publishes (`frame.publish` or `page.build`) and the frame's fidelity score met the gate, the worker queues an index job for that Handoff: split, caption the sections not already in the library, embed (text: caption + tags; image: crop), upsert by signature, add the sighting to `sources`.
- A section already indexed is not captioned again; only a source is added.
- `pnpm agent library index --tenant <t> [--handoff <id> | --all]` indexes one Handoff or backfills every published one.
- Crops are written next to the run's artifacts locally and stored by key; the key moves to S3 with ticket 12.

## Done when

- Publishing a frame in a test leaves its sections in the library, and publishing it again adds sources and no rows.
- A frame below the fidelity gate adds nothing.
- Backfill on the demo tenant indexes every published Handoff and prints how many sections it added and skipped.
