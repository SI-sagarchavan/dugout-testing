# 06 — What an MCP adapter observed survives a resume

Status: ready-for-agent

An adapter's `observe` keeps a result's structured data under the run (`packages/mcp/src/observations.ts`): a map in the process, 200 runs at most. hook-maker's check on `final` reads the output of the hook's last run from it (`observed(runId, "hookRun:<id>")`). A run resumed in another process has none, and the check then lets the answer through unchecked.

A hook's output is too large for run state (ADR 0035). Store it in the run's output store and keep its reference in state under `hookRun:<id>`; `observed` reads it back. The MCP tool wrapper (`packages/mcp/src/tools.ts`) has the `ToolContext`, so it can set the key.

Done when hook-maker's final check refuses a `covers` path that is empty after the run was resumed in a fresh process.
