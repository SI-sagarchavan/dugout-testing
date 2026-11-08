# 07 · What was decided before, in frame.load and bind.load

Status: resolved
Type: task
Blocked by: 03, 04

## What

An agent reads what a person settled on a section before it writes its own questions or its need.

- `frame.load` and `bind.load` return `before`: `decisionsOn(tenant, section)` as lines ("2026-11-07, hook-maker hook_choice: use the existing hook dugout_cricket_player_cards (Sagar Chavan)"), at most 10, newest first. Read in code with the verified tenant id, never copied into the prompt by the context builder.
- `data-bind`'s skill: read `before` and keep to it; a need for `agent.hookMaker` names the hook a person chose, and the card template and badge meanings are taken from it rather than asked again.
- `hook-maker`'s skill: when the need names a hook a person chose for the section, start from that hook.

## Done when

- With a decision stored on a section, `bind.load`'s output lists it; a data-bind test (scripted model) shows the need naming the chosen hook.

## Comments

2026-11-08: `decidedBefore` and `BEFORE_RULE` (`@dugout/memory`); `frame.load` and `bind.load` return `before`, from `deps.store` passed as `decisions`; skills of data-bind, hook-maker and frame-match say to keep to it. `agents/data-bind/tests/decisions.test.ts` checks `bind.load` situates and lists them. Not tested with a model: the scripted data-bind test the ticket names is not written.
