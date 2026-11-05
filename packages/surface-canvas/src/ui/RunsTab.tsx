/**
 * Runs: everything this plugin has sent, newest first, and what to do about it.
 *
 * What the plugin can honestly say is whether the files reached Studio. So a run
 * is *running* while frames are still going out, *needs you* when some did not
 * make it, and *sent* when everything did. Studio's own progress (matching,
 * binding, waiting for approval) is not visible from here until a runs API
 * exists; `Open in Studio` is how the designer follows a frame from there.
 */
import type { JSX } from "react";
import { useState } from "react";
import {
  ago,
  countFrames,
  framesToResend,
  needsAttention,
  runProblem,
  runStatus,
  runTitle,
  sortRuns,
  type RunRecord,
} from "../sends.js";
import { ArchiveIcon, ChevronIcon, ExternalIcon, RetryIcon } from "./icons.js";
import { send } from "./main.js";
import type { StudioState } from "./state.js";

/** Runs shown before the rest fold under "Older runs". */
const RECENT = 3;

export function RunsTab({ state }: { state: StudioState }): JSX.Element {
  const [showOlder, setShowOlder] = useState(false);
  const runs = sortRuns(state.runs);
  const recent = runs.slice(0, RECENT);
  const older = runs.slice(RECENT);

  const needs = needsAttention(runs);
  const running = runs.filter((run) => runStatus(run) === "running").length;

  if (runs.length === 0) {
    return (
      <main className="fs-main">
        <div className="fs-card fs-empty">
          <div className="t-label">Nothing sent yet.</div>
          <div className="t-body" style={{ color: "var(--ink-muted)" }}>
            Frames you send from this file show up here, with what to do if one didn’t make it.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="fs-main">
      <p className="t-mono" style={{ color: "var(--ink-muted)", marginBottom: 4 }}>
        {summary(needs, running, runs.length)}
      </p>

      {recent.map((run) => (
        <RunCard key={run.id} run={run} busy={state.busy} />
      ))}

      {older.length > 0 ? (
        <>
          <button
            className="fs-disclose"
            style={{ padding: "0 4px", color: "var(--ink-muted)" }}
            aria-expanded={showOlder}
            onClick={() => setShowOlder((value) => !value)}
          >
            <span className="t-label">Older runs</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="t-mono">{older.length}</span>
              <span style={{ display: "inline-flex", transform: showOlder ? "rotate(90deg)" : undefined }}>
                <ChevronIcon />
              </span>
            </span>
          </button>
          {showOlder ? older.map((run) => <RunCard key={run.id} run={run} busy={state.busy} />) : null}
        </>
      ) : null}
    </main>
  );
}

function summary(needs: number, running: number, total: number): string {
  const parts: string[] = [];
  if (needs > 0) parts.push(`${needs} needs you`);
  if (running > 0) parts.push(`${running} running`);
  return parts.length > 0 ? parts.join(" · ") : `${total} ${total === 1 ? "run" : "runs"}`;
}

function RunCard({ run, busy }: { run: RunRecord; busy: boolean }): JSX.Element {
  const status = runStatus(run);
  const counts = countFrames(run);
  const title = runTitle(run);
  const when = ago(run.at, Date.now());

  const head =
    status === "needs-you"
      ? { label: "Needs you", color: "var(--attention)" }
      : status === "running"
        ? { label: "Running", color: "var(--link)" }
        : status === "cancelled"
          ? { label: "Cancelled", color: "var(--ink-muted)" }
          : { label: "Sent", color: "var(--bound)" };

  return (
    <article className="fs-card" aria-label={`${title}: ${head.label.toLowerCase()}`}>
      <div className="fs-line1" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span className="fs-status" style={{ color: head.color }}>
          <span className="fs-dot" />
          {head.label}
        </span>
        <span className="t-mono" style={{ color: "var(--ink-muted)" }}>
          {when}
        </span>
      </div>

      <h2 className="t-title">{title}</h2>

      {status === "needs-you" ? <p className="t-body">{runProblem(run)}</p> : null}
      {status === "cancelled" ? (
        <p className="t-body" style={{ color: "var(--ink-muted)" }}>
          Stopped after {counts.sent} of {counts.total} {counts.total === 1 ? "frame" : "frames"}.
        </p>
      ) : null}

      {status === "running" ? (
        <>
          <div
            className="fs-bar is-link"
            role="progressbar"
            aria-label="Run progress"
            aria-valuemin={0}
            aria-valuemax={counts.total}
            aria-valuenow={counts.sent}
          >
            <span style={{ width: `${counts.total === 0 ? 0 : (counts.sent / counts.total) * 100}%` }} />
          </div>
          <div className="fs-line1" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
            <span className="t-mono" style={{ color: "var(--ink-muted)" }}>
              {counts.sent} of {counts.total} sent
            </span>
            <button
              className="fs-btn is-text"
              disabled={busy}
              onClick={() => send({ type: "restart-send", runId: run.id })}
            >
              <RetryIcon />
              Cancel and re-send
            </button>
          </div>
        </>
      ) : null}

      {status === "needs-you" || status === "cancelled" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            className="fs-btn"
            style={{ flex: 1 }}
            onClick={() =>
              send({
                type: "retry-frames",
                runId: run.id,
                frameIds: framesToResend(run).map((frame) => frame.frameId),
              })
            }
          >
            <RetryIcon />
            Re-send
          </button>
          <button
            className="fs-btn"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={() =>
              send({ type: "download-zip", frameIds: run.frames.map((frame) => frame.frameId) })
            }
          >
            <ArchiveIcon />
            Download ZIP
          </button>
        </div>
      ) : null}

      {status === "sent" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            className="fs-btn is-primary"
            style={{ flex: 1 }}
            onClick={() => send({ type: "open-studio" })}
          >
            Open in Studio
            <ExternalIcon />
          </button>
          <button
            className="fs-btn"
            onClick={() =>
              send({ type: "send-frames", frameIds: run.frames.map((frame) => frame.frameId) })
            }
          >
            <RetryIcon />
            Re-send
          </button>
        </div>
      ) : null}
    </article>
  );
}
