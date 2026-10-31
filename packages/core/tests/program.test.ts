import { describe, expect, it } from "vitest";
import {
  defineGraph,
  defineProgram,
  END,
  type ProgramCheckpoint,
  type ProgramEvent,
  runProgram,
  type TaskOutcome,
  type TaskRequest,
  type TaskRunner,
} from "../src/program.ts";

interface RoundState extends Record<string, unknown> {
  fixtures: string[];
  packs: Array<{ id: string; text?: string }>;
  kind: string;
}

const round = defineProgram<RoundState>({
  id: "round",
  initial: { fixtures: [], packs: [], kind: "" },
  fields: {
    fixtures: { reduce: "replace" },
    packs: { reduce: "merge", id: "id" },
    kind: { reduce: "replace" },
  },
  run: async (ctx) => {
    await ctx.step("load", async () => ({ fixtures: ["a", "b", "c"] }));
    await ctx.step("plan", async (state) => ({
      kind: state.fixtures.length > 0 ? "slate" : "empty",
    }));
    await ctx.all(
      2,
      ctx.state.fixtures.map(
        (id) => () =>
          ctx.task(id, {
            agentId: "matchday",
            input: { fixtureId: id },
            until: (output) => (output as { ok?: boolean }).ok === true,
            maxAttempts: 2,
          }),
      ),
    );
  },
});

const ok = (id: string): TaskOutcome => ({
  status: "completed",
  output: { id, ok: true, text: id },
});

describe("runProgram", () => {
  it("runs two code steps and three tasks, two at a time, and tags each task's events", async () => {
    let active = 0;
    let maxActive = 0;
    const release: Record<string, () => void> = {};
    const tasks: TaskRunner = (req) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      let go: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        go = resolve;
      });
      release[req.id] = () => {
        active -= 1;
        go();
      };
      return gate.then(() => ok(req.id));
    };
    const events: ProgramEvent[] = [];
    const running = runProgram(round, { tasks, onEvent: (event) => events.push(event) });

    await waitFor(() => Object.keys(release).length >= 2);
    expect(Object.keys(release).sort()).toEqual(["a", "b"]);
    expect(maxActive).toBe(2);
    release.a?.();
    release.b?.();
    await waitFor(() => release.c !== undefined);
    expect(maxActive).toBe(2);
    release.c?.();

    const { state } = await running;
    expect(state.fixtures).toEqual(["a", "b", "c"]);
    expect(state.kind).toBe("slate");
    expect(state.packs).toEqual([]);
    const taskEvents = events.filter((event) => event.type.startsWith("task."));
    expect(taskEvents.length).toBeGreaterThan(0);
    expect(taskEvents.every((event) => event.taskId === event.id)).toBe(true);
    expect(
      events.filter((event) => event.type === "step.completed").map((event) => event.id),
    ).toEqual(["load", "plan"]);
  });

  it("ends a task from code when the check passes, and when the attempts run out", async () => {
    const scores = defineProgram({
      id: "scores",
      initial: { best: 0 },
      fields: { best: { reduce: "replace" } },
      run: async (ctx) => {
        const rising = await ctx.task("rising", {
          agentId: "judge",
          input: {},
          until: (output) => (output as { score: number }).score >= 2,
          maxAttempts: 3,
        });
        await ctx.step("keep", async () => ({ best: (rising as { score: number }).score }));
        await ctx.task("stuck", {
          agentId: "judge",
          input: {},
          until: () => false,
          maxAttempts: 2,
        });
      },
    });
    const calls: string[] = [];
    const { state, checkpoint } = await runProgram(scores, {
      tasks: async (req) => {
        calls.push(`${req.id}:${req.attempt}`);
        return { status: "completed", output: { score: req.attempt } };
      },
    });
    expect(calls).toEqual(["rising:1", "rising:2", "stuck:1", "stuck:2"]);
    expect(state.best).toBe(2);
    expect(checkpoint.done.rising?.status).toBe("completed");
    expect(checkpoint.done.stuck?.status).toBe("stopped");
  });

  it("resumes after a crash with finished steps and tasks untouched", async () => {
    const calls: string[] = [];
    let crash = true;
    const tasks: TaskRunner = async (req) => {
      calls.push(req.id);
      if (crash && req.id === "b") throw new Error("worker died");
      return ok(req.id);
    };
    let saved: ProgramCheckpoint<RoundState> | undefined;
    const save = (checkpoint: ProgramCheckpoint<RoundState>) => {
      saved = checkpoint;
    };
    await expect(runProgram(round, { tasks, save })).rejects.toThrow("worker died");
    expect(calls).toEqual(["a", "b"]);
    expect(saved?.done.a?.status).toBe("completed");
    expect(saved?.done.load?.status).toBe("completed");
    expect(saved?.done.b).toBeUndefined();
    if (!saved) throw new Error("no checkpoint");

    calls.length = 0;
    crash = false;
    const { state } = await runProgram(round, { tasks, save, resume: saved });
    expect(calls).toEqual(["b", "c"]);
    expect(state.fixtures).toEqual(["a", "b", "c"]);
    expect(Object.keys(state).sort()).toEqual(["fixtures", "kind", "packs"]);
  });

  it("appends and merges state by the field rule", async () => {
    const program = defineProgram({
      id: "pages",
      initial: { notes: [] as string[], pages: [] as Array<{ id: string; title: string }> },
      fields: {
        notes: { reduce: "append" },
        pages: { reduce: "merge", id: "id" },
      },
      run: async (ctx) => {
        await ctx.step("one", async () => ({
          notes: ["home"],
          pages: [{ id: "home", title: "Home" }],
        }));
        await ctx.step("two", async () => ({
          notes: ["about"],
          pages: [{ id: "home", title: "Home page" }],
        }));
      },
    });
    const { state } = await runProgram(program, { tasks: async () => ok("unused") });
    expect(state.notes).toEqual(["home", "about"]);
    expect(state.pages).toEqual([{ id: "home", title: "Home page" }]);
  });
});

