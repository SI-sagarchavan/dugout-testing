/**
 * FanOS Surface Canvas — sandbox entry. FIGMA-AWARE.
 *
 * Owns the session: which frame is being checked, which theme it is checked
 * against, the reconciled binding index, the last report, and the heatmap. Every
 * decision about *what is wrong* lives in the pure engine under src/health/;
 * this file only reads Figma, writes Figma, and posts messages.
 *
 * Performance shape, because the sandbox is single-threaded and blocking it
 * freezes the canvas:
 *
 *   - traversal yields to the event loop every 500 nodes
 *   - `nodechange` on the current page is debounced 400ms
 *   - a change re-walks only the subtrees named in the event, then re-runs the
 *     pure pass over the patched tree. Full re-walk only on explicit refresh.
 *   - variables and styles are resolved once per session into Maps
 */
import { inferBreakpoint } from "./match/type.js";
import {
  ACTIVITY_PREFIX,
  appendLane,
  laneKey,
  mergeActivity,
  parseLane,
  popLane,
  type ActivityActor,
  type ActivityEntry,
  type ActivityKind,
} from "./health/activity.js";
import { reconciliationReport } from "./health/reconcile-report.js";
import { invalidateSlots } from "./health/slots.js";
import type { Batch, BatchItem, LintOptions, LintReport, ThemeSnapshot } from "./health/types.js";
import { DEFAULT_LINT_OPTIONS, isFixProposal, isRoundProposal } from "./health/types.js";
import type { FrameIRDocument, FrameIRNode } from "./ir/schema";
import { lint } from "./rules/index.js";
import {
  applyAll,
  applyBatch,
  applyCandidate,
  applyRound,
  convertGroupsToFrames,
  hugText,
  undoLastBatch,
  wrapAsColumn,
  type ApplyOptions,
  type ApplyOutcome,
} from "./fix.js";
import * as heatmap from "./heatmap.js";
import { loadBindingIndex, reconcile, type BindingIndex } from "./reconcile.js";
import {
  ASSET_PLUGIN_KEY,
  isConfident,
  matchAssetToTargets,
  parseBindings,
  placementsFromIr,
  removeBinding,
  renameBinding,
  retargetBinding,
  serializeBindings,
  setBindingFit,
  suggestAssetName,
  targetOptionsFromIr,
  upsertBinding,
  type AssetBinding,
  type AssetFit,
} from "./assets.js";
import { runExport } from "./export.js";
import { createAuthClient } from "./auth/client.js";
import { chooseTenant, tenantBlocker, type TenantsView } from "./auth/tenants.js";
import {
  CLIENT_STORAGE_AUTH_KEY,
  isExpiring,
  parseCredentials,
  type Credentials,
} from "./auth/credentials.js";
import { runLogin, type WaitingInfo } from "./auth/login.js";
import { createMissingVariables, resetDriftedVariables } from "./variables.js";
import { defaultTheme, themeById, themeChoices } from "./themes.js";
import {
  createApiClient,
  createSendsClient,
  isAllowedLoginUrl,
  prepareSend,
  resolveAuthBaseUrl,
  resolveOrigin,
  runSend,
  UnsupportedAssetError,
  type ApiClient,
  type ApiFetch,
  type ApiFetchInit,
  type StudioPage,
} from "./api/index.js";
import {
  CLIENT_STORAGE_RUNS_KEY,
  cancelWaiting,
  newRun,
  parseRuns,
  pushRun,
  replaceRun,
  setFrame,
  settleInterrupted,
  type FrameSend,
  type RunRecord,
} from "./sends.js";
import {
  CLIENT_STORAGE_API_ORIGIN_KEY,
  CLIENT_STORAGE_AUTH_BASE_URL_KEY,
  CLIENT_STORAGE_KEY,
  CLIENT_STORAGE_THEME_KEY,
  PANEL_SIZES,
  type AppliedPayload,
  type AuthView,
  type PanelState,
  type PluginMessage,
  type UiMessage,
} from "./protocol.js";
import {
  errorMessage,
  newCaches,
  traverseSubtree,
  traverseToDocument,
  yieldToEventLoop,
  type Caches,
} from "./traverse";

const NODE_CHANGE_DEBOUNCE_MS = 400;
/**
 * Our own writes come back as change events and we cannot tell them apart from
 * the designer's. So changes are ignored for a moment after a fix — which we
 * re-lint ourselves anyway, on just the subtrees we touched.
 */
const SELF_WRITE_QUIET_MS = 700;

interface State {
  booted: boolean;
  caches: Caches;
  index: BindingIndex | null;
  snapshot: ThemeSnapshot | null;
  themeId: string;
  root: SceneNode | null;
  /** The pinned frame. Survives selection changes; only "Check selection" moves it. */
  rootId: string | null;
  ir: FrameIRDocument | null;
  report: LintReport | null;
  heatmapOn: boolean;
  panelState: PanelState;
  options: LintOptions;
  busy: boolean;
  quietUntil: number;
  lastActivityId: string | null;
  /** Outbound Surface Studio client. Never blocks a lint. */
  api: ApiClient | null;
  /** The FanXP backend: where accounts live. Not the Studio `api` sends go to. */
  authBaseUrl: string;
  /** Who the plugin is signed in as, on `authOrigin`. */
  auth: Credentials | null;
  /** The sign-in in progress, if any. */
  login: { running: boolean; cancel: boolean; waiting: WaitingInfo | null };
  /** Why the plugin is signed out, when it was not the designer's doing. */
  authMessage: string | null;
  /** The clients this account may send for, and which one this file is for. */
  tenants: TenantsView;
  /** Every send this plugin has made, newest first. Persisted in clientStorage. */
  runs: RunRecord[];
  /** The run the Send tab is showing: in flight, or finished and not yet dismissed. */
  activeRunId: string | null;
  /** A send loop is running. One at a time. */
  sending: boolean;
  /** Set by Cancel; the loop reads it between frames. */
  cancelRequested: boolean;
  /**
   * The last failure, kept so `ui-ready` can replay it.
   *
   * `fail()` posts into an iframe that may not be listening yet — boot's own
   * catch fires before `figma.showUI` has a panel on the other end whenever the
   * failure is early enough. Every other piece of boot state is replayed on
   * `ui-ready` for exactly that reason; the error was the one that was not, so a
   * plugin that failed to start showed a loading placeholder forever with the
   * diagnosis posted into the void.
   */
  error: string | null;
}

