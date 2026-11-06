/**
 * The panel reducer. Pure, so the message handling is testable without a DOM.
 */
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../src/ui/state.js";
import type { AppliedPayload, PluginMessage } from "../src/protocol.js";
import { PANEL_SIZES } from "../src/protocol.js";
import { newBatch } from "../src/handoffs.js";
import { lint } from "../src/rules/index.js";
import { reconciliationReport } from "../src/health/reconcile-report.js";
import { context, document, looseFill, node, themeSnapshot, withDepths } from "./health-fixtures.js";

const snapshot = themeSnapshot();
const report = lint(
  document(withDepths(node({ layoutMode: "vertical", children: [node({ fill: looseFill("#ffffff") })] }))),
  context({ theme: snapshot }),
);

const reportMessage: PluginMessage = {
  type: "report",
  report,
  reconciliation: reconciliationReport(snapshot),
  scope: "full",
  nodeCount: 2,
};

const applied: AppliedPayload = {
  batchId: report.batches[0]!.id,
  label: "fill #ffffff",
  tokenRef: "color.core_neu_00",
  applied: 1,
  failed: 0,
  failures: [],
  undoable: true,
  user: { id: "u1", name: "Priya Shah", color: "#e10a15" },
};

describe("reduce", () => {
  it("boots with the file, the themes and the stored panel size", () => {
    const next = reduce(initialState, {
      type: "boot",
      payload: {
        fileName: "Southern Brave",
        pageName: "Home",
        themes: [{ id: "t1", name: "Southern Brave", slug: "southern-brave", source: "f.json" }],
        themeId: "t1",
        panelState: "collapsed",
      uiTheme: null,
        user: { id: "u1", name: "Priya Shah", color: "#e10a15" },
      },
    });
    expect(next.booted).toBe(true);
    expect(next.user?.name).toBe("Priya Shah");
    expect(next.panelState).toBe("collapsed");
    expect(next.themes).toHaveLength(1);
  });

  it("stores a report and clears any error", () => {
    const errored = reduce(initialState, { type: "error", message: "boom" });
    expect(errored.error).toBe("boom");
    const next = reduce(errored, reportMessage);
    expect(next.error).toBeNull();
    expect(next.report?.coverage.loose).toBe(1);
    expect(next.nodeCount).toBe(2);
  });

  it("keeps the undo notice across a later report", () => {
    // The affordance stays until dismissed or superseded. A re-lint arrives
    // milliseconds after a fix; losing the notice there would make Undo a race.
    const withNotice = reduce(reduce(initialState, reportMessage), {
      type: "applied",
      payload: applied,
    });
    const afterRelint = reduce(withNotice, { ...reportMessage, scope: "incremental" });
    expect(afterRelint.applied).toEqual(applied);
  });

  it("supersedes the notice when a second fix lands", () => {
    const first = reduce(initialState, { type: "applied", payload: applied });
    const second = reduce(first, {
      type: "applied",
      payload: { ...applied, tokenRef: "space.4", applied: 78 },
    });
    expect(second.applied?.tokenRef).toBe("space.4");
    expect(second.applied?.applied).toBe(78);
  });

  it("stops being busy once a report lands, even with no status behind it", () => {
    // The regression this guards: `busy` starts true and gates every button, and
    // it used to be reachable only through a transient `status` message. A batch
    // that finished before the iframe attached its listener left the panel on
    // "Starting…" with a disabled Export tab and a complete report on screen.
    expect(initialState.busy).toBe(true);
    const next = reduce(initialState, reportMessage);
    expect(next.busy).toBe(false);
    expect(next.status).toBe("");
    expect(next.report).not.toBeNull();
  });

  it("lets a status that follows a report put it back to work", () => {
    // An incremental re-lint during a bulk fix posts report-then-status in the
    // same tick; the status wins, which is what keeps buttons disabled mid-apply.
    const reported = reduce(initialState, reportMessage);
    const working = reduce(reported, { type: "status", message: "Linting…", busy: true });
    expect(working.busy).toBe(true);
  });

  it("takes the panel state from the sandbox, never from a click", () => {
    // The sandbox posts this only after the window has actually resized, so a
    // resize that fails leaves the layout matching the window that exists.
    const collapsed = reduce(initialState, { type: "panel-state", state: "collapsed" });
    expect(collapsed.panelState).toBe("collapsed");
    expect(reduce(collapsed, { type: "panel-state", state: "expanded" }).panelState).toBe(
      "expanded",
    );
  });

  it("names the frame being checked, not just the page", () => {
    const next = reduce(initialState, reportMessage);
    expect(next.report?.rootName).toBe(report.rootName);
    expect(next.report?.rootName.length).toBeGreaterThan(0);
  });

  it("tracks the selection", () => {
    const selected = reduce(initialState, {
      type: "selection",
      count: 1,
      name: "Hero",
      id: "1:99",
      nodeId: "1:99",
      hasImage: false,
      parentId: "1:1",
      parentName: "Home",
      frames: [{ id: "1:99", name: "Hero" }],
    });
    expect(selected).toMatchObject({ selectionCount: 1, selectionName: "Hero", selectionId: "1:99" });
    expect(selected.selectionFrames).toEqual([{ id: "1:99", name: "Hero" }]);
  });

  it("carries no selection id for something that isn't a container", () => {
    // The re-target offer keys off this: a selected text layer is not a page to
    // check, so the header must not offer to check it.
    const selected = reduce(initialState, {
      type: "selection",
      count: 1,
      name: "Headline",
      id: null,
      nodeId: "1:12",
      hasImage: false,
      parentId: "1:99",
      parentName: "Hero",
      frames: [],
    });
    expect(selected.selectionId).toBeNull();
    expect(selected.selectionFrames).toEqual([]);
  });

  it("ignores an unknown message instead of wiping state", () => {
    const next = reduce(initialState, { type: "boot", payload: {
      fileName: "F",
      pageName: "P",
      themes: [],
      themeId: "t",
      panelState: "expanded",
      uiTheme: null,
      user: { id: null, name: "Anonymous", color: "#6b6b6b" },
    }});
    expect(reduce(next, { type: "not-a-message" } as never)).toBe(next);
  });

  it("clears busy on an error so the panel never wedges", () => {
    const busy = reduce(initialState, { type: "status", message: "Walking…", busy: true });
    expect(busy.busy).toBe(true);
    expect(reduce(busy, { type: "error", message: "nope" }).busy).toBe(false);
  });

  it("keeps the batches the sandbox posts, and which one the Handoff tab shows", () => {
    const batch = newBatch({
      id: "batch-1",
      at: 1,
      fileName: "Southern Brave",
      origin: "http://localhost:3000",
      frames: [{ frameId: "1:2", name: "Home" }],
    });
    const next = reduce(initialState, { type: "batches", batches: [batch], activeId: "batch-1" });
    expect(next.batches).toEqual([batch]);
    expect(next.activeBatchId).toBe("batch-1");

    // Leaving the progress screen clears only the active id; the batch stays.
    const left = reduce(next, { type: "batches", batches: [batch], activeId: null });
    expect(left.activeBatchId).toBeNull();
    expect(left.batches).toHaveLength(1);
  });

  it("starts signed out, and keeps what the sandbox says about the account", () => {
    expect(initialState.auth).toEqual({ phase: "signed-out" });

    const waiting = reduce(initialState, {
      type: "auth",
      auth: { phase: "waiting", userCode: "ABCD-1234", loginUrl: "https://x/y", expiresAt: 9 },
    });
    expect(waiting.auth).toMatchObject({ phase: "waiting", userCode: "ABCD-1234" });

    const signedIn = reduce(waiting, {
      type: "auth",
      auth: { phase: "signed-in", user: { id: "u1", name: "Sagar" } },
    });
    expect(signedIn.auth).toMatchObject({ phase: "signed-in", user: { name: "Sagar" } });

    const withClients = reduce(signedIn, {
      type: "tenants",
      tenants: { status: "ready", tenants: [{ code: "sb", name: "Southern Brave" }], selected: "sb" },
    });
    expect(withClients.tenants).toMatchObject({ status: "ready", selected: "sb" });
  });
});

