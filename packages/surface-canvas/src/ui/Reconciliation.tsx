/**
 * This file vs the theme.
 *
 * Collapsed, at the bottom. The queue already says which batches can bind;
 * this is the inventory: tokens the theme has that Figma has never heard of,
 * variables that drifted, orphans with no token. It is also where the theme is
 * chosen, because switching it re-runs this very comparison.
 */
import type { JSX } from "react";
import { useState } from "react";
import type { ReconciliationReport } from "../health/reconcile-report.js";
import { ChevronIcon } from "./icons.js";
import { send } from "./main.js";
import type { StudioState } from "./state.js";

const MAX_LISTED = 12;

export function Reconciliation({ state }: { state: StudioState }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const reconciliation: ReconciliationReport | null = state.reconciliation;
  if (!reconciliation) return null;
  const { total, bindable, missing, mismatched, orphans, localCollections, libraryCollections, fromLibrary } =
    reconciliation;

  const disabled = state.busy || state.themes.length === 0;

  return (
    <div style={{ borderTop: "1px solid var(--line)" }}>
      <button
        className="fs-disclose"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="t-body truncate">This file vs {reconciliation.themeName}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-muted)" }}>
          <span className="t-mono" style={{ whiteSpace: "nowrap" }} title="tokens that exist as variables in this file">
            {bindable} / {total} tokens
          </span>
          <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : undefined }}>
            <ChevronIcon />
          </span>
        </span>
      </button>

      {open ? (
        <div style={{ paddingBottom: 12 }}>
      <label className="row" style={{ marginBottom: 4 }}>
        <span className="grow t-body">Token set</span>
        <select
          value={state.themeId}
          disabled={disabled}
          onChange={(event) => send({ type: "select-theme", themeId: event.target.value })}
          aria-label="Token set"
          title="Re-runs reconciliation and re-proposes every batch"
          style={{ maxWidth: 220 }}
        >
          {state.themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
      </label>

      <SourceLine
        localCollections={localCollections}
        libraryCollections={libraryCollections}
        fromLibrary={fromLibrary}
        libraryError={reconciliation.libraryError}
      />

      {mismatched.length > 0 ? (
        <>
          <h4 style={{ margin: "10px 0 4px", color: "var(--fos-warn)" }}>
            {mismatched.length} {mismatched.length === 1 ? "variable holds" : "variables hold"} a
            different value
          </h4>
          <p className="muted" style={{ margin: "0 0 4px" }}>
            Binding these would change the design rather than describe it, so they're switched off.
          </p>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {mismatched.slice(0, MAX_LISTED).map((token) => (
              <li key={token.ref}>
                <span className="mono">{token.figmaName}</span> is {token.figmaValue}
                <span className="muted">, theme says {token.value}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {missing.length > 0 ? (
        <>
          <h4 style={{ margin: "10px 0 4px" }}>{missing.length} tokens have no Figma variable</h4>
          <p className="muted" style={{ margin: "0 0 4px" }}>
            The queue offers Add on any exact batch that needs one of these.
          </p>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {missing.slice(0, MAX_LISTED).map((token) => (
              <li key={token.ref}>
                <span className="mono">{token.raw}</span>{" "}
                <span className="muted">
                  {token.category} · {token.value}
                </span>
              </li>
            ))}
          </ul>
          {missing.length > MAX_LISTED ? (
            <div className="muted">+{missing.length - MAX_LISTED} more</div>
          ) : null}
        </>
      ) : null}

      {orphans.length > 0 ? (
        <>
          <h4 style={{ margin: "10px 0 4px" }}>
            {orphans.length} Figma {orphans.length === 1 ? "variable has" : "variables have"} no
            token
          </h4>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {orphans.slice(0, MAX_LISTED).map((orphan) => (
              <li key={`${orphan.medium}-${orphan.figmaName}`}>
                <span className="mono">{orphan.figmaName}</span>{" "}
                <span className="muted">{orphan.collection ?? orphan.medium}</span>
              </li>
            ))}
          </ul>
          {orphans.length > MAX_LISTED ? (
            <div className="muted">+{orphans.length - MAX_LISTED} more</div>
          ) : null}
        </>
      ) : null}

      <div className="row muted" style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}>
        {reconciliation.byCategory.map((tally) => (
          <span key={tally.category}>
            {tally.category} {tally.bindable}/{tally.total}
          </span>
        ))}
      </div>
        </div>
      ) : null}
    </div>
  );
}

function SourceLine({
  localCollections,
  libraryCollections,
  fromLibrary,
  libraryError,
}: {
  localCollections: number;
  libraryCollections: number;
  fromLibrary: number;
  libraryError?: string;
}): JSX.Element {
  if (libraryError) {
    return (
      <p style={{ color: "var(--fos-warn)", margin: "8px 0 0" }}>
        Couldn't read enabled libraries: {libraryError}
      </p>
    );
  }

  if (localCollections === 0 && libraryCollections === 0) {
    return (
      <p style={{ color: "var(--fos-warn)", margin: "8px 0 0" }}>
        No local variable collections and no enabled libraries publishing variables.
      </p>
    );
  }

  if (localCollections === 0 && fromLibrary > 0) {
    return (
      <p className="muted" style={{ margin: "8px 0 0" }}>
        Variables come from {libraryCollections}{" "}
        {libraryCollections === 1 ? "library" : "libraries"}. Binding one imports it into this
        file — checking never does.
      </p>
    );
  }

  if (fromLibrary > 0) {
    return (
      <p className="muted" style={{ margin: "8px 0 0" }}>
        {localCollections} local {localCollections === 1 ? "collection" : "collections"} ·{" "}
        {fromLibrary} tokens will import from a library on first bind.
      </p>
    );
  }

  return (
    <p className="muted" style={{ margin: "8px 0 0" }}>
      {localCollections} local {localCollections === 1 ? "collection" : "collections"}
      {libraryCollections > 0
        ? ` · ${libraryCollections} ${libraryCollections === 1 ? "library" : "libraries"} enabled`
        : ""}
      .
    </p>
  );
}
