/**
 * A run written as a program: code steps, agent tasks, and typed state.
 *
 * The body is ordinary TypeScript, so loops and branches are code. A graph
 * (nodes and conditional edges, including a back edge) compiles to the same
 * runner. A task node can fold its output into state before the next edge.
 * Finished steps and tasks are skipped when the same program is run again
 * from the checkpoint, so a crash continues with that work untouched.
 *
 * Ids are the resume key. A step or task id that runs twice in one program
 * returns the first result; a loop gives each pass its own id. `until` is how
 * one task repeats until code says it is done.
 */

export interface StateField {
  reduce: "replace" | "append" | "merge";
  /** Required when `reduce` is `merge`: the property that identifies an item. */
  id?: string;
}

export type StateFields<S> = { [K in keyof S]: StateField };

export interface ProgramDone {
  output: unknown;
  status: "completed" | "stopped";
}

/** Saved after every finished step and task. Pass it back as `resume`. */
export interface ProgramCheckpoint<S> {
  version: 1;
  state: S;
  done: Record<string, ProgramDone>;
  /** Attempts a task has already returned, when code has not ended it yet. */
  attempts: Record<string, number>;
  /** Where the program was when it stopped. A graph keeps its position here. Older files have none. */
  cursor?: unknown;
}

export interface TaskRequest {
  id: string;
  agentId: string;
  input: unknown;
  /** 1 on the first try. A resumed unfinished task uses the next number. */
  attempt: number;
}

export interface TaskOutcome {
  status: "completed" | "failed";
  output: unknown;
}

export type TaskRunner = (req: TaskRequest) => Promise<TaskOutcome>;

export interface ProgramEvent {
  type: "step.started" | "step.completed" | "task.started" | "task.completed";
  programId: string;
  id: string;
  /** Set on task events: the task the event belongs to. */
  taskId?: string;
  attempt?: number;
  status?: "completed" | "stopped";
}

export interface ProgramContext<S> {
  readonly state: S;
  /** Deterministic work. Return a partial state; each key is merged by its rule. */
  step(id: string, run: (state: S) => Promise<Partial<S> | undefined>): Promise<void>;
  /**
   * One agent task. `until` ends it: while it returns false the task runs again,
   * and after `maxAttempts` code ends it as `stopped` whether or not the model
   * called `final`.
   */
  task(
    id: string,
    req: {
      agentId: string;
      input: unknown;
      until?: (output: unknown) => boolean;
      maxAttempts?: number;
    },
  ): Promise<unknown>;
  /** Runs `jobs` with at most `concurrency` in flight. */
  all(concurrency: number, jobs: Array<() => Promise<unknown>>): Promise<void>;
  /** The output of a finished step or task, including one skipped on resume. */
  result(id: string): unknown;
  /** The saved cursor, or undefined on a fresh run or an older checkpoint. */
  cursor<T>(): T | undefined;
  /** Saves a cursor with the checkpoint. */
  setCursor(value: unknown): Promise<void>;
}

export interface Program<S extends Record<string, unknown>> {
  id: string;
  initial: S;
  fields: StateFields<S>;
  run: (ctx: ProgramContext<S>) => Promise<void>;
}

export interface RunProgramOptions<S> {
  tasks: TaskRunner;
  resume?: ProgramCheckpoint<S>;
  /** Called with a copy of the checkpoint after every finished step or task attempt. */
  save?: (checkpoint: ProgramCheckpoint<S>) => void | Promise<void>;
  onEvent?: (event: ProgramEvent) => void;
}

export function defineProgram<S extends Record<string, unknown>>(program: Program<S>): Program<S> {
  for (const [key, field] of Object.entries(program.fields) as Array<[string, StateField]>) {
    if (field.reduce === "merge" && !field.id) {
      throw new Error(`${program.id}: state.${key} merges by id, so set id`);
    }
  }
  return program;
}

