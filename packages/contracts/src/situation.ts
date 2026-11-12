import { z } from "zod";

/**
 * What a run works on (ADR 0033): the section, by the structural signature of its tree's root, set
 * by a tool from what it loaded, never by the model. A decision a person makes is about it.
 */
export const Situation = z.object({
  section: z.string().min(1),
  /** The section's name, for people (the frame's name). */
  name: z.string().optional(),
});
export type Situation = z.infer<typeof Situation>;
