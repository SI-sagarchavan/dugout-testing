import { z } from "zod";
import type { RunHook } from "./hooks.ts";
import type { Message } from "./messages.ts";
import type { RunContext } from "./runtime.ts";
import type { RunStateReader } from "./state.ts";

export const MemoryScope = z.enum(["episodic", "semantic", "procedural"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

/**
 * What an agent is, as data. Only `id`, `instructions` and `model` must be written: the rest has
 * the default most agents take (version 1, no tools beyond the ones passed to `defineAgent`, its
 * skills and approved lessons read, $1 and 30 steps a run, every write approved).
 */
export const AgentSpec = z.object({
  id: z.string(),
  /** Raised when a saved run of the old version could not carry on under the new one. */
  version: z.number().int().positive().default(1),
  /** The team that answers for it; recorded, and read by nothing. */
  owner: z.string().optional(),
  /** One line on what the agent does: what a parent's model reads when it may call this agent. */
  description: z.string().optional(),
  instructions: z.string(),
  // names in the tool registry: the allow-list. Tools passed to `defineAgent` as a list are on it
  // already; memory's and a factory's are named here
  tools: z.array(z.string()).default([]),
  /**
   * Agents this one may hand a part of its work to (ADR 0025). Each is a tool, `agent.<camelId>`,
   * whose input is that agent's input; a call starts a child run. Needs `budget.maxDepth` of 1 or more.
   */
  agents: z.array(z.string()).optional(),
  /**
   * What the agent needs from MCP servers, by capability, never by server (ADR 0026):
   * `hooks.author`. The registry (`config/mcp`) says which servers have it and which of their
   * tools it grants; those tools are added to `tools` when the agent is created.
   */
  requires: z.array(z.string()).optional(),
  /** Capabilities used when a server that has them is configured here, and left out otherwise. */
  optional: z.array(z.string()).optional(),
  skills: z.array(z.string()).default([]), // procedural memory, in full in the instructions
  // listed by name and description only; the agent loads one with `skill.load` when it needs it
  onDemandSkills: z.array(z.string()).default([]),
  model: z.string().min(1), // a name in the model list (`config/models.json`)
  memory: z
    .object({
      read: z.array(MemoryScope).default(["procedural"]),
      /** Read by nothing: only consolidation writes long-term memory. Kept for specs that say it. */
      write: z.array(MemoryScope).default([]),
      /**
       * Fact keys, by prefix, the agent always needs (`["club.", "approvals."]`, ADR 0034): only
       * these go in the system prompt. The rest are one line there (how many, under which prefixes)
       * and are reached by `memory.search`, or returned by a tool that reads them by key. Left out:
       * every active fact, as before.
       */
      pin: z.array(z.string().min(1)).optional(),
    })
    .default({ read: ["procedural"], write: [] }),
  budget: z
    .object({
      usdPerRun: z.number().positive().default(1),
      maxSteps: z.number().int().positive().default(30),
      /** How many levels of child runs it may start: 0 for an agent that calls no agent. */
      maxDepth: z.number().int().nonnegative().default(0),
    })
    .default({ usdPerRun: 1, maxSteps: 30, maxDepth: 0 }),
  // tool names, or "effect:write". Every write is approved unless the spec says otherwise
  approvals: z.array(z.string()).default(["effect:write"]),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

/**
 * What the checks on `final` read of the run. `state` is what its tools kept (ADR 0035): read a
 * tool's result from there, not from `messages`, where a long result is only a reference.
 */
export interface FinalRun {
  ctx: RunContext;
  messages: Message[];
  state: RunStateReader;
}

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
  verifyFinal?: (output: unknown, run: FinalRun) => string | undefined;
  /**
   * Sync, no I/O. Runs on the unwrapped `final` value before `verifyFinal`: the host overwrites
   * what a tool already returned, so the model need not copy it exactly. Returns the value to use.
   */
  completeFinal?: (output: unknown, run: FinalRun) => unknown;
  /**
   * The run result's shape, when `completeFinal` turns the model's `final` into something else
   * (sitemap: a compact tree in, the backend's page tree out). Hosts see this; the model never
   * does. Defaults to `output`.
   */
  result?: z.ZodType;
  /**
   * Whether this run is expected to write something. `final` is only FORCED (a forced tool choice,
   * on the last step or after the nudge) once a write has happened when one is expected, because a
   * model forced to answer before it saved ends `completed` with nothing saved and no approval ever
   * asked for. Default: expected when the spec lists a tool that writes. An agent that can write but
   * does not on some runs (a draft the reviewer may not need) says so here.
   */
  writeExpected?: (input: unknown) => boolean;
  /**
   * The agent's own per-turn rules (ADR 0023). They run after the harness's, in list order.
   * Pure and synchronous; see `RunHook`.
   */
  hooks?: RunHook[];
}
