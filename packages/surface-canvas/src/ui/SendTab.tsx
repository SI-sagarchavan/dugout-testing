/**
 * Send: what is going out, whether it should, and how it is going.
 *
 * Two screens on one tab. The pre-flight lists the frames and four checks, none
 * of which blocks the send: a designer who knows about a loose value should be
 * able to send anyway, and the checks say so in words ("Open items won't block
 * the send"). The progress screen takes over the moment a send starts and stays
 * until the designer leaves it, so a finished send is read, not missed.
 *
 * Frames go out one Send each. The files for a frame travel in a single request,
 * so there is no honest percentage for a frame in flight: it shows how many files
 * it carries and a moving bar, and the overall bar counts frames.
 */
import type { JSX } from "react";
import type { AuthView, Tab } from "../protocol.js";
import {
  countFrames,
  runStatus,
  type FrameSend,
  type RunRecord,
} from "../sends.js";
import { tenantBlocker } from "../auth/tenants.js";
import { connect } from "./auth.js";
import { framesToSend, sendLabel } from "./frames.js";
import {
  AlertIcon,
  ArchiveIcon,
  CheckIcon,
  ExternalIcon,
  RetryIcon,
  SendIcon,
} from "./icons.js";
import { send } from "./main.js";
import { needsPick } from "./rows.js";
import type { PanelAction, StudioState } from "./state.js";

