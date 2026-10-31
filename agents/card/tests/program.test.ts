import { type ProgramCheckpoint, runProgram, type TaskRunner } from "@dugout/core";
import { describe, expect, it } from "vitest";
import { EditBatchSchema } from "../src/edits.ts";
import {
  type CardDiff,
  type CardProgramDeps,
  type CardProgramRequest,
  type CardProgramState,
  type CardTaken,
  defineCardProgram,
  initialCardState,
  oneToOneSize,
} from "../src/program.ts";

const request: CardProgramRequest = {
  cardId: "fixture-rail",
  brief: "The Southern Brave fixture rail.",
  figma: "/tmp/rail.dsl.json",
  screenshot: "/tmp/rail.png",
  maxAttempts: 3,
};

function noScreenshot(req: CardProgramRequest): CardProgramRequest {
  const { screenshot: _screenshot, ...rest } = req;
  return rest;
}

const tree = {
  schemaVersion: "1.0.0",
  nodes: [
    {
      id: "card",
      parent: null,
      idx: 0,
      type: "Stack",
      src: "synthetic:fixture-rail:0",
      props: {},
    },
  ],
};
const data = { match: {} };

const passed: CardDiff = {
  ok: true,
  message: "within 8 pixels",
  size: {
    render: { width: 1366, height: 312 },
    screenshot: { width: 1366, height: 312 },
  },
  regions: [],
};

function saved(output: unknown = { tree, data }) {
  return { status: "completed" as const, output: { status: "completed", output } };
}

function edited() {
  return saved({ edits: [{ id: "card", props: { surface: "surface.fixture_card" } }] });
}

function harness(over: Partial<CardProgramDeps> = {}) {
  const calls: string[] = [];
  const deps: CardProgramDeps = {
    load: async () => {
      calls.push("load");
      return { ok: true, tree, data };
    },
    check: async () => {
      calls.push("check");
      return { ok: true, issues: [] };
    },
    diff: async () => {
      calls.push("diff");
      return passed;
    },
    save: async () => {
      calls.push("save");
    },
    approve: async () => ({ approved: true }),
    take: (output): CardTaken | undefined => {
      const result = output as { status?: string; output?: unknown };
      if (result.status !== "completed" || !result.output || typeof result.output !== "object") {
        return undefined;
      }
      const body = result.output as { tree?: unknown; data?: unknown; edits?: unknown };
      if (Array.isArray(body.edits)) {
        const parsed = EditBatchSchema.safeParse(body);
        if (!parsed.success) return undefined;
        return {
          edits: parsed.data.edits,
          ...(parsed.data.data ? { data: parsed.data.data } : {}),
        };
      }
      if (body.tree !== undefined) {
        return body.data !== undefined ? { tree: body.tree, data: body.data } : { tree: body.tree };
      }
      return undefined;
    },
    ...over,
  };
  return { calls, deps };
}