const state: State = {
  booted: false,
  caches: newCaches(),
  index: null,
  snapshot: null,
  themeId: "",
  root: null,
  rootId: null,
  ir: null,
  report: null,
  heatmapOn: false,
  panelState: "expanded",
  options: DEFAULT_LINT_OPTIONS,
  busy: false,
  quietUntil: 0,
  lastActivityId: null,
  api: null,
  authBaseUrl: "",
  auth: null,
  login: { running: false, cancel: false, waiting: null },
  authMessage: null,
  tenants: { status: "idle" },
  runs: [],
  activeRunId: null,
  sending: false,
  cancelRequested: false,
  error: null,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * The message handler is installed SYNCHRONOUSLY, before any await.
 *
 * The iframe posts `ui-ready` as soon as React mounts, and that can easily land
 * before an `await figma.clientStorage.getAsync(...)` further down has resolved.
 * A handler installed after the first await misses it, and since `ui-ready` is
 * what triggers the boot payload, missing it once leaves the panel showing its
 * initial state forever — empty theme picker, "Starting…" that never moves.
 */
figma.ui.onmessage = (message: UiMessage) => {
  void handle(message).catch((err) => fail(errorMessage(err)));
};

// `void boot()` on its own swallows a rejection into an unhandled promise and the
// panel just sits there. Anything that goes wrong in here has to reach the UI.
void boot().catch((err) => fail(`Couldn't start: ${errorMessage(err)}`));

async function boot(): Promise<void> {
  state.panelState = await readPanelState();
  const size = PANEL_SIZES[state.panelState];

  figma.showUI(__html__, { width: size.width, height: size.height, themeColors: true });
  // Applied again on `ui-ready` — see the note there. Once is not enough.
  applyPanelSize(state.panelState);

  heatmap.registerCleanup();
  heatmap.clearStaleOverlays();

  const storedTheme = await readStoredTheme();
  const theme = (storedTheme && themeById(storedTheme)) || defaultTheme();
  state.themeId = theme.id;

  const origin = resolveOrigin(await readStoredApiOrigin());
  state.api = createApiClient({ origin, fetch: sandboxFetch });
  state.authBaseUrl = resolveAuthBaseUrl(await readStoredAuthBaseUrl());
  state.auth = parseCredentials(await readStoredAuth(), state.authBaseUrl);
  console.log(`[fanos-studio] api origin ${origin}`);

  // A send that was still going when the plugin closed never finished. Settle it
  // as a failure so Runs can offer Re-send instead of showing it uploading forever.
  state.runs = parseRuns(await readStoredRuns()).map(settleInterrupted);
  void saveRuns();

  state.booted = true;
  if (state.auth) void loadTenants();
  // Sent unconditionally AND replayed on every `ui-ready`. Whichever side wins
  // the race, the panel ends up with the payload.
  postBoot();
  // The window opens before storage is read, so the panel's `ui-ready` can arrive
  // while auth and runs are still empty. Post them now that they are loaded;
  // otherwise a restart shows "signed out" with valid credentials in hand.
  postAuth();
  postRuns();
  postTenants();

  figma.on("selectionchange", postSelection);
  // `figma.on("documentchange")` is unavailable under `documentAccess:
  // dynamic-page` without calling `loadAllPagesAsync()` first, which on a real
  // file means loading every page before the panel can do anything. The page-
  // scoped `nodechange` event is what we actually want anyway: this plugin only
  // ever lints the current page.
  watchCurrentPage();
  // The listener above is bound to one page, so switching pages has to re-bind
  // it and re-lint. Otherwise the panel keeps showing a confident report about a
  // page the designer has left.
  figma.on("currentpagechange", () => {
    watchCurrentPage();
    // A new page needs a new root; the pinned one lives on the old one.
    state.rootId = null;
    void fullLint(true);
  });
  postSelection();

  await fullLint();
}

let unwatchPage: (() => void) | undefined;

function watchCurrentPage(): void {
  unwatchPage?.();
  const page = figma.currentPage;
  page.on("nodechange", onNodeChange);
  unwatchPage = () => page.off("nodechange", onNodeChange);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handle(message: UiMessage): Promise<void> {
  switch (message.type) {
    case "ui-ready":
      // Replay everything the panel needs, in the order it needs it. The iframe
      // re-sends `ui-ready` if it hasn't heard back, so this has to be safe to
      // run more than once — it is: all three are plain re-posts of current state.
      if (state.booted) postBoot();
      // Re-apply the window size now that the iframe genuinely exists. Figma
      // restores the size the user last dragged this plugin to, and that restore
      // can land AFTER the `showUI` call — clobbering a size set in the same
      // tick. Doing it again here is what makes the collapsed state stick.
      applyPanelSize(state.panelState);
      postSelection();
      // Only once boot has read storage: before that these are empty, and
      // posting them would tell the panel it is signed out.
      if (state.booted) {
        postRuns();
        postAuth();
        postTenants();
      }
      if (state.report) postReport(state.report, "full");
      // Replayed like everything else above. A failure that happened before the
      // iframe existed is the one a reader most needs, and it is the one that
      // was previously lost.
      if (state.error) post({ type: "error", message: state.error });
      // ALWAYS, not just when there is no report. `busy` starts true in the
      // panel and is only ever cleared by a status message, so a run that
      // finished before the iframe was listening would otherwise leave it stuck
      // on "Starting…" with every button disabled — with a perfectly good
      // report already on screen.
      status(state.busy ? "Reading the page…" : "", state.busy);
      return;
    case "refresh":
      // An explicit refresh re-reads EVERYTHING, variables included. Somebody who
      // just created the missing variables the reconciliation report asked for
      // needs this to pick them up — the index is cached for the session
      // otherwise, and the batches would stay disabled with no way to fix it.
      state.index = null;
      await fullLint();
      return;
    case "retarget":
      await fullLint(true);
      return;
    case "select-theme":
      await selectTheme(message.themeId);
      return;
    case "select-batch":
      selectBatchLayers(message.batchId);
      return;
    case "apply-batch":
      await applyBatchById(message.batchId, null);
      return;
    case "autofix":
      await runAutofix();
      return;
    case "apply-round":
      await applyRoundById(message.batchId);
      return;
    case "apply-structural":
      await applyStructural(message.action);
      return;
    case "reset-drift":
      await resetDrift(message.refs);
      return;
    case "select-nodes":
      await selectNodes(message.nodeIds);
      return;
    case "hug-text":
      await hugPinnedText(message.nodeIds);
      return;
    case "create-variables":
      await createVariables(message.refs);
      return;
    case "apply-candidate":
      await applyBatchById(message.batchId, message.tokenRef);
      return;
    case "undo-last":
      undoLastBatch();
      if (state.root) retractActivity(state.root, state.lastActivityId);
      state.lastActivityId = null;
      state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
      await fullLint();
      return;
    case "dismiss-undo":
      return;
    case "toggle-heatmap":
      toggleHeatmap(message.on);
      return;
    case "set-panel-state":
      await setPanelState(message.state);
      return;
    case "upload-asset":
      await uploadAsset(message);
      return;
    case "place-asset":
      await placeAsset(message);
      return;
    case "retarget-asset":
      await retargetAsset(message.key, message.targetId);
      return;
    case "remove-asset":
      removeAsset(message.key);
      return;
    case "rename-asset":
      renameAsset(message.key, message.name);
      return;
    case "set-asset-fit":
      setAssetFit(message.key, message.fit);
      return;
    case "send-frames":
      await sendFrames(message.frameIds);
      return;
    case "retry-frames":
      await retryFrames(message.runId, message.frameIds);
      return;
    case "cancel-send":
      cancelSend();
      return;
    case "restart-send":
      await restartSend(message.runId);
      return;
    case "dismiss-send":
      state.activeRunId = null;
      postRuns();
      return;
    case "download-zip":
      await downloadZip(message.frameIds);
      return;
    case "open-studio":
      if (state.api) figma.openExternal(state.api.origin);
      return;
    case "auth-start":
      await startLogin(message.verifier);
      return;
    case "auth-cancel":
      state.login.cancel = true;
      return;
    case "auth-open":
      reopenLogin();
      return;
    case "auth-sign-out":
      await signOut();
      return;
    case "tenants-load":
      await loadTenants();
      return;
    case "tenant-select":
      selectTenant(message.code);
      return;
    case "close":
      figma.closePlugin();
      return;
  }
}

// ---------------------------------------------------------------------------
// Linting
// ---------------------------------------------------------------------------

async function fullLint(repick = false): Promise<void> {
  // A fresh attempt clears the last verdict. Without this the banner from a
  // failure three actions ago sits above a report that succeeded.
  state.error = null;
  const root = await resolveRoot(repick);
  if (!root) {
    fail("This page has no frame to check. Add a frame, or select the one you want checked.");
    return;
  }
  state.root = root;
  await busy(async () => {
    // Walk FIRST. The traversal's id->name cache ends up holding every variable
    // the page is already bound to, and on a library-driven file those are the
    // only real Variable objects there are — `getLocalVariableCollectionsAsync`
    // returns nothing at all. Reconciling before the walk means reconciling
    // against an empty file.
    status("Walking the page…");
    const { document } = await traverseToDocument(root, state.caches, (message, nodes) =>
      status(nodes > 0 ? `${message}` : message),
    );
    state.ir = document;

    status("Reading variables…");
    if (!state.index) state.index = await loadBindingIndex(state.caches.variables.keys());

    const theme = themeById(state.themeId) ?? defaultTheme();
    status(`Reconciling ${theme.name}…`);
    state.snapshot = await reconcile(theme, state.index);

    status("Linting…");
    runLint("full");
    if (state.heatmapOn && state.ir) heatmap.draw(state.ir);
  });
}

function runLint(scope: "full" | "incremental"): void {
  /**
   * Say so, rather than returning into silence.
   *
   * Both of these are set earlier in `fullLint`, so a miss here means a step
   * before it bailed without throwing. The panel cannot tell that apart from
   * "still working" — no report, no status, no error — which is precisely the
   * stuck "Reading the page…" this exists to prevent.
   */
  if (!state.ir || !state.snapshot) {
    fail(
      !state.ir
        ? "The page was read but produced no document to lint — nothing to report."
        : "No theme snapshot to lint against — reconciliation produced nothing.",
    );
    return;
  }
  // An incremental re-lint patches subtrees in place under the SAME root object,
  // which would otherwise hit the memoized slot walk and report the score from
  // before the edit. Dropping it here means every lint sees the tree as it is.
  invalidateSlots(state.ir.root);
  const started = Date.now();
  const report = lint(
    state.ir,
    {
      theme: state.snapshot,
      breakpoint: inferBreakpoint(state.ir.breakpointHint),
      options: state.options,
    },
    started,
  );
  state.report = report;
  postReport(report, scope);
  postAssets();
}

function postBoot(): void {
  post({
    type: "boot",
    payload: {
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      themes: themeChoices(),
      themeId: state.themeId,
      panelState: state.panelState,
      user: currentActor(),
    },
  });
  postAssets();
}

function postReport(report: LintReport, scope: "full" | "incremental"): void {
  if (!state.snapshot) return;
  post({
    type: "report",
    report,
    reconciliation: reconciliationReport(state.snapshot),
    activity: state.root ? readActivity(state.root) : [],
    scope,
    nodeCount: state.ir ? heatmap.nodeCountFor(state.ir.root) : 0,
  });
  // A report is a fact; `busy` is a fact about the sandbox. They travel together
  // so the panel can never end up holding one without the other.
  post({ type: "status", message: state.busy ? "Linting…" : "", busy: state.busy });
  // The screenshot follows the check: a full report means the checked frame was
  // (re)read, which is when it can have moved or changed.
  if (scope === "full") schedulePreview();
}

/**
 * The frame being checked, which STAYS the frame being checked.
 *
 * Once resolved it is pinned to `state.rootId` and every later lint re-reads
 * that same node. Re-targeting happens in exactly two places: an explicit
 * "Check selection" from the panel, and a page change. Nothing else moves it —
 * least of all a refresh, which used to re-derive the root from whatever
 * happened to be selected and so followed "Select layers" onto a single card.
 */
async function resolveRoot(repick: boolean): Promise<SceneNode | null> {
  if (!repick && state.rootId) {
    const pinned = await figma.getNodeByIdAsync(state.rootId);
    // Still alive, still on this page, still something we can walk.
    if (
      pinned &&
      !(pinned as SceneNode).removed &&
      "children" in pinned &&
      isOnCurrentPage(pinned as SceneNode)
    ) {
      return pinned as SceneNode;
    }
  }

  const picked = pickRoot();
  state.rootId = picked?.id ?? null;
  return picked;
}

function isOnCurrentPage(node: SceneNode): boolean {
  let current: BaseNode | null = node;
  while (current) {
    if (current.id === figma.currentPage.id) return true;
    current = current.parent;
  }
  return false;
}

/**
 * A selected container wins — that is what "Check selection" means. Otherwise
 * the page's biggest top-level container, which on a real page is the design.
 */
function pickRoot(): SceneNode | null {
  const selection = figma.currentPage.selection;
  if (selection.length === 1 && "children" in selection[0]!) return selection[0]!;

  const candidates = figma.currentPage.children.filter(
    (node) => node.visible !== false && node.name !== heatmap.HEATMAP_FRAME_NAME,
  );
  if (candidates.length === 0) return null;

  // Containers first, then biggest. Area alone picks a full-bleed background
  // image over the layout sitting next to it — a node with nothing bindable
  // inside it, which reads in the panel as a page with 0% coverage.
  const containers = candidates.filter(
    (node) => "children" in node && (node as ChildrenMixin).children.length > 0,
  );
  const pool = containers.length > 0 ? containers : candidates;

  let best = pool[0]!;
  let bestArea = area(best);
  for (const node of pool.slice(1)) {
    const a = area(node);
    if (a > bestArea) {
      best = node;
      bestArea = a;
    }
  }
  return best;
}

function area(node: SceneNode): number {
  const box = "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
  return (box?.width ?? 0) * (box?.height ?? 0);
}

// ---------------------------------------------------------------------------
// Incremental re-lint
// ---------------------------------------------------------------------------

let pendingChanges = new Set<string>();
let debounceTimer: number | undefined;

function onNodeChange(event: NodeChangeEvent): void {
  // Only our own writes are ignored, and only briefly — we re-lint those
  // ourselves, on just the subtrees we touched. Everything the designer does is
  // collected, even mid-lint, so an edit made while Studio is working is not
  // silently dropped.
  if (Date.now() < state.quietUntil) return;
  for (const change of event.nodeChanges) pendingChanges.add(change.id);
  scheduleRelint();
}

function scheduleRelint(): void {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    // Mid-lint: leave the ids queued and come back rather than running two
    // traversals over the same tree.
    if (state.busy) {
      scheduleRelint();
      return;
    }
    const ids = [...pendingChanges];
    pendingChanges = new Set();
    void relint(ids).catch((err) => fail(errorMessage(err)));
  }, NODE_CHANGE_DEBOUNCE_MS);
}

