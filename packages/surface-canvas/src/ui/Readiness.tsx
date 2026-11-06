/**
 * The readiness card: how much of this frame is described by tokens.
 *
 * Coverage is a proportion, so the bar is the shape of one and the number leads.
 * "Needs you" is the card's verdict in a word, because a colour alone is not one:
 * anything loose, or a blocker, means the designer still has something to decide.
 *
 * The third stat is the session's movement, not the change since the last report:
 * a delta that resets every time you look away cannot answer "am I getting
 * anywhere".
 */
import type { JSX } from "react";
import { ArrowUpIcon } from "./icons.js";
import type { StudioState } from "./state.js";

export function Readiness({ state }: { state: StudioState }): JSX.Element {
  const report = state.report;
  const coverage = report?.coverage;

  if (!coverage) {
    return (
      <section className="fs-card" aria-label="Readiness">
        <span className="t-body" style={{ color: "var(--ink-muted)" }}>
          {state.status || "Reading the page…"}
        </span>
      </section>
    );
  }

  if (coverage.total === 0) {
    return (
      <section className="fs-card" aria-label="Readiness">
        <div className="t-label truncate">Nothing bindable in {report?.rootName ?? "this frame"}</div>
        <div className="t-body" style={{ color: "var(--ink-muted)" }}>
          Select the page frame and use “Check … instead”.
        </div>
      </section>
    );
  }

  const session =
    state.sessionBasePercent === null
      ? 0
      : Math.round((coverage.percent - state.sessionBasePercent) * 10) / 10;
  // Loose values make the page less themeable; they never block a Handoff.
  const needsYou = coverage.loose > 0;

  return (
    <section className="fs-card" aria-label="Readiness">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="t-score">{coverage.percent}%</span>
          <span className="t-overline" style={{ color: "var(--ink-muted)" }}>
            bound
          </span>
        </div>
        <span
          className="fs-status"
          style={{ color: needsYou ? "var(--attention)" : "var(--bound)", marginTop: 6 }}
        >
          <span className="fs-dot" />
          {needsYou ? "Needs you" : "Ready"}
        </span>
      </div>

      <div
        className="fs-bar"
        role="progressbar"
        aria-label="Values bound to tokens"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={coverage.percent}
        title={
          `${coverage.bound.toLocaleString()} of ${coverage.total.toLocaleString()} slots bound` +
          (coverage.oneClickAway > 0
            ? ` · ${coverage.oneClickAway.toLocaleString()} more are one click away`
            : "")
        }
      >
        <span style={{ width: `${coverage.percent}%` }} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
        <Stat value={coverage.bound.toLocaleString()} label="bound" />
        <Stat
          value={coverage.loose.toLocaleString()}
          label="loose"
          color={coverage.loose > 0 ? "var(--attention)" : undefined}
        />
        <Stat
          value={session === 0 ? "—" : `${Math.abs(session)}`}
          label="this session"
          color={session > 0 ? "var(--bound)" : session < 0 ? "var(--attention)" : undefined}
          icon={session > 0 ? <ArrowUpIcon size={12} /> : undefined}
          prefix={session < 0 ? "−" : undefined}
          title={
            state.sessionBasePercent === null
              ? undefined
              : `Started this session at ${state.sessionBasePercent}%`
          }
        />
      </div>

      <div className="t-caption truncate" style={{ color: "var(--ink-muted)" }}>
        Checking {report?.rootName || state.pageName || "—"} · {state.nodeCount.toLocaleString()} layers
      </div>
    </section>
  );
}

function Stat({
  value,
  label,
  color,
  icon,
  prefix,
  title,
}: {
  value: string;
  label: string;
  color?: string | undefined;
  icon?: JSX.Element | undefined;
  prefix?: string | undefined;
  title?: string | undefined;
}): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }} title={title}>
      <span className="fs-stat" style={{ display: "flex", alignItems: "center", gap: 4, color }}>
        {icon}
        {prefix}
        {value}
      </span>
      <span className="t-caption" style={{ color: "var(--ink-muted)" }}>
        {label}
      </span>
    </div>
  );
}
