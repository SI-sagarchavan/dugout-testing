import type { DataExpect, EvalCase } from "@dugout/evals";

/** A slot (or frame) of a published Handoff, with the data it should get. */
export interface DataCase extends EvalCase {
  kind: "standard";
  /** The published frame (the local control plane's preview link of its dsl_tree). */
  preview?: string;
  /** The slot of the frame this case binds, by its name; the whole frame when left out. */
  slot?: string;
  /** A dataset the API serves, bound as given (the reference plan's case). */
  data?: string;
  expect: DataExpect;
  /** A person confirmed the expected answer. Unconfirmed cases run and are reported, never gate. */
  confirmed: boolean;
  /** Why the case expects what it does. */
  why: string;
  /** Set when the case cannot run yet, and what it needs. */
  needs?: string;
}

const TEAM_FRAME = "http://localhost:3000/preview/default/4ef6a64d-7b6c-4b55-ae93-bd3b05e47b45";

/**
 * Start with the Team frame of Southern Brave (Handoff 74cebc8c), the frame run 3acd204c bound to
 * the wrong team, and the reference plan for the fixtures strip. Cases that need a Handoff the
 * control plane does not hold yet say what they need (`needs`) and are skipped until it is there.
 */
export const CASES: DataCase[] = [
  {
    id: "team-squad",
    kind: "standard",
    tenant: "sb",
    preview: TEAM_FRAME,
    slot: "the-brave-squad",
    expect: {
      ending: "bound",
      hook: {
        schema: {
          type: "object",
          required: ["women", "men"],
          properties: {
            women: { type: "array", items: { type: "object", required: ["name"] } },
            men: { type: "array", items: { type: "object", required: ["name"] } },
          },
        },
      },
      must: { team: "Southern Brave" },
      required: ["name"],
    },
    confirmed: false,
    why: "Southern Brave's women's and men's squads, so the WOMEN and MEN tabs switch between them. Today the slot binds an IPL franchise's squad.",
  },
  {
    id: "team-fixtures",
    kind: "standard",
    tenant: "sb",
    preview: TEAM_FRAME,
    slot: "the-road-ahead",
    // no Southern Brave fixtures feed exists: the slot must say so, never bind another team's
    expect: { ending: "stand-in", must: { team: "Southern Brave" } },
    confirmed: false,
    why: "Southern Brave's fixtures. None exists in Cast today, so the honest ending is a stand-in or none, never bound.",
  },
  {
    id: "fixtures-strip",
    kind: "standard",
    tenant: "demo-cricket",
    data: "fixtures-strip",
    expect: {
      ending: "bound",
      required: ["status_label", "local_time", "logo", "name", "score"],
      variants: ["R", "U"],
    },
    confirmed: false,
    why: "The reference plan, apps/api/data/fixtures-strip-plan.json: a result card and an upcoming card, chosen by the match's state.",
    needs:
      "a published preview of the fixtures strip frame (set `preview`); the dataset and its reference plan are in apps/api/data",
  },
  {
    id: "articles-list",
    kind: "standard",
    tenant: "sb",
    data: "news-grid",
    expect: { ending: "bound", required: ["title", "image", "date"], order: "newest-first" },
    confirmed: false,
    why: "A news grid bound to the articles dataset (agents/data-bind/tests/fixtures/news-grid.*).",
    needs: "a published preview of the news grid frame (set `preview`)",
  },
  {
    id: "videos-list",
    kind: "standard",
    tenant: "sb",
    expect: { ending: "bound", required: ["title", "image"] },
    confirmed: false,
    why: "A videos list: title and thumbnail for each video.",
    needs: "a Handoff with a videos list in the control plane, published (set `preview`)",
  },
  {
    id: "standings-table",
    kind: "standard",
    tenant: "sb",
    expect: { ending: "bound", required: ["team", "played", "points"] },
    confirmed: false,
    why: "A standings table: one row per team with played and points.",
    needs: "a Handoff with a standings table in the control plane, published (set `preview`)",
  },
];