export async function runProgram<S extends Record<string, unknown>>(
  program: Program<S>,
  opts: RunProgramOptions<S>,
): Promise<{ state: S; checkpoint: ProgramCheckpoint<S> }> {
  const checkpoint: ProgramCheckpoint<S> = opts.resume
    ? structuredClone(opts.resume)
    : { version: 1, state: structuredClone(program.initial), done: {}, attempts: {} };

  const emit = (event: ProgramEvent) => opts.onEvent?.(event);
  const persist = async () => {
    await opts.save?.(structuredClone(checkpoint));
  };

  const ctx: ProgramContext<S> = {
    get state() {
      return checkpoint.state;
    },

    result(id) {
      return checkpoint.done[id]?.output;
    },

    cursor<T>() {
      return checkpoint.cursor as T | undefined;
    },

    async setCursor(value) {
      checkpoint.cursor = structuredClone(value);
      await persist();
    },

    async step(id, run) {
      if (checkpoint.done[id]) return;
      emit({ type: "step.started", programId: program.id, id });
      const patch = await run(checkpoint.state);
      if (patch) checkpoint.state = applyState(program, checkpoint.state, patch);
      checkpoint.done[id] = { output: patch ?? null, status: "completed" };
      emit({ type: "step.completed", programId: program.id, id, status: "completed" });
      await persist();
    },

    async task(id, req) {
      const finished = checkpoint.done[id];
      if (finished) return finished.output;
      const max = req.maxAttempts ?? 1;
      if (max < 1) throw new Error(`${program.id}: task ${id} needs maxAttempts >= 1`);
      let last: unknown;
      let attempt = checkpoint.attempts[id] ?? 0;
      while (attempt < max) {
        attempt += 1;
        emit({
          type: "task.started",
          programId: program.id,
          id,
          taskId: id,
          attempt,
        });
        const outcome = await opts.tasks({
          id,
          agentId: req.agentId,
          input: req.input,
          attempt,
        });
        last = outcome.output;
        checkpoint.attempts[id] = attempt;
        const passed = outcome.status === "completed" && (req.until?.(outcome.output) ?? true);
        if (passed) {
          checkpoint.done[id] = { output: last, status: "completed" };
          delete checkpoint.attempts[id];
          emit({
            type: "task.completed",
            programId: program.id,
            id,
            taskId: id,
            attempt,
            status: "completed",
          });
          await persist();
          return last;
        }
        await persist();
      }
      checkpoint.done[id] = { output: last, status: "stopped" };
      delete checkpoint.attempts[id];
      emit({
        type: "task.completed",
        programId: program.id,
        id,
        taskId: id,
        status: "stopped",
      });
      await persist();
      return last;
    },

    async all(concurrency, jobs) {
      if (concurrency < 1) throw new Error(`${program.id}: concurrency must be at least 1`);
      const queue = [...jobs];
      let failed = false;
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0 && !failed) {
          const job = queue.shift();
          if (!job) return;
          try {
            await job();
          } catch (err) {
            failed = true;
            throw err;
          }
        }
      });
      await Promise.all(workers);
    },
  };

  await program.run(ctx);
  return { state: checkpoint.state, checkpoint: structuredClone(checkpoint) };
}

/** An edge to `END` finishes the graph. */
export const END = null;

export type GraphNode<S> =
  | { kind: "step"; run: (state: S) => Promise<Partial<S> | undefined> }
  | {
      kind: "task";
      agentId: string;
      input: (state: S) => unknown;
      until?: (output: unknown) => boolean;
      maxAttempts?: number;
      /**
       * Folds the task output into state before the next edge. Runs as the step
       * `${visitId}:apply`, so a resume skips it once it has run.
       */
      apply?: (
        output: unknown,
        state: S,
      ) => Partial<S> | undefined | Promise<Partial<S> | undefined>;
    }
  | {
      kind: "map";
      over: (state: S) => Array<{ id: string; input: unknown }>;
      concurrency: number;
      agentId: string;
      until?: (output: unknown) => boolean;
      maxAttempts?: number;
    };

export interface GraphEdge<S> {
  from: string;
  to: string | null;
  when?: (state: S) => boolean;
}

export interface Graph<S extends Record<string, unknown>> {
  id: string;
  initial: S;
  fields: StateFields<S>;
  start: string;
  nodes: Record<string, GraphNode<S>>;
  edges: Array<GraphEdge<S>>;
  /** Stops a back edge that never settles. Defaults to 100. */
  maxVisits?: number;
}

interface GraphCursor {
  node: string | null;
  visits: number;
  seen: Record<string, number>;
}

