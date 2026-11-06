# 04. The agents ask at their gaps

Status: done
Blocked by: 01

## What

- `frame-match`: `frame.layout` asks the layout's questions itself (code writes them from the evidence; `AwaitingAnswers`) instead of an approval card, and applies the answers.
- `hook-maker` (which now finds a hook first and builds only when none fits, ADR 0030): asks before building when a hook gave part of the need, built into its instructions and skill. `data-bind` asks the rest, when the data does not fit the design: the content type differs (articles for videos: use them, build a hook from a named connector, or leave it), image paths are relative (which domain), a field the design shows is missing (build a hook, leave the placeholder, or hide it).
- Skills and instructions say when to ask, and to ask everything known at once.


## Comments

2026-11-06: `frame.layout` asks (`layoutQuestions`, `applyLayoutAnswers` in `agents/frame-match/src/layout.ts`; it is a read tool now and throws `AwaitingAnswers`). `data-bind` asks at its gaps (instruction 1e and the "When to ask a person" section of its skill). `hook-maker` asks before it builds when a hook gave part of the need (ADR 0030).