describe("defineGraph", () => {
  it("follows a branch and a back edge, and stops when the condition settles", async () => {
    const graph = defineGraph({
      id: "revise",
      initial: { n: 0, path: [] as string[] },
      fields: {
        n: { reduce: "replace" },
        path: { reduce: "append" },
      },
      start: "work",
      maxVisits: 10,
      nodes: {
        work: {
          kind: "step",
          run: async (state) => ({
            n: state.n + 1,
            path: [state.n < 2 ? "work" : "last"],
          }),
        },
      },
      edges: [
        { from: "work", to: "work", when: (state) => state.n < 3 },
        { from: "work", to: END },
      ],
    });
    const { state } = await runProgram(graph, { tasks: async () => ok("unused") });
    expect(state.n).toBe(3);
    expect(state.path).toEqual(["work", "work", "last"]);
  });

  it("maps items onto tasks with a concurrency limit", async () => {
    const graph = defineGraph({
      id: "slate",
      initial: { fixtures: ["a", "b", "c"] },
      fields: { fixtures: { reduce: "replace" } },
      start: "write",
      nodes: {
        write: {
          kind: "map",
          concurrency: 2,
          agentId: "matchday",
          over: (state) => state.fixtures.map((id) => ({ id, input: { fixtureId: id } })),
        },
      },
      edges: [{ from: "write", to: END }],
    });
    let active = 0;
    let maxActive = 0;
    const waiting: Array<(value: TaskOutcome) => void> = [];
    const tasks = (_req: TaskRequest) =>
      new Promise<TaskOutcome>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        waiting.push((value) => {
          active -= 1;
          resolve(value);
        });
      });
    const running = runProgram(graph, { tasks });
    await waitFor(() => waiting.length >= 2);
    expect(waiting).toHaveLength(2);
    waiting.shift()?.(ok("a"));
    await waitFor(() => waiting.length >= 2);
    expect(maxActive).toBe(2);
    waiting.shift()?.(ok("b"));
    waiting.shift()?.(ok("c"));
    await running;
    expect(maxActive).toBe(2);
  });

  it("refuses a back edge that never settles", async () => {
    const graph = defineGraph({
      id: "spin",
      initial: { n: 0 },
      fields: { n: { reduce: "replace" } },
      start: "work",
      maxVisits: 3,
      nodes: { work: { kind: "step", run: async (state) => ({ n: state.n + 1 }) } },
      edges: [{ from: "work", to: "work" }],
    });
    await expect(runProgram(graph, { tasks: async () => ok("unused") })).rejects.toThrow(
      "stopped after 3 visits",
    );
  });

  it("folds a task output into state before the next edge", async () => {
    const graph = defineGraph({
      id: "fold",
      initial: { n: 0, seen: [] as string[] },
      fields: { n: { reduce: "replace" }, seen: { reduce: "append" } },
      start: "ask",
      nodes: {
        ask: {
          kind: "task",
          agentId: "echo",
          input: (state) => ({ n: state.n }),
          apply: (output) => ({ n: output as number }),
        },
        note: { kind: "step", run: async (state) => ({ seen: [String(state.n)] }) },
      },
      edges: [
        { from: "ask", to: "ask", when: (state) => state.n < 2 },
        { from: "ask", to: "note" },
        { from: "note", to: END },
      ],
    });
    const inputs: unknown[] = [];
    const tasks: TaskRunner = async (req) => {
      inputs.push(req.input);
      return { status: "completed", output: (req.input as { n: number }).n + 1 };
    };
    const { state } = await runProgram(graph, { tasks });
    expect(inputs).toEqual([{ n: 0 }, { n: 1 }]);
    expect(state.n).toBe(2);
    expect(state.seen).toEqual(["2"]);
  });

  it("skips a finished task and its apply step on resume", async () => {
    let applied = 0;
    const graph = defineGraph({
      id: "fold-resume",
      initial: { n: 0 },
      fields: { n: { reduce: "replace" } },
      start: "ask",
      nodes: {
        ask: {
          kind: "task",
          agentId: "echo",
          input: () => ({}),
          apply: (output) => {
            applied += 1;
            return { n: output as number };
          },
        },
      },
      edges: [{ from: "ask", to: END }],
    });
    const tasks: TaskRunner = async () => ({ status: "completed", output: 4 });
    const first = await runProgram(graph, { tasks });
    expect(applied).toBe(1);
    expect(first.state.n).toBe(4);
    const second = await runProgram(graph, { tasks, resume: first.checkpoint });
    expect(applied).toBe(1);
    expect(second.state.n).toBe(4);
  });
});

async function waitFor(ready: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the program");
}
