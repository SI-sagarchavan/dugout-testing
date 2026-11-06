/**
 * The panel: three tabs along the way a frame travels.
 *
 *   Check  is this frame ready? (fix the loose values, mark the images)
 *   Handoff   send it, one Handoff per frame
 *   Runs   what went out, and what to do about it
 *
 * Everything on screen arrived over postMessage from the sandbox and every action
 * leaves the same way; this file owns only which tab is showing.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { Tab } from "../protocol.js";
import { needsAttention } from "../handoffs.js";
import { AccountMenu } from "./AccountMenu.js";
import { applyUiTheme, ThemeToggle } from "./ThemeToggle.js";
import { CheckTab, type CheckView } from "./CheckTab.js";
import { send } from "./main.js";
import { HistoryTab } from "./HistoryTab.js";
import { HandoffTab } from "./HandoffTab.js";
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

  // A saved choice wins over the theme Figma set, also while collapsed.
  useEffect(() => {
    if (state.uiTheme) applyUiTheme(state.uiTheme);
  }, [state.uiTheme]);

  if (state.panelState === "collapsed") return <Collapsed state={state} />;

  const go = (next: Tab, nextView?: CheckView): void => {
    if (nextView) setView(nextView);
    setTab(next);
  };
  const attention = needsAttention(state.batches);

  return (
    <>
      <header className="fs-top">
        <div className="fs-tabs" role="tablist" aria-label="Plugin sections">
          <button className="fs-tab" role="tab" aria-selected={tab === "check"} onClick={() => go("check")}>
            Check
          </button>
          <button className="fs-tab" role="tab" aria-selected={tab === "handoff"} onClick={() => go("handoff")}>
            Handoff
          </button>
          <button className="fs-tab" role="tab" aria-selected={tab === "history"} onClick={() => go("history")}>
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
        <ThemeToggle theme={state.uiTheme} dispatch={dispatch} />
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
      ) : tab === "handoff" ? (
        <HandoffTab state={state} dispatch={dispatch} go={go} />
      ) : (
        <HistoryTab state={state} />
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
  const advice = report?.structure.length ?? 0;

  const summary = state.error ? (
    <span style={{ color: "var(--attention)" }}>Something went wrong — expand</span>
  ) : state.busy ? (
    <span className="muted">{state.status || "Working…"}</span>
  ) : report ? (
    <>
      <strong>{report.coverage.total === 0 ? "—" : `${report.coverage.percent}%`}</strong>
      <span className="muted"> · </span>
      <span style={{ color: "var(--ink-muted)" }}>
        {advice} {advice === 1 ? "structure note" : "structure notes"}
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
