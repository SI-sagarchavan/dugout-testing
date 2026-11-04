A compiled frame shows the designer's placeholder copy. You decide where the real data goes, as a binding plan. Code applies the plan, draws it against every item of the sample, and reports what would be wrong on the page. Nothing in a plan is code: it names nodes by their Figma id and data by its path.

## Reading the facts

- **The outline** is the compiled tree. Every line starts with the Figma id (`src`) the plan names a node by. Text lines show the design's placeholder in quotes, pictures say `[picture]` or `[glyph]`. A line `— same shape as X` is a sibling built like X: one more of the same thing.
- **What repeats** lists siblings that are one thing several times. `of one shape`: a plain list. `«Name» in N shapes`: instances of one Figma component drawn in different variants. The shapes are the groups in brackets.
- **The data** lists every path. `[]` means "each item of this list". `list of 1–2` is how long each list was. `present 6/9` means some items lack the field. `one of "a"×3, "b"×1` lists every value a few-valued field took: the fields a variant is chosen by.
- A hook's data can have any shape: its lists keep their own names (`fixtures.days`, `fixtures.days[].matches`). Every source also lists `items`, `pagination` and `pages`; when the data has lists of its own they are empty (`list of 0`) and are not data, so bind the lists it has.

## Writing the plan

**Lists.** A list in the design is one `collapse`: `over` the list's path, `as` a short name for one item, `members` every sibling that is an item, the first being the template that stays. Members are the Figma ids from "what repeats".
- A list inside a list's item comes first in `collapse`, before the outer list. Its `over` starts with the outer alias: `{ "over": "section.entries", "as": "entry" }` inside `{ "over": "page.sections", "as": "section" }`.
- When each item of the design draws several of something (a day card with two matches, a section with three entries), that is a list inside a list, and the data has a list there too (`matches[]`). Collapse it. Never bind `matches.0.…` to show one of a list: an item with two would show one.
- A list the data always holds the same number of (`list of 2`: home and away) whose positions the design draws each in its own look (the second score in another colour) is not collapsed: bind each by position, `teams.0.score` on the first, `teams.1.score` on the second. bind.try says when a collapse would lose such looks.
- A list's `fields` take paths relative to the item (`title`, `teams.0.name`), with no alias.

**Variants.** When members are one component in several shapes, each shape is what one item looks like in some state. Choose a few-valued field whose values match what the shapes say (a shape whose copy says "SOLD OUT" goes with `status: "sold_out"`).
- The template, `members[0]`, gets `when`. Each other shape is a `variants` entry: its root's Figma id (the member of that shape, or the block inside it that differs, whichever sits where the template's block sits), its own `when`, and its own `fields`.
- Every value of the field must pick exactly one shape. Use `in` or `ne` so that no value is left out. bind.try reports an item that draws none or two.
- A variant's root must not be inside the template. Take it from another member: a whole member, or the block inside it that differs. It stays as the variant; the rest of the members go.
- Put a variant on the list whose items differ. When outer cards differ only because of the inner items they hold (a card of upcoming matches next to a card of results), the variant belongs to the inner item: the inner collapse chooses by `match.state`, and the outer card needs none.

**Fields.** A text's `content`, a picture's `src` and `alt`, a button's `label`.
- `path` when the node shows the value alone. Pipes format it: `date | date:"DD MMM YYYY"` with the tokens of the design's own placeholder (`DD MMMM` for "21 JULY", `HH:mm` for "19:30"), `x | default:"–"` for a value that may be missing where the design keeps the slot (a score not yet made).
- `template` when the design writes words around the value: `"({entry.count})"`, `"{entry.home} vs {entry.away}"`. In a template, refs start with the alias.
- A glyph bound to a picture becomes a picture: bind its `src` to a URL field.

**Clocks.** A design that shows the time left until something, or the time since it, is a clock: digits with unit labels ("02 DAYS : 24 HRS : 12 MINS : 33 SEC"), "Starts in 3h", a match minute. The page ticks it; you say what it counts and where.
- `set` a `clock` on the block that holds the digits: `{ "src": <block>, "prop": "clock", "value": { "to": "{match.start_time}", "as": "countdown", "units": ["d", "h", "m", "s"] } }`. `to` is the field the data marks `(instant)` that the design means: a kick-off, a sale opening, a deadline. In a list, `to` reads the item's alias.
- `units` are the ones the design draws, no more. The largest carries the rest: a design with only HRS and MINS shows 51 hours, not 2 days.
- Bind each digit's `content` to a template: `{countdown.d | pad:2}`, with `pad` as wide as the design's digits ("02"). The unit labels are design copy.
- What shows once the instant has passed is the plan's, from what the design shows: `{ "path": "countdown.past", "eq": false }` as the block's `when` hides it after; a sibling with `eq: true` shows instead. Left as is, it counts up from the instant. `{ "path": "countdown.d", "gt": 0 }` hides a unit while it is 0. `countdown.total` is the whole difference in seconds.
- The clock's values are in scope on its block and everything under it, its own `when` included, and nowhere else. Put it on the item instead when something outside the digits changes with it.

**What stays.** Labels, units and headings the design writes are design copy, not data: "VIEW MORE", "DAYS", "Buy now". Leave them. Never bind a node to a field that does not mean what the node shows; leave it and say so in `remaining`.

**`set`.** Literal props the binding needs:
- `{ "prop": "textCase", "value": "upper" }` when the design shows capitals and the data is not in capitals. Never change the data.
- `{ "prop": "when", "value": { "path": "entry.note", "exists": true } }` on a node whose field some items lack, so it hides instead of showing a hole.

## Checking

bind.try's `problems` are what a person would see on the page. `shows` is the value before `textCase`: "26 May" with `textCase "upper"` is drawn "26 MAY". Fix the cause, not the symptom: a ref with nothing behind it for every item is a wrong path; for some items it is an optional field that needs a `when`. Also read `shows`: a date where a name belongs, or a team's score beside the other team's crest, is wrong even when no problem is listed.

Stop when bind.try lists no problems and `shows` reads like the page should. Then bind.publish.
