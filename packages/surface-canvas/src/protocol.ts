/**
 * The sandbox <-> iframe message contract.
 *
 * Both sides import this file, so a message the UI sends and a message the
 * sandbox handles cannot drift apart without the compiler saying so.
 *
 * Everything crossing the boundary is structured-clonable: no Maps, no
 * functions, no class instances. `LintReport` was designed for that.
 */
import type { AssetPlacement, TargetMatch, TargetOption } from "./assets.js";
import type { Annotation, AnnotationKind, AssetBinding, AssetFit } from "./ir/schema.js";
import type { Person } from "./health/person.js";
import type { LintReport } from "./health/types.js";
import type { ReconciliationReport } from "./health/reconcile-report.js";
import type { TenantsView } from "./auth/tenants.js";
import type { HandoffBatch } from "./handoffs.js";
import type { ThemeChoice } from "./themes.js";

export type { Person, TenantsView };

export type UiTheme = "light" | "dark";

export type PanelState = "expanded" | "collapsed";

/**
 * Who the plugin is signed in as. Every API needs an account, the local board
 * included: the local board runs the same sign-in as production, so a designer
 * tests the real flow before it ships.
 */
export type AuthView =
  | { phase: "signed-out"; message?: string }
  | { phase: "waiting"; userCode: string; loginUrl: string; expiresAt: number }
  | { phase: "signed-in"; user: { id: string; name: string } };

export type Tab = "check" | "handoff" | "history";

export const PANEL_SIZES: Record<PanelState, { width: number; height: number }> = {
  expanded: { width: 400, height: 640 },
  collapsed: { width: 280, height: 44 },
};

export const CLIENT_STORAGE_KEY = "fanos-studio.panel-state";
/** The panel's own look: "light" or "dark". Absent means follow Figma. */
export const CLIENT_STORAGE_UI_THEME_KEY = "fanos-studio.ui-theme";
export const CLIENT_STORAGE_THEME_KEY = "fanos-studio.theme-id";
/** Origin Surface Studio is listening on. Must be on the api allowlist. */
export const CLIENT_STORAGE_API_ORIGIN_KEY = "fanos-studio.api-origin";
/** Origin sign-in runs against: the FanXP backend. */
export const CLIENT_STORAGE_AUTH_BASE_URL_KEY = "fanos-studio.auth-base-url";

// ---------------------------------------------------------------------------
// UI -> sandbox
// ---------------------------------------------------------------------------

export type UiMessage =
  | { type: "ui-ready" }
  /**
   * Full re-lint of the frame already being checked. Deliberately does NOT
   * re-target: "Select layers" and any stray canvas click change the selection,
   * and a refresh that quietly followed it would keep moving the ground under
   * someone who just wanted their numbers updated.
   */
  | { type: "refresh" }
  /** Re-target onto the current selection. The only way the checked frame moves. */
  | { type: "retarget" }
  | { type: "select-theme"; themeId: string }
  | { type: "select-batch"; batchId: string }
  | { type: "apply-batch"; batchId: string }
  /**
   * Apply every safe batch at once, as ONE undo step. Not a loop over
   * `apply-batch` — that produced one undo entry per batch, so taking back an
   * autofix meant pressing Ctrl-Z as many times as there happened to be batches.
   */
  | { type: "autofix" }
  /** F7 — write whole-pixel values for one batch. Not a token bind. */
  | { type: "apply-round"; batchId: string }
  /** B1 / B2. */
  | { type: "apply-structural"; action: "wrap-autolayout" | "convert-groups" }
  /**
   * Rewrite drifted local variables to the theme's values. Never library
   * variables — those are not ours to change.
   */
  | { type: "reset-drift"; refs?: string[] }
  | { type: "select-nodes"; nodeIds: string[] }
  /**
   * Set pinned text to hug height (textAutoResize HEIGHT). Live copy can then
   * grow the box. Omit nodeIds to hug every pinned text layer in the report.
   */
  | { type: "hug-text"; nodeIds?: string[] }
  /**
   * Create the Figma variables the queue is blocked on. Omit `refs` for every
   * token an exact batch wants and this file does not have.
   */
  | { type: "create-variables"; refs?: string[] }
  /** A near batch, after the designer picked one of the candidate swatches. */
  | { type: "apply-candidate"; batchId: string; tokenRef: string }
  | { type: "undo-last" }
  | { type: "dismiss-undo" }
  | { type: "set-panel-state"; state: PanelState }
  /** The panel's light/dark choice, kept across sessions. */
  | { type: "set-ui-theme"; theme: UiTheme }
  /**
   * An image the designer exported from Figma and dropped in.
   *
   * The bytes are registered with the Figma document and the region they came
   * from is inferred from the filename and the pixel size — see
   * `ir/match-asset.ts`. `targetId` is only set when the designer is answering
   * a question the matcher could not.
   */
  | {
      type: "upload-asset";
      fileName: string;
      bytes: Uint8Array;
      width: number;
      height: number;
      targetId?: string;
    }
  /**
   * Place an image already registered with the document.
   *
   * The answer to the "which element is this?" prompt. The bytes went in when
   * the file was dropped, so answering must not re-upload them — passing empty
   * bytes back through `upload-asset` would ask Figma to create a second image
   * from nothing.
   */
  | {
      type: "place-asset";
      imageHash: string;
      fileName: string;
      width: number;
      height: number;
      targetId: string;
    }
  /**
   * Write a note on a layer for the agents that build the section. `id` is set
   * when editing; absent when adding. The target's name is read in the sandbox.
   */
  | { type: "save-note"; id?: string; targetId: string; kind: AnnotationKind; text: string }
  | { type: "remove-note"; id: string }
  /** Point an existing asset at a different element. */
  | { type: "retarget-asset"; key: string; targetId: string }
  | { type: "remove-asset"; key: string }
  /**
   * Rename the asset. This is `asset.texture.<name>` — a token the compiler
   * emits and a run persists a URL against — so the sandbox validates it and
   * refuses a collision rather than writing it through.
   */
  | { type: "rename-asset"; key: string; name: string }
  /** Override how the bitmap fills its box. */
  | { type: "set-asset-fit"; key: string; fit: AssetFit }
  /**
   * Hand off frames to Studio, one Handoff per frame.
   *
   * Each frame is walked and posted on its own, in order, so each becomes its own
   * agent run and one slow frame cannot hold the others up. The sandbox owns the
   * run record and posts it back as `batches` after every step.
   */
  | { type: "handoff-frames"; frameIds: string[] }
  /**
   * Hand off frames of an existing run again, in that run: a failure the designer
   * retried. The run flips from "needs you" to sent instead of leaving a stale
   * one behind and starting another.
   */
  | { type: "retry-frames"; batchId: string; frameIds: string[] }
  /** Stop after the frame in flight. Frames still queued are marked cancelled. */
  | { type: "cancel-send" }
  /** Stop, then send the same frames again as a new run. */
  | { type: "restart-handoff"; batchId: string }
  /** Leave the Handoff tab's progress screen. The run stays in Runs. */
  | { type: "dismiss-send" }
  /** Is Studio answering? Asked when the Handoff tab opens, and on Retry. */
  | { type: "open-studio" }
  /**
   * Start signing in. The verifier is the PKCE secret, made here in the iframe
   * (it has `crypto.getRandomValues`) and used by the sandbox, which does the
   * network. It never leaves the plugin: only its hash goes to the server.
   */
  | { type: "auth-start"; verifier: string }
  /** Stop waiting for the browser. */
  | { type: "auth-cancel" }
  /** Open the sign-in page again, for someone who closed the tab. */
  | { type: "auth-open" }
  | { type: "auth-sign-out" }
  /** Ask the backend again which clients this account may send for. */
  | { type: "tenants-load" }
  /** Which client this file's handoffs are for. Remembered on the file. */
  | { type: "tenant-select"; code: string }
  | { type: "close" };

