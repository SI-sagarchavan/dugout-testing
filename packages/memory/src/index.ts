import type { AgentSpec, RunContext, RunMemoryContext } from "@dugout/contracts";
import type { CompletedRun } from "@dugout/core";
import { consolidateRun, type LessonWriter } from "./consolidate.ts";
import { buildContext, MEMORY_SHARE } from "./context.ts";
import type { MemoryStore } from "./store.ts";
import { createMemoryTools, createSkillTool } from "./tools.ts";

export * from "./consolidate.ts";
export * from "./context.ts";
export * from "./embeddings.ts";
export * from "./skills.ts";
export * from "./store.ts";
export * from "./tools.ts";

export interface MemoryHooksOptions {
  store: MemoryStore;
  spec: AgentSpec;
  skillsDir: string;
  contextWindow: number;
  lessons?: LessonWriter;
  /** Off for eval runs that must not change memory. */
  consolidate?: boolean;
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
    tools: [...createMemoryTools({ reader: store }), createSkillTool(skills)],
    context: (ctx: RunContext, input: unknown): Promise<RunMemoryContext> =>
      buildContext({
        reader: store,
        ...skills,
        tenantId: ctx.tenantId,
        agentId: spec.id,
        query: typeof input === "string" ? input : JSON.stringify(input),
        budgetTokens: Math.floor(opts.contextWindow * MEMORY_SHARE),
        readSemantic: spec.memory.read.includes("semantic"),
        readEpisodic: spec.memory.read.includes("episodic"),
      }),
    afterRun: async ({ ctx, events }: CompletedRun) => {
      if (opts.consolidate === false) return;
      await consolidateRun({
        writer: store,
        tenantId: ctx.tenantId,
        agentId: spec.id,
        runId: ctx.runId,
        events,
        ...(opts.lessons ? { lessons: opts.lessons } : {}),
      });
    },
  };
}
