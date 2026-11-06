/**
 * Images: the background assets this frame ships, and where to add one.
 *
 * An asset creates `asset.texture.<name>`: a token the compiler emits, the run
 * stores a URL against, and the renderer fetches. The designer exports a region
 * from Figma the way they always do and drops the file in; the only remaining
 * question, which region it was, is answered by matching the filename and pixel
 * size against the frame. When that is certain nothing is asked at all.
 *
 * A row is the asset at a glance — name, where it came from, a button that
 * selects what it paints on the canvas. Opening it shows the rest: fit, target,
 * and how the bitmap lands inside the element.
 */
import type { DragEvent, JSX } from "react";
import { useState } from "react";
import type { TargetMatch, TargetOption } from "../assets.js";
import { assetRef, type AssetBinding, type AssetFit } from "../ir/schema.js";
import type { AssetPlacement } from "../ir/placement.js";
import { ImageIcon, TargetIcon } from "./icons.js";
import { send } from "./main.js";
import type { PanelAction, StudioState } from "./state.js";

const FITS: ReadonlyArray<{ value: AssetFit; label: string; hint: string }> = [
  { value: "cover", label: "Cover", hint: "fills the box, cropping the overflow" },
  { value: "contain", label: "Contain", hint: "fits inside the box, whole" },
  { value: "repeat", label: "Tile", hint: "repeats from the top-left" },
  { value: "none", label: "None", hint: "natural size, no scaling" },
];

