import type { RunEvent } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { corrects } from "../src/agent.ts";

const loaded = (comments: unknown): RunEvent[] =>
  [
    {
      runId: "r",
      seq: 1,
      at: "2026-11-11T08:00:00Z",
      type: "tool.completed",
      data: {
        step: 1,
        callId: "c1",
        tool: "ui.load",
        ok: true,
        content: JSON.stringify({ comments }),
        durationMs: 1,
      },
    },
  ] as RunEvent[];

const OLD = "11111111-1111-4111-8111-111111111111";
const FROM = `http://localhost:3000/preview/default/${OLD}?theme=t`;

const output = (comments: unknown[]) => ({
  previewUrl: "http://localhost:3000/preview/default/new",
  treeArtifactId: "new",
  edits: 1,
  comments,
  remaining: [],
});

describe("ui-editor's corrections (ADR 0034)", () => {
  it("reports the addressed comments in the person's words, the tree it corrected and the preview it made", () => {
    const run = corrects({
      input: { preview: FROM },
      output: output([
        { id: "a", status: "addressed", detail: "gap 2 to 4" },
        { id: "b", status: "not-addressed", detail: "asks for a new element" },
      ]),
      events: loaded([
        { id: "a", text: "more space between the cards" },
        { id: "b", text: "add a sponsor strip" },
      ]),
    });
    expect(run).toEqual({
      of: OLD,
      edited: "http://localhost:3000/preview/default/new",
      comments: ["more space between the cards"],
    });
  });

  it("falls back to what the agent says it changed when the load result is not at hand", () => {
    const run = corrects({
      input: { preview: FROM },
      output: output([{ id: "a", status: "addressed", detail: "gap 2 to 4" }]),
      events: [],
    });
    expect(run?.comments).toEqual(["gap 2 to 4"]);
  });

  it("reports nothing when no comment was addressed, or the run has no result", () => {
    const none = output([{ id: "a", status: "not-addressed", detail: "no" }]);
    expect(corrects({ input: { preview: "p" }, output: none, events: [] })).toBeUndefined();
    expect(corrects({ input: { preview: "p" }, output: undefined, events: [] })).toBeUndefined();
    // a link that is not a preview of a tree names nothing a record could have made
    const addressed = output([{ id: "a", status: "addressed", detail: "gap" }]);
    expect(
      corrects({ input: { preview: "http://x/elsewhere" }, output: addressed, events: [] }),
    ).toBeUndefined();
  });
});
