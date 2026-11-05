import { agent as bind } from "@dugout/agent-data-bind";
import { agent as frameMatch } from "@dugout/agent-frame-match";
import type { Message } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { agent, assemble, builtIn, completeFinal, pipeline, verifyFinal } from "../src/agent.ts";

const frame = {
  previewUrl: "http://localhost:3000/preview/default/frame-1?theme=t",
  treeArtifactId: "tree-1",
  measured: true,
  coverage: 93,
  estimated: false,
  unchecked: [],
  placeholderIcons: 0,
  before: 81.8,
  match: 98,
  remaining: ["title is 2px off"],
  compilerFindings: ["a carousel arrow has no part"],
};
const data = {
  previewUrl: "http://localhost:3000/preview/default/frame-1?theme=t&data=d&plan=p",
  planArtifactId: "plan-1",
  dataArtifactId: "data-1",
  bound: 16,
  collapsed: 1,
  remaining: ["the countdown has no data field"],
};
const EXPORT = "6f0e8c1a-0000-4000-8000-000000000001";

describe("section-builder", () => {
  it("runs frame-match, then bind on the preview it published, and hands over bind's preview", async () => {
    const calls: Array<{ agent: string; input: unknown }> = [];
    const answer = await pipeline.run(
      async (child, input) => {
        calls.push({ agent: child.spec.id, input });
        return child.spec.id === "frame-match" ? frame : data;
      },
      { exportId: EXPORT, project: "default" },
    );
    expect(calls).toEqual([
      { agent: "frame-match", input: { exportId: EXPORT, project: "default" } },
      { agent: "data-bind", input: { preview: frame.previewUrl } },
    ]);
    // one handover: the data's preview, with everything still off from both stages
    expect(answer).toMatchObject({
      previewUrl: data.previewUrl,
      treeArtifactId: "tree-1",
      planArtifactId: "plan-1",
      dataArtifactId: "data-1",
      bound: 16,
      match: 98,
      remaining: ["frame: title is 2px off", "data: the countdown has no data field"],
    });
  });

  it("does not run bind when frame-match failed", async () => {
    const ran: string[] = [];
    await expect(
      pipeline.run(
        async (child) => {
          ran.push(child.spec.id);
          throw new Error("frame-match failed, invalid_output: no screenshot");
        },
        { exportId: EXPORT, project: "default" },
      ),
    ).rejects.toThrow(/frame-match failed/);
    expect(ran).toEqual(["frame-match"]);
  });

  it("says why nothing was compared, among what is still off", () => {
    const out = assemble(
      {
        ...frame,
        measured: false,
        unmeasuredBecause: "the frame is too tall",
        before: undefined,
        match: undefined,
      },
      data,
    );
    expect(out.remaining[0]).toBe("frame: nothing was compared: the frame is too tall");
    expect(out).not.toHaveProperty("match");
  });

  it("copies every field of its answer from what page.build returned, whatever the model sent", () => {
    const built = assemble(frame, data);
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "page.build", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "c1", content: JSON.stringify(built) },
    ];
    expect(builtIn(messages)).toEqual(built);
    expect(completeFinal({ previewUrl: "http://invented" }, { messages })).toEqual(built);
    expect(verifyFinal(built, { messages })).toBeUndefined();
    // nothing built: an answer is refused, and a failed build is not a result
    const failed: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "page.build", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "c1", content: "bind failed", isError: true },
    ];
    expect(builtIn(failed)).toBeUndefined();
    expect(verifyFinal({ previewUrl: "x" }, { messages: failed })).toMatch(/has not completed/);
  });

  it("gives the model the one tool, and lists the two agents it runs", () => {
    expect(agent.spec.agents).toEqual([frameMatch.spec.id, bind.spec.id]);
    expect(agent.spec.tools).toEqual(["page.build"]);
    expect(agent.spec.tools).not.toContain("agent.frameMatch");
  });

  it("leaves room below it for bind's researcher and builder", () => {
    // section-builder → bind → researcher/builder: two levels below a host-started run
    expect(bind.spec.budget.maxDepth).toBeGreaterThanOrEqual(2);
    expect(agent.spec.budget.maxDepth).toBeGreaterThanOrEqual(1);
    // its budget covers both stages' own limits
    expect(agent.spec.budget.usdPerRun).toBeGreaterThanOrEqual(
      frameMatch.spec.budget.usdPerRun + bind.spec.budget.usdPerRun,
    );
  });
});
