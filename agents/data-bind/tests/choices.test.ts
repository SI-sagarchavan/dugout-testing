import { describe, expect, it } from "vitest";
import { completeFinal, verifyFinal } from "../src/agent.ts";
import { choiceProblems, describeChoice, describeLink, linksOf } from "../src/choices.ts";

const toggle = {
  key: "women_men",
  options: [
    { value: "women", label: "WOMEN" },
    { value: "men", label: "MEN" },
  ],
  initial: "men",
  section: "THE BRAVE SQUAD",
};

describe("a list that follows another section's choice", () => {
  it("is found by the field that holds the choice's values, however the feed writes them", () => {
    const data = {
      squad: {
        items: [
          { name: "Danni Wyatt", team: "Women" },
          { name: "James Vince", team: "Men" },
          { name: "Maia Bouchier", team: "Women" },
        ],
      },
    };
    const [link] = linksOf(data, [toggle]);
    if (!link) throw new Error("no link found");
    expect(link).toEqual({
      list: "squad.items",
      field: "team",
      key: "women_men",
      covers: ["women", "men"],
      others: 0,
    });
    expect(describeLink(link)).toContain('{ "path": "<as>.team", "eqPath": "_page.women_men" }');
  });

  it("is not found where one value of the choice is all the items hold", () => {
    const data = { squad: { items: [{ team: "Men" }, { team: "Men" }] } };
    expect(linksOf(data, [toggle])).toEqual([]);
  });

  it("names the choice and the section that writes it", () => {
    expect(describeChoice(toggle)).toBe(
      '_page.women_men: women ("WOMEN") | men ("MEN"), starts at men; written by "THE BRAVE SQUAD"',
    );
  });
});

describe("a frame with nothing to bind", () => {
  const run = {
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "s", name: "bind.static", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "s",
        content: JSON.stringify({ static: true, previewUrl: "http://x/preview/default/t" }),
      },
    ],
  } as never;

  it("ends with the frame as published, nothing bound", () => {
    const out = completeFinal(
      {
        previewUrl: "",
        planArtifactId: "",
        dataArtifactId: "",
        bound: 3,
        collapsed: 1,
        remaining: [],
        notes: [],
      },
      run,
    );
    expect(out).toMatchObject({
      static: true,
      previewUrl: "http://x/preview/default/t",
      bound: 0,
      collapsed: 0,
    });
    expect(verifyFinal(out, run)).toBeUndefined();
  });

  it("still needs a publish when it never said so", () => {
    expect(verifyFinal({ remaining: [], notes: [] }, { messages: [] } as never)).toContain(
      "bind.static",
    );
  });
});

describe("a list a page choice governs (ticket 13)", () => {
  const choice = (key: string, values: string[]) => ({
    key,
    options: values.map((value) => ({ value })),
    initial: values[0] ?? "",
  });
  const plan = (over: string, when?: unknown) => ({
    collapse: [{ over, as: "it", members: ["card"], ...(when ? { when } : {}) }],
  });

  it("faults a news list under category tabs that the collapse draws whole, and passes the filtered one", () => {
    const data = {
      feed: {
        items: [
          { title: "a", category: "news" },
          { title: "b", category: "Video" },
          { title: "c", category: "news" },
        ],
      },
    };
    const tabs = [choice("tab", ["news", "video"])];
    const open = choiceProblems(plan("feed.items"), data, tabs);
    expect(open).toHaveLength(1);
    expect(open[0]?.message).toContain('when { "path": "it.category", "eqPath": "_page.tab" }');
    // on the list's template: a plan can keep it with why
    expect(open[0]?.src).toBe("card");
    const filtered = plan("feed.items", { path: "it.category", eqPath: "_page.tab" });
    expect(choiceProblems(filtered, data, tabs)).toEqual([]);
  });

  it("faults a filter that holds none of the options, and passes an ALL option no item holds", () => {
    const data = {
      m: {
        items: [
          { name: "A", state: "result" },
          { name: "B", state: "result" },
        ],
      },
    };
    // an option no item holds draws every item (the DSL's ALL rule): not a fault
    const p = plan("m.items", { path: "it.state", eqPath: "_page.view" });
    expect(choiceProblems(p, data, [choice("view", ["all", "result"])])).toEqual([]);
    // the field holds none of the options: every option draws the whole list
    const problems = choiceProblems(p, data, [choice("view", ["live", "upcoming"])]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("no item holds any of its options");
  });

  it("is not faulted by another section's choice whose values a field happens to share", () => {
    // a home/away toggle elsewhere on the page; fixtures each say where they are played
    const data = {
      f: {
        items: [
          { opponent: "Riverside", venue: "Home" },
          { opponent: "Hill Town", venue: "Away" },
        ],
      },
    };
    const elsewhere = choice("where", ["home", "away"]);
    // not drawn here and not placed with the list: no problem, wherever it is on the page
    expect(choiceProblems(plan("f.items"), data, [], [], [elsewhere])).toEqual([]);
    // the slot was told to read it, and its options cover every value: it governs the list
    expect(choiceProblems(plan("f.items"), data, [], [elsewhere])).toHaveLength(1);
    // told to read it, but the field holds values it has no option for: not this list's
    const mixed = { f: { items: [...data.f.items, { opponent: "X", venue: "Neutral" }] } };
    expect(choiceProblems(plan("f.items"), mixed, [], [elsewhere])).toEqual([]);
  });

  it("leaves a list that follows the choice by its over alone", () => {
    const data = { squad: { women: [{ n: 1 }], men: [{ n: 2 }] } };
    expect(
      choiceProblems(plan("squad.{_page.squad}"), data, [choice("squad", ["women", "men"])]),
    ).toEqual([]);
  });
});
