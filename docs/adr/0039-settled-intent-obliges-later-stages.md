# 0039: What was settled obliges the stages after it

Date: 2026-11-12 · Status: accepted · Builds on ADR 0030 (paged hooks), 0035 (run state) and 0038 (interaction)

## Context

A section is built in stages: frame-match, then hook-maker inside data-bind, then interaction. Each stage's model judges for itself. On handoff 9aa22f72 (photo galleries with LOAD MORE), data-bind asked hook-maker for a paged list, and hook-maker built a hook that takes a page and answers `next`. Then data-bind bound the cards by position only, with no list a later page could draw into, and interaction left LOAD MORE unwired. Both gave the same reason: the feed holds 7 galleries and `next` is null today (runs 8d874bde and 7dafe3b0).

A sentence added to both skills fixed interaction on the next run and was ignored by data-bind. This is one case of a general failure: a later stage reasons from what the data holds today and undoes an intent an earlier stage settled. Skill sentences can't cover every case, and the model doesn't always follow them.

## Decision

- **An intent is settled once, by a model, and travels in the artifact it shaped.** For paging, data-bind's model settles that the design pages this list (`need.paged`). The paged hook answers `next` at its top (ADR 0030), and that `next` is where every later stage reads the intent. Code never infers the intent from the design. It only reads what was settled.
- **Each kind of intent states once what it obliges each stage to build** (`agents/data-bind/src/obligations.ts`). Each stage's check holds its own output to that, whatever the data holds today. A list on its last page is still a paged list.
  - **Paging, for data-bind:** a plan that reads a paged source's list draws it with a collapse that has an open `slice: [n]`. `bind.try` reports a plan without one as a problem that can't be fixed with `keep`. It has to be fixed in the plan, or published `despite` with a reason a reviewer can read.
  - **Paging, for interaction:** the section's machine has a request with `source: <as>`, and a layer is drawn on `<as>.next`. `ix.load` and `ix.apply` report what is still open as `obligations`, kept in the run's state, and the check on `final` refuses while one is open. The only way to leave one is `unmet`, with a reason from a fixed list (`nothing-asks`: the design draws nothing a fan presses for more). What the data holds today is never a listed reason.
- **Fixed count, for data-bind:** a list the design draws N of (`need.count` N, not paged, not grouped) is drawn N at most, however long the data grows. Every collapse over it has a closed slice within N, and no card is bound past the N-th item by position. The intent is read from what the run asked hook-maker: the SDK keeps each call to a child agent in the parent's state (`askedOf(state, childId)`), and the source bound by that hook carries it.
- **A list that shrinks, for data-bind:** a card bound to an item by position has a `when` on itself, or on a node around it, that reads that item. A shorter or empty feed then hides the card instead of drawing it empty. This holds for every list the plan reads by position. It isn't a settled intent, just what a list is.
- **Links, for data-bind:** when the run asked hook-maker for a field of kind `link` (the item's own page), the plan links the cards from it: an `href` on the card's node, by path or by a template from a `route.*` house fact, or a Button's navigate action. `href` is a new universal DSL prop, drawn as a real `<a>` on a Stack, Box, Overlay or Text. S19 refuses a link inside a link, an `href` on a Button, and an `href` on any other type.
- **Carousel, for data-bind:** frame-match's model settles that a container is a carousel, and it travels in the tree as a `Carousel` node. A list drawn in it is a collapse that cuts nothing, and no slide is bound to an item by position. A list the design draws a fixed number of (`need.count`) is cut by that obligation instead.
- **The model still decides how to build it.** Code holds the output to what was settled and doesn't build it itself. The refusal says what's missing in the same words the skill uses.
- **A new kind** (tabs, search, a choice another section reads) gets an entry in `obligations.ts` with a check per stage, not a new sentence in each skill.

## Consequences

- Paging was the first kind. Fixed count, shrinking lists, links and carousels followed the same day. Tabs need nothing new: hook-maker already refuses a `filterBy` the output doesn't give, and `bind.try` reports a choice whose options draw nothing. hook-maker's check (a paged need answered without `next` is refused) is the same rule at the stage before.
- A paged hook reused for a section that doesn't page (a strip of four galleries) obliges data-bind too. That section's run publishes `despite`, or interaction names it `unmet`. Both are on record for a reviewer.
- Not done: settling the intent earlier, in frame-match's reading ("a grid with LOAD MORE under it"), so a data-bind that never sets `need.paged` is caught too. Also not done: turning a person's correction into a lesson for the agent that made the mistake, which is part of the separate memory work.
