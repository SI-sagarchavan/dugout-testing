import type { AgentSpec, RunContext, RunMemoryContext } from "@dugout/contracts";
import type { CompletedRun } from "@dugout/core";
import {
  type BuildReporter,
  type CorrectionReporter,
  consolidateRun,
  type LessonWriter,
  recordCorrections,
} from "./consolidate.ts";
import { buildContext, MEMORY_SHARE } from "./context.ts";
import type { MemoryStore } from "./store.ts";
import {
  noteOf,
  renderThread,
  THREAD_BUDGET_TOKENS,
  type ThreadNoteParts,
  type ThreadNotes,
} from "./thread.ts";
import { createMemoryTools, createSkillTool } from "./tools.ts";

export * from "./built.ts";
export * from "./consolidate.ts";
export * from "./context.ts";
export * from "./decisions.ts";
export * from "./embeddings.ts";
export * from "./patterns.ts";
export * from "./reembed.ts";
export * from "./shared.ts";
export * from "./skills.ts";
export * from "./store.ts";
export * from "./thread.ts";
export * from "./tools.ts";

export interface MemoryHooksOptions {
  store: MemoryStore;
  spec: AgentSpec;
  skillsDir: string;
  contextWindow: number;
  lessons?: LessonWriter;
  /** Off for eval runs that must not change memory. */
  consolidate?: boolean;
  /**
   * The shared scopes a run reads too (ADR 0014), from its tenant and, when the agent's input says
   * which sports it is about, its input. Without it, the tenant's own memory only.
   */
  groupsOf?: (tenantId: string, input?: unknown) => string[];
  /**
   * The threads' notes (ADR 0031). With it, a run a host started reads what earlier runs in its
   * thread did, and leaves a note of its own when it ends. A child run does neither.
   */
  threads?: ThreadNotes;
  /** The agent's account of what a run built, kept as a build record (ADR 0034). */
  record?: BuildReporter;
  /** What the run's edits changed in a preview people commented on (ADR 0034). */
  corrects?: CorrectionReporter;
  /** The agent's own word on what a run did, made and left open, for its thread's note. */
  threadNote?: (input: unknown, output: unknown) => string | ThreadNoteParts | undefined;
}

/** Everything `runLocal` needs to give an agent memory: tools, a context builder, consolidation. */
export function memoryHooks(opts: MemoryHooksOptions) {
  const { store, spec } = opts;
  const skills = {
    skillsDir: opts.skillsDir,
    skills: spec.skills,
    onDemandSkills: spec.onDemandSkills,
  };
  return {
    tools: [
      ...createMemoryTools({
        reader: store,
        ...(opts.groupsOf ? { groupsOf: opts.groupsOf } : {}),
      }),
      createSkillTool(skills),
    ],
    context: async (ctx: RunContext, input: unknown): Promise<RunMemoryContext> => {
      const built = await buildContext({
        reader: store,
        ...skills,
        tenantId: ctx.tenantId,
        groups: opts.groupsOf?.(ctx.tenantId, input) ?? [],
        agentId: spec.id,
        query: typeof input === "string" ? input : JSON.stringify(input),
        budgetTokens: Math.floor(opts.contextWindow * MEMORY_SHARE),
        readSemantic: spec.memory.read.includes("semantic"),
        ...(spec.memory.pin ? { pin: spec.memory.pin } : {}),
        readEpisodic: spec.memory.read.includes("episodic"),
        // approved lessons are how the agent works, as its skills are
        readLessons: spec.memory.read.includes("procedural"),
      });
      // a child's window is its own: its parent hands it what it needs
      if (!opts.threads || ctx.parent) return built;
      const threadId = await opts.threads.threadOf(ctx.tenantId, ctx.runId);
      if (!threadId) return built;
      const notes = (await opts.threads.list(ctx.tenantId, threadId)).filter(
        (n) => n.runId !== ctx.runId,
      );
      // versions are read where the table is: a database before migration 026 has none
      const versions =
        (await opts.threads.versions?.(ctx.tenantId, threadId).catch(() => [])) ?? [];
      const thread = renderThread(notes, THREAD_BUDGET_TOKENS, versions);
      if (!thread) return built;
      const tokens = Math.ceil(thread.length / 4);
      return {
        ...built,
        // input-dependent, like recalled lessons: the first user message, after the cached prompt
        recalled: [thread, built.recalled].filter(Boolean).join("\n\n"),
        tokens: built.tokens + tokens,
        sources: [
          ...built.sources,
          {
            id: `thread:${threadId}`,
            kind: "thread",
            tokens,
            text: `${notes.length} earlier run${notes.length === 1 ? "" : "s"} in this thread`,
          },
        ],
      };
    },
    afterRun: async ({ ctx, result, events, childEvents }: CompletedRun) => {
      // the thread's note first: it is what the next run in the thread starts from
      if (opts.threads && !ctx.parent) {
        const threadId = await opts.threads.threadOf(ctx.tenantId, ctx.runId);
        if (threadId) {
          const output = result.status === "completed" ? result.output : undefined;
          await opts.threads.add(
            ctx.tenantId,
            threadId,
            noteOf({
              runId: ctx.runId,
              agentId: spec.id,
              input: ctx.input,
              result,
              events,
              childEvents,
              said: output === undefined ? undefined : opts.threadNote?.(ctx.input, output),
            }),
          );
        }
      }
      if (opts.consolidate === false) return;
      const corrections =
        opts.corrects && result.status === "completed"
          ? opts.corrects({ input: ctx.input, output: result.output, events })
          : undefined;
      if (corrections)
        await recordCorrections({
          writer: store,
          tenantId: ctx.tenantId,
          agentId: spec.id,
          runId: ctx.runId,
          at: events.at(-1)?.at ?? new Date().toISOString(),
          report: corrections,
        });
      await consolidateRun({
        writer: store,
        tenantId: ctx.tenantId,
        agentId: spec.id,
        runId: ctx.runId,
        events,
        childEvents,
        ...(opts.record ? { record: opts.record } : {}),
        ...(ctx.situation ? { situation: ctx.situation } : {}),
        ...(opts.lessons ? { lessons: opts.lessons } : {}),
        model: spec.model,
        // a child's questions are learned in the run a person answered (ADR 0033)
        learnsAnswers: !ctx.parent,
      });
    },
  };
}
