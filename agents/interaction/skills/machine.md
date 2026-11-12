## Writing a machine (the DSL's interaction language)

A section's behaviour is one machine on its root, JSON shaped like an XState v5 config, and props on its layers. The page runs it; nothing else is written for a behaviour. Pass the machine whole as `machine` in `ix.apply` and the layer props as `props` (`{ src, prop, value }`).

**The machine.** `context` (what the section remembers, as JSON, before anything happens), `states` (the root's states are regions side by side: a menu, a drawer, a request each its own region with an `initial` state), `on` (an event's transition: a target state name, or `{ target?, guard?, actions? }`, or a list of them, the first whose guard holds), `entry`/`exit`, `after` (`{ "3000": "hidden" }`), `always`, `tags` (names a layer can test: `loading`), `computed` (values derived from the state), `exports` (what other sections read as `$page.<key>`), `requests`, `persist`.

**Expressions** (guards, `assign`, `computed`, a request's `input`) are JsonLogic-shaped: a scalar, a list, or one op `{ "<op>": [args] }`. `{ "var": "context.page" }` reads a path (`context`, `computed`, `event`); `+ - * / %`, `== != < <= > >=`, `and or not if`, `len includes toggle append remove uniq concat`, `map filter find some every sum count sort` (the item is `it`). A plain object is never a literal: build one with `{ "obj": { "k": e } }`. An unknown op is an error, so ix.apply says so.

**Actions** (a closed set): `assign` (`{ "assign": { "page": e } }`), `raise`, `send` (to the page's other sections), `emit` (tracking, snake_case), `navigate`, `call` (a host action, fire and forget), `focus`, `scrollTo`, `if`.

**Requests.** A state with `invoke: { request, input, onDone, onError }` makes the request while it is active; leaving the state cancels it. Each request is declared in `requests`: `{ "action": "fan_prefs.save" }` for a host action, or `{ "source": "photos" }` for **more of a data source the section reads** (the name its refs start with, `ix.load`'s `sources[].as`): the page runs that source again with the request's input over the inputs it was bound with, and adds the answer to what it holds (lists appended, the rest replaced). The machine never holds data: it holds which page it asked for.

**On layers.** `on`: what a press sends, `{ "click": { "send": "photos.more" } }` (also `input`, `change`, `submit`, `outside`, `escape`; `payload` for values, `"to": "page"` for another section's machine). Every event a layer sends its own section must be handled by the machine. `when`: the layer is drawn only while it holds; a condition reads the data (`{ "path": "photos.next", "exists": true }`), the state (`{ "path": "$state.tags", "has": "loading" }`, `$state.context.<field>`), or the page (`$page.<key>`). `statesWhen`: a look per state (`{ "disabled": <when> }`).

### Example: LOAD MORE

`ix.load` shows a source whose top holds where the list stands (`sources: [{ as: "photos", input: {…}, holds: { galleries: "list of 10", next: 2 } }]`) and a button under the list (`buttons: [{ src: "348:20275", label: "LOAD MORE" }]`). The binding put the cards after the design's own looks in a list over `photos.galleries` from an index on (`slice: [7]`), so each page added draws there. The hook takes the page as an input; read its name in `sources[].input` (or the hook's own inputs: `page`).

```json
{
  "machine": {
    "context": { "page": 1 },
    "requests": { "next_page": { "source": "photos" } },
    "states": {
      "more": {
        "initial": "idle",
        "states": {
          "idle": { "on": { "photos.more": "loading" } },
          "loading": {
            "tags": ["loading"],
            "invoke": {
              "request": "next_page",
              "input": { "obj": { "page": { "+": [{ "var": "context.page" }, 1] } } },
              "onDone": {
                "target": "idle",
                "actions": [{ "assign": { "page": { "+": [{ "var": "context.page" }, 1] } } }]
              },
              "onError": "idle"
            }
          }
        }
      }
    }
  },
  "props": [
    { "src": "348:20275", "prop": "on", "value": { "click": { "send": "photos.more" } } },
    { "src": "348:20275", "prop": "when", "value": { "path": "photos.next", "exists": true } }
  ]
}
```

The button's `when` reads the data, never a count you keep: the last page answers `next: null`, and the button is gone. `ix.load`'s `obligations` name a paged source the section does not yet ask more of: final is refused until it is wired, or named in `unmet` with a listed reason. When the source holds no field that says whether there is more (`next`, a total and a page), say so in `remaining` with what the hook should answer, rather than guessing from a count. A section with a machine already keeps it: write the whole machine, with its regions and yours.

Read ix.apply's `states` after it publishes: at first (what is drawn), after each press (the states it is in, what it asks for), after the answer. A press that asks for nothing, or a part that never hides, is not what the design means.
