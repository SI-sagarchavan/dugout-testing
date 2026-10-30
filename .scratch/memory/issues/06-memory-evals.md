# 06 · Memory evals

Status: ready-for-agent
Type: task
Blocked by: 02, 03, 04

## What

Eval cases that check memory changes behaviour, modelled on LongMemEval's abilities but on our own agents:

- **Knowledge update:** a fact's new version is followed in the next run, the old one isn't.
- **Lesson carry-over:** a rejection changes the tenant's next run and no other tenant's (exists as E5; extend to tenant-wide facts).
- **Abstention:** a searchable fact that doesn't apply isn't used.
- **Long run:** a compacted run still finishes and respects notes it wrote before compaction.

## Done when

- `pnpm eval` runs these in both agents' suites, scripted and live, inside the 90% gate.
