/**
 * The last thing that happened on this frame, and Undo.
 *
 * The panel's only running commentary. A fix does not push a toast, a banner or a
 * log entry — those stack up, move everything below them, and turn a queue you
 * were reading into a queue you have to find again. It reports the change and it
 * stays put.
 *
 * Undo is this session only, and only while the fix is still on top of Figma's
 * undo stack.
 */
import type { JSX } from "react";
import { initialOf } from "../health/person.js";
import { UndoIcon } from "./icons.js";
import { send } from "./main.js";
import type { StudioState } from "./state.js";

export function StatusLine({ state }: { state: StudioState }): JSX.Element {
  const applied = state.applied;
  const person = applied?.user ?? state.user;
  const change = applied ? describe(applied.label, applied.tokenRef, applied.applied) : null;
  const failure =
    applied && applied.failed > 0 ? (applied.failures[0] ?? `${applied.failed} failed`) : null;

  return (
    <div className="fs-item">
      {person ? (
        <span className="fs-avatar" aria-hidden="true" title={person.name}>
          {initialOf(person.name)}
        </span>
      ) : null}

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span className="t-caption" style={{ fontWeight: 600 }}>
          {person ? firstWord(person.name) : ""}
        </span>
        <span
          className="t-caption truncate"
          style={{ color: "var(--ink-muted)" }}
          title={applied?.failures.join("\n") || change || undefined}
        >
          {failure ?? change ?? "Nothing changed yet"}
        </span>
      </div>

      {applied && applied.undoable ? (
        <button
          className="fs-btn is-text"
          onClick={() => send({ type: "undo-last" })}
          disabled={state.busy}
        >
          <UndoIcon />
          Undo
        </button>
      ) : null}
    </div>
  );
}

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function describe(label: string, tokenRef: string, applied: number): string {
  const count = applied > 0 ? ` · ${applied.toLocaleString()}` : "";
  // `round` is the F7 fix — a whole-pixel rewrite, not a token. Naming a token
  // there would be a lie about what changed.
  if (!tokenRef || tokenRef === "round") return `${label}${count}`;
  return `${label} → ${tokenRef}${count}`;
}
