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
  /**
   * The house facts the case assumes the tenant has, made active in the eval's memory before it
   * runs: a real client's facts are not kept in the repo, so a case names the ones it relies on.
   */
  facts?: Array<{ key: string; content: string }>;
}

/** What Southern Brave's people answered once and the club keeps: who it is, where pictures live. */
const SB_FACTS = [
  { key: "club.team", content: "The club is Southern Brave (The Hundred, women and men)." },
  { key: "media.team-crest", content: "Team crests: https://www.southernbrave.com{logo}" },
];

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
    facts: SB_FACTS,
    // the output's shape is the hook's to choose: with the WOMEN | MEN tabs filtering the list,
    // hook-maker gives one list whose items say which squad each player is in (need.filterBy), so
    // no schema pins key names; the team, the bound name and nothing broken are graded
    expect: {
      ending: "bound",
      must: { team: "Southern Brave" },
      required: ["name"],
    },
    confirmed: false,
    why: "Southern Brave's women's and men's squads in one list, each player tagged with the squad the WOMEN and MEN tabs choose.",
  },
  {
    id: "team-fixtures",
    kind: "standard",
    tenant: "sb",
    preview: TEAM_FRAME,
    slot: "the-road-ahead",
    facts: SB_FACTS,
    // dugout_cricket_fixture_day_cards holds Southern Brave's matches (2026-11-12: all 17 name
    // team 2034 or 2042), so the slot binds them; another team's data would still be a stand-in
    expect: { ending: "bound", must: { team: "Southern Brave" } },
    confirmed: false,
    why: "Southern Brave's fixtures, from the day-card hook, which now holds their matches (women and men), so the ending is bound.",
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