interface IrLocation {
  node: FrameIRNode;
  parent: FrameIRNode | null;
  index: number;
}

function indexIr(root: FrameIRNode): Map<string, IrLocation> {
  const map = new Map<string, IrLocation>();
  const stack: Array<{ node: FrameIRNode; parent: FrameIRNode | null; index: number }> = [
    { node: root, parent: null, index: -1 },
  ];
  while (stack.length > 0) {
    const item = stack.pop()!;
    map.set(item.node.id, { node: item.node, parent: item.parent, index: item.index });
    for (let i = item.node.children.length - 1; i >= 0; i--) {
      stack.push({ node: item.node.children[i]!, parent: item.node, index: i });
    }
  }
  return map;
}

/**
 * Re-walks only the subtrees that changed, then re-runs the pure pass over the
 * patched tree.
 *
 * The pure pass is cheap and whole-page rules (the blockers, the naming warn)
 * need the whole tree anyway, so the saving that matters is the Figma reads —
 * which is where all the time goes.
 */
async function relint(changedIds: string[]): Promise<void> {
  if (!state.ir || changedIds.length === 0) return;

  const located = indexIr(state.ir.root);
  const roots = new Set<string>();
  for (const id of changedIds) {
    const anchor = await anchorFor(id, located);
    if (anchor === "full") {
      await fullLint();
      return;
    }
    if (anchor) roots.add(anchor);
  }
  if (roots.size === 0) return;

  await busy(async () => {
    for (const id of roots) {
      const location = located.get(id);
      if (!location) continue;
      const node = await figma.getNodeByIdAsync(id);
      if (!node || (node as SceneNode).removed) {
        if (location.parent) location.parent.children.splice(location.index, 1);
        continue;
      }
      const fresh = await traverseSubtree(node as SceneNode, location.node.depth, state.caches);
      if (location.parent) location.parent.children[location.index] = fresh;
      else if (state.ir) state.ir = { ...state.ir, root: fresh };
    }
    runLint("incremental");
    if (state.heatmapOn && state.ir) heatmap.draw(state.ir);
  });
}

/**
 * The nearest ancestor of a changed node that the cached IR knows about.
 *
 * A brand-new layer is not in the tree, but its parent is; re-walking the parent
 * picks it up. Nothing on the path being known means the change was outside the
 * frame we are checking, or the tree moved under us — the caller falls back to a
 * full pass.
 */
async function anchorFor(
  id: string,
  located: Map<string, IrLocation>,
): Promise<string | "full" | null> {
  if (located.has(id)) return id;

  const node = await figma.getNodeByIdAsync(id);
  if (!node) return null;

  let current: BaseNode | null = (node as SceneNode).parent ?? null;
  for (let hops = 0; current && hops < 64; hops++) {
    if (located.has(current.id)) return current.id;
    current = current.parent;
  }
  // Outside the checked frame entirely — a change on another page or another
  // top-level frame. Nothing to do.
  return null;
}

// ---------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------

async function applyBatchById(batchId: string, tokenRef: string | null): Promise<void> {
  const batch = state.report?.batches.find((b) => b.id === batchId);
  if (!batch) {
    fail("That batch is from an older report. Refresh and try again.");
    return;
  }
  const proposal = batch.proposal;
  if (!proposal || !isFixProposal(proposal)) {
    fail(`${batch.label} has no fix to apply.`);
    return;
  }

  const ref = tokenRef ?? proposal.tokenRef;
  const binding = bindingFor(ref);
  if (!binding) {
    fail(`${ref} has nothing behind it in this file.`);
    return;
  }
  const index = state.index;
  if (!index) {
    fail("Variables haven't been read yet. Refresh and try again.");
    return;
  }

  await busy(async () => {
    status(`Binding ${batch.count} ${batch.count === 1 ? "layer" : "layers"} to ${ref}…`);
    const expected = expectedValueFor(ref);
    const outcome: ApplyOutcome =
      tokenRef === null
        ? await applyBatch({ batch, tokenRef: ref, binding, index, ...(expected ? { expected } : {}) })
        : await applyCandidate({ batch, tokenRef: ref, binding, index, ...(expected ? { expected } : {}) });

    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    figma.notify(
      outcome.applied === 0 && outcome.failed > 0
        ? "Already bound on this frame — someone else may have got there first."
        : outcome.failed > 0
          ? `Bound ${outcome.applied} of ${batch.count} — ${outcome.failed} failed.`
          : `Bound ${outcome.applied} ${outcome.applied === 1 ? "layer" : "layers"} to ${ref}. One undo reverts all of it.`,
    );

    postApplied(
      {
        batchId: batch.id,
        label: batch.label,
        tokenRef: ref,
        applied: outcome.applied,
        failed: outcome.failed,
        failures: outcome.failures,
        undoable: outcome.applied > 0,
      },
      "bind",
    );

    // Re-lint the affected subtrees only, per the spec — not the whole page.
    await relintAffected(batch);
  });
}

async function applyRoundById(batchId: string): Promise<void> {
  const batch = state.report?.batches.find((item) => item.id === batchId);
  if (!batch) {
    fail("That batch is from an older report. Refresh and try again.");
    return;
  }
  const proposal = batch.proposal;
  if (!proposal || !isRoundProposal(proposal)) {
    fail(`${batch.label} isn't a value to round.`);
    return;
  }

  await busy(async () => {
    status(`Rounding ${batch.count} ${batch.count === 1 ? "value" : "values"}…`);
    const outcome = await applyRound(batch);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    figma.notify(
      outcome.failed > 0
        ? `Rounded ${outcome.applied} of ${batch.count} — ${outcome.failed} failed.`
        : `Rounded ${outcome.applied} ${outcome.applied === 1 ? "value" : "values"} to ${proposal.roundedTo}. One undo reverts all of it.`,
    );
    postApplied({
      batchId: batch.id,
      label: `Rounded to ${proposal.roundedTo}`,
      tokenRef: "round",
      applied: outcome.applied,
      failed: outcome.failed,
      failures: outcome.failures,
      undoable: outcome.applied > 0,
    });
    await relintAffected(batch);
  });
}

