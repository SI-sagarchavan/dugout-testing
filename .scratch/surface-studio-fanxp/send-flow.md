# Send flow: from the Figma plugin to a live page

Agreed with the user on 2026-11-05. This is the path we build on. It replaces today's flow
(plugin posts the whole export, base64 inside JSON, to `localhost:3000/v1/exports`, then
`pnpm agent watch` polls every 2 s). The wider plan is in `spec.md`; this file is the Send path in it.

**Status, 2026-11-05.** The current description of the whole flow, its components and who owns which
data is `docs/architecture/send-to-page.md`. Decisions made since this note was written:

- Two databases, and the control plane (`apps/api`, `fanos`) goes away: `docs/adr/0027-two-databases.md`.
  Where this note says the control plane stores or reads something, read it as the Send ledger
  (FanXP DB), S3 and Surface MCP. Section 4 step 3 (card-match reading "the files from S3") is how it
  will work once `surface.getSend` exists; today card-match still reads the control plane.
- Temporal runs agent runs before production: `docs/adr/0028-temporal-runs-agent-runs.md`.
- Live updates use one SSE connection per open panel from the backend, not Electric (Confluence ADR018).
- Built: plugin sign-in, the three Send calls (`POST /surface/sends`, PUT, `/complete`) in the backend and
  the plugin. Not built: `complete` queueing the run, Surface MCP, saving and publishing results.

## Why today's flow does not scale

- One request carries the IR and every PNG as base64. The news grid Send (`b4829859`) is about 4.2 MB.
  A synchronous Lambda accepts 6 MB and API Gateway 10 MB. The control plane's limit is 32 MB.
- The request has no user, tenant or theme. The plugin has no FanXP JWT or `client` header.
- The control plane stores blobs on local disk (`BlobStore` has only `fs-blob-store.ts`).
- A CLI polls for new Sends. Nothing in production would run it.

## The flow

### 1. Send (plugin to S3)

1. `POST /surface/sends` with a small JSON body: page ref, summary, and a manifest of files
   `{name, nodeId, kind, contentType, size, sha256}`. The endpoint authenticates the caller,
   creates the Send with status `uploading`, and returns a `sendId` and one presigned PUT URL for
   each file it does not already hold.
2. The plugin PUTs each file straight to S3 as raw bytes (no base64).
3. `POST /surface/sends/:id/complete`. The backend checks each object (HeadObject size and checksum),
   marks the Send `received`, and inserts the `send-to-page` row into `runs` in the same request.
   It returns the `runId`. Nothing polls.

Details:
- S3 keys are the file hash under the client's folder (section 5). A re-sent frame uploads only what changed.
- Each URL covers one key, with signed content type and length, and expires in about 15 minutes.
- The IR goes to S3 as one more file, so the request stays small for any frame size.
- `manifest.json` `networkAccess.allowedDomains` (today `http://localhost:3000`) needs the API
  domain and the S3 or CloudFront host. The bucket's CORS must allow PUT from the `null` origin with
  `Content-Type`.
- The backend's `src/utils/s3.ts` has `PutObjectCommand` and `getSignedDownloadUrl` but no upload
  signer. Add one beside it.
- The control plane needs an S3 `BlobStore` adapter, or artifact rows that reference S3 keys.
- Abandoned Sends: a lifecycle rule on the working prefix, or a sweeper for Sends stuck in `uploading`.

### 2. What the Send carries

- The IR.
- One full screenshot for the diff. The root picture (`art-root`) and the section screenshot show
  almost the same pixels on the news grid (1.35 MB each), so send one and cut the section from it.
- Vector and mask pictures (fixed crests, icons, swooshes). No API supplies them and the IR has
  no path data.
- Marked background assets (`exportMarkedAssets`), as the designer's original bytes.
- No content photos. The compiler already emits every content Image with `src: ""`
  (`packages/compile/src/compile.ts:667`) and `art-plates.ts` already treats photos as stand-ins.
  Card-match leaves Image boxes out of the pixel diff. The geometry gate still checks each box.
  Run output lists every placeholder that bind left unbound, so a missing marked asset shows up in review.
