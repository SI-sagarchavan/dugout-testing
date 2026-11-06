/**
 * Check: is this frame ready to go?
 *
 * The readiness card leads because it is the one reading on the tab. Under it,
 * two views of the work: the fix queue (loose values) and Images (what ships as
 * background). Everything that resolves, resolves in place — one status line for
 * the last action, one row open at a time — so nothing a click does ever moves
 * the list the designer was reading.
 */
import type { JSX } from "react";
import type { Tab } from "../protocol.js";
import { Autofix } from "./Autofix.js";
import { framesToHandoff, handoffLabel } from "./frames.js";
import { FixQueue } from "./FixQueue.js";
import { HandoffIcon } from "./icons.js";
import { ImagesView } from "./Images.js";
import { NotesView } from "./Notes.js";
import { send } from "./main.js";
import { SelectionPreview } from "./SelectionPreview.js";
import { Reconciliation } from "./Reconciliation.js";
import { Readiness } from "./Readiness.js";
import { needsPick } from "./rows.js";
import type { PanelAction, StudioState } from "./state.js";
import { StatusLine } from "./StatusLine.js";

export type CheckView = "queue" | "images" | "notes";

export function CheckTab({
  state,
  dispatch,
  go,
  view,
  setView,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
  go: (tab: Tab) => void;
  /** Lifted to the shell so the Handoff tab's "Fix" and "View" can land on the right one. */
  view: CheckView;
  setView: (view: CheckView) => void;
}): JSX.Element {
  const report = state.report;

  // A container is selected, and it isn't the one being checked. That is the only
  // moment re-targeting is a meaningful offer.
  const offerRetarget =
    state.selectionId !== null && report !== null && state.selectionId !== report.rootNodeId;

  const picks = needsPick(state);
  const frames = framesToHandoff(state);
  const queueCount = report?.batches.length ?? 0;

  const reviewPicks = (): void => {
    const first = picks[0];
    if (!first) return;
    setView("queue");
    if (state.openBatchId !== first.id) dispatch({ type: "open-batch", batchId: first.id });
  };

  return (
    <>
      <main className="fs-main">
        <SelectionPreview preview={state.preview} />

        {offerRetarget ? (
          <button
            className="fs-btn is-primary"
            disabled={state.busy}
            onClick={() => send({ type: "retarget" })}
            title="Check the selected frame instead of the current one"
          >
            <span className="truncate">Check “{state.selectionName}” instead</span>
          </button>
        ) : null}

        <Readiness state={state} />

        <div className="fs-seg" role="tablist" aria-label="Check views">
          <button
            className="fs-segitem"
            role="tab"
            aria-selected={view === "queue"}
            onClick={() => setView("queue")}
          >
            Fix queue
            <span className="fs-pill">{queueCount}</span>
          </button>
          <button
            className="fs-segitem"
            role="tab"
            aria-selected={view === "images"}
            onClick={() => setView("images")}
          >
            Images
            <span className="fs-pill">{state.assets.length}</span>
          </button>
          <button
            className="fs-segitem"
            role="tab"
            aria-selected={view === "notes"}
            onClick={() => setView("notes")}
          >
            Notes
            <span className="fs-pill">{state.notes.length}</span>
          </button>
        </div>

        {view === "queue" ? (
          <>
            <FixQueue
              state={state}
              dispatch={dispatch}
              onReviewImages={() => setView("images")}
              toolbar={<Autofix state={state} />}
            />
            <PinnedText state={state} />
            <div className="fs-card is-list" style={{ marginTop: "auto" }}>
              <StatusLine state={state} />
              <Reconciliation state={state} />
            </div>
          </>
        ) : view === "images" ? (
          <ImagesView state={state} dispatch={dispatch} />
        ) : (
          <NotesView state={state} />
        )}
      </main>

      <footer className="fs-foot">
        {picks.length > 0 ? (
          <button className="fs-btn" onClick={reviewPicks}>
            Review {picks.length} {picks.length === 1 ? "pick" : "picks"}
          </button>
        ) : null}
        <button
          className="fs-btn is-primary"
          style={{ flex: 1 }}
          disabled={frames.length === 0}
          onClick={() => go("handoff")}
        >
          <HandoffIcon />
          {handoffLabel(frames)}
        </button>
      </footer>
    </>
  );
}

/**
 * Text that cannot grow.
 *
 * A text layer with auto-resize off is a fixed box: the moment `{headline}` is
 * longer than the string the designer typed, the copy clips. That is invisible in
 * Figma — the design string always fits — and only shows up once real data
 * arrives. One line and one button, silent when there is nothing pinned, which on
 * a healthy frame is most of the time.
 */
function PinnedText({ state }: { state: StudioState }): JSX.Element | null {
  const pinned = state.report?.sizing?.pinnedText ?? [];
  if (pinned.length === 0) return null;

  return (
    <div className="fs-row is-quiet">
      <div className="fs-row-head" style={{ minHeight: 38 }}>
        <span className="t-body" style={{ flex: 1, color: "var(--attention)" }}>
          {pinned.length} {pinned.length === 1 ? "text layer is" : "text layers are"} pinned. Longer
          copy will clip.
        </span>
        <button
          className="fs-btn"
          disabled={state.busy}
          onClick={() => send({ type: "hug-text" })}
          title="Sets text auto-resize to height. Width stays. One undo reverts all of it."
        >
          Hug {pinned.length}
        </button>
      </div>
    </div>
  );
}
