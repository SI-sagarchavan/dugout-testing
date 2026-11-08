# 01 · `ui.load` sends pictures to the model

Status: done
Type: bug

## What

`ui.load` (`agents/ui-editor/src/tools.ts`) gives the model each comment's element from `summary()`, with `props` unchanged. An Image's `src` can be a `data:image/png;base64,…` value, so the picture goes into the model's context as text. The tool is `alwaysInline`, so the 16k limit never moves it out. `ui.node` uses the same `summary()`.

Stored comment contexts (`ui_comments.context`) average 620 KB, up to 995 KB. The tree's own nodes carry the same pictures.

## Fix

- In `summary()`, replace any `data:` string in props with a short handle, such as `<picture png, 412 KB>`. An edit to that prop is still possible: the model can write a new URL, and code keeps the old value when it is not changed.
- Drop `alwaysInline` from `ui.load`, or keep it only once the output is small enough for it.
- `outline()` already shortens strings to 40 characters. Leave it.

## Done when

- A test with a 500 KB `data:` source on a commented Image: `ui.load` and `ui.node` stay under 16k characters, and the handle names the type and size.
- An edit to another prop of that Image publishes with the picture unchanged.