- Crests that come from data (teams in a fixture card) are content images, so placeholders. A fixed
  crest (the club's own badge in the header) is platform art and ships.

### 3. Icons

Tenants upload a Fontello icon font in the Layout Builder's font manager. The backend stores the
font and its CSS on S3 (`src/services/fonts/index.ts`). Today dugout ignores it and draws icons from
its own `ICON_REGISTRY`.
- Valid icon names come from the glyph names in the tenant's Fontello metadata.
- The compiler's `ctx.icons` alias links a Figma layer name to a glyph name, once per tenant.
- The renderer loads the tenant's icon CSS and draws the glyph by class.
- Start by still sending the small icon pictures, and let card-match ignore any icon that matched a
  glyph. Revisit once the plugin gets the glyph list from the authenticated start call.
- A font that still has default names like `icon-1` cannot be matched by name.

### 4. After the upload

1. **Run starts.** The `complete` call queues `send-to-page` with the tenant taken from the token.
2. **Worker claims it** (agents worker on ECS). Events go to the run's Valkey stream, and the
   backend's SSE route streams them to Studio.
3. **card-match** reads the files from S3, compiles the IR against the tenant theme, renders, diffs
   and fixes. Questions it cannot answer from the frame (carousel or not) pause the run under
   "Needs you". Output: DSL tree and surface set.
4. **bind** asks cast-researcher for a `dugout_` hook, or has cast-builder build one (a person
   approves each try). It writes the bound tree: refs and Repeaters applied, a `data` block naming the
   hook. Plan and sample data stay as evidence.
5. **Review.** Studio's canvas renders the tree with the tenant's theme, fonts and icons and live hook
   data by `workflowId`. The reviewer approves, requests a change, or rejects.
6. **Publish.** Approval runs the write step:
   - copy used assets from the Send's working folder to the tenant's permanent asset folder, and
     point the tree at CDN URLs;
   - `POST /surface/templates` creates or versions the `surface_v2` template and adds its
     `master_cast_template_bindings` row, so `workflowId` arrives like for every Cast-bound template.
     The same Figma frame sent again makes a new version.
7. **Live.** Someone places the template on a page in the Layout Builder, "Publish All Changes"
   snapshots it, and fanxp-web-renderer fetches `/cast/api/flow/<workflowId>` and renders it with
   `@fanos/renderer`. No agent runs and no plan is applied at serve time.

### 5. Two S3 locations with different lifetimes

Both are in the **client's own bucket** (`site_master.site_configuration.aws.bucket`; dev has
`si-build-fanxp-dev-assets` for 163 sites and `si-waf-asset-fanxp` for 167 legacy ones). The client's
root folder is the first segment of `aws.asset_upload_path` (`ibl/static-assets/` gives `ibl`).
CloudFront serves only `static-assets/*` and `*.xml` from these buckets, and public access is blocked.

- `<client>/surface-sends/<ab>/<cd>/<sha256>` holds working files. Not served. Content-addressed, so a
  re-sent frame uploads only what changed. Every upload is tagged `kind=surface-send`; one bucket-wide
  lifecycle rule on that tag (like the existing `kind=rendered-page` rule) expires them.
- **Published assets: as they work today, no new path.** A template's images go through
  `utilsService.imageUploadWrapper(fastify, client, {name, base64}, userId, 'template')`: it writes to
  `<asset_upload_path>template/<name>.<ext>` (for example `ibl/static-assets/template/...`), records the
  image row, and returns the CDN URL with `awsS3AccessPathGenerator`. Nothing there expires. The publish step
  reuses it as is (it takes base64, so it reads the working object and passes the bytes). Not built yet.

Without the copy in step 6, a live page would lose its images when the working files expire.

**Infra still to do (si-build-iac), per bucket the plugin sends to:** CORS rule allowing PUT from origin
`null` (Figma's sandbox; today the list has only localhost and `dev-fanxp.sportz.io`); lifecycle rule on
tag `kind=surface-send`; the backend task role needs `s3:PutObject`, `s3:PutObjectTagging`, `s3:GetObject`
on `*/surface-sends/*`, and the agents worker role `s3:GetObject` there.

## Open

- ~~Plugin authentication.~~ Done: see `plugin-auth.md`.
- ~~Where the Send record lives.~~ Decided: the backend's FanXP DB (`surface_sends`,
  `surface_send_files`). The control plane goes away (`docs/adr/0027-two-databases.md`).
- ~~Hashing in the plugin.~~ Done in pure JS in the sandbox (`src/auth/pkce.ts`'s `sha256`), because a null-origin
  iframe is not a secure context. Its speed inside Figma's sandbox is not measured yet (19.7 MB took 0.37 s in
  Node). The plugin logs the times.
- How the plugin learns the tenant's glyph names (see icons).
- Do not publish dugout packages to CodeArtifact (see memory). How the backend and the renderer reach
  `@fanos/*` stays an open question (spec open question 2).
