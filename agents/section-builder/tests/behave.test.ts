/**
 * The interaction stage: every published section is handed to it, and its model decides whether
 * there is anything to build. What it published is handed over; when it built nothing the preview
 * stays; a failure leaves the preview as the stages made it.
 */
import { AwaitingAnswers } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { behave, makeBuild, type Output } from "../src/agent.ts";

const BEFORE =
  "http://localhost:3000/preview/default/11111111-1111-4111-8111-111111111111?plan=p1&data=d1";
const AFTER =
  "http://localhost:3000/preview/default/22222222-2222-4222-8222-222222222222?plan=p2&data=d1";
const out = {
  previewUrl: BEFORE,
  treeArtifactId: "11111111-1111-4111-8111-111111111111",
  planArtifactId: "p1",
  dataArtifactId: "d1",
  settled: [],
  remaining: ["frame: something"],
  behaviours: [],
} as unknown as Output;

describe("the interaction stage", () => {
  it("hands over the preview it made, with what it does and what it settled", async () => {
    const calls: unknown[] = [];
    const made = await behave(out, async (step, input) => {
      calls.push({ step: step.spec.id, input });
      return {
        previewUrl: AFTER,
        treeArtifactId: "22222222-2222-4222-8222-222222222222",
        behaviours: ["picked: toggled by the card"],
        settled: [{ id: "max_favourites", by: "person", value: "2" }],
        remaining: ["SAVE sends nothing yet"],
      };
    });
    expect(calls).toEqual([{ step: "interaction", input: { preview: BEFORE } }]);
    expect(made).toMatchObject({
      previewUrl: AFTER,
      planArtifactId: "p2",
      behaviours: ["picked: toggled by the card"],
      settled: [{ id: "max_favourites", by: "person", value: "2" }],
    });
    expect(made.remaining).toContain("behaviour: SAVE sends nothing yet");
  });

  it("keeps the preview when the interaction model found nothing to build", async () => {
    const same = await behave(out, async () => ({
      previewUrl: BEFORE,
      treeArtifactId: "11111111-1111-4111-8111-111111111111",
      behaviours: [],
      settled: [],
      remaining: [],
    }));
    expect(same.previewUrl).toBe(BEFORE);
    expect(same.planArtifactId).toBe("p1");
    expect(same.behaviours).toEqual([]);
    expect(same.remaining).toEqual(["frame: something"]);
  });

  it("runs interaction last, on the preview the stages before published, with no gate of code's", async () => {
    const calls: string[] = [];
    const frame = {
      previewUrl: BEFORE,
      treeArtifactId: "11111111-1111-4111-8111-111111111111",
      measured: true,
      coverage: 90,
      remaining: [],
      compilerFindings: [],
      notes: [],
      content: { data: "none", evidence: ["a heading and a button"] },
    };
    const made = await makeBuild()(
      async (step, input) => {
        calls.push(step.spec.id);
        if (step.spec.id === "frame-match") return frame;
        expect(input).toEqual({ preview: BEFORE });
        return {
          previewUrl: BEFORE,
          treeArtifactId: frame.treeArtifactId,
          behaviours: [],
          settled: [],
          remaining: [],
        };
      },
      { exportId: "6f0e8c1a-0000-4000-8000-000000000001", project: "default" },
    );
    expect(calls).toEqual(["frame-match", "interaction"]);
    expect(made.data).toBe("none");
  });

  it("leaves the preview as it was when it fails, and passes a person's question up", async () => {
    const failed = await behave(out, async () => Promise.reject(new Error("boom")));
    expect(failed.previewUrl).toBe(BEFORE);
    expect(failed.remaining).toContain("behaviour: not made: boom");
    await expect(
      behave(out, async () => Promise.reject(new AwaitingAnswers([], []))),
    ).rejects.toBeInstanceOf(AwaitingAnswers);
  });
});
