import { describe, expect, it } from "vitest";
import { completeFinal, verifyFinal } from "../src/agent.ts";
import { describeChoice, describeLink, linksOf } from "../src/choices.ts";

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
