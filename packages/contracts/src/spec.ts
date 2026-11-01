import { z } from "zod";
import type { Message } from "./messages.ts";
import type { RunContext } from "./runtime.ts";

export const MemoryScope = z.enum(["episodic", "semantic", "procedural"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const AgentSpec = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  owner: z.string(),
  instructions: z.string(),
  tools: z.array(z.string()), // names in the tool registry
  skills: z.array(z.string()).default([]), // procedural memory, in full in the instructions
  // listed by name and description only; the agent loads one with `skill.load` when it needs it
  onDemandSkills: z.array(z.string()).default([]),
  model: z.string().min(1), // a name in the model list (`config/models.json`)
  memory: z.object({ read: z.array(MemoryScope), write: z.array(MemoryScope) }),
  budget: z.object({
    usdPerRun: z.number().positive(),
    maxSteps: z.number().int().positive(),
    maxDepth: z.number().int().nonnegative(),
  }),
  approvals: z.array(z.string()), // tool names, or "effect:write"
});
export type AgentSpec = z.infer<typeof AgentSpec>;

/**
 * A spec plus what only code can carry. When `output` is set, the run ends through the `final`
 * tool and its input is validated against this schema.
 */
export interface AgentDefinition {
  spec: AgentSpec;
  output?: z.ZodType;
  /**
   * Sync check, no I/O (like `Tool.block`), after `output` passes and on the unwrapped value. A
   * string refuses the `final` call and goes back to the model as the reason.
   */
  verifyFinal?: (
    output: unknown,
    run: { ctx: RunContext; messages: Message[] },
  ) => string | undefined;
  /**
   * Sync, no I/O. Runs on the unwrapped `final` value before `verifyFinal`: the host overwrites
   * what a tool already returned, so the model need not copy it exactly. Returns the value to use.
   */
  completeFinal?: (output: unknown, run: { ctx: RunContext; messages: Message[] }) => unknown;
  /**
   * Whether this run is expected to write something. `final` is only FORCED (a forced tool choice,
   * on the last step or after the nudge) once a write has happened when one is expected, because a
   * model forced to answer before it saved ends `completed` with nothing saved and no approval ever
   * asked for. Default: expected when the spec lists a tool that writes. An agent that can write but
   * does not on some runs (a card made from a brief) says so here.
   */
  writeExpected?: (input: unknown) => boolean;
}