describe("card program", () => {
  it("names the 1× size of a 2× screenshot", () => {
    expect(oneToOneSize({ width: 1366, height: 312 }, { width: 2732, height: 624 })).toEqual({
      width: 1366,
      height: 312,
    });
    expect(oneToOneSize({ width: 2732, height: 312 }, { width: 2732, height: 624 })).toEqual({
      width: 1366,
      height: 312,
    });
    expect(
      oneToOneSize({ width: 1366, height: 312 }, { width: 1366, height: 400 }),
    ).toBeUndefined();
  });

  it("repairs a failed check and does not load the Figma file again", async () => {
    let checks = 0;
    const { calls, deps } = harness({
      check: async () => {
        checks += 1;
        calls.push("check");
        return checks === 1
          ? { ok: false, issues: ["T1 surface.d_2_fixture_card"] }
          : { ok: true, issues: [] };
      },
    });
    const reports: string[] = [];
    const tasks: TaskRunner = async (req) => {
      expect(req.agentId).toBe("card-repair");
      reports.push((req.input as { report: string }).report);
      return edited();
    };
    const { state } = await runProgram(defineCardProgram(noScreenshot(request), deps), {
      tasks,
    });
    expect(calls).toEqual(["load", "check", "check", "save"]);
    expect(reports).toEqual(["T1 surface.d_2_fixture_card"]);
    expect(state.passed).toBe(true);
    expect(state.repairs).toBe(1);
    const node = (state.tree as { nodes: Array<{ props: { surface?: string } }> }).nodes[0];
    expect(node?.props.surface).toBe("surface.fixture_card");
  });

  it("repairs a pixel miss and then diffs again, without a second load", async () => {
    let diffs = 0;
    const { calls, deps } = harness({
      diff: async () => {
        diffs += 1;
        calls.push("diff");
        if (diffs === 1) {
          return {
            ok: false,
            message: "the render is 400×300 and the screenshot is 400×280",
            size: { render: { width: 400, height: 300 }, screenshot: { width: 400, height: 280 } },
            regions: [{ x: 0, y: 10, w: 40, h: 20, nodeIds: ["title", "card"] }],
          };
        }
        return passed;
      },
    });
    const reports: string[] = [];
    const tasks: TaskRunner = async (req) => {
      reports.push((req.input as { stage: string; report: string }).report);
      expect((req.input as { stage: string }).stage).toBe("diff");
      return edited();
    };
    const { state } = await runProgram(defineCardProgram(request, deps), { tasks });
    expect(calls.filter((call) => call === "load")).toEqual(["load"]);
    expect(calls).toEqual(["load", "check", "diff", "check", "diff", "save"]);
    expect(reports[0]).toContain("title");
    expect(reports[0]).toContain("Change the root size");
    expect(state.passed).toBe(true);
    expect(state.repairs).toBe(1);
  });

  it("stops on a 2× screenshot without calling repair", async () => {
    const { calls, deps } = harness({
      diff: async () => {
        calls.push("diff");
        return {
          ok: false,
          message: "the render is 2732×312 and the screenshot is 2732×624",
          size: { render: { width: 2732, height: 312 }, screenshot: { width: 2732, height: 624 } },
          regions: [],
        };
      },
    });
    const tasks: TaskRunner = async () => {
      throw new Error("repair should not run");
    };
    const { state } = await runProgram(defineCardProgram(request, deps), { tasks });
    expect(calls).toEqual(["load", "check", "diff"]);
    expect(state.passed).toBe(false);
    expect(state.halt).toBe(true);
    expect(state.repairs).toBe(0);
    expect(state.error).toContain("1366×312");
  });

  it("stops when the repair attempts run out", async () => {
    const { calls, deps } = harness({
      check: async () => {
        calls.push("check");
        return { ok: false, issues: ["still broken"] };
      },
    });
    const tasks: TaskRunner = async () => edited();
    const { state } = await runProgram(
      defineCardProgram({ ...noScreenshot(request), maxAttempts: 2 }, deps),
      { tasks },
    );
    expect(state.passed).toBe(false);
    expect(state.repairs).toBe(2);
    expect(calls).not.toContain("save");
    expect(calls.filter((call) => call === "load")).toHaveLength(1);
  });

  it("authors from the brief when there is no Figma file", async () => {
    const { calls, deps } = harness();
    const stages: string[] = [];
    const tasks: TaskRunner = async (req) => {
      expect(req.agentId).toBe("card-draft");
      stages.push((req.input as { stage: string }).stage);
      return saved();
    };
    const { state } = await runProgram(
      defineCardProgram({ cardId: request.cardId, brief: request.brief }, deps),
      { tasks },
    );
    expect(stages).toEqual(["draft"]);
    expect(calls).toEqual(["check", "save"]);
    expect(state.passed).toBe(true);
    expect(state.repairs).toBe(0);
  });

  it("sends an editor's change back to repair and does not reload", async () => {
    let asked = 0;
    const { calls, deps } = harness({
      approve: async () => {
        asked += 1;
        return asked === 1
          ? { approved: false, changes: "Make the kicker upper case" }
          : { approved: true };
      },
    });
    const reports: string[] = [];
    const tasks: TaskRunner = async (req) => {
      reports.push((req.input as { report: string }).report);
      return edited();
    };
    const { state } = await runProgram(defineCardProgram(noScreenshot(request), deps), {
      tasks,
    });
    expect(reports).toEqual(["Make the kicker upper case"]);
    expect(calls.filter((call) => call === "load")).toEqual(["load"]);
    expect(state.passed).toBe(true);
    expect(state.repairs).toBe(1);
  });

  it("resumes after a failed check and repairs without loading again", async () => {
    const { calls, deps } = harness({
      check: async () => {
        calls.push("check");
        return { ok: true, issues: [] };
      },
    });
    const tasks: TaskRunner = async (req) => {
      expect(req.id).toBe("repair#1");
      expect((req.input as { report: string }).report).toContain("surface.d_2");
      return edited();
    };
    const base = initialCardState(noScreenshot(request));
    const resume: ProgramCheckpoint<CardProgramState> = {
      version: 1,
      state: {
        ...base,
        tree,
        data,
        stage: "check",
        report: "T1 surface.d_2_fixture_card",
        checkOk: false,
      },
      done: {
        "load#1": { output: null, status: "completed" },
        "check#1": { output: null, status: "completed" },
      },
      attempts: {},
    };
    const { state } = await runProgram(defineCardProgram(noScreenshot(request), deps), {
      tasks,
      resume,
    });
    expect(calls).toEqual(["check", "save"]);
    expect(state.passed).toBe(true);
    expect(state.repairs).toBe(1);
  });

  it("keeps the loaded tree when repair sends a whole tree", async () => {
    const { deps } = harness({
      check: async () => ({ ok: false, issues: ["surface"] }),
    });
    const impostor = {
      schemaVersion: "1.0.0",
      nodes: [
        {
          id: "other",
          parent: null,
          idx: 0,
          type: "Stack",
          src: "synthetic:other:0",
          props: { content: "Fixtures" },
        },
      ],
    };
    const tasks: TaskRunner = async () =>
      saved({ tree: impostor, data: { match: { title: "Fixtures" } } });
    const { state } = await runProgram(
      defineCardProgram({ ...noScreenshot(request), maxAttempts: 1 }, deps),
      { tasks },
    );
    expect(state.passed).toBe(false);
    expect(state.repairs).toBe(1);
    expect(state.error).toContain("edits");
    const nodes = (state.tree as { nodes: Array<{ id: string }> }).nodes;
    expect(nodes.map((node) => node.id)).toEqual(["card"]);
  });
});