export function ImagesView({
  state,
  dispatch,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
}): JSX.Element {
  const frame = state.report?.rootName ?? state.selectionName ?? "";

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-label="Background assets">
      <div className="fs-line1" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <p className="t-mono" style={{ color: "var(--ink-muted)" }}>
          Background assets in the selected frame
        </p>
        {frame ? <span className="fs-pill truncate">{frame}</span> : null}
      </div>

      {state.unmapped ? <UnmappedPrompt unmapped={state.unmapped} dispatch={dispatch} /> : null}

      {state.assets.length > 0 ? (
        <ul style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {state.assets.map((binding) => (
            <li key={binding.imageHash}>
              <AssetRow
                binding={binding}
                placement={state.placements[binding.imageHash]}
                targets={state.targets[binding.imageHash] ?? []}
                busy={state.busy}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="fs-card fs-empty">
          <div className="t-label">No background images yet.</div>
          <div className="t-body" style={{ color: "var(--ink-muted)" }}>
            Content photos stay placeholders. Drop an exported texture or plate below to ship it.
          </div>
        </div>
      )}

      <DropZone busy={state.busy} />
    </section>
  );
}

/**
 * Read the dropped files and hand the bytes to the sandbox.
 *
 * The natural size is measured HERE, in the iframe, because the sandbox has no
 * `Image` and no `createImageBitmap` — and the size is half of what identifies
 * the region the file came from. Sending bytes without it would leave the
 * matcher with only the filename to go on.
 */
function DropZone({ busy }: { busy: boolean }): JSX.Element {
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(0);

  async function accept(files: readonly File[]): Promise<void> {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;

    setReading(images.length);
    try {
      for (const file of images) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const size = await naturalSize(file);
        send({
          type: "upload-asset",
          fileName: file.name,
          bytes,
          width: size.width,
          height: size.height,
        });
      }
    } finally {
      setReading(0);
    }
  }

  return (
    <label
      className={`dropzone${over ? " over" : ""}`}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        void accept([...e.dataTransfer.files]);
      }}
    >
      {/* A file input as well as a drop target: dragging out of Figma's own export
          dialog is fiddly, and some people would rather browse. */}
      <input
        type="file"
        accept="image/*"
        multiple
        disabled={busy}
        onChange={(e) => {
          void accept([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <div className="t-label">
        {reading > 0
          ? `Reading ${reading} ${reading === 1 ? "image" : "images"}…`
          : "Drop exported images here"}
      </div>
      <div className="t-caption" style={{ color: "var(--ink-muted)", marginTop: 2 }}>
        Export a region from Figma as usual, then drop the file in. Each one is matched to the
        part of the design it came from.
      </div>
    </label>
  );
}

/**
 * "Which element is this?" — asked only when the matcher is not sure.
 *
 * A background painted onto the wrong element is harder to notice, and harder
 * to diagnose, than one that was never placed. So an uncertain match asks. The
 * bytes are already in the document, so answering costs a click rather than
 * another drag.
 */
function UnmappedPrompt({
  unmapped,
  dispatch,
}: {
  unmapped: NonNullable<StudioState["unmapped"]>;
  dispatch: (action: PanelAction) => void;
}): JSX.Element {
  return (
    <div className="fs-card" role="group" aria-label={`Where does ${unmapped.fileName} go?`}>
      <div className="fs-line1" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span className="t-label truncate">Where does “{unmapped.fileName}” go?</span>
        <button
          className="fs-btn is-text"
          onClick={() => dispatch({ type: "dismiss-unmapped" })}
          style={{ color: "var(--ink-muted)" }}
        >
          Skip
        </button>
      </div>
      <div className="t-caption" style={{ color: "var(--ink-muted)" }}>
        {unmapped.width}×{unmapped.height} px ·{" "}
        {unmapped.candidates.length === 0
          ? "nothing in this frame is that shape or name"
          : "closest matches first"}
      </div>

      {unmapped.candidates.map((candidate) => (
        <Candidate key={candidate.id} candidate={candidate} unmapped={unmapped} />
      ))}
    </div>
  );
}

function Candidate({
  candidate,
  unmapped,
}: {
  candidate: TargetMatch;
  unmapped: NonNullable<StudioState["unmapped"]>;
}): JSX.Element {
  return (
    <button
      className="fs-btn"
      style={{ flexDirection: "column", alignItems: "flex-start", gap: 0, padding: "6px 10px", minHeight: 40 }}
      onClick={() =>
        // `place-asset`, not `upload-asset`: the bytes went into the document
        // when the file was dropped, and re-uploading would duplicate them.
        send({
          type: "place-asset",
          imageHash: unmapped.imageHash,
          fileName: unmapped.fileName,
          width: unmapped.width,
          height: unmapped.height,
          targetId: candidate.id,
        })
      }
      onMouseEnter={() => send({ type: "select-nodes", nodeIds: [candidate.id] })}
    >
      <span className="t-label truncate" style={{ maxWidth: "100%" }}>
        {candidate.name}
      </span>
      <span className="t-caption truncate" style={{ color: "var(--ink-muted)", maxWidth: "100%" }}>
        {candidate.width}×{candidate.height} · {candidate.reasons.join(", ")}
      </span>
    </button>
  );
}

function AssetRow({
  binding,
  placement,
  targets,
  busy,
}: {
  binding: AssetBinding;
  placement: AssetPlacement | undefined;
  targets: readonly TargetOption[];
  busy: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const key = binding.imageHash;

  return (
    <div className={open ? "fs-row is-open" : "fs-row"}>
      <div className="fs-row-head">
        <button
          className="fs-row-hit"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          title={`${assetRef(binding.name)} — ${open ? "hide" : "show"} details`}
        >
          <span className="fs-well" aria-hidden="true">
            <ImageIcon />
          </span>
          <span className="fs-rowbody">
            <span className="fs-line1" style={{ flexWrap: "nowrap" }}>
              <span className="t-label truncate">{binding.name}</span>
              {/* An auto-mapping is a guess. Saying so is what lets a designer who
                  later finds the wrong region painted know where to look. */}
              {binding.mapping === "auto" ? <span className="fs-pill">auto</span> : null}
            </span>
            <span className="t-caption truncate" style={{ color: "var(--ink-muted)" }}>
              Background · {binding.fileName} · {binding.width}×{binding.height} → {binding.targetName}
            </span>
          </span>
        </button>
        <button
          className="fs-iconbtn"
          aria-label={`Select ${binding.name} on canvas`}
          title="Select what it paints on the canvas"
          onClick={() => send({ type: "select-nodes", nodeIds: [binding.targetId] })}
        >
          <TargetIcon />
        </button>
      </div>

      {open ? (
        <div className="fs-body">
          {editing ? (
            <NameField
              name={binding.name}
              onCommit={(name) => {
                setEditing(false);
                if (name !== binding.name) send({ type: "rename-asset", key, name });
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <button
              className="fs-btn is-text"
              style={{ alignSelf: "flex-start", padding: 0 }}
              onClick={() => setEditing(true)}
              title={`${assetRef(binding.name)} — click to rename`}
            >
              Rename {assetRef(binding.name)}
            </button>
          )}

          <Placement placement={placement} />

          <div className="fs-line1" style={{ gap: 4 }}>
            <FitPicker binding={binding} busy={busy} />
          </div>

          <TargetPicker binding={binding} targets={targets} busy={busy} />

          <button
            className="fs-btn is-text"
            style={{ alignSelf: "flex-start", padding: 0, color: "var(--ink-muted)" }}
            onClick={() => send({ type: "remove-asset", key })}
            title="Stop shipping this image"
          >
            Stop shipping this image
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where the bitmap lands, in the words that describe what will be emitted.
 *
 * "Covers" and "placed" are the two branches the compiler takes: a covering
 * asset folds into the target's surface, a placed one stays a positioned node.
 */
function Placement({ placement }: { placement: AssetPlacement | undefined }): JSX.Element | null {
  if (!placement) return null;

  const { covers, offset, size, target } = placement;
  const box = `${Math.round(size.w)}×${Math.round(size.h)}`;

  if (covers) {
    return (
      <div className="t-caption truncate" style={{ color: "var(--ink-muted)" }}>
        paints the whole element
      </div>
    );
  }

  return (
    <div className="t-caption" style={{ color: "var(--attention)" }}>
      {box} at {Math.round(offset.x)},{Math.round(offset.y)} in a {Math.round(target.w)}×
      {Math.round(target.h)} target — placed, not full-bleed
    </div>
  );
}

/** Which element this asset paints, chosen from the target's ancestors. */
function TargetPicker({
  binding,
  targets,
  busy,
}: {
  binding: AssetBinding;
  targets: readonly TargetOption[];
  busy: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (targets.length === 0) return null;

  if (!open) {
    return (
      <button
        className="fs-btn is-text"
        style={{ alignSelf: "flex-start", padding: 0 }}
        onClick={() => setOpen(true)}
        title="Choose which element this image paints"
      >
        Change what it paints
      </button>
    );
  }

  return (
    <div className="target-picker">
      {targets.map((target) => {
        const current = target.id === binding.targetId;
        return (
          <button
            key={target.id}
            className={current ? "fs-btn is-compact is-primary" : "fs-btn is-compact"}
            disabled={busy}
            style={{ width: "100%", justifyContent: "flex-start", marginBottom: 4 }}
            onClick={() => {
              setOpen(false);
              if (!current) {
                send({ type: "retarget-asset", key: binding.imageHash, targetId: target.id });
              }
            }}
            onMouseEnter={() => send({ type: "select-nodes", nodeIds: [target.id] })}
            title={`${target.width}×${target.height}`}
          >
            <span className="truncate">
              {"↳ ".repeat(Math.min(target.depth - 1, 3))}
              {target.name}
            </span>
            <span style={{ color: "var(--ink-muted)" }}>
              {" "}
              {target.width}×{target.height}
            </span>
          </button>
        );
      })}
      <button className="fs-btn is-text" style={{ color: "var(--ink-muted)" }} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

function FitPicker({ binding, busy }: { binding: AssetBinding; busy: boolean }): JSX.Element {
  const current = binding.fit ?? "cover";
  return (
    <>
      {FITS.map((fit) => (
        <button
          key={fit.value}
          className={current === fit.value ? "fs-btn is-compact is-primary" : "fs-btn is-compact"}
          disabled={busy}
          onClick={() => send({ type: "set-asset-fit", key: binding.imageHash, fit: fit.value })}
          title={fit.hint}
        >
          {fit.label}
        </button>
      ))}
    </>
  );
}

/**
 * Rename, validated on the way in.
 *
 * The sandbox is the authority — it owns the other assets and refuses a
 * collision — but a field that lets you type a space and only complains after a
 * round trip is a worse field.
 */
function NameField({
  name,
  onCommit,
  onCancel,
}: {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState(name);

  return (
    <input
      className="name-field"
      autoFocus
      value={value}
      onChange={(event) => setValue(normalizeName(event.target.value))}
      onBlur={() => (value ? onCommit(value) : onCancel())}
      onKeyDown={(event) => {
        if (event.key === "Enter" && value) onCommit(value);
        if (event.key === "Escape") onCancel();
      }}
      spellCheck={false}
      aria-label="Asset name"
    />
  );
}

/** What the token layer will accept, applied while typing rather than after. */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+/, "");
}

/**
 * The image's own pixel size.
 *
 * Half of what identifies the region it came from: a 2732x836 file is the
 * 1366x418 header at a 2x export, and no other element in the frame is that
 * shape. Measured with a blob URL rather than `createImageBitmap`, which Figma's
 * iframe does not reliably expose.
 */
function naturalSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    // A size of zero still uploads: the filename alone may identify the layer,
    // and refusing the file outright over an unreadable header helps nobody.
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 0, height: 0 });
    };
    img.src = url;
  });
}
