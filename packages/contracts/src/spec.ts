import { z } from "zod";

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
}
