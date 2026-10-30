import { defineTool } from "@dugout/contracts";
import { z } from "zod";
import { loadSkill, SKILL_NAME } from "./skills.ts";
import type { MemoryReader } from "./store.ts";

export const SEARCH_TOOL = "memory.search";
export const PROPOSE_TOOL = "memory.propose";
export const SKILL_TOOL = "skill.load";

/** Read-only memory tools. The tenant comes from the tool context; every agent reads all of it. */
export function createMemoryTools(opts: { reader: MemoryReader }) {
  const search = defineTool({
    name: SEARCH_TOOL,
    description:
      "Search this tenant's reviewed facts and past feedback. Use it when you need a house rule or lesson that isn't already in your instructions.",
    input: z.object({
      query: z.string().min(2),
      kinds: z
        .array(z.enum(["semantic", "episodic"]))
        .min(1)
        .default(["semantic", "episodic"]),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    effect: "read",
    timeoutMs: 10_000,
    async run({ query, kinds, limit }, ctx) {
      const items = await opts.reader.search({ tenantId: ctx.tenantId, query, kinds, limit });
      return items.map(({ kind, key, content, createdAt }) => ({ kind, key, content, createdAt }));
    },
  });

  // Records a proposal in the run's events only; consolidation stores it and a reviewer decides.
  const propose = defineTool({
    name: PROPOSE_TOOL,
    description:
      "Propose a new or corrected house fact for this tenant. A human reviews it before any run uses it. Every agent working for this tenant will read it, so say what it applies to, e.g. 'Match previews: at most 120 words'.",
    input: z.object({
      key: z.string().regex(/^[a-z][a-z0-9.-]*$/, "dotted lower-case key, e.g. style.spelling"),
      content: z.string().min(5).max(500),
      confidence: z.number().min(0).max(1),
    }),
    effect: "read",
    timeoutMs: 1_000,
    run: async () => ({ recorded: true, note: "A reviewer must approve this before it is used." }),
  });

  return [search, propose];
}

export interface SkillToolOptions {
  skillsDir: string;
  /** Already in the instructions. */
  skills: string[];
  onDemandSkills: string[];
}

/** Loads one of the agent's on-demand skills, as listed under "Skills you can load". */
export function createSkillTool(opts: SkillToolOptions) {
  return defineTool({
    name: SKILL_TOOL,
    description:
      "Load the full instructions of a skill listed under 'Skills you can load'. Load one when the task needs it, before doing that part of the work.",
    input: z.object({ name: z.string().regex(SKILL_NAME) }),
    effect: "read",
    timeoutMs: 5_000,
    alwaysInline: true,
    async run({ name }) {
      if (opts.skills.includes(name)) return `Skill ${name} is already in your instructions.`;
      if (!opts.onDemandSkills.includes(name)) {
        throw new Error(`no skill ${name}: load one listed under "Skills you can load"`);
      }
      const skill = await loadSkill(opts.skillsDir, name);
      return `## Skill: ${name}\n\n${skill.content}`;
    },
  });
}
