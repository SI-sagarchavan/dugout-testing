import { z } from "zod";

/**
 * Something a run found on its section that other sections may agree on (ADR 0034, section 8): a
 * candidate house fact, said by the agent that knows what it means. Memory counts the sections
 * whose latest good record proposes the same `value` under the same `key`, and proposes the fact
 * for a person to approve when enough agree; it never reads `did` for this.
 *
 * `{name}` in `key` is the section's label of that name (`section.labels`, from any agent's record
 * on the same section), written as a slug; the same `{name}` in `sentence` and in the string values
 * of `value` is the label as it is. A pattern whose labels the section has none of is not counted.
 */
export const BuildPattern = z.object({
  /** The fact's key, dotted: `data.hook.{list}`, `form.date.published-date`. */
  key: z.string().min(1),
  /** What the sections must agree on; it becomes the fact's value. */
  value: z.unknown(),
  /** The fact as a person reads it, without how many sections agreed: memory adds that. */
  sentence: z.string().min(1),
});
export type BuildPattern = z.infer<typeof BuildPattern>;

/**
 * How one run built one section and how that turned out (ADR 0034): an episode of type `build` in
 * memory, keyed by the agent and the section's structural signature, written by consolidation from
 * what the agent's `record` returns and the run's events. Never written by a model.
 */
export const BuildRecord = z.object({
  v: z.literal(1),
  agent: z.string(),
  agentVersion: z.number(),
  section: z.object({
    signature: z.string().min(1),
    name: z.string().optional(),
    /** What the section is and how it is laid out, when the agent knows; the library knows too. */
    kind: z.string().optional(),
    layout: z.string().optional(),
    /**
     * What the section is in the agent's own terms (`{ list: "fixtures" }`), for the patterns of
     * any agent's records on it. Absent from records written before patterns were the agents'.
     */
    labels: z.record(z.string(), z.string()).optional(),
  }),
  run: z.object({
    runId: z.string(),
    handoffId: z.string().optional(),
    previewUrl: z.string().optional(),
    /** The previews a person's comments produced from it, newest last (ui-editor, ADR 0034). */
    edited: z.array(z.string()).optional(),
    at: z.string(),
  }),
  /** The agent's own typed payload: what it applied, bound or chose. */
  did: z.unknown(),
  /** The part of `did` with no id, name or value of the club. */
  portable: z.unknown().optional(),
  /** What the agent says other sections may agree on; none on records written before. */
  patterns: z.array(BuildPattern).optional(),
  outcome: z.object({
    ended: z.enum(["completed", "failed", "rejected"]),
    /** Code's verdict, the agent's own rule over a run that completed. */
    good: z.boolean(),
    /** Match, 0 to 100, where the agent measures one. */
    score: z.number().optional(),
    /** What was still off when it published. */
    remaining: z.array(z.string()),
    steps: z.number(),
    costUsd: z.number(),
    asked: z.number(),
    approvedBy: z.enum(["person", "auto", "none"]),
  }),
  corrected: z
    .array(
      z.object({ at: z.string(), by: z.string(), what: z.string(), runId: z.string().optional() }),
    )
    .optional(),
});
export type BuildRecord = z.infer<typeof BuildRecord>;

/** What an agent's `record` returns for a run: the rest of the record is read from the events. */
export interface BuildReport {
  did: unknown;
  portable?: unknown;
  /** The agent's own rule; a run that did not complete is never good, whatever this says. */
  good: boolean;
  score?: number;
  remaining?: string[];
  /** One clause on what was done, for the record's sentence: `bound "Fixtures" to dugout_fixtures`. */
  line: string;
  section?: { kind?: string; layout?: string; labels?: Record<string, string> };
  /** Candidate facts for memory to count across sections (`BuildPattern`). */
  patterns?: BuildPattern[];
  handoffId?: string;
  previewUrl?: string;
}
