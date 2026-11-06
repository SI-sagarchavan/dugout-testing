/**
 * Notes: what the frame cannot show, written on the layer it is about.
 *
 * "This strip swipes." "The badge is a live score." "Leave this one static."
 * The layout, content and style come from the frame; a note carries only what a
 * designer would otherwise have to say aloud to whoever builds the section. It
 * travels with the Handoff, and the agents treat each one as a requirement: it
 * is met, or the run says why not.
 */
import type { JSX } from "react";
import { useState } from "react";
import { ANNOTATION_KINDS, ANNOTATION_MAX_CHARS } from "../annotations.js";
import type { Annotation, AnnotationKind } from "../ir/schema.js";
import { TargetIcon } from "./icons.js";
import { send } from "./main.js";
import { Select } from "./Select.js";
import type { StudioState } from "./state.js";

const KIND_LABEL: Record<AnnotationKind, { label: string; hint: string }> = {
  "must-do": { label: "Must do", hint: "the build has to honour this" },
  data: { label: "Data", hint: "where this content comes from, or what it shows" },
  behaviour: { label: "Behaviour", hint: "what it does: swipes, opens, updates live" },
  ignore: { label: "Ignore", hint: "leave this out or keep it static" },
};

export function NotesView({ state }: { state: StudioState }): JSX.Element {
  const target = state.selectionNodeId;
  const [editing, setEditing] = useState<string | null>(null);
  const editingNote = state.notes.find((n) => n.id === editing) ?? null;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-label="Notes for the builder">
      <p className="t-mono" style={{ color: "var(--ink-muted)" }}>
        Notes the builder must address
      </p>

      {state.orphanedNotes > 0 ? (
        <div className="fs-card" role="status">
          <div className="t-body">
            {state.orphanedNotes} {state.orphanedNotes === 1 ? "note is" : "notes are"} on layers that are no longer in
            this frame. They will not be sent.
          </div>
        </div>
      ) : null}

      {state.notes.length > 0 ? (
        <ul style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {state.notes.map((note) => (
            <li key={note.id}>
              <NoteRow
                note={note}
                onEdit={() => setEditing(note.id)}
                active={editing === note.id}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="fs-card fs-empty">
          <div className="t-label">No notes yet.</div>
          <div className="t-body" style={{ color: "var(--ink-muted)" }}>
            Select a section or any layer on the canvas and say what the builder has to know about it.
          </div>
        </div>
      )}

      <NoteEditor
        key={editingNote?.id ?? target ?? "none"}
        state={state}
        note={editingNote}
        targetId={editingNote?.targetId ?? target}
        targetName={editingNote?.targetName ?? state.selectionName}
        onDone={() => setEditing(null)}
      />
    </section>
  );
}

function NoteRow({
  note,
  onEdit,
  active,
}: {
  note: Annotation;
  onEdit: () => void;
  active: boolean;
}): JSX.Element {
  return (
    <div className="fs-card" style={active ? { outline: "1px solid var(--link)" } : undefined}>
      <div className="fs-line1" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span className="t-label truncate">{note.targetName}</span>
        <span className="fs-pill">{KIND_LABEL[note.kind].label}</span>
      </div>
      <div className="t-body" style={{ whiteSpace: "pre-wrap" }}>
        {note.text}
      </div>
      <div className="fs-line1" style={{ gap: 4 }}>
        <button
          className="fs-btn is-text"
          onClick={() => send({ type: "select-nodes", nodeIds: [note.targetId] })}
          aria-label={`Select ${note.targetName} on canvas`}
        >
          <TargetIcon /> Select
        </button>
        <button className="fs-btn is-text" onClick={onEdit}>
          Edit
        </button>
        <button
          className="fs-btn is-text"
          style={{ color: "var(--ink-muted)" }}
          onClick={() => send({ type: "remove-note", id: note.id })}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function NoteEditor({
  state,
  note,
  targetId,
  targetName,
  onDone,
}: {
  state: StudioState;
  note: Annotation | null;
  targetId: string | null;
  targetName: string | null;
  onDone: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<AnnotationKind>(note?.kind ?? "must-do");
  const [text, setText] = useState(note?.text ?? "");
  const ready = Boolean(targetId) && text.trim().length > 0 && !state.busy;

  const save = (): void => {
    if (!targetId || !ready) return;
    send({ type: "save-note", ...(note ? { id: note.id } : {}), targetId, kind, text: text.trim() });
    setText("");
    onDone();
  };

  return (
    <div className="fs-card" role="group" aria-label={note ? "Edit note" : "New note"}>
      <div className="t-label truncate">
        {targetId ? (
          <>
            {note ? "Editing note on" : "Note on"} “{targetName}”
          </>
        ) : (
          "Select a layer to write a note on it"
        )}
      </div>
      <Select
        value={kind}
        options={ANNOTATION_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k].label, hint: KIND_LABEL[k].hint }))}
        onChange={setKind}
        label="What kind of note"
      />
      <textarea
        value={text}
        maxLength={ANNOTATION_MAX_CHARS}
        rows={3}
        placeholder="e.g. This strip swipes on mobile; each card links to its article."
        onChange={(event) => setText(event.target.value)}
        aria-label="Note text"
        style={{ resize: "vertical", width: "100%" }}
      />
      <div className="fs-line1" style={{ justifyContent: "space-between" }}>
        <span className="t-caption" style={{ color: "var(--ink-muted)" }}>
          {text.length}/{ANNOTATION_MAX_CHARS}
        </span>
        <span style={{ display: "flex", gap: 4 }}>
          {note ? (
            <button className="fs-btn is-compact" onClick={onDone}>
              Cancel
            </button>
          ) : null}
          <button className="fs-btn is-primary is-compact" disabled={!ready} onClick={save}>
            {note ? "Save" : "Add note"}
          </button>
        </span>
      </div>
    </div>
  );
}
