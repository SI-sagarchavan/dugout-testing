import { describe, expect, it } from "vitest";
import {
  type FoundSlots,
  joined,
  joinsFrom,
  keyPart,
  ownersOf,
  slotted,
  splitChoices,
  splitQuestion,
} from "../src/slots.ts";

const slot = (id: string, name: string, ir: string[]) => ({
  id,
  name,
  nodes: [id],
  ir,
  confidence: "sure" as const,
  signature: `sig-${id}`,
});

/** Two slots under one background, each with a WOMEN/MEN tab bar and a panel that reads it. */
function frame() {
  type N = {
    id: string;
    parent: string | null;
    src?: string;
    type: string;
    props: Record<string, unknown>;
  };
  const tab = (id: string, parent: string, src: string, value: string) => ({
    id,
    parent,
    src,
    type: "Frame",
    props: { select: { key: "women_men", value } },
  });
  const panel = (id: string, parent: string, src: string, value: string) => ({
    id,
    parent,
    src,
    type: "Frame",
    props: { when: { path: "_page.women_men", eq: value } },
  });
  const nodes: N[] = [
    { id: "root", parent: null, src: "f", type: "Frame", props: {} },
    { id: "bg", parent: "root", src: "back", type: "Image", props: {} },
    { id: "bgchild", parent: "bg", type: "Image", props: {} },
    { id: "a", parent: "root", src: "a", type: "Frame", props: {} },
    tab("a-w", "a", "a1", "women"),
    tab("a-m", "a", "a2", "men"),
    panel("a-p", "a", "a3", "men"),
    { id: "a-gen", parent: "a-p", type: "Text", props: {} },
    { id: "b", parent: "root", src: "b", type: "Frame", props: {} },
    tab("b-w", "b", "b1", "women"),
    panel("b-p", "b", "b2", "women"),
  ];
  return { nodes };
}

const found: FoundSlots = {
  slots: [slot("a", "squad", ["a", "a1", "a2", "a3"]), slot("b", "fixtures", ["b", "b1", "b2"])],
  background: ["back"],
};
/** What `pageChoices` does: the tabs among `nodes`, grouped by key. */
const choicesOf = (nodes: Array<{ props: Record<string, unknown> }>) => {
  const byKey = new Map<string, string[]>();
  for (const n of nodes) {
    const select = n.props.select as { key: string; value: string } | undefined;
    if (select) byKey.set(select.key, [...(byKey.get(select.key) ?? []), select.value]);
  }
  return [...byKey].map(([key, values]) => ({
    key,
    options: values.map((value) => ({ value })),
    initial: values[0] ?? "",
  }));
};

describe("ownersOf", () => {
  it("gives a node its layer's slot, a generated node its parent's, and the background none", () => {
    const owners = ownersOf(frame().nodes, found);
    expect(owners.get("a-p")).toBe(0);
    expect(owners.get("a-gen")).toBe(0);
    expect(owners.get("b-w")).toBe(1);
    expect(owners.get("bg")).toBe(-1);
    expect(owners.get("bgchild")).toBe(-1);
    expect(owners.get("root")).toBe(-1);
  });
});

describe("slotted", () => {
  it("names a choice for the slot that draws it, so two slots' tabs get two keys", () => {
    const r = slotted(frame(), found, choicesOf);
    expect(r.choices.map((c) => [c.key, c.owner])).toEqual([
      ["squad_women_men", "a"],
      ["fixtures_women_men", "b"],
    ]);
    const tabs = r.tree.nodes.flatMap((n) => {
      const select = n.props.select as { key: string } | undefined;
      return select ? [[n.id, select.key]] : [];
    });
    expect(tabs).toEqual([
      ["a-w", "squad_women_men"],
      ["a-m", "squad_women_men"],
      ["b-w", "fixtures_women_men"],
    ]);
  });

  it("changes the keys its slot's panels read, and records what each slot writes and reads", () => {
    const r = slotted(frame(), found, choicesOf);
    const when = (id: string) =>
      r.tree.nodes.find((n) => n.id === id)?.props.when as { path: string };
    expect(when("a-p").path).toBe("_page.squad_women_men");
    expect(when("b-p").path).toBe("_page.fixtures_women_men");
    expect(r.writes).toEqual([["squad_women_men"], ["fixtures_women_men"]]);
    expect(r.reads).toEqual([["squad_women_men"], ["fixtures_women_men"]]);
  });

  it("leaves a slot's read of a key it does not draw as it is", () => {
    const tree = frame();
    tree.nodes = tree.nodes.filter((n) => n.id !== "b-w");
    const r = slotted(tree, found, choicesOf);
    expect(r.reads).toEqual([["squad_women_men"], ["women_men"]]);
  });

  it("leaves a one-slot frame's keys as they are", () => {
    const one: FoundSlots = {
      slots: [slot("a", "squad", ["a", "a1", "a2", "a3"])],
      background: [],
    };
    const r = slotted(frame(), one, choicesOf);
    expect(r.choices.map((c) => [c.key, c.owner])).toEqual([["women_men", "a"]]);
    expect(r.writes).toEqual([["women_men"]]);
  });
});

describe("keyPart", () => {
  it("makes a page key of a slot's name", () => {
    expect(keyPart("the-brave-squad")).toBe("the_brave_squad");
    expect(keyPart("2024-squad")).toBe("s_2024_squad");
  });
});

describe("settling which parts are one section (ticket 04)", () => {
  const part = (id: string, name: string, why?: string) => ({
    ...slot(id, name, [id, `${id}1`]),
    ...(why ? { confidence: "unsure" as const, why } : {}),
  });
  const unsure: FoundSlots = {
    slots: [
      part("h", "the-brave-squad", "a heading with no content under it"),
      part("c", "cards"),
      part("x", "extras", "no heading between it and c: one section or two?"),
    ],
    background: [],
  };

  it("asks nothing when the finder is sure of every part", () => {
    expect(splitQuestion(found)).toBeUndefined();
  });

  it("offers each join the finder was unsure of, proposing a heading's join to the part below", () => {
    const q = splitQuestion(unsure);
    expect(q).toMatchObject({ id: "section_split", kind: "multi", proposed: ["join:h+c"] });
    expect(q?.options.map((o) => o.value)).toEqual(["apart", "join:h+c", "join:c+x"]);
    expect(splitChoices(unsure).joins).toEqual([
      ["h", "c"],
      ["c", "x"],
    ]);
  });

  it("proposes keeping them apart when no join is likelier", () => {
    const q = splitQuestion({
      slots: [part("c", "cards"), unsure.slots[2] as never],
      background: [],
    });
    expect(q?.proposed).toEqual(["apart"]);
  });

  it("joins what a person joined into one sure part, signed again, and ignores what is gone", () => {
    const joins = joinsFrom(["join:h+c", "apart", "join:gone+c"]);
    expect(joins).toEqual([
      ["h", "c"],
      ["gone", "c"],
    ]);
    const out = joined(unsure.slots, joins, (ids) => `sig:${ids.join(",")}`);
    expect(out.map((s) => [s.id, s.name, s.nodes, s.confidence, s.signature])).toEqual([
      ["h", "cards", ["h", "c"], "sure", "sig:h,c"],
      ["x", "extras", ["x"], "unsure", "sig-x"],
    ]);
    expect(out[0]?.ir).toEqual(["h", "h1", "c", "c1"]);
  });
});
