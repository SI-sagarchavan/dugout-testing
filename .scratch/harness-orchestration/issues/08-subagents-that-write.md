# 08 · Subagents that write: approval through the parent

Status: wontfix

Skipped by decision on 2026-11-02, with 07. Reopen when an agent needs to hand a part of its work to another.
Type: design
Blocked by: 07

## What

A child that lists a write tool. Its approval request goes to the parent's reviewer. The parent saves
`waiting: { kind: "child", runId }` and ends its invocation, as it does for an approval. The worker
resumes the parent when the child ends. The child gets its own lease. A rejection in the child comes
back to the parent as the tool's result, not as the end of the parent. Spec: section G, "later slice".

## Open

- One review for the whole run (harness issue 06) or one per child.
- What the CLI shows while a child waits.
