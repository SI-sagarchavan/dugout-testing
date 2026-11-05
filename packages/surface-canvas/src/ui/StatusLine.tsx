/**
 * The last thing that happened on this frame, and Undo.
 *
 * The panel's only running commentary. A fix does not push a toast, a banner or a
 * log entry — those stack up, move everything below them, and turn a queue you
 * were reading into a queue you have to find again. It reports the change and it
 * stays put.
 *
 * Undo is this session only, and only while the fix is still on top of Figma's
 * undo stack. Somebody else's bind is news, never a button.
 */
import type { JSX } from "react";
import { recentActors, samePerson } from "../health/activity.js";
import type { ActivityActor } from "../health/activity.js";
import { initialOf } from "../health/activity.js";
import { UndoIcon } from "./icons.js";
import { send } from "./main.js";
import { PersonChip } from "./PersonChip.js";
import type { StudioState } from "./state.js";

export function StatusLine({ state }: { state: StudioState }): JSX.Element {
  const applied = state.applied;
  const latest = state.activity[0] ?? null;

  const actor: ActivityActor | null = applied?.user ?? latest?.actor ?? state.user;
  const change = applied
    ? describe(applied.label, applied.tokenRef, applied.applied)
    : latest
      ? describe(latest.label, latest.tokenRef, latest.applied)
      : null;

  const failure =
    applied && applied.failed > 0 ? (applied.failures[0] ?? `${applied.failed} failed`) : null;

  // Everyone else who has touched this frame recently, as bare initials. The line
  // has room for one name, and "who else is in here" is worth more than a second
  // line to say it in.
  const others = recentActors(state.activity).filter(
    (other) => !(actor && samePerson(other, actor)),
  );

  return (
    <div className="fs-item">
      {actor ? (
        <span className="fs-avatar" aria-hidden="true" title={actor.name}>
          {initialOf(actor.name)}
        </span>
      ) : null}

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span className="t-caption" style={{ fontWeight: 600 }}>
          {actor ? firstWord(actor.name) : ""}
        </span>
        <span
          className="t-caption truncate"
          style={{ color: "var(--ink-muted)" }}
          title={applied?.failures.join("\n") || change || undefined}
        >
          {failure ?? change ?? "No binds on this frame yet"}
        </span>
      </div>

      {others.length > 0 ? (
        <span className="others" title={`Also here: ${others.map((o) => o.name).join(", ")}`}>
          {others.map((other) => (
            <PersonChip key={other.id ?? other.name} actor={other} nameless />
          ))}
        </span>
      ) : null}

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
