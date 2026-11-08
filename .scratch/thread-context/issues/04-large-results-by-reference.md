# 04 · Large tool results by reference

Status: ready-for-agent
Type: task
Blocked by: 01

## What

Tool outputs over 16k characters are stored and read back with `output.read` (`packages/core/src/tools.ts:149`). These tools skip that limit (`alwaysInline: true`):
- `frame.load`, `frame.tokens`, `frame.override`, `frame.layout` (frame-match);
- `bind.load`, `bind.source` (data-bind);
- `ui.load` (ui-editor, fixed in 01).

One tool result is about 50k characters.

## Fix

For each, give the model a summary it can act on, and a way to read the rest. That can be `output.read`, or a narrower tool such as `ui.node` and `frame.node` that reads one part. Keep `alwaysInline` only where the output is small enough. Measure each tool's output on the eval frames before and after.

## Done when

- No tool returns more than 16k characters on the eval frames, unless it is listed in the ticket with a reason.
- `pnpm eval frame-match` and data-bind's suite pass at their current rates.
