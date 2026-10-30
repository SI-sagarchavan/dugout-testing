import type { EvalCase } from "@dugout/evals";
import type { Channel } from "../src/index.ts";

export interface MatchdayCase extends EvalCase {
  fixtureId: string;
  brief?: string;
  channels?: Channel[];
  /** The first pack is sent back; the second must name the venue. */
  revise?: { request: string };
}

export const cases: MatchdayCase[] = [
  {
    id: "c-101-preview",
    kind: "standard",
    tenant: "demo-cricket",
    fixtureId: "c-101",
    brief: "Season opener. Keep it short.",
  },
  {
    id: "c-101-social",
    kind: "standard",
    tenant: "demo-cricket",
    fixtureId: "c-101",
    channels: ["social"],
    brief: "Write the social post as well.",
  },
  {
    id: "c-101-channels",
    kind: "standard",
    tenant: "demo-cricket",
    fixtureId: "c-101",
    channels: ["social", "push", "headline"],
  },
  {
    id: "c-101-revise",
    kind: "hard",
    tenant: "demo-cricket",
    fixtureId: "c-101",
    revise: { request: "Name the venue in the preview." },
  },
];
