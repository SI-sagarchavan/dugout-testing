# 05 · Skill-edit suggestions

Status: ready-for-agent
Type: task
Blocked by: 02

## What

`pnpm memory:suggest-skills <agent> [--tenant <t>]` reads the agent's strongest lessons (reinforced, across tenants unless one is named) and its skill, and asks the smart model for a short edit to the skill that would make the lessons unnecessary. It writes the suggestion as a patch next to the skill for a person to review and commit. It never changes a skill itself, and tenant-specific lessons are suggested as tenant facts instead.

## Done when

- With scripted lessons, the command writes a patch that applies to the skill file.
- A lesson that is tenant-specific is listed as a suggested fact, not put into the skill.