// ---------------------------------------------------------------------------
// sandbox -> UI
// ---------------------------------------------------------------------------

export interface BootPayload {
  fileName: string;
  pageName: string;
  themes: ThemeChoice[];
  themeId: string;
  panelState: PanelState;
  /** The designer's choice, or null to follow Figma's own theme. */
  uiTheme: UiTheme | null;
  user: Person;
}

export interface AppliedPayload {
  batchId: string;
  label: string;
  tokenRef: string;
  applied: number;
  failed: number;
  /** First few failures, so the panel can say what went wrong and not just how many. */
  failures: string[];
  /** True while the fix is still the top of the undo stack. */
  undoable: boolean;
  /** Who ran this apply. Undo is only this session — never someone else's bind. */
  user: Person;
}

export type PluginMessage =
  | { type: "boot"; payload: BootPayload }
  | { type: "status"; message: string; busy: boolean }
  | {
      type: "report";
      report: LintReport;
      reconciliation: ReconciliationReport;
      scope: "full" | "incremental";
      nodeCount: number;
    }
  | { type: "applied"; payload: AppliedPayload }
  /**
   * The authoritative panel state, posted after the window has actually been
   * resized. The UI never changes its own layout on a click — it waits for this
   * — so the window size and the layout drawn inside it cannot disagree.
   */
  | { type: "panel-state"; state: PanelState }
  | {
      type: "selection";
      count: number;
      name: string | null;
      id: string | null;
      /** Any single selected node — image layers included. */
      nodeId: string | null;
      hasImage: boolean;
      parentId: string | null;
      parentName: string | null;
      /** Every selected container, in canvas order. What the Handoff tab offers to send. */
      frames: SelectedFrame[];
    }
  | {
      type: "assets";
      bindings: AssetBinding[];
      /** Keyed by image hash. Where each asset lands inside what it paints. */
      placements: Record<string, AssetPlacement>;
      /** Keyed by image hash. The elements each asset could be re-pointed at. */
      targets: Record<string, TargetOption[]>;
    }
  /** The designer's notes on this frame; `orphaned` counts those whose layer is gone. */
  | { type: "notes"; notes: Annotation[]; orphaned: number }
  /**
   * A dropped image the matcher could not place with confidence.
   *
   * Carries the candidates rather than picking one. A background painted onto
   * the wrong element is harder to notice, and harder to diagnose, than one
   * that was never placed — so an uncertain match asks instead of guessing.
   * The bytes are already in the document; only the target is outstanding.
   */
  | {
      type: "asset-unmapped";
      fileName: string;
      imageHash: string;
      width: number;
      height: number;
      candidates: TargetMatch[];
    }
  /**
   * Every run, newest first, and which one the Handoff tab is showing. Posted after
   * every step of a send so the panel never has to ask.
   */
  | { type: "batches"; batches: HandoffBatch[]; activeId: string | null }
  | { type: "auth"; auth: AuthView }
  /**
   * A PNG of the frame being checked, or null. Follows the check, not the
   * selection, so it never disagrees with the numbers beside it.
   */
  | { type: "preview"; preview: SelectionPreview | null }
  | { type: "tenants"; tenants: TenantsView }
  | { type: "error"; message: string };

export interface SelectedFrame {
  id: string;
  name: string;
}

/** A screenshot of the frame being checked. Tall selections (a whole page) stay tall: the panel scrolls it. */
export interface SelectionPreview {
  nodeId: string;
  name: string;
  /** Size of the node on canvas, in Figma units. */
  width: number;
  height: number;
  png: Uint8Array;
}