async function applyStructural(action: "wrap-autolayout" | "convert-groups"): Promise<void> {
  const report = state.report;
  if (!report) {
    fail("Nothing has been checked yet.");
    return;
  }
  const planned = report.actions.find((item) => item.id === action);
  if (!planned) {
    fail("That fix is from an older report. Refresh and try again.");
    return;
  }

  await busy(async () => {
    status(action === "wrap-autolayout" ? "Stacking as a column…" : "Turning groups into frames…");
    const outcome =
      action === "wrap-autolayout"
        ? await wrapAsColumn(planned.nodeIds[0] ?? report.rootNodeId)
        : await convertGroupsToFrames(planned.nodeIds);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    state.index = null;
    figma.notify(
      outcome.failed > 0
        ? `${planned.label}: ${outcome.applied} done, ${outcome.failed} failed.`
        : `${planned.label}. One undo reverts it.`,
    );
    postApplied({
      batchId: action,
      label: planned.label,
      tokenRef: action,
      applied: outcome.applied,
      failed: outcome.failed,
      failures: outcome.failures,
      undoable: outcome.applied > 0,
    });
    await fullLint();
  });
}

async function resetDrift(requested?: string[]): Promise<void> {
  const snapshot = state.snapshot;
  const index = state.index;
  if (!snapshot || !index) {
    fail("Nothing has been checked yet.");
    return;
  }
  const refs =
    requested && requested.length > 0
      ? requested
      : [
          ...snapshot.colors,
          ...snapshot.spaces,
          ...snapshot.radii,
        ]
          .filter((entry) => entry.binding?.valueMatches === false)
          .map((entry) => entry.ref);
  if (refs.length === 0) {
    figma.notify("No drifted variables to reset.");
    return;
  }

  await busy(async () => {
    status(`Resetting ${refs.length} ${refs.length === 1 ? "variable" : "variables"}…`);
    const result = await resetDriftedVariables(refs, snapshot, index);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    figma.notify(
      result.created.length === 0
        ? `Nothing reset — ${result.skipped[0]?.reason ?? "nothing to do"}.`
        : `Reset ${result.created.length} ${result.created.length === 1 ? "variable" : "variables"} to the theme. One undo reverts them.`,
    );
    postApplied({
      batchId: "reset-drift",
      label: "Reset to theme",
      tokenRef: result.created.map((entry) => entry.figmaName).join(", ") || "none",
      applied: result.created.length,
      failed: result.skipped.length,
      failures: result.skipped.map((entry) => `${entry.ref}: ${entry.reason}`).slice(0, 5),
      undoable: result.created.length > 0,
    });
    state.index = null;
    await fullLint();
  });
}

async function hugPinnedText(requested?: string[]): Promise<void> {
  const ids =
    requested && requested.length > 0
      ? requested
      : (state.report?.sizing.pinnedText.map((item) => item.nodeId) ?? []);
  if (ids.length === 0) {
    figma.notify("No pinned text to hug.");
    return;
  }

  await busy(async () => {
    status(`Hugging ${ids.length} ${ids.length === 1 ? "text layer" : "text layers"}…`);
    const outcome = await hugText(ids);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    figma.notify(
      outcome.failed > 0
        ? `Hugged ${outcome.applied} of ${ids.length} — ${outcome.failed} failed.`
        : `Hugged ${outcome.applied} ${outcome.applied === 1 ? "text layer" : "text layers"}. Copy can grow the box. One undo reverts.`,
    );
    postApplied({
      batchId: "hug-text",
      label: "Hug height",
      tokenRef: "textAutoResize",
      applied: outcome.applied,
      failed: outcome.failed,
      failures: outcome.failures,
      undoable: outcome.applied > 0,
    });
    await fullLint();
  });
}

async function selectNodes(ids: readonly string[]): Promise<void> {
  const nodes: SceneNode[] = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && !(node as SceneNode).removed) nodes.push(node as SceneNode);
  }
  if (nodes.length === 0) {
    figma.notify("Those layers are gone. Refresh the report.");
    return;
  }
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
}

/**
 * The tokens an exact batch wants and this file does not have.
 *
 * Deliberately only these: the queue's actual blockers, never the whole theme.
 * Unlocking four batches is not a licence to add 252 variables to somebody's
 * file.
 */
function missingTokenRefs(): string[] {
  const report = state.report;
  if (!report) return [];
  const refs = new Set<string>();
  for (const batch of report.batches) {
    const proposal = batch.proposal;
    if (!proposal || !isFixProposal(proposal)) continue;
    if (proposal.bindable) continue;
    if (proposal.kind !== "exact" && proposal.kind !== "near") continue;
    // Only genuinely absent ones. A variable that exists but holds the wrong
    // value is a conflict to resolve by hand, not a thing to create twice.
    if (bindingFor(proposal.tokenRef)) continue;
    refs.add(proposal.tokenRef);
  }
  return [...refs];
}

async function createVariables(requested?: string[]): Promise<void> {
  const snapshot = state.snapshot;
  const index = state.index;
  if (!snapshot || !index) {
    fail("Nothing has been checked yet.");
    return;
  }

  const refs = requested && requested.length > 0 ? requested : missingTokenRefs();
  if (refs.length === 0) {
    figma.notify("Every token the queue needs already exists.");
    return;
  }

  await busy(async () => {
    status(`Creating ${refs.length} ${refs.length === 1 ? "variable" : "variables"}…`);
    const result = await createMissingVariables(refs, snapshot, index);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;

    figma.notify(
      result.created.length === 0
        ? `No variables created — ${result.skipped[0]?.reason ?? "nothing to do"}.`
        : `Created ${result.created.length} ${result.created.length === 1 ? "variable" : "variables"} in "${result.collectionName}". One undo removes them.`,
    );

    postApplied(
      {
        batchId: "create-variables",
        label: `New variables in ${result.collectionName}`,
        tokenRef: result.created.map((entry) => entry.figmaName).join(", ") || "none",
        applied: result.created.length,
        failed: result.skipped.length,
        failures: result.skipped.map((entry) => `${entry.ref}: ${entry.reason}`).slice(0, 5),
        undoable: result.created.length > 0,
      },
      "add",
    );

    // The variables exist now, so the index and every proposal are stale.
    state.index = null;
    await fullLint();
  });
}

/**
 * Every safe batch, one undo step, one report afterwards.
 *
 * A batch whose token cannot be resolved is dropped from the run rather than
 * failing it — the rest of the fix is still worth having, and the panel names
 * what was left behind.
 */
async function runAutofix(): Promise<void> {
  const report = state.report;
  const index = state.index;
  if (!report || !index) {
    fail("Nothing has been checked yet.");
    return;
  }

  const safe = report.batches.filter((batch) => batch.safe);
  if (safe.length === 0) {
    figma.notify("Nothing here is safe to bind unattended.");
    return;
  }

  const plan: ApplyOptions[] = [];
  const unresolved: string[] = [];
  for (const batch of safe) {
    const proposal = batch.proposal;
    if (!proposal || !isFixProposal(proposal)) continue;
    const binding = bindingFor(proposal.tokenRef);
    if (!binding) {
      unresolved.push(proposal.tokenRef);
      continue;
    }
    const expected = expectedValueFor(proposal.tokenRef);
    plan.push({
      batch,
      tokenRef: proposal.tokenRef,
      binding,
      index,
      ...(expected ? { expected } : {}),
    });
  }

  if (plan.length === 0) {
    fail(`None of the proposed tokens could be resolved (${unresolved.slice(0, 3).join(", ")}).`);
    return;
  }

  const layers = plan.reduce((sum, item) => sum + item.batch.count, 0);

  await busy(async () => {
    status(`Autofixing ${layers} ${layers === 1 ? "layer" : "layers"}…`);
    const outcome = await applyAll(plan);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;

    figma.notify(
      outcome.failed > 0
        ? `Autofix bound ${outcome.applied} of ${layers} — ${outcome.failed} failed.`
        : `Autofix bound ${outcome.applied} ${outcome.applied === 1 ? "layer" : "layers"} across ${plan.length} ${plan.length === 1 ? "batch" : "batches"}. One undo reverts all of it.`,
    );

    postApplied(
      {
        batchId: "autofix",
        label: `Autofix · ${plan.length} ${plan.length === 1 ? "batch" : "batches"}`,
        tokenRef: `${plan.length} ${plan.length === 1 ? "token" : "tokens"}`,
        applied: outcome.applied,
        failed: outcome.failed,
        failures: [
          ...outcome.failures,
          ...(unresolved.length > 0 ? [`Skipped: ${unresolved.join(", ")}`] : []),
        ].slice(0, 5),
        undoable: outcome.applied > 0,
      },
      "autofix",
    );
  });

  // Fresh index + full walk. Incremental patching left bound layers in the
  // queue, so Bind 130 looked like it only did a slice and needed another click.
  state.index = null;
  await fullLint();
}

