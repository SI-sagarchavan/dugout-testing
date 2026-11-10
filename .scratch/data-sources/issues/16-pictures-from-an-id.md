# 16 · A picture the design shows is never kept silently

Status: resolved
Type: task
Blocked by: none

## What

Feeds often give an item's id and no picture URL, while the club's site builds the URL from the id.
For example, Southern Brave players are
`https://www.southernbrave.com/static-assets/images/players/{id}.png?v=1.16&w=285`, and team crests
follow the same idea. In run `f77d8a76` data-bind kept the design's placeholder photos and crests
("feed has no photo"), with no question asked. Each card then shows the designer's sample picture
next to a real name.

The `media.<what>` house fact and the `picture_url` question already exist for this
(`pnpm agent memory fact --key media.player-photo …`), but nothing makes data-bind use them.

## Change

1. **`bind.try` reports a per-item picture left as designed** as an open item (ticket 11's
   `open`), not an accepted keep, when the design's items show different pictures (it already
   knows: "5 different pictures across the design's 5 items") and the data's items have an id.
   It is settled by a `media.*` fact, by the agent from evidence, or by a person. A keep is
   accepted only when it was settled as "no picture".
2. **Report the evidence a good question needs.** The open item `picture_url` carries the item's
   id field, two real values, and any URL-shaped fields or candidate patterns found. `canTake` is
   a URL template with `{field}` placeholders. The model asks in its own words. A template it
   passes back is checked by loading the URL for two items before it is bound. On three sections
   it becomes the club's fact (ADR 0033).
3. **hook-maker looks first.** When a need's field is a picture and the feed has none, hook-maker
   checks the feed for any URL-shaped field and for a sibling connector that has one (a players or
   teams feed). It says what it found in `missing`, so data-bind can ask with it.

## Done when

- `facts.test.ts`: a per-item picture kept with no fact and no answer is a problem. With a `media.*`
  fact the src is bound as a template. A picture the same on every card (a background) is not
  flagged.
- A data-bind test: no fact gives a `picture_url` question with a real id and a template, and the
  answer binds `src`.
- Works for any per-item picture: a player photo, a crest, an article thumbnail, a video poster.

## Pointers

- `agents/data-bind/src/facts.ts` (picture checks, "accepts"), `agents/data-bind/skills/bind.md`
  (`picture_url`, `media.*` facts), `packages/memory/src/decisions.ts`

## Comments

2026-11-09: done. A per-item picture left as designed is no longer keepable: it is bound (a `media.*` template) or hidden (a `set` when); the problem carries evidence (`pictureEvidence`: id field with two real values, URL-shaped fields, media facts). hook-maker's skill says to look for a URL field or a sibling connector first and report what it found in `missing`. The template is already loaded for the first items by bind.try. `picture_url` as a club fact on three sections is unchanged (its key varies by picture kind).