export function SendTab({
  state,
  dispatch,
  go,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
  go: (tab: Tab, view?: "queue" | "images") => void;
}): JSX.Element {
  const run = state.activeRunId ? state.runs.find((item) => item.id === state.activeRunId) : undefined;
  return run ? (
    <Progress state={state} run={run} />
  ) : (
    <Preflight state={state} dispatch={dispatch} go={go} />
  );
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

function Preflight({
  state,
  dispatch,
  go,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
  go: (tab: Tab, view?: "queue" | "images") => void;
}): JSX.Element {
  const frames = framesToSend(state);
  const report = state.report;
  const theme = state.themes.find((item) => item.id === state.themeId);
  const loose = report?.coverage.loose ?? 0;
  const picks = needsPick(state).length;
  const checkedFrame = report?.rootName ?? "";
  const auth = state.auth;
  // Signed out: everything else about the send can still be looked at; only the
  // send itself waits.
  const clientBlocker = tenantBlocker(state.tenants);
  const blocked = auth.phase !== "signed-in" || clientBlocker !== null;
  const blockedReason = auth.phase !== "signed-in" ? "Connect your account to send." : clientBlocker;

  return (
    <>
      <main className="fs-main" style={{ gap: 12 }}>
        <Account auth={auth} />

        <section className="fs-card" aria-label="What you are sending">
          <div className="fs-line1" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
            <h2 className="t-title">
              {frames.length} {frames.length === 1 ? "frame" : "frames"}
            </h2>
          </div>
          {frames.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {frames.map((frame) => (
                <span key={frame.id} className="fs-tag" title={frame.name}>
                  {frame.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="t-body" style={{ color: "var(--ink-muted)" }}>
              Select one or more frames on the canvas to send them.
            </p>
          )}
          {frames.length > 0 ? (
            <p className="t-caption" style={{ color: "var(--ink-muted)" }}>
              Select other frames on the canvas to change this. Each goes out as its own Send.
            </p>
          ) : null}
          <div
            className="fs-line1"
            style={{
              justifyContent: "space-between",
              paddingTop: 12,
              borderTop: "1px solid var(--line)",
            }}
          >
            <span className="t-overline" style={{ color: "var(--ink-muted)" }}>
              Sends to
            </span>
            <span className="t-label truncate">FanXP backend</span>
          </div>
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label="Pre-flight">
          <h2 className="t-overline" style={{ color: "var(--ink-muted)" }}>
            Pre-flight
          </h2>
          <ul className="fs-card is-list">
            <Check
              ok={auth.phase === "signed-in"}
              pending={auth.phase === "waiting"}
              title="Account"
              detail={
                auth.phase === "signed-in"
                  ? auth.user.name
                  : auth.phase === "waiting"
                    ? "Waiting for the browser…"
                    : "Not connected"
              }
              trailing={
                auth.phase === "signed-in" ? (
                  <Verdict ok label="Passed" />
                ) : auth.phase === "signed-out" ? (
                  <button className="fs-btn is-text" onClick={connect}>
                    Connect
                  </button>
                ) : null
              }
            />

            {auth.phase === "signed-in" ? <ClientRow state={state} /> : null}

            <Check
              ok={Boolean(theme)}
              title="Token set"
              detail={theme?.name ?? "No token set"}
              trailing={
                theme ? <Verdict ok label="Passed" /> : <Verdict ok={false} label="Missing" />
              }
            />

            <Check
              ok={loose === 0}
              title="Loose values"
              detail={
                loose === 0
                  ? "Everything is bound"
                  : `${loose} left${picks > 0 ? ` · ${picks} ${picks === 1 ? "batch needs" : "batches need"} a pick` : ""}`
              }
              trailing={
                loose === 0 ? (
                  <Verdict ok label="Passed" />
                ) : (
                  <button
                    className="fs-btn is-text"
                    aria-label="Fix loose values in Check"
                    onClick={() => go("check", "queue")}
                  >
                    Fix
                  </button>
                )
              }
            />

            <Check
              ok
              title="Background images"
              detail={
                state.assets.length === 0
                  ? `None marked${checkedFrame ? ` in ${checkedFrame}` : ""}`
                  : `${state.assets.length} ${state.assets.length === 1 ? "asset" : "assets"}${checkedFrame ? ` in ${checkedFrame}` : ""}`
              }
              trailing={
                <button
                  className="fs-btn is-text"
                  aria-label="View background images in Check"
                  onClick={() => go("check", "images")}
                >
                  View
                </button>
              }
            />

          </ul>
        </section>

        <p className="t-caption" style={{ color: "var(--ink-muted)" }}>
          Open items won’t block the send.
        </p>
      </main>

      <footer className="fs-foot">
        <button
          className="fs-btn"
          disabled={frames.length === 0 || state.busy}
          onClick={() => send({ type: "download-zip", frameIds: frames.map((frame) => frame.id) })}
          title="Same files as the send, on disk. For when the backend is down."
        >
          <ArchiveIcon />
          {state.busy ? "Preparing…" : "Export ZIP"}
        </button>
        <button
          className="fs-btn is-primary"
          style={{ flex: 1 }}
          disabled={frames.length === 0 || blocked}
          title={blockedReason ?? undefined}
          onClick={() => send({ type: "send-frames", frameIds: frames.map((frame) => frame.id) })}
        >
          <SendIcon />
          {blocked && frames.length > 0
            ? auth.phase !== "signed-in"
              ? "Connect to send"
              : "Choose a client"
            : sendLabel(frames)}
        </button>
      </footer>
    </>
  );
}

/**
 * Signing in, as the cards it takes.
 *
 * Signed out: one button. Waiting: the code the person compares with the browser
 * page, because approving a login you did not start is exactly the mistake a
 * device-style flow invites. Signed in: nothing here at all; the pre-flight's
 * Account row says who, and the profile at top right is how to leave.
 */
function Account({ auth }: { auth: AuthView }): JSX.Element | null {
  if (auth.phase === "waiting") {
    return (
      <section className="fs-card" aria-label="Sign in" aria-live="polite">
        <h2 className="t-title">Approve in your browser</h2>
        <p className="t-body" style={{ color: "var(--ink-muted)" }}>
          Check this code matches the one on the page, then approve.
        </p>
        <div
          className="fs-val"
          style={{ fontSize: 22, lineHeight: "28px", letterSpacing: "0.12em", textAlign: "center" }}
          aria-label={`Code ${auth.userCode.split("").join(" ")}`}
        >
          {auth.userCode}
        </div>
        <div className="fs-line1" style={{ justifyContent: "space-between" }}>
          <button className="fs-btn is-text" onClick={() => send({ type: "auth-open" })}>
            Open the page again
          </button>
          <button
            className="fs-btn is-text"
            style={{ color: "var(--ink-muted)" }}
            onClick={() => send({ type: "auth-cancel" })}
          >
            Cancel
          </button>
        </div>
      </section>
    );
  }

  if (auth.phase === "signed-out") {
    return (
      <section className="fs-card" aria-label="Sign in">
        <h2 className="t-title">Connect your account</h2>
        <p className="t-body" style={{ color: "var(--ink-muted)" }}>
          Sign in with FanXP to send. You approve in your browser; the plugin never sees your
          password.
        </p>
        {auth.message ? (
          <p className="t-body" role="alert" style={{ color: "var(--attention)" }}>
            {auth.message}
          </p>
        ) : null}
        <button className="fs-btn is-primary" onClick={connect}>
          Connect
        </button>
      </section>
    );
  }
  return null;
}

function Check({
  ok,
  pending = false,
  title,
  detail,
  trailing,
}: {
  ok: boolean;
  pending?: boolean;
  title: string;
  detail: string;
  trailing: JSX.Element | null;
}): JSX.Element {
  const color = pending ? "var(--ink-muted)" : ok ? "var(--bound)" : "var(--attention)";
  return (
    <li className="fs-item" style={{ minHeight: 44, padding: "6px 0" }}>
      <span className="fs-mark" style={{ color }} aria-hidden="true">
        {pending ? <span className="fs-dot" /> : ok ? <CheckIcon /> : <AlertIcon />}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span className="t-label">{title}</span>
        <span className="t-caption" style={{ color: "var(--ink-muted)" }}>
          {detail}
        </span>
      </div>
      {trailing}
    </li>
  );
}

function Verdict({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return (
    <span className="fs-status" style={{ color: ok ? "var(--bound)" : "var(--attention)" }}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function Progress({ state, run }: { state: StudioState; run: RunRecord }): JSX.Element {
  const status = runStatus(run);
  const counts = countFrames(run);
  const running = status === "running";
  const percent = counts.total === 0 ? 0 : Math.round((counts.sent / counts.total) * 100);
  const failed = run.frames.filter((frame) => frame.status === "failed" || frame.status === "cancelled");

  const verdict =
    status === "running"
      ? { label: "Uploading", color: "var(--link)" }
      : status === "sent"
        ? { label: "Sent", color: "var(--bound)" }
        : status === "cancelled"
          ? { label: "Cancelled", color: "var(--ink-muted)" }
          : { label: "Needs you", color: "var(--attention)" };

  const note = running
    ? "Keep this window open until it finishes."
    : status === "sent"
      ? "Everything is uploaded and checked."
      : status === "cancelled"
        ? "Stopped. Frames that were already sent are uploaded."
        : "Some frames didn’t make it. Retry them, or download a ZIP.";

  return (
    <>
      <main className="fs-main" style={{ gap: 12 }}>
        <section className="fs-card" aria-label="Upload progress">
          <div className="fs-line1" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span className="t-score">
                {counts.sent} of {counts.total}
              </span>
              <span className="t-body" style={{ color: "var(--ink-muted)" }}>
                sent
              </span>
            </span>
            <span className="fs-status" style={{ color: verdict.color }}>
              <span className="fs-dot" />
              {verdict.label}
            </span>
          </div>
          <div
            className={status === "needs-you" ? "fs-bar" : "fs-bar is-link"}
            role="progressbar"
            aria-label="Overall upload"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span
              style={{
                width: `${percent}%`,
                background: status === "sent" ? "var(--bound)" : undefined,
              }}
            />
          </div>
          <p className="t-caption" style={{ color: "var(--ink-muted)" }}>
            {note}
          </p>
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label="Per frame">
          <h2 className="t-overline" style={{ color: "var(--ink-muted)" }}>
            Frames
          </h2>
          <ul className="fs-card is-list">
            {run.frames.map((frame) => (
              <FrameRow key={frame.frameId} run={run} frame={frame} busy={state.busy} />
            ))}
          </ul>
        </section>

        {failed.length > 0 && !running ? (
          <section
            className="fs-card"
            aria-label="ZIP fallback"
            style={{ flexDirection: "row", alignItems: "center" }}
          >
            <span className="fs-well" aria-hidden="true">
              <ArchiveIcon />
            </span>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="t-label">Still failing?</span>
              <span className="t-caption" style={{ color: "var(--ink-muted)" }}>
                Download everything as a ZIP and add it in Studio yourself.
              </span>
            </div>
            <button
              className="fs-btn"
              style={{ padding: "0 10px" }}
              disabled={state.busy}
              onClick={() =>
                send({ type: "download-zip", frameIds: run.frames.map((frame) => frame.frameId) })
              }
            >
              {state.busy ? "Preparing…" : "Download"}
            </button>
          </section>
        ) : null}
      </main>

      <footer className="fs-foot">
        {running ? (
          <>
            <button className="fs-btn" onClick={() => send({ type: "cancel-send" })}>
              Cancel send
            </button>
            <button className="fs-btn is-primary" aria-disabled="true" style={{ flex: 1 }}>
              Sending…
            </button>
          </>
        ) : (
          <>
            <button className="fs-btn" onClick={() => send({ type: "dismiss-send" })}>
              Done
            </button>
            {failed.length > 0 ? (
              <button
                className="fs-btn is-primary"
                style={{ flex: 1 }}
                onClick={() =>
                  send({
                    type: "retry-frames",
                    runId: run.id,
                    frameIds: failed.map((frame) => frame.frameId),
                  })
                }
              >
                <RetryIcon />
                Retry {failed.length} {failed.length === 1 ? "frame" : "frames"}
              </button>
            ) : (
              <button
                className="fs-btn is-primary"
                style={{ flex: 1 }}
                onClick={() => send({ type: "open-studio" })}
              >
                Open Studio
                <ExternalIcon />
              </button>
            )}
          </>
        )}
      </footer>
    </>
  );
}

function FrameRow({
  run,
  frame,
  busy,
}: {
  run: RunRecord;
  frame: FrameSend;
  busy: boolean;
}): JSX.Element {
  const files = `${frame.files} ${frame.files === 1 ? "file" : "files"}`;
  const inFlight = frame.status === "walking" || frame.status === "uploading";

  const color =
    frame.status === "sent"
      ? "var(--bound)"
      : frame.status === "failed"
        ? "var(--attention)"
        : inFlight
          ? "var(--link)"
          : "var(--ink-muted)";

  return (
    <li className="fs-item is-wrap" style={{ minHeight: 44, padding: "8px 0" }}>
      <span className="fs-mark" style={{ color }} aria-hidden="true">
        {frame.status === "sent" ? (
          <CheckIcon />
        ) : frame.status === "failed" ? (
          <AlertIcon />
        ) : inFlight ? (
          <SendIcon />
        ) : (
          <span className="fs-dot" />
        )}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span className="t-label truncate">{frame.name}</span>
        {frame.status === "failed" ? (
          <span className="t-caption" style={{ color: "var(--attention)" }}>
            Upload failed{frame.error ? ` · ${frame.error}` : ""}
          </span>
        ) : (
          <span className="t-mono" style={{ color: "var(--ink-muted)" }}>
            {frame.status === "walking"
              ? "Reading the frame…"
              : frame.status === "waiting"
                ? "Waiting"
                : frame.status === "cancelled"
                  ? "Cancelled"
                  : files}
          </span>
        )}
      </div>

      {frame.status === "failed" || frame.status === "cancelled" ? (
        <button
          className="fs-btn"
          aria-label={`Retry ${frame.name}`}
          style={{ padding: "0 10px", background: "var(--surface-well)" }}
          disabled={busy}
          onClick={() => send({ type: "retry-frames", runId: run.id, frameIds: [frame.frameId] })}
        >
          <RetryIcon />
          Retry
        </button>
      ) : frame.status === "sent" ? (
        <span className="fs-status" style={{ color }}>
          Sent
        </span>
      ) : null}

      {inFlight ? (
        <div
          className="fs-bar is-link is-thin is-busy"
          role="progressbar"
          aria-label={`${frame.name} upload`}
          style={{ flexBasis: "100%" }}
        >
          <span />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Which client this send is for. One sign-in covers every client the account may
 * send for; the file remembers the choice. Only the backend decides what is
 * allowed, so this list is a convenience, never the gate.
 */
function ClientRow({ state }: { state: StudioState }): JSX.Element {
  const view = state.tenants;
  if (view.status !== "ready") {
    return (
      <Check
        ok={false}
        pending={view.status === "loading"}
        title="Client"
        detail={tenantBlocker(view) ?? ""}
        trailing={
          view.status === "error" ? (
            <button className="fs-btn is-text" onClick={() => send({ type: "tenants-load" })}>
              Retry
            </button>
          ) : null
        }
      />
    );
  }

  if (view.tenants.length === 0) {
    return <Check ok={false} title="Client" detail={tenantBlocker(view) ?? ""} trailing={null} />;
  }

  return (
    <Check
      ok={view.selected !== null}
      title="Client"
      detail={view.tenants.length === 1 ? view.tenants[0]!.name : "Where these frames go"}
      trailing={
        view.tenants.length === 1 ? (
          <Verdict ok label="Passed" />
        ) : (
          <select
            aria-label="Client"
            value={view.selected ?? ""}
            onChange={(event) => send({ type: "tenant-select", code: event.target.value })}
            style={{ maxWidth: 170 }}
          >
            {view.selected === null ? <option value="">Choose…</option> : null}
            {view.tenants.map((tenant) => (
              <option key={tenant.code} value={tenant.code}>
                {tenant.name}
              </option>
            ))}
          </select>
        )
      }
    />
  );
}