async function relintAffected(batch: Batch): Promise<void> {
  await relintItems(batch.items);
}

/**
 * Re-walks just the layers a fix touched, then re-runs the pure pass once.
 *
 * Deduped and linted ONCE for the whole set — an autofix over six batches must
 * not run six full rule passes, and a layer that appears in two batches must not
 * be walked twice.
 */
async function relintItems(items: readonly BatchItem[]): Promise<void> {
  if (!state.ir || items.length === 0) return;
  const located = indexIr(state.ir.root);
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.nodeId)) continue;
    seen.add(item.nodeId);
    const location = located.get(item.nodeId);
    if (!location) continue;
    const node = await figma.getNodeByIdAsync(item.nodeId);
    if (!node || (node as SceneNode).removed) continue;
    const fresh = await traverseSubtree(node as SceneNode, location.node.depth, state.caches);
    if (location.parent) location.parent.children[location.index] = fresh;
    else state.ir = { ...state.ir, root: fresh };
  }

  runLint("incremental");
  if (state.heatmapOn && state.ir) heatmap.draw(state.ir);
}

/**
 * What the theme says this token holds, rendered for comparison. A library
 * variable's value cannot be read until it is imported, so this travels with the
 * apply and is checked on the other side.
 */
function expectedValueFor(ref: string): string | undefined {
  const snapshot = state.snapshot;
  if (!snapshot) return undefined;
  const color = snapshot.colors.find((entry) => entry.ref === ref);
  if (color) return color.hex;
  const number =
    snapshot.spaces.find((entry) => entry.ref === ref) ??
    snapshot.radii.find((entry) => entry.ref === ref);
  return number ? String(number.px) : undefined;
}