describe("panel sizes", () => {
  it("matches the two states the spec calls for", () => {
    expect(PANEL_SIZES.expanded).toEqual({ width: 400, height: 640 });
    expect(PANEL_SIZES.collapsed).toEqual({ width: 280, height: 44 });
  });
});

/**
 * A dropped image the matcher could not place.
 *
 * Held rather than discarded: the bytes are already in the Figma document, so
 * the only thing missing is the target. Throwing the upload away would make the
 * designer drag the file in again to answer one question.
 */
describe("an unmapped upload", () => {
  const unmapped = {
    type: "asset-unmapped" as const,
    fileName: "mystery.png",
    imageHash: "hash-a",
    width: 800,
    height: 245,
    candidates: [
      { id: "1:2", name: "Top Header", width: 1366, height: 418, score: 25, reasons: ["same proportions"] },
    ],
  };

  it("keeps the upload and its candidates until answered", () => {
    const s = reduce(initialState, unmapped);
    expect(s.unmapped).toMatchObject({ fileName: "mystery.png", imageHash: "hash-a" });
    expect(s.unmapped?.candidates).toHaveLength(1);
  });

  it("can be dismissed without placing anything", () => {
    const s = reduce(reduce(initialState, unmapped), { type: "dismiss-unmapped" });
    expect(s.unmapped).toBeNull();
  });

  /** Answering the question is what closes it, not a separate acknowledgement. */
  it("clears once that image lands as an asset", () => {
    let s = reduce(initialState, unmapped);
    s = reduce(s, {
      type: "assets",
      bindings: [
        {
          role: "background",
          name: "mystery",
          imageHash: "hash-a",
          fileName: "mystery.png",
          width: 800,
          height: 245,
          targetId: "1:2",
          targetName: "Top Header",
          mapping: "manual",
        },
      ],
      placements: {},
      targets: {},
    });
    expect(s.unmapped).toBeNull();
  });

  it("leaves an unrelated prompt alone when a different image lands", () => {
    let s = reduce(initialState, unmapped);
    s = reduce(s, {
      type: "assets",
      bindings: [
        {
          role: "background",
          name: "other",
          imageHash: "hash-b",
          fileName: "other.png",
          width: 10,
          height: 10,
          targetId: "1:3",
          targetName: "Body",
          mapping: "auto",
        },
      ],
      placements: {},
      targets: {},
    });
    expect(s.unmapped?.imageHash).toBe("hash-a");
  });
});
