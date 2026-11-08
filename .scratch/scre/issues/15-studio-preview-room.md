# 15 · Room for the preview in Studio

Status: done (2026-11-06)
Type: task
Blocked by: none

## What

Revised the same day at the user's request: no three vertical columns. The preview is the centre;
every Send is a thread at the right.

The queue screen gave the section about 375px of a 1440px screen (a 1280px section at 29%): the app
sidebar, the queue, the preview and the inspector all shared the width. wnm-fanxp-frontend
`apps/surface-studio`:

- `queue-page.tsx`: two regions. Centre: the preview. Right (`aside` "Threads", 340–420px): the
  filters, then every Send as a thread (`send-thread.tsx`).
- A thread is an accordion row (status dot, name, status · time · cost, Figma file). Clicking it
  selects the Send (the preview draws it) and opens it; clicking the selected one closes or reopens it
  and the preview stays. Open, it shows the run (`RunInspector` `variant="thread"`: figures, the waiting
  question, Cancel, then tabs **Execution · Plan · Data · Issues · Advanced**, scrolling with the list).
- `inspector-plan-tab.tsx` (new): the binding plan: its data source, each bound node, each repeat
  (list, items, cards, fields), fixed values, the raw plan.
- `use-queue-layout.ts`: the threads close (`surface_studio_queue_layout_v2`); Focus closes them and the
  app sidebar, and exiting puts back what was open.
- `preview-toolbar.tsx`: one bar over the preview in every state: the section's name, theme, width
  and scale; notices (an amber count chip), Snapshot/Live, zoom (Fit, 50%, 75%, 100%), Add to page,
  Focus, the threads toggle. Mounted once per Send, so it does not remount while the section loads.
- The app sidebar starts as its icon rail (cookie `surface_studio_sidebar_state_v2`); the Needs you count
  shows on the rail's icon.
- `queue-list-item.tsx` is gone (the thread row replaces it). `src/test/render.tsx` wraps a page in
  `SidebarProvider` (opt out with `sidebar: false`).

| 1440×900, "IN THE FRAME" (1280px) | before | after |
| --------------------------------- | ------ | ----- |
| threads open                      | 29%    | 65%   |
| Focus                             | n/a    | 98%   |

## Checked

- Tests rewritten for threads (open with the selection; clicking the selected one closes it and keeps
  the preview; picking another closes the one before; Plan tab; threads hide/show and are remembered;
  Focus). Studio: 349 pass, `tsc -b` and `oxlint` clean.
- Screenshots of a standalone Studio in `http` mode with the API answered from fixtures (the real tree,
  plan and surfaces, Southern Brave's theme) at 1440×900 and 1280×800.

## Not checked

- In the host at :5555, signed in (ticket 08).
