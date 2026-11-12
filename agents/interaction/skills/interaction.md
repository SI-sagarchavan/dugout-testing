A section was published as it looks: a still picture of one moment. A design shows how it behaves only by drawing its cards in different states side by side (one card picked, one starred, the rest neither) and by what it lays out (a search box over a list, a list taller than its sheet). You read that, settle what it means, and code makes the section do it.

## Reading the differences

- `ix.load`'s `differences` are every part of a list's cards whose look is not the same on every card: each look, the cards it is on (1 first), the layer drawing it on each and, for a picture, what it shows (`shows`: "green circle with white tick"). A layer's name (`Frame 1984079177`) means nothing; read `shows`. A text's words are not a look, so a name the data fills in is not a difference.
- `boundTo` says what the plan binds on the template's layer there (`src <- photo`), and `everyCard` that each card has its own look there. Both point to the data, but read them: a part the plan binds is the data's; one where every card differs and nothing is bound may still be a state each card shows its own way.
- A look that differs on one card only, and that no state explains (a name in a colour no other card has), may be a mistake left from building the frame: read it with the other cards, and say so in `remaining` rather than building a state for it.
- A difference that an item field explains on the same cards is the data's: a captain badge on the cards whose `is_captain` is true. Leave it to the data. When no field explains it, it is what the fan picked on the page: a tick against an empty circle, a filled star against an outline, a highlighted card. The design draws a few cards picked to show what picking looks like; which ones is the designer's choice, not data.
- Two looks of one part sit at the same place on different cards. Each is its own layer: `show` the one look when the item is in the list, the other when it is not (`is: "out"`). A look only some cards have is put on every card by code, so name the layer from any card that has it.
- A layer whose look changes (a name bold and blue on the picked and the starred cards, plain on the rest) is `restyle`d: the template's layer, the layer on a card that shows the other look, and the state that look is drawn in. When the cards with the look are those in either of two lists, name both lists: it is drawn when the item is in any of them.
- What a press toggles: the whole card for picking (its template src, the list's `template`), a part for a part's own list (each look of a star, so a press on either toggles it). One press sends one event, so do not give the card and a part inside it the same list.

## Lists in state

- Name a list for what it holds (`picked`, `favourite`, `following`), with the item field that tells items apart. `key` is code's proposal; `keys` lists every field that would do. Pick the one that names an item for as long as the fan's choice should last (an id over a name that may change).
- `max` is how many it may hold. The design rarely says; a counter such as `0/2` or copy such as "choose up to 3" does. How many cards the design draws in a state shows what the state looks like, never a limit: one starred card does not mean one star. When nothing says and a limit would change what the fan can do, ask; 0 is no limit.
- `share`: another section of the page reads it (a summary, a count, a SAVE that sends it). `keep: "browser"` keeps it after a reload, for a choice the fan would expect to stay before they save.
- SAVE and what it sends are the page's to wire to a host action, which this agent does not do yet: say so in `remaining`, with what it would send.

## What the plan already decides

`planRules` (per list in `ix.load`) are rules the binding plan put on the cards' layers: a `when` it draws a layer under (a badge for `p.is_captain`), a look by the item's place (`at`: hidden on the last card). When a behaviour makes the state decide a part, a rule on it, or on a layer around it, meets the state's, and `ix.apply` will not publish until you settle each in `planRules`: `state` takes the plan's rule off (it was the binding's reading of the very difference you settled as a state), `both` keeps it (the data explains it too, and the part is drawn only when both hold). `ix.apply`'s `states` then shows what that draws; a part drawn in no state means the rule you kept hides it.

## Search and scroll

- A field (`fields`) whose placeholder or name says search, beside a list, filters that list by what is typed. Pick the item field a person would search (a name, a title). A search shows every item while nothing is typed.
- A box in `overflow` clips content that runs past it: the list was drawn longer than its sheet. It scrolls on that axis.

## Asking

Ask only what changes what you build and nothing in the design, the data or memory settles: a limit, whether picks are kept, which of two fields a search reads when both fit. Ask everything at once, each question with an id named for what it settles and `remember: section`, or `club` for what holds for every section of the club. Propose your best answer, from the evidence. What you settle yourself goes in `settled` with `agent`, with why in a few words where it matters.

## What a request asks

A `request` is a person's words about the preview (from comments), each with the element it is on: make it do that. "Make the search work" is a search; "the list should scroll" is a scroll; "let me pick players and star two" is two toggles, with a limit of two on the stars. Read the evidence to find the layers it means. What it asks that no behaviour here can do goes in `remaining`, with why.
