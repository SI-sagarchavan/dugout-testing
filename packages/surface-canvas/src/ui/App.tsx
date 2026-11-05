/**
 * The panel: three tabs along the way a frame travels.
 *
 *   Check  is this frame ready? (fix the loose values, mark the images)
 *   Send   send it, one Send per frame
 *   Runs   what went out, and what to do about it
 *
 * Everything on screen arrived over postMessage from the sandbox and every action
 * leaves the same way; this file owns only which tab is showing.
 */
import type { JSX } from "react";
import { useState } from "react";
import type { Tab } from "../protocol.js";
import { needsAttention } from "../sends.js";
import { AccountMenu } from "./AccountMenu.js";
import { CheckTab, type CheckView } from "./CheckTab.js";
import { RescanIcon } from "./icons.js";
import { send } from "./main.js";
import { RunsTab } from "./RunsTab.js";
import { SendTab } from "./SendTab.js";
import type { PanelAction, StudioState } from "./state.js";

export function App({
  state,
  dispatch,
  stalled = false,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
  stalled?: boolean;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>("check");
  const [view, setView] = useState<CheckView>("queue");

  if (state.panelState === "collapsed") return <Collapsed state={state} />;

  const go = (next: Tab, nextView?: CheckView): void => {
    if (nextView) setView(nextView);
    setTab(next);
  };
  const attention = needsAttention(state.runs);

  return (
    <>
      <header className="fs-top">
        <div className="fs-tabs" role="tablist" aria-label="Plugin sections">
          <button className="fs-tab" role="tab" aria-selected={tab === "check"} onClick={() => go("check")}>
            Check
          </button>
          <button className="fs-tab" role="tab" aria-selected={tab === "send"} onClick={() => go("send")}>
            Send
          </button>
          <button className="fs-tab" role="tab" aria-selected={tab === "runs"} onClick={() => go("runs")}>
            Runs
            {attention > 0 ? (
              <>
                <span className="fs-count">{attention}</span>
                <span className="sr">{attention} needs you</span>
              </>
            ) : null}
          </button>
        </div>
        <AccountMenu auth={state.auth} tenants={state.tenants} />
        <button
          className="fs-iconbtn"
          aria-label="Rescan this file"
          title="Re-check this frame. Doesn’t follow your selection."
          disabled={state.busy}
          onClick={() => send({ type: "refresh" })}
        >
          <RescanIcon />
        </button>
      </header>

      {stalled ? (
        <div className="fs-banner" role="alert">
          The plugin didn’t answer. Close and reopen it, and if it happens again, check the console
          (Plugins → Development → Open console) for a startup error.
        </div>
      ) : null}

      {state.error ? (
        <div className="fs-banner" role="alert">
          {state.error}
        </div>
      ) : null}

      {tab === "check" ? (
        <CheckTab state={state} dispatch={dispatch} go={go} view={view} setView={setView} />
      ) : tab === "send" ? (
        <SendTab state={state} dispatch={dispatch} go={go} />
      ) : (
        <RunsTab state={state} />
      )}
    </>
  );
}

/**
 * Collapsed bar. Everything a designer needs to decide whether to open it again:
 * where the score is, and whether anything is blocked.
 *
 * It also has to be able to say "working" and "broken". A collapsed panel that
 * can only ever render a number is a dead box when something goes wrong, and the
 * only way out is to expand it and hope.
 */
function Collapsed({ state }: { state: StudioState }): JSX.Element {
  const report = state.report;
  const blockers = report?.blockers.length ?? 0;

  const summary = state.error ? (
    <span style={{ color: "var(--attention)" }}>Something went wrong — expand</span>
  ) : state.busy ? (
    <span className="muted">{state.status || "Working…"}</span>
  ) : report ? (
    <>
      <strong>{report.coverage.total === 0 ? "—" : `${report.coverage.percent}%`}</strong>
      <span className="muted"> · </span>
      <span style={{ color: blockers > 0 ? "var(--attention)" : "var(--ink-muted)" }}>
        {blockers} {blockers === 1 ? "blocker" : "blockers"}
      </span>
    </>
  ) : (
    <span className="muted">Starting…</span>
  );

  return (
    <div className="collapsed">
      <button
        className="ghost"
        onClick={() => send({ type: "set-panel-state", state: "expanded" })}
        title="Expand"
        aria-label="Expand"
      >
        ›
      </button>
      <span className="grow truncate">{summary}</span>
    </div>
  );
}
