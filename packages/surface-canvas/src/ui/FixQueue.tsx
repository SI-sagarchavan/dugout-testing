/**
 * The fix queue: loose values, ranked by what fixing them is worth.
 *
 * A row is a decision, and a decision resolves where it was taken. Bind and the
 * row becomes the receipt for its own bind. Skip and it stays, dashed, with the
 * way back on it. Nothing is appended, nothing below moves, and the queue you
 * were reading is still the queue in front of you.
 *
 * Closed, a row is one claim — this value, this many layers, this much coverage,
 * and the one button that settles it. Open, it is the evidence: the candidates,
 * and the two ways out. One row is open at a time.
 */
import type { JSX, ReactNode } from "react";
import { isFixProposal } from "../health/types.js";
import type { Batch, FixCandidate } from "../health/types.js";
import { ImageIcon, SpacingIcon, UndoIcon } from "./icons.js";
import { send } from "./main.js";
import type { PanelAction, ResolvedRow, StudioState } from "./state.js";
import {
  bindAction,
  candidatesOf,
  hintFor,
  isImageBatch,
  missingRefs,
  queueRows,
  targetLine,
  tileGlyph,
} from "./rows.js";

export function FixQueue({
  state,
  dispatch,
  toolbar,
  onReviewImages,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
  /** Autofix and the heatmap, drawn on the caption line. */
  toolbar: ReactNode;
  onReviewImages: () => void;
}): JSX.Element | null {
  const report = state.report;
  if (!report) return null;

  const rows = queueRows(state);

  if (rows.length === 0) {
    return (
      <div className="fs-card fs-empty">
        <div className="t-label">Nothing loose on this page.</div>
        <div className="t-body" style={{ color: "var(--ink-muted)" }}>
          Every fill, spacing and radius here is bound to a token.
        </div>
      </div>
    );
  }

  const covered = report.batches
    .slice(0, report.batchesFor90Percent)
    .reduce((sum, batch) => sum + batch.count, 0);
  const share = report.coverage.loose > 0 ? Math.round((covered / report.coverage.loose) * 100) : 0;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label="Fix queue">
      <div className="fs-line1" style={{ justifyContent: "space-between" }}>
        <p className="t-mono" style={{ color: "var(--ink-muted)" }}>
          {report.batches.length > 0
            ? `Sorted by gain · top ${report.batchesFor90Percent} cover ${share}%`
            : "Nothing left to fix"}
        </p>
        <div className="fs-line1" style={{ flexWrap: "nowrap", gap: 4, marginLeft: "auto" }}>
          {toolbar}
        </div>
      </div>

      <ul style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((row) => (
          <li key={row.id} style={{ display: "flex", flexDirection: "column" }}>
            {row.kind === "receipt" ? (
              <Receipt row={row.row} undoable={row.undoable} busy={state.busy} />
            ) : row.kind === "skipped" ? (
              <Skipped batch={row.batch} dispatch={dispatch} />
            ) : (
              <Row
                batch={row.batch}
                open={row.open}
                picked={row.picked}
                busy={state.busy}
                dispatch={dispatch}
                onReviewImages={onReviewImages}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({
  batch,
  open,
  picked,
  busy,
  dispatch,
  onReviewImages,
}: {
  batch: Batch;
  open: boolean;
  picked: FixCandidate | null;
  busy: boolean;
  dispatch: (action: PanelAction) => void;
  onReviewImages: () => void;
}): JSX.Element {
  const image = isImageBatch(batch);
  const glyph = tileGlyph(batch);
  const candidates = candidatesOf(batch);
  const action = bindAction(batch, picked);
  const target = targetLine(batch);
  const layers = `${batch.count} ${batch.count === 1 ? "layer" : "layers"}`;
  const label = image ? "image" : batch.currentValue;

  return (
    <div className={open ? "fs-row is-open" : "fs-row"}>
      <div className="fs-row-head">
        <button
          className="fs-row-hit"
          aria-expanded={image ? undefined : open}
          onClick={() => (image ? onReviewImages() : dispatch({ type: "open-batch", batchId: batch.id }))}
        >
          <span
            className="fs-well"
            style={glyph.swatch ? { background: glyph.swatch } : undefined}
            role={glyph.swatch ? "img" : undefined}
            aria-label={glyph.swatch ? `Colour swatch ${glyph.swatch}` : undefined}
            aria-hidden={glyph.swatch ? undefined : true}
          >
            {glyph.swatch ? null : image ? (
              <ImageIcon />
            ) : glyph.letter === "P" || glyph.letter === "G" ? (
              <SpacingIcon />
            ) : (
              glyph.letter
            )}
          </span>

          <span className="fs-rowbody">
            <span className="fs-line1">
              <span className="fs-val truncate">{label}</span>
              <span className="fs-pill">{layers}</span>
              <span className="t-mono" style={{ color: "var(--ink-muted)" }}>
                +{batch.coverageGain}%
              </span>
            </span>
            {image ? (
              <span className="t-caption" style={{ color: "var(--ink-muted)" }}>
                Image fills aren’t tokens. They’re sent as background assets.
              </span>
            ) : (
              <span className="fs-line1">
                <span className="t-caption" style={{ color: "var(--ink-muted)" }} aria-hidden="true">
                  →
                </span>
                {target.token ? (
                  <>
                    <span className="fs-val truncate" style={{ fontSize: 11 }}>
                      {target.token}
                    </span>
                    <TargetNote note={target.note} />
                  </>
                ) : (
                  <span className="t-caption" style={{ color: "var(--ink-muted)" }}>
                    {target.note}
                  </span>
                )}
              </span>
            )}
          </span>
        </button>

        <RowAction
          batch={batch}
          image={image}
          action={action}
          picked={picked}
          busy={busy}
          dispatch={dispatch}
          onReviewImages={onReviewImages}
          label={label}
        />
      </div>

      {open && !image ? (
        <div className="fs-body">
          <div className="fs-hint">{hintFor(batch)}</div>

          {candidates.map((candidate) => (
            <button
              key={candidate.tokenRef}
              className={picked && picked.tokenRef === candidate.tokenRef ? "cand cand-on" : "cand"}
              onClick={() =>
                dispatch({ type: "pick-candidate", batchId: batch.id, tokenRef: candidate.tokenRef })
              }
              title={
                candidate.bindable
                  ? `Bind all ${batch.count} to ${candidate.tokenRef}`
                  : `${candidate.tokenRef} has no Figma variable in this file yet`
              }
            >
              <span className="radio" aria-hidden />
              {candidate.value.startsWith("#") ? (
                <span className="swatch" style={{ background: candidate.value }} aria-hidden />
              ) : null}
              <span className="cand-main">
                <span className="cand-ref truncate">{candidate.tokenRef}</span>
                <span className="cand-evidence">
                  <span>{candidate.value}</span>
                  {candidate.value.startsWith("#") ? (
                    <span className="fs-de">ΔE {candidate.distance}</span>
                  ) : null}
                  {candidate.bindable ? null : <span className="cand-add">add</span>}
                </span>
              </span>
            </button>
          ))}

          <div className="fs-line1" style={{ justifyContent: "space-between" }}>
            <button
              className="fs-btn is-text"
              onClick={() => send({ type: "select-batch", batchId: batch.id })}
            >
              Select {layers} on canvas
            </button>
            <button
              className="fs-btn is-text"
              onClick={() => dispatch({ type: "skip-batch", batchId: batch.id })}
              title="Puts this row aside for now. Nothing is written."
              style={{ color: "var(--ink-muted)" }}
            >
              Skip
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The one button on a closed row: the move that settles it.
 *
 * An exact match with a real variable behind it binds in place. Anything that
 * needs a decision — a near match, a token the file lacks — opens the row, where
 * the decision is made. An image goes to the Images view. A row with nothing to
 * press, because the theme has no token for it, draws no button at all: a
 * disabled one would promise something that is never going to happen.
 */
function RowAction({
  batch,
  image,
  action,
  picked,
  busy,
  dispatch,
  onReviewImages,
  label,
}: {
  batch: Batch;
  image: boolean;
  action: ReturnType<typeof bindAction>;
  picked: FixCandidate | null;
  busy: boolean;
  dispatch: (action: PanelAction) => void;
  onReviewImages: () => void;
  label: string;
}): JSX.Element | null {
  if (image) {
    return (
      <button
        className="fs-btn"
        aria-label={`Review ${batch.count} background ${batch.count === 1 ? "image" : "images"}`}
        onClick={onReviewImages}
      >
        Review
      </button>
    );
  }

  if (action.kind === "bind") {
    const proposal = batch.proposal;
    const exact = proposal && isFixProposal(proposal) && proposal.kind === "exact";
    // A near match the designer has picked still binds from the open row, where
    // the pick is visible. Only an exact match is safe to bind blind.
    if (exact) {
      return (
        <button
          className="fs-btn"
          disabled={busy}
          title={action.title}
          aria-label={`Bind ${label} to ${action.tokenRef}`}
          onClick={() =>
            send({ type: "apply-candidate", batchId: batch.id, tokenRef: action.tokenRef })
          }
        >
          Bind
        </button>
      );
    }
    return (
      <button
        className="fs-btn is-primary"
        disabled={busy}
        title={action.title}
        aria-label={`Bind ${label} to ${action.tokenRef}`}
        onClick={() =>
          send({ type: "apply-candidate", batchId: batch.id, tokenRef: action.tokenRef })
        }
      >
        Bind
      </button>
    );
  }

  if (action.kind === "add") {
    const proposal = batch.proposal;
    const refs =
      picked && !picked.bindable
        ? [picked.tokenRef]
        : proposal && isFixProposal(proposal)
          ? missingRefs(proposal)
          : [];
    return (
      <button
        className="fs-btn"
        disabled={busy || refs.length === 0}
        title={action.title}
        onClick={() => send({ type: "create-variables", refs })}
      >
        Add
      </button>
    );
  }

  if (action.kind === "pick") {
    return (
      <button
        className="fs-btn"
        title={action.title}
        aria-label={`Review ${label}`}
        onClick={() => dispatch({ type: "open-batch", batchId: batch.id })}
      >
        Review
      </button>
    );
  }

  // kind === "none": nothing to press. The row's own line says why.
  return null;
}

/** Bound. Same row, same place: it is what the row became. */
function Receipt({
  row,
  undoable,
  busy,
}: {
  row: ResolvedRow;
  undoable: boolean;
  busy: boolean;
}): JSX.Element {
  return (
    <div className="fs-row is-quiet">
      <div className="fs-row-head" style={{ minHeight: 38 }}>
        <span className="fs-mark" style={{ color: "var(--bound)" }} aria-hidden="true">
          <svg className="ic" viewBox="0 0 24 24">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </span>
        <span className="fs-rowbody">
          <span className="fs-val truncate" style={{ color: "var(--bound)" }}>
            {row.tokenRef}
          </span>
          <span className="t-caption truncate" style={{ color: "var(--ink-muted)" }}>
            {row.count} {row.count === 1 ? "layer" : "layers"} bound · +{row.gain}%
            {row.failed > 0 ? ` · ${row.failed} failed` : ""}
          </span>
        </span>
        {undoable ? (
          <button className="fs-btn is-text" disabled={busy} onClick={() => send({ type: "undo-last" })}>
            <UndoIcon />
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Put aside. Nothing was written, so the way back is a panel action, not an undo. */
function Skipped({
  batch,
  dispatch,
}: {
  batch: Batch;
  dispatch: (action: PanelAction) => void;
}): JSX.Element {
  return (
    <div className="fs-row is-quiet">
      <div className="fs-row-head" style={{ minHeight: 38 }}>
        <span className="fs-val truncate" style={{ flex: 1, color: "var(--ink-muted)" }}>
          {batch.currentValue} · skipped
        </span>
        <button
          className="fs-btn is-text"
          onClick={() => dispatch({ type: "unskip-batch", batchId: batch.id })}
        >
          <UndoIcon />
          Undo
        </button>
      </div>
    </div>
  );
}

function TargetNote({ note }: { note: string }): JSX.Element | null {
  if (!note) return null;
  if (note.startsWith("ΔE")) return <span className="fs-de">{note}</span>;
  if (note === "exact") return <span className="fs-de">exact</span>;
  return (
    <span className="t-mono" style={{ color: "var(--ink-muted)" }}>
      {note}
    </span>
  );
}

