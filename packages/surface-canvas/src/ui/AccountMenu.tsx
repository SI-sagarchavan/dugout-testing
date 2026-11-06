/**
 * Who you are, top right.
 *
 * Where every product puts it, so nobody hunts: the corner of the header, next to
 * the one other global control. Closed it is one small button: your initial when
 * you are signed in, a person with a dot when you are not (the dot is the whole
 * "you still need to do something" signal, and it goes when you connect). Open it
 * is a small card with exactly what you can do from where you are:
 *
 *   signed in   who, which tenant, Sign out
 *   signed out  Connect
 *   waiting     the code to compare with the browser, open the page again, Cancel
 *
 * The Handoff tab has its own Connect card because that is where being signed out
 * hurts. This is the one place that is always there.
 */
import type { JSX } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { initialOf } from "../health/person.js";
import type { AuthView, TenantsView } from "../protocol.js";
import { connect } from "./auth.js";
import { send } from "./main.js";

export function AccountMenu({
  auth,
  tenants,
}: {
  auth: AuthView;
  tenants: TenantsView;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes it and hands focus back, so the keyboard never loses its place.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The code is the thing the person is waiting to compare, so a connect started
  // from anywhere brings the menu up to show it.
  const waiting = auth.phase === "waiting";
  useEffect(() => {
    if (waiting) setOpen(true);
  }, [waiting]);

  const label =
    auth.phase === "signed-in"
      ? `Account: ${auth.user.name}`
      : auth.phase === "waiting"
        ? "Account: waiting for the browser"
        : "Account: not connected";

  return (
    <>
      <button
        ref={buttonRef}
        className={auth.phase === "signed-in" ? "fs-avatar-btn is-in" : "fs-avatar-btn"}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={label.replace("Account: ", "")}
        onClick={() => setOpen((value) => !value)}
      >
        {auth.phase === "signed-in" ? (
          <span aria-hidden="true">{initialOf(auth.user.name)}</span>
        ) : (
          <>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="8.5" r="3.5" />
              <path d="M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5" />
            </svg>
            <span className={waiting ? "fs-avatar-dot is-busy" : "fs-avatar-dot"} aria-hidden="true" />
          </>
        )}
      </button>

      {open ? (
        <>
          <div className="fs-pop-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="fs-pop" id={panelId} role="dialog" aria-label="Account">
            {auth.phase === "signed-in" ? (
              <>
                <div className="fs-pop-who">
                  <span className="fs-avatar" aria-hidden="true">
                    {initialOf(auth.user.name)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="t-label truncate">{auth.user.name}</div>
                    <div className="t-caption truncate" style={{ color: "var(--ink-muted)" }}>
                      {handoffsFor(tenants)}
                    </div>
                  </div>
                </div>
                <button
                  className="fs-btn"
                  onClick={() => {
                    setOpen(false);
                    send({ type: "auth-sign-out" });
                  }}
                >
                  Sign out
                </button>
              </>
            ) : auth.phase === "waiting" ? (
              <>
                <div className="t-label">Approve in your browser</div>
                <div className="t-caption" style={{ color: "var(--ink-muted)" }}>
                  Check this code matches the one on the page.
                </div>
                <div
                  className="fs-val"
                  style={{ fontSize: 20, lineHeight: "26px", letterSpacing: "0.12em", textAlign: "center" }}
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
              </>
            ) : (
              <>
                <div className="t-label">Not connected</div>
                <div className="t-caption" style={{ color: "var(--ink-muted)" }}>
                  Sign in with FanXP to send frames. You approve in your browser.
                </div>
                {auth.message ? (
                  <div className="t-caption" role="alert" style={{ color: "var(--attention)" }}>
                    {auth.message}
                  </div>
                ) : null}
                <button className="fs-btn is-primary" onClick={connect}>
                  Connect
                </button>
              </>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

/** The line under the name: which client this file's handoffs go to. */
function handoffsFor(tenants: TenantsView): string {
  if (tenants.status === "loading") return "Loading clients…";
  if (tenants.status === "error") return "Couldn’t load clients";
  if (tenants.status !== "ready") return "Signed in";
  const chosen = tenants.tenants.find((tenant) => tenant.code === tenants.selected);
  if (chosen) return `Handoffs for ${chosen.name}`;
  return tenants.tenants.length === 0 ? "No clients available" : "Choose a client in Handoff";
}