/** A declared graph compiled onto {@link defineProgram}. Conditional and back edges are edges. */
export function defineGraph<S extends Record<string, unknown>>(graph: Graph<S>): Program<S> {
  if (!graph.nodes[graph.start]) throw new Error(`${graph.id}: no start node ${graph.start}`);
  for (const edge of graph.edges) {
    if (!graph.nodes[edge.from])
      throw new Error(`${graph.id}: edge from unknown node ${edge.from}`);
    if (edge.to !== null && !graph.nodes[edge.to]) {
      throw new Error(`${graph.id}: edge to unknown node ${edge.to}`);
    }
  }
  for (const [name, node] of Object.entries(graph.nodes)) {
    if (node.kind === "map" && node.concurrency < 1) {
      throw new Error(`${graph.id}: ${name} concurrency must be at least 1`);
    }
  }

  return defineProgram({
    id: graph.id,
    initial: graph.initial,
    fields: graph.fields,
    run: async (ctx) => {
      const limit = graph.maxVisits ?? 100;
      // A saved cursor names the visit that was under way. It is counted already,
      // so carry on at that visit; its finished steps and tasks are skipped by id.
      const saved = ctx.cursor<GraphCursor>();
      const seen: Record<string, number> = { ...saved?.seen };
      let node: string | null = saved ? saved.node : graph.start;
      let visits = saved?.visits ?? 0;
      let resumed = saved !== undefined && saved.node !== null;
      while (node) {
        const name: string = node;
        const current = graph.nodes[name];
        if (!current) throw new Error(`${graph.id}: no node ${name}`);
        if (!resumed) {
          visits += 1;
          if (visits > limit) throw new Error(`${graph.id}: stopped after ${limit} visits`);
          seen[name] = (seen[name] ?? 0) + 1;
        }
        resumed = false;
        // Before the node, so a crash inside it comes back to this same visit.
        await ctx.setCursor({ node: name, visits, seen } satisfies GraphCursor);
        await runNode(ctx, `${name}#${seen[name]}`, current);
        node = nextNode(graph, name, ctx.state);
      }
      await ctx.setCursor({ node: null, visits, seen } satisfies GraphCursor);
    },
  });
}

async function runNode<S>(ctx: ProgramContext<S>, visitId: string, node: GraphNode<S>) {
  if (node.kind === "step") {
    await ctx.step(visitId, node.run);
    return;
  }
  if (node.kind === "task") {
    const output = await ctx.task(visitId, {
      agentId: node.agentId,
      input: node.input(ctx.state),
      ...(node.until ? { until: node.until } : {}),
      ...(node.maxAttempts !== undefined ? { maxAttempts: node.maxAttempts } : {}),
    });
    if (node.apply) {
      const apply = node.apply;
      await ctx.step(`${visitId}:apply`, (state) => Promise.resolve(apply(output, state)));
    }
    return;
  }
  const items = node.over(ctx.state);
  await ctx.all(
    node.concurrency,
    items.map(
      (item) => () =>
        ctx.task(`${visitId}:${item.id}`, {
          agentId: node.agentId,
          input: item.input,
          ...(node.until ? { until: node.until } : {}),
          ...(node.maxAttempts !== undefined ? { maxAttempts: node.maxAttempts } : {}),
        }),
    ),
  );
}

function nextNode<S extends Record<string, unknown>>(
  graph: Graph<S>,
  from: string,
  state: S,
): string | null {
  const outs = graph.edges.filter((edge) => edge.from === from);
  if (outs.length === 0) throw new Error(`${graph.id}: ${from} has no edge`);
  for (const edge of outs) {
    if (!edge.when || edge.when(state)) return edge.to;
  }
  throw new Error(`${graph.id}: ${from} has no matching edge`);
}

function applyState<S extends Record<string, unknown>>(
  program: Program<S>,
  state: S,
  patch: Partial<S>,
): S {
  const next = { ...state };
  for (const key of Object.keys(patch) as Array<keyof S & string>) {
    const value = patch[key];
    if (value === undefined) continue;
    const field = program.fields[key];
    if (!field || field.reduce === "replace") {
      next[key] = value;
      continue;
    }
    const current = state[key];
    if (!Array.isArray(current)) {
      throw new Error(`${program.id}: state.${key} is ${field.reduce}d and must be a list`);
    }
    if (!Array.isArray(value)) {
      throw new Error(`${program.id}: state.${key} ${field.reduce}s a list`);
    }
    if (field.reduce === "append") {
      next[key] = [...current, ...value] as S[typeof key];
      continue;
    }
    const id = field.id;
    if (!id) throw new Error(`${program.id}: state.${key} merges by id, so set id`);
    const merged = new Map<unknown, Record<string, unknown>>();
    for (const item of current) {
      merged.set(recordId(item, id, program.id, key), { ...asRecord(item) });
    }
    for (const item of value) {
      const record = asRecord(item);
      const itemId = recordId(record, id, program.id, key);
      merged.set(itemId, { ...merged.get(itemId), ...record });
    }
    next[key] = [...merged.values()] as S[typeof key];
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("a merged state item must be an object");
  }
  return value as Record<string, unknown>;
}

function recordId(value: unknown, id: string, programId: string, key: string): unknown {
  const record = asRecord(value);
  if (!(id in record)) throw new Error(`${programId}: state.${key} item has no ${id}`);
  return record[id];
}
