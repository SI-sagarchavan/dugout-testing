# 10 · The `section-composer` agent

Status: ready-for-agent
Type: task
Blocked by: 06, 09

## What

`agents/section-composer` as `spec.md` describes ("Generation"): input `description`, optional `inspiration` image and `kind`; tools `library.search`, `library.get`, `compose.check`, `compose.publish`; a skill on adapting sections and token roles.

- `compose.check` runs validate, the token lint and a render with `@fanos/renderer`, and returns issues plus the render as an image the model reads.
- The repair loop has a fixed limit; at the limit the run reports what is still off.
- `compose.publish` is a write behind approval and returns a preview link `data-bind` takes.
- Added to `apps/worker/scripts/work.ts`; `pnpm agent section-composer --tenant <t> --description "..." [--inspiration <path>]` runs it; `pnpm agent schemas` writes its schemas.

## Done when

- A scripted test (fake model, fake library) goes search → adapt → check → publish and the published tree validates.
- A live run on the demo tenant turns "a carousel of upcoming fixtures with both crests and kick-off time" into a preview that renders, in that tenant's tokens.
- With an empty library it writes from nothing and still passes `compose.check`.