function bindingFor(ref: string) {
  const snapshot = state.snapshot;
  if (!snapshot) return undefined;
  const pools = [
    snapshot.colors,
    snapshot.spaces,
    snapshot.radii,
    snapshot.types,
    snapshot.shadows,
    snapshot.gradients,
  ];
  for (const pool of pools) {
    const hit = pool.find((entry) => entry.ref === ref);
    if (hit?.binding) return hit.binding;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Selection, heatmap, panel, export
// ---------------------------------------------------------------------------

function selectBatchLayers(batchId: string): void {
  const batch = state.report?.batches.find((b) => b.id === batchId);
  if (!batch) return;

  void (async () => {
    const nodes: SceneNode[] = [];
    for (const item of batch.items) {
      const node = await figma.getNodeByIdAsync(item.nodeId);
      if (node && !(node as SceneNode).removed) nodes.push(node as SceneNode);
    }
    if (nodes.length === 0) {
      figma.notify("Those layers are gone. Refresh the report.");
      return;
    }
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
  })();
}

function toggleHeatmap(on: boolean): void {
  state.heatmapOn = on;
  if (!on) {
    heatmap.clearStaleOverlays();
    post({ type: "heatmap", on: false, nodes: 0 });
    return;
  }
  if (!state.ir) {
    post({ type: "heatmap", on: false, nodes: 0 });
    return;
  }
  const result = heatmap.draw(state.ir);
  if (result.truncated) {
    figma.notify(`Heatmap drawn for the first ${result.nodes} layers.`);
  }
  post({ type: "heatmap", on: true, nodes: result.nodes });
}

async function selectTheme(themeId: string): Promise<void> {
  if (!themeById(themeId)) {
    fail("That theme isn't bundled into this build.");
    return;
  }
  state.themeId = themeId;
  await figma.clientStorage.setAsync(CLIENT_STORAGE_THEME_KEY, themeId);

  // A different tenant means different names, different values, and therefore a
  // different set of bindable tokens — every batch is re-proposed.
  await busy(async () => {
    if (!state.index) state.index = await loadBindingIndex(state.caches.variables.keys());
    const theme = themeById(themeId)!;
    status(`Reconciling ${theme.name}…`);
    state.snapshot = await reconcile(theme, state.index);
    runLint("full");
  });
}

async function setPanelState(next: PanelState): Promise<void> {
  applyPanelSize(next);
  await figma.clientStorage.setAsync(CLIENT_STORAGE_KEY, next);
}

/**
 * Resize, then tell the UI what it actually got.
 *
 * The panel deliberately does not flip its own layout on a click. If the resize
 * throws — and it is the one call here that talks to the host window — the UI
 * keeps drawing the layout that matches the window that exists, instead of a
 * collapsed bar floating in a tall box.
 */
function applyPanelSize(next: PanelState): void {
  const size = PANEL_SIZES[next];
  try {
    figma.ui.resize(size.width, size.height);
    state.panelState = next;
  } catch (err) {
    console.log(`[fanos-studio] resize to ${size.width}x${size.height} failed: ${errorMessage(err)}`);
  }
  post({ type: "panel-state", state: state.panelState });
}

async function readPanelState(): Promise<PanelState> {
  try {
    const stored = await figma.clientStorage.getAsync(CLIENT_STORAGE_KEY);
    return stored === "collapsed" ? "collapsed" : "expanded";
  } catch {
    return "expanded";
  }
}

async function readStoredTheme(): Promise<string | undefined> {
  try {
    const stored = await figma.clientStorage.getAsync(CLIENT_STORAGE_THEME_KEY);
    return typeof stored === "string" ? stored : undefined;
  } catch {
    return undefined;
  }
}

async function readStoredApiOrigin(): Promise<string | undefined> {
  try {
    const stored = await figma.clientStorage.getAsync(CLIENT_STORAGE_API_ORIGIN_KEY);
    return typeof stored === "string" ? stored : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Figma's fetch, narrowed to the client's contract. The URL is a string and
 * headers are a plain object — that is what the sandbox accepts.
 */
const sandboxFetch: ApiFetch = (url: string, init: ApiFetchInit) => {
  const { body, ...rest } = init;
  // Bytes go as a Uint8Array that owns exactly those bytes: the sandbox's fetch validates the
  // body as a string or a Uint8Array and rejects an ArrayBuffer, and a view onto a larger
  // buffer would be copied whole, so a view is copied to its own.
  return fetch(url, { ...rest, ...(body === undefined ? {} : { body: exactBytes(body) }) });
};

function exactBytes(body: string | Uint8Array): string | Uint8Array<ArrayBuffer> {
  if (typeof body === "string") return body;
  return body.byteOffset === 0 && body.byteLength === body.buffer.byteLength
    ? (body as Uint8Array<ArrayBuffer>)
    : body.slice();
}

// ---------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------

function postRuns(): void {
  post({ type: "runs", runs: state.runs, activeId: state.activeRunId });
}

async function saveRuns(): Promise<void> {
  try {
    await figma.clientStorage.setAsync(CLIENT_STORAGE_RUNS_KEY, state.runs);
  } catch {
    // History is a convenience. A full or unavailable store must not fail a send.
  }
}

async function readStoredRuns(): Promise<unknown> {
  try {
    return await figma.clientStorage.getAsync(CLIENT_STORAGE_RUNS_KEY);
  } catch {
    return undefined;
  }
}

function getRun(runId: string): RunRecord | undefined {
  return state.runs.find((run) => run.id === runId);
}

/** Write one run back, tell the panel, and keep the history on disk. */
function commitRun(run: RunRecord): void {
  state.runs = replaceRun(state.runs, run);
  postRuns();
  void saveRuns();
}

function patchFrame(runId: string, frameId: string, patch: Partial<Omit<FrameSend, "frameId">>): void {
  const run = getRun(runId);
  if (run) commitRun(setFrame(run, frameId, patch));
}

/**
 * Send each frame as its own Send, in order.
 *
 * One frame is walked, posted, and settled before the next starts: the walk is
 * single-threaded in the sandbox anyway, and a failure then belongs to exactly
 * one frame rather than to "the send". Nothing here throws into the session —
 * a frame that cannot go out is recorded as failed with the reason.
 */
async function sendFrames(frameIds: string[]): Promise<void> {
  if (state.sending) return;
  const ids = [...new Set(frameIds)];
  if (ids.length === 0) {
    fail("Select the frames you want to send.");
    return;
  }

  const frames: Array<{ frameId: string; name: string }> = [];
  for (const id of ids) {
    const node = await sceneNode(id);
    frames.push({ frameId: id, name: node?.name ?? "Missing frame" });
  }

  const at = Date.now();
  const run = newRun({
    id: `run-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at,
    fileName: figma.root.name,
    origin: state.authBaseUrl,
    frames,
  });
  state.runs = pushRun(state.runs, run);
  state.activeRunId = run.id;
  postRuns();
  void saveRuns();

  await processRun(run.id, ids);
}

async function retryFrames(runId: string, frameIds: readonly string[]): Promise<void> {
  const run = getRun(runId);
  if (state.sending || !run) return;
  const known = new Set(run.frames.map((frame) => frame.frameId));
  const ids = frameIds.filter((id) => known.has(id));
  if (ids.length === 0) return;
  // Queue them all first, so the panel shows what is coming and Cancel has
  // something to cancel.
  for (const id of ids) patchFrame(runId, id, { status: "waiting", files: 0 });
  state.activeRunId = runId;
  postRuns();
  await processRun(runId, ids);
}

async function processRun(runId: string, frameIds: readonly string[]): Promise<void> {
  state.sending = true;
  state.cancelRequested = false;
  try {
    for (const frameId of frameIds) {
      if (state.cancelRequested) break;
      await sendOneFrame(runId, frameId);
    }
  } finally {
    // Whatever Cancel did not get to mark is still queued; settle it now so a
    // run can never be left "waiting" with nothing running.
    const run = getRun(runId);
    if (run && state.cancelRequested) commitRun(cancelWaiting(run));
    state.sending = false;
    state.cancelRequested = false;
  }
}

async function sendOneFrame(runId: string, frameId: string): Promise<void> {
  // Before the walk, not after: a designer who is signed out should hear it now,
  // not once a 950-layer frame has been read for nothing.
  const session = await ensureSession();
  if (!session.ok) {
    patchFrame(runId, frameId, { status: "failed", error: session.message });
    return;
  }

  // Also before the walk: no client chosen is something the designer fixes in a click.
  const clientBlocker = tenantBlocker(state.tenants);
  if (clientBlocker) {
    patchFrame(runId, frameId, { status: "failed", error: clientBlocker });
    return;
  }

  patchFrame(runId, frameId, { status: "walking" });

  const node = await sceneNode(frameId);
  if (!node) {
    patchFrame(runId, frameId, {
      status: "failed",
      error: "The frame is no longer in this file.",
    });
    return;
  }

  try {
    const walkStart = Date.now();
    const result = await runExport(node, state.caches, () => {});
    console.log(`[fanos-studio] read "${node.name}" in ${Date.now() - walkStart} ms`);

    // The backend's say, before anything leaves: a frame from an unrelated design
    // is stopped here and never reaches S3.
    const refused = await checkWithBackend(frameId, node.name, result.summary);
    if (refused) {
      patchFrame(runId, frameId, { status: "failed", error: refused });
      return;
    }

    // Hash what will be uploaded. The backend signs each file's size and SHA-256 into its
    // upload URL, so these must come from the very bytes that are sent.
    const hashStart = Date.now();
    const prepared = await prepareSend(
      {
        jsonName: result.jsonName,
        json: result.json,
        screenshots: result.screenshots,
        assets: result.assets,
      },
      yieldToEventLoop,
    );
    const files = prepared.files.length;
    const megabytes = prepared.files.reduce((sum, file) => sum + file.size, 0) / 1_000_000;
    console.log(
      `[fanos-studio] hashed ${files} files (${megabytes.toFixed(1)} MB) in ${Date.now() - hashStart} ms`,
    );
    if (prepared.skipped.length > 0) {
      console.log(`[fanos-studio] not sent (content photos or empty): ${prepared.skipped.join(", ")}`);
    }
    patchFrame(runId, frameId, { status: "uploading", files });

    const credentials = state.auth;
    const tenants = state.tenants;
    if (!credentials || tenants.status !== "ready" || !tenants.selected) {
      patchFrame(runId, frameId, { status: "failed", files, error: "Connect your account to send." });
      return;
    }

    const page = currentPageRef(node);
    const uploadStart = Date.now();
    const sent = await runSend({
      client: createSendsClient({ baseUrl: state.authBaseUrl, fetch: sandboxFetch }),
      accessToken: credentials.accessToken,
      tenant: tenants.selected,
      source: {
        ...page,
        frames: [{ frameId, name: node.name }],
        summary: result.summary as unknown as Record<string, unknown>,
      },
      files: prepared.files,
    });

    if (sent.ok) {
      console.log(
        `[fanos-studio] send ${sent.value.sendId}: ${sent.value.uploaded} uploaded, ${sent.value.present} already there, in ${Date.now() - uploadStart} ms`,
      );
      patchFrame(runId, frameId, { status: "sent", files });
      return;
    }
    if (sent.unauthorized) {
      await dropCredentials("Your session ended. Connect your account again.");
      patchFrame(runId, frameId, {
        status: "failed",
        files,
        error: "Your session ended. Connect your account, then retry.",
      });
      return;
    }
    // The list was stale: access to the client was removed since it loaded.
    if (sent.forbidden) void loadTenants();
    patchFrame(runId, frameId, { status: "failed", files, error: sent.message });
  } catch (err) {
    patchFrame(runId, frameId, {
      status: "failed",
      error: err instanceof UnsupportedAssetError ? err.message : errorMessage(err),
    });
  }
}

/**
 * Stop after the frame in flight. A fetch cannot be aborted from the sandbox, so
 * the frame that is already uploading finishes; everything queued behind it is
 * marked cancelled straight away, so the panel answers the click at once.
 */
function cancelSend(): void {
  if (!state.sending) return;
  state.cancelRequested = true;
  const run = state.activeRunId ? getRun(state.activeRunId) : undefined;
  if (run) commitRun(cancelWaiting(run));
}

async function restartSend(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const frameIds = run.frames.map((frame) => frame.frameId);
  if (state.sending) {
    cancelSend();
    while (state.sending) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await sendFrames(frameIds);
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

function authView(): AuthView {
  if (state.login.waiting) return { phase: "waiting", ...state.login.waiting };
  if (state.auth) return { phase: "signed-in", user: state.auth.user };
  return state.authMessage
    ? { phase: "signed-out", message: state.authMessage }
    : { phase: "signed-out" };
}

function postAuth(): void {
  post({ type: "auth", auth: authView() });
}

async function readStoredAuthBaseUrl(): Promise<unknown> {
  try {
    return await figma.clientStorage.getAsync(CLIENT_STORAGE_AUTH_BASE_URL_KEY);
  } catch {
    return undefined;
  }
}

async function readStoredAuth(): Promise<unknown> {
  try {
    return await figma.clientStorage.getAsync(CLIENT_STORAGE_AUTH_KEY);
  } catch {
    return undefined;
  }
}

async function saveAuth(): Promise<void> {
  try {
    if (state.auth) await figma.clientStorage.setAsync(CLIENT_STORAGE_AUTH_KEY, state.auth);
    else await figma.clientStorage.deleteAsync(CLIENT_STORAGE_AUTH_KEY);
  } catch {
    // A store that cannot be written means signing in again next time, not a failure now.
  }
}

async function dropCredentials(message: string | null): Promise<void> {
  state.auth = null;
  state.authMessage = message;
  state.tenants = { status: "idle" };
  await saveAuth();
  postAuth();
  postTenants();
}

async function startLogin(verifier: string): Promise<void> {
  const origin = state.authBaseUrl;
  if (!origin || state.login.running) return;
  // The verifier is the one secret in this flow, and it comes from the iframe. A
  // value that is not a verifier would only weaken the exchange, so refuse it.
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) {
    state.authMessage = "Couldn’t start sign-in. Close the plugin and try again.";
    postAuth();
    return;
  }

  state.login = { running: true, cancel: false, waiting: null };
  state.authMessage = null;
  postAuth();

  const outcome = await runLogin(verifier, {
    client: createAuthClient({ origin, fetch: sandboxFetch }),
    open: (url) => figma.openExternal(url),
    allowUrl: (url) => isAllowedLoginUrl(url, origin),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    onWaiting: (waiting) => {
      state.login.waiting = waiting;
      postAuth();
    },
    cancelled: () => state.login.cancel,
  });

  state.login = { running: false, cancel: false, waiting: null };
  switch (outcome.kind) {
    case "signed-in":
      state.auth = {
        origin,
        accessToken: outcome.tokens.accessToken,
        refreshToken: outcome.tokens.refreshToken,
        expiresAt: Date.now() + outcome.tokens.expiresIn * 1000,
        user: outcome.tokens.user,
      };
      state.authMessage = null;
      await saveAuth();
      void loadTenants();
      break;
    case "denied":
      state.authMessage = "Sign-in was declined in the browser.";
      break;
    case "expired":
      state.authMessage = "The sign-in link expired. Connect again.";
      break;
    case "cancelled":
      state.authMessage = null;
      break;
    case "failed":
      state.authMessage = outcome.message;
      break;
  }
  postAuth();
}

function reopenLogin(): void {
  const waiting = state.login.waiting;
  if (waiting && isAllowedLoginUrl(waiting.loginUrl, state.authBaseUrl)) {
    figma.openExternal(waiting.loginUrl);
  }
}

/**
 * Forget the account here, and tell the server to forget it too. The network call
 * is best effort and never waited on: signing out has to work offline.
 */
async function signOut(): Promise<void> {
  const refreshToken = state.auth?.refreshToken;
  await dropCredentials(null);
  if (refreshToken) {
    void createAuthClient({ origin: state.authBaseUrl, fetch: sandboxFetch }).revoke(refreshToken);
  }
}

/**
 * Whether a send may start, refreshing the token first if it is about to expire.
 *
 * A send needs an account. A refresh the server refuses means the
 * token is dead, so sign out and say why; a refresh that merely failed to reach
 * the server does not, because the token may still be good and a wifi blip should
 * not log anyone out.
 */
async function ensureSession(): Promise<{ ok: true } | { ok: false; message: string }> {
  const api = state.api;
  if (!api) return { ok: false, message: "Studio isn’t configured." };

  const credentials = state.auth;
  if (!credentials) return { ok: false, message: "Connect your account to send." };
  if (!isExpiring(credentials, Date.now())) return { ok: true };

  // One refresh at a time. The server rotates the refresh token on every use and
  // treats a second use of the old one as theft, revoking the whole sign-in — so
  // two callers refreshing together (boot, the tenants list, a send) would log
  // the designer out.
  refreshInFlight ??= refreshSession().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

let refreshInFlight: Promise<{ ok: true } | { ok: false; message: string }> | null = null;

async function refreshSession(): Promise<{ ok: true } | { ok: false; message: string }> {
  // Another Figma window running this plugin shares our storage. If it already
  // rotated the token, ours is dead and its newer one is the one to use.
  const adopted = await adoptStoredCredentials();
  const credentials = state.auth;
  if (!credentials) return { ok: false, message: "Connect your account to send." };
  if (adopted && !isExpiring(credentials, Date.now())) return { ok: true };

  const client = createAuthClient({ origin: state.authBaseUrl, fetch: sandboxFetch });
  const refreshed = await client.refresh(credentials.refreshToken);
  if (refreshed.ok) {
    state.auth = {
      ...credentials,
      accessToken: refreshed.tokens.accessToken,
      // Refresh tokens rotate: the old one is dead the moment a new one is issued.
      refreshToken: refreshed.tokens.refreshToken,
      expiresAt: Date.now() + refreshed.tokens.expiresIn * 1000,
      user: refreshed.tokens.user,
    };
    await saveAuth();
    return { ok: true };
  }
  if (refreshed.rejected) {
    // We may have lost a race with another window that rotated it a moment ago.
    if ((await adoptStoredCredentials()) && state.auth && !isExpiring(state.auth, Date.now())) {
      return { ok: true };
    }
    await dropCredentials("Your session ended. Connect your account again.");
    return { ok: false, message: "Your session ended. Connect your account, then retry." };
  }
  return Date.now() < credentials.expiresAt
    ? { ok: true }
    : { ok: false, message: `Couldn’t renew your session: ${refreshed.message}` };
}

/** Take the stored credentials when they are newer than the ones in memory. */
async function adoptStoredCredentials(): Promise<boolean> {
  const stored = parseCredentials(await readStoredAuth(), state.authBaseUrl);
  if (!stored || !state.auth || stored.refreshToken === state.auth.refreshToken) return false;
  if (stored.expiresAt < state.auth.expiresAt) return false;
  state.auth = stored;
  return true;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** Where a file remembers which client it is for. Travels with the file. */
const FILE_CLIENT_KEY = "fanos-studio.client";

function readFileClient(): string | null {
  try {
    return figma.root.getPluginData(FILE_CLIENT_KEY) || null;
  } catch {
    return null;
  }
}

function writeFileClient(code: string): void {
  try {
    figma.root.setPluginData(FILE_CLIENT_KEY, code);
  } catch {
    // A file that cannot be written (view-only) just asks again next time.
  }
}

function postTenants(): void {
  post({ type: "tenants", tenants: state.tenants });
}

/** Ask the backend which clients this account may send for, right now. */
async function loadTenants(): Promise<void> {
  if (!state.auth) {
    state.tenants = { status: "idle" };
    postTenants();
    return;
  }
  state.tenants = { status: "loading" };
  postTenants();

  const session = await ensureSession();
  const credentials = state.auth;
  if (!session.ok || !credentials) {
    state.tenants = session.ok ? { status: "idle" } : { status: "error", message: session.message };
    postTenants();
    return;
  }

  const result = await createAuthClient({ origin: state.authBaseUrl, fetch: sandboxFetch }).tenants(
    credentials.accessToken,
  );
  if (!result.ok) {
    if (result.unauthorized) {
      await dropCredentials("Your session ended. Connect your account again.");
      return;
    }
    state.tenants = { status: "error", message: result.message };
    postTenants();
    return;
  }
  state.tenants = {
    status: "ready",
    tenants: result.tenants,
    selected: chooseTenant(result.tenants, readFileClient()),
  };
  postTenants();
}

function selectTenant(code: string): void {
  const view = state.tenants;
  if (view.status !== "ready" || !view.tenants.some((tenant) => tenant.code === code)) return;
  state.tenants = { ...view, selected: code };
  writeFileClient(code);
  postTenants();
}

/**
 * Ask the backend whether this frame may go to the chosen client. The backend
 * decides: access to the client, and whether the frame looks like a FanOS design.
 * Returns the reason when it may not, null when it may.
 */
async function checkWithBackend(
  frameId: string,
  name: string,
  summary: { boundCount: number; looseCount: number },
): Promise<string | null> {
  const view = state.tenants;
  const credentials = state.auth;
  if (view.status !== "ready" || !view.selected || !credentials) {
    return tenantBlocker(view) ?? "Connect your account to send.";
  }
  const check = await createAuthClient({ origin: state.authBaseUrl, fetch: sandboxFetch }).checkSend(
    credentials.accessToken,
    view.selected,
    [
      {
        frameId,
        name,
        slots: { total: summary.boundCount + summary.looseCount, bound: summary.boundCount },
      },
    ],
  );
  if (check.ok) return null;
  if (check.unauthorized) {
    await dropCredentials("Your session ended. Connect your account again.");
    return "Your session ended. Connect your account, then retry.";
  }
  // The list was stale: access was removed since it loaded.
  if (check.forbidden) void loadTenants();
  return check.message;
}

/**
 * The same files a send carries, on disk. Walks each frame again rather than
 * reusing a result: this is the escape hatch for a broken Studio, and it has to
 * work without any send having happened.
 */
async function downloadZip(frameIds: string[]): Promise<void> {
  const ids = [...new Set(frameIds)];
  if (ids.length === 0) {
    fail("Select the frames you want in the ZIP.");
    return;
  }
  await busy(async () => {
    const files: Array<{ name: string; data: Uint8Array | string }> = [];
    const several = ids.length > 1;
    let single = "";

    for (const id of ids) {
      const node = await sceneNode(id);
      if (!node) continue;
      status(`Reading ${node.name}…`);
      const result = await runExport(node, state.caches, () => {});
      const folder = several ? `${safeFileName(node.name)}/` : "";
      single = result.jsonName.replace(/\.ir\.json$/, "");
      files.push({ name: `${folder}${result.jsonName}`, data: result.json });
      for (const shot of result.screenshots) files.push({ name: `${folder}${shot.name}`, data: shot.bytes });
      for (const asset of result.assets) {
        files.push({
          name: `${folder}assets/${asset.name}-${asset.nodeId.replace(/:/g, "-")}.png`,
          data: asset.bytes,
        });
      }
    }

    if (files.length === 0) {
      fail("None of those frames could be read.");
      return;
    }
    post({
      type: "zip-ready",
      name: `${several ? `${safeFileName(figma.root.name)}-frames` : single}.zip`,
      files,
    });
  });
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "frame";
}

function currentPageRef(root: SceneNode): StudioPage {
  return {
    fileKey: typeof figma.fileKey === "string" ? figma.fileKey : null,
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
    rootNodeId: root.id,
    rootName: root.name,
  };
}

/** Widest the screenshot is drawn: the panel body at 2x. */
const PREVIEW_WIDTH_PX = 760;
/** Figma refuses very large exports; a whole page stays well under this. */
const PREVIEW_MAX_HEIGHT_PX = 12000;
const PREVIEW_DEBOUNCE_MS = 250;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewSeq = 0;

/**
 * Screenshot the frame being CHECKED for the panel — not the selection. The
 * numbers beside it describe the checked frame, and a picture of something else
 * would say the opposite. It moves when the check does (the "Check … instead"
 * button, a rescan, a page change).
 *
 * Debounced, and a stale export is dropped: a whole page is not an instant export.
 */
function schedulePreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  const seq = ++previewSeq;
  previewTimer = setTimeout(() => {
    void exportPreview(seq);
  }, PREVIEW_DEBOUNCE_MS);
}

async function exportPreview(seq: number): Promise<void> {
  const node = state.root;
  if (!node || node.removed || !("exportAsync" in node) || node.width <= 0 || node.height <= 0) {
    if (seq === previewSeq) post({ type: "preview", preview: null });
    return;
  }
  const scale = Math.min(1, PREVIEW_WIDTH_PX / node.width, PREVIEW_MAX_HEIGHT_PX / node.height);
  try {
    const png = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
    });
    if (seq !== previewSeq) return;
    post({
      type: "preview",
      preview: {
        nodeId: node.id,
        name: node.name,
        width: Math.round(node.width),
        height: Math.round(node.height),
        png,
      },
    });
  } catch (error) {
    // A preview is a convenience. Never turn a failed export into a panel error.
    console.log(`[fanos-studio] preview failed: ${error instanceof Error ? error.message : String(error)}`);
    if (seq === previewSeq) post({ type: "preview", preview: null });
  }
}

function postSelection(): void {
  const selection = figma.currentPage.selection;
  const only = selection.length === 1 ? selection[0]! : null;
  const parent = only && only.parent && "id" in only.parent && only.parent.type !== "PAGE" && only.parent.type !== "DOCUMENT"
    ? only.parent
    : null;
  post({
    type: "selection",
    count: selection.length,
    name: only ? only.name : null,
    // Only containers are offerable as a root — a selected text layer is not a
    // page to check.
    id: only && "children" in only ? only.id : null,
    nodeId: only ? only.id : null,
    hasImage: only ? "fills" in only : false,
    parentId: parent && "id" in parent ? parent.id : null,
    parentName: parent && "name" in parent ? parent.name : null,
    frames: selection
      .filter((node) => "children" in node)
      .map((node) => ({ id: node.id, name: node.name })),
  });
}

function readBindings(): AssetBinding[] {
  return state.root ? parseBindings(state.root.getPluginData(ASSET_PLUGIN_KEY)) : [];
}

function writeBindings(bindings: AssetBinding[]): void {
  if (!state.root) return;
  state.root.setPluginData(ASSET_PLUGIN_KEY, serializeBindings(bindings));
  postAssets();
}

/**
 * The assets, where each lands, and where else each could go.
 *
 * Placement and target options are computed by the SAME functions the compiler
 * uses, from the same IR, so the panel's "covers its target" and the tree that
 * comes out cannot disagree.
 */
function postAssets(): void {
  const bindings = readBindings();
  post({
    type: "assets",
    bindings,
    placements: state.ir ? placementsFromIr(state.ir.root, bindings) : {},
    targets: state.ir ? targetOptionsFromIr(state.ir.root, bindings) : {},
  });
}

async function sceneNode(id: string): Promise<SceneNode | null> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === "PAGE" || node.type === "DOCUMENT") return null;
  return node as SceneNode;
}

// ---------------------------------------------------------------------------
// Uploaded assets
// ---------------------------------------------------------------------------

/**
 * Take a dropped image, work out which region it is, and bind it there.
 *
 * The bytes go into the FIGMA DOCUMENT via `figma.createImage`, not into
 * pluginData. pluginData is a small key-value store on a node; a 3MB header
 * base64s to 4MB and would not survive there. The document's image store has no
 * such ceiling, dedupes by content hash, and persists across reopening the
 * file — so a binding only ever carries the hash.
 *
 * The mapping is a guess with a confidence, and it says so. A confident match
 * is applied; anything less is returned as ranked candidates for the designer
 * to pick from, because a background painted onto the wrong element is harder
 * to notice than one that was never placed.
 */
async function uploadAsset(message: {
  fileName: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  targetId?: string;
}): Promise<void> {
  if (!state.root || !state.ir) {
    fail("Check a frame first, then drop the image in.");
    return;
  }

  let image: Image;
  try {
    image = figma.createImage(message.bytes);
  } catch (err) {
    // Figma refuses images past its own size ceiling. That is a fact about the
    // file, not a bug, and the designer needs the reason rather than a stack.
    fail(`Figma would not accept "${message.fileName}": ${errorMessage(err)}`);
    return;
  }

  const existing = readBindings();
  const upload = {
    fileName: message.fileName,
    width: message.width,
    height: message.height,
  };

  const taken = new Set(existing.map((b) => b.targetId));
  const matches = matchAssetToTargets(state.ir.root, upload, { taken });

  // An explicit target wins over the matcher: the designer is answering the
  // question the matcher was asking.
  const chosenId = message.targetId ?? (isConfident(matches) ? matches[0]!.id : undefined);
  if (!chosenId) {
    post({
      type: "asset-unmapped",
      fileName: message.fileName,
      imageHash: image.hash,
      width: message.width,
      height: message.height,
      candidates: matches,
    });
    return;
  }

  const target = await sceneNode(chosenId);
  if (!target) {
    fail("That element is no longer in this frame.");
    return;
  }

  const taken_names = new Set(
    existing.filter((b) => b.imageHash !== image.hash).map((b) => b.name),
  );
  const binding: AssetBinding = {
    role: "background",
    name: suggestAssetName(message.fileName, taken_names),
    imageHash: image.hash,
    fileName: message.fileName,
    width: Math.max(1, message.width),
    height: Math.max(1, message.height),
    targetId: target.id,
    targetName: target.name,
    // An exported region fills the element it came from.
    fit: "cover",
    mapping: message.targetId ? "manual" : "auto",
  };

  writeBindings(upsertBinding(existing, binding));
  figma.notify(`"${message.fileName}" paints ${target.name}`);
}

/**
 * Bind an already-registered image to an element the designer picked.
 *
 * Split from `uploadAsset` because the bytes are already in the document:
 * re-running `createImage` on an answer would either duplicate the image or,
 * with no bytes to hand, throw.
 */
async function placeAsset(message: {
  imageHash: string;
  fileName: string;
  width: number;
  height: number;
  targetId: string;
}): Promise<void> {
  const target = await sceneNode(message.targetId);
  if (!target) {
    fail("That element is no longer in this frame.");
    return;
  }

  const existing = readBindings();
  const taken = new Set(existing.filter((b) => b.imageHash !== message.imageHash).map((b) => b.name));

  writeBindings(
    upsertBinding(existing, {
      role: "background",
      name: suggestAssetName(message.fileName, taken),
      imageHash: message.imageHash,
      fileName: message.fileName,
      width: Math.max(1, message.width),
      height: Math.max(1, message.height),
      targetId: target.id,
      targetName: target.name,
      fit: "cover",
      mapping: "manual",
    }),
  );
  figma.notify(`"${message.fileName}" paints ${target.name}`);
}

async function retargetAsset(key: string, targetId: string): Promise<void> {
  const target = await sceneNode(targetId);
  if (!target) {
    fail("Pick the element this image should paint.");
    return;
  }
  writeBindings(retargetBinding(readBindings(), key, { id: target.id, name: target.name }));
}

function removeAsset(key: string): void {
  writeBindings(removeBinding(readBindings(), key));
}

function renameAsset(key: string, name: string): void {
  const result = renameBinding(readBindings(), key, name.trim());
  if (!result.ok) {
    fail(result.error);
    return;
  }
  writeBindings(result.bindings);
}

function setAssetFit(key: string, fit: AssetFit): void {
  writeBindings(setBindingFit(readBindings(), key, fit));
}


// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function busy<T>(work: () => Promise<T>): Promise<T | undefined> {
  state.busy = true;
  try {
    return await work();
  } catch (err) {
    fail(errorMessage(err));
    return undefined;
  } finally {
    state.busy = false;
    status("", false);
  }
}

function currentActor(): ActivityActor {
  const user = figma.currentUser;
  if (!user) return { id: null, name: "Anonymous", color: "#6b6b6b" };
  return { id: user.id, name: user.name, color: user.color };
}

function readActivity(node: SceneNode): ActivityEntry[] {
  const keys = node.getPluginDataKeys().filter((key) => key.startsWith(ACTIVITY_PREFIX));
  return mergeActivity(keys.map((key) => parseLane(node.getPluginData(key))));
}

function recordActivity(node: SceneNode, entry: ActivityEntry): void {
  const key = laneKey(entry.actor.id);
  const next = appendLane(parseLane(node.getPluginData(key)), entry);
  node.setPluginData(key, JSON.stringify(next));
}

function retractActivity(node: SceneNode, entryId: string | null): void {
  const key = laneKey(currentActor().id);
  const next = popLane(parseLane(node.getPluginData(key)), entryId ?? undefined);
  node.setPluginData(key, next.length > 0 ? JSON.stringify(next) : "");
}

function postApplied(partial: Omit<AppliedPayload, "user">, kind?: ActivityKind): void {
  const user = currentActor();
  const payload: AppliedPayload = { ...partial, user };
  if (kind && payload.applied > 0 && state.root) {
    const entry: ActivityEntry = {
      id: `${user.id ?? "anon"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      actor: user,
      kind,
      label: payload.label,
      tokenRef: payload.tokenRef,
      applied: payload.applied,
      at: Date.now(),
    };
    recordActivity(state.root, entry);
    state.lastActivityId = entry.id;
  }
  post({ type: "applied", payload });
}

function post(message: PluginMessage): void {
  figma.ui.postMessage(message);
}

function status(message: string, isBusy = true): void {
  post({ type: "status", message, busy: isBusy });
}

function fail(message: string): void {
  console.log(`[fanos-studio] ${message}`);
  state.error = message;
  post({ type: "error", message });
}
