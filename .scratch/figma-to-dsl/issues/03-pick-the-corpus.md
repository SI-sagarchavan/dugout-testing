# 03 · Pick the corpus

Status: ready-for-human
Type: task

## What

Choose about 20 sections from pages we have already shipped, across tenants and kinds: carousel, pictures, news, video, photos, newsletter, plus a few single buttons. For each one, collect:

- the Figma export (frame IR) and section screenshot, as the plugin sends them
- the DSL we accepted for it, where one exists
- the tenant's theme (tokens)

Store them as fixtures the eval suite can read: export ids from the FanOS control plane, or files.

## Why

Everything is measured against it: the baseline (04), the evals (09) and the repair agent (11). The FanOS README already calls for a labeled corpus of what was shipped.

## Done when

- About 20 sections are listed, each with its export, screenshot, tokens and (if any) accepted DSL.
- They cover every kind of section we ship, and at least two tenants.

## Pointers

- `trial/README.md` ("a labeled corpus of what we have already shipped")
- `trial/apps/api` figma exports and artifacts
