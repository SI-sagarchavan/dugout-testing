# 07 · The copied DSL stays equal to dugout's

Status: needs-triage
Type: task
Blocked by: none

## What

`packages/scre/src/dsl/` in fanxp-web-renderer is a verbatim copy of 16 files of dugout's
`packages/dsl/src` (`universal`, `field`, `binding`, `values`, `clock`, `cast`, `bind`, `ops`, `flat`,
`version`, `collapse`, `subtree-signature`, `sha1`, `nodes/{index,leaves,structural}`), with only the
`@fanos/tokens` import changed to `../tokens.js`. A DSL change in dugout that is not copied makes the
compiler emit trees the renderer reads differently.

Options: a `pnpm dsl:sync` script in dugout that writes the copy and a CI check that fails when they
differ; or move the DSL runtime into its own `@sikit` package both repos install (same registry problem
as 06). Pick one.

## Done when

- Changing a DSL file in dugout without syncing fails a check.
