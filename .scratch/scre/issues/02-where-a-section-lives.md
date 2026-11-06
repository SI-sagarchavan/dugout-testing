# 02 · Where a published section lives for pages, and the template's shape

Status: done
Type: grilling
Blocked by: none

## Question

Studio reads a section from dugout's control plane (:4100), by the ids on a run. A page cannot: the
control plane is retiring (ADR 0027) and a page has no run. Before `surface_section` (03) can render, settle:

1. **Where the tree, plan and surface set are stored once published.** Candidates: the tenant's S3 bucket
   through the backend (the Handoff already stores files content-addressed at
   `<client>/surface-handoffs/<ab>/<cd>/<sha256>`, `services/surface-handoff`), or a backend table.
2. **What a page template carries.** Proposal: `content_type: "surface_section"`, `workflowId` for its data
   (as any Cast-bound template already has), and `data.surfaceSection: { tree, plan, surfaces }` as refs or
   inline. Compare with `dynamic_block`, whose body `kmp.service.ts` hydrates during page load
   (`/apiv3/dynamic-blocks/<id>`, around line 1208) into `template.data.dynamicBlock`.
3. **Who publishes it.** Today a person approves `page.build` and the artifacts land in the control plane.
   Does approving in Studio publish to the page store, or is that a second step ("Add to page")?
4. **Versioning.** A section is content-addressed; a template pointing at a digest never changes under a
   live page. Is that what we want, or does a template follow "latest approved"?

## Answer

Answered by the user, 2026-11-06:

1. **A column, like a template.** A page has templates; a section on a page is one more template, content
   type `Surface Section` (`surface_section`), with its DSL in a `surface_dsl` JSONB column of
   `master_templates` (and `prefill_templates`, `publish_templates`). Ticket 10.
2. **What the template carries:** `surface_dsl: { digest, tree, plan, surfaces, source, runId, handoffId,
   width }`. Data stays the Cast hook's (`source.workflowId`). Ticket 10.
3. **A separate "Add to page"** in Studio, not approving the run. Tickets 11, 13.
4. **Pinned digest.** The template holds a copy; a republished section is added again.

For now the page does not draw it: the page builder shows a placeholder, as for a plugin or a dynamic
block, with a link to preview it in Studio (ticket 12).

