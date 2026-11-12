/**
 * Page state: the choice a toggle writes, and a `when` in any section that reads it.
 */

import { describe, expect, it } from "vitest";
import { evaluateWhen } from "../src/binding.js";
import { checkBindings } from "../src/contract.js";
import type { FlatTree } from "../src/flat.js";
import {
  pageChoices,
  pageDefaults,
  pageFields,
  pageKeyOf,
  pageReads,
  pageScope,
  pageValueOf,
  splitPageWhen,
} from "../src/page.js";
import { issuesByCode, validate } from "../src/validate.js";
import { registry } from "./helpers.js";

/** The squad header's toggle: WOMEN | MEN, MEN drawn selected. */
function toggle(): FlatTree {
  return {
    schemaVersion: "1",
    nodes: [
      { id: "bar", parent: null, idx: 0, type: "Stack", src: "1:1", props: { direction: "row" } },
      { id: "women", parent: "bar", idx: 0, type: "Stack", src: "1:2", props: { select: { key: "women_men", value: "women" } } },
      { id: "women_label", parent: "women", idx: 0, type: "Text", src: "1:3", props: { content: "WOMEN", style: "type.body_sm_bold" } },
      { id: "men", parent: "bar", idx: 1, type: "Stack", src: "1:4", props: { select: { key: "women_men", value: "men", initial: true } } },
      { id: "men_label", parent: "men", idx: 0, type: "Text", src: "1:5", props: { content: "MEN", style: "type.body_sm_bold" } },
    ],
  } as unknown as FlatTree;
}

describe("the choices a tree writes", () => {
  it("lists each choice with its options' labels and where it starts", () => {
    expect(pageChoices(toggle())).toEqual([
      {
        key: "women_men",
        initial: "men",
        options: [
          { value: "women", label: "WOMEN", node: "women" },
          { value: "men", label: "MEN", node: "men" },
        ],
      },
    ]);
  });

  it("starts at the first option when none is marked", () => {
    const tree = toggle();
    delete (tree.nodes[3]!.props as { select: { initial?: boolean } }).select.initial;
    expect(pageDefaults([tree])).toEqual({ women_men: "women" });
  });

  it("names a choice nobody named from its labels", () => {
    expect(pageKeyOf(["WOMEN", "MEN"])).toBe("women_men");
    expect(pageValueOf("Men's T20")).toBe("mens_t20");
    expect(pageKeyOf(["1st XI", "2nd XI"])).toBe("choice_1st_xi_2nd_xi");
  });
});

describe("a when that reads the page", () => {
  it("compares an item with the page's choice", () => {
    const when = { path: "item.team", eqPath: "_page.women_men" };
    expect(evaluateWhen(when, { item: { team: "men" }, ...pageScope({ women_men: "men" }) })).toBe(true);
    expect(evaluateWhen(when, { item: { team: "women" }, ...pageScope({ women_men: "men" }) })).toBe(false);
    // nothing chosen is equal to nothing
    expect(evaluateWhen(when, { item: {} })).toBe(false);
  });

  it("is split so the browser needs only the page state", () => {
    const split = splitPageWhen(
      [{ path: "item.photo", exists: true }, { path: "item.team", eqPath: "_page.women_men" }],
      { item: { team: "women", photo: "x.png" } },
    );
    expect(split.now).toEqual([{ path: "item.photo", exists: true }]);
    expect(split.page).toEqual([{ path: "_page.women_men", eq: "women" }]);
    expect(splitPageWhen({ path: "item.photo", exists: true }, {}).page).toEqual([]);
  });

  it("searches an item's text for what is typed, ignoring case; nothing typed lets every item through", () => {
    const when = { path: "p.name", containsPath: "_page.search" };
    const ben = { p: { name: "Ben McKinney" } };
    expect(evaluateWhen(when, { ...ben, ...pageScope({ search: "mck" }) })).toBe(true);
    expect(evaluateWhen(when, { ...ben, ...pageScope({ search: "  BEN " }) })).toBe(true);
    expect(evaluateWhen(when, { ...ben, ...pageScope({ search: "rew" }) })).toBe(false);
    expect(evaluateWhen(when, { ...ben, ...pageScope({ search: "" }) })).toBe(true);
    expect(evaluateWhen(when, ben)).toBe(true);
    // the server reads the item's text; the browser compares what is typed with it
    const split = splitPageWhen([{ path: "p.squad", eqPath: "_page.women_men" }, when], { p: { name: "Ben McKinney", squad: "men" } });
    expect(split.page).toEqual([
      { path: "_page.women_men", eq: "men" },
      { path: "_page.search", within: "Ben McKinney" },
    ]);
    expect(evaluateWhen(split.page, pageScope({ women_men: "men", search: "ben" }))).toBe(true);
    expect(evaluateWhen(split.page, pageScope({ women_men: "men", search: "thomas" }))).toBe(false);
  });

  it("is listed among the keys a tree reads", () => {
    const strip = {
      schemaVersion: "1",
      nodes: [{ id: "row", parent: null, idx: 0, type: "Stack", src: "2:1", props: { when: { path: "_page.women_men", eq: "men" } } }],
    } as unknown as FlatTree;
    expect(pageReads(strip)).toEqual(["women_men"]);
  });

  it("is never looked for in the data, which is another section's to write", () => {
    const strip = {
      schemaVersion: "1",
      nodes: [
        { id: "row", parent: null, idx: 0, type: "Stack", src: "2:1", props: { when: { path: "_page.women_men", eq: "men" } } },
        { id: "list", parent: "row", idx: 0, type: "Repeater", src: "synthetic:2:1:1", props: { over: "squad.items", as: "item" } },
        {
          id: "card",
          parent: "list",
          idx: 0,
          type: "Stack",
          src: "2:2",
          props: { when: { path: "item.team", eqPath: "_page.women_men" } },
        },
      ],
    } as unknown as FlatTree;
    expect(checkBindings(strip, { squad: { items: [{ team: "men" }] } })).toEqual([]);
    expect(issuesByCode({ errors: checkBindings(strip, { squad: { items: [{ name: "x" }] } }), warnings: [] } as never, "B1")).toHaveLength(1);
  });
});

describe("S17", () => {
  const check = (tree: FlatTree) => validate(tree, { registry: registry() });

  it("passes a toggle", () => {
    expect(issuesByCode(check(toggle()), "S17")).toEqual([]);
  });

  it("refuses two options that set one value, and two starts", () => {
    const tree = toggle();
    tree.nodes[1]!.props = { select: { key: "women_men", value: "men", initial: true } };
    const codes = issuesByCode(check(tree), "S17").map((i) => i.path);
    expect(codes).toContain("select.value");
    expect(codes).toContain("select.initial");
  });

  it("refuses a key that is not one name", () => {
    const tree = toggle();
    tree.nodes[1]!.props = { select: { key: "women.men", value: "women" } };
    expect(issuesByCode(check(tree), "S17").map((i) => i.path)).toContain("select.key");
  });
});

describe("values on the page", () => {
  it("compare as a feed and a design write them: Women is women, Men's is mens", () => {
    const scope = { item: { team: "Women" }, ...pageScope({ squad: "women" }) };
    expect(evaluateWhen({ path: "item.team", eqPath: "_page.squad" }, scope)).toBe(true);
    expect(evaluateWhen({ path: "_page.squad", eq: "WOMEN" }, scope)).toBe(true);
    expect(evaluateWhen({ path: "_page.squad", eq: "men" }, scope)).toBe(false);
    // data compared with data stays exact
    expect(evaluateWhen({ path: "item.team", eq: "women" }, scope)).toBe(false);
  });
});

/** The newsletter's form: an email field and a consent box, and a note shown once it is ticked. */
function form(): FlatTree {
  return {
    schemaVersion: "1",
    nodes: [
      { id: "form", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
      { id: "email", parent: "form", idx: 0, type: "Input", src: "1:2", props: { key: "email", kind: "email", placeholder: "Your Email Address", style: "type.body_sm_regular" } },
      { id: "consent", parent: "form", idx: 1, type: "Checkbox", src: "1:3", props: { key: "consent", label: "I'd like to hear from Southern Brave" } },
      { id: "thanks", parent: "form", idx: 2, type: "Text", src: "1:4", props: { content: "Thanks", style: "type.body_sm_bold", when: { path: "_page.consent", eq: true } } },
    ],
  } as unknown as FlatTree;
}

describe("the fields a tree has", () => {
  it("lists each field's key and where it starts", () => {
    expect(pageFields(form())).toEqual([
      { key: "email", type: "Input", node: "email", initial: "" },
      { key: "consent", type: "Checkbox", node: "consent", initial: "false" },
    ]);
  });

  it("starts the page at a field's value and a box's tick", () => {
    const tree = form();
    tree.nodes[1]!.props = { ...tree.nodes[1]!.props, value: "a@b.co" };
    tree.nodes[2]!.props = { ...tree.nodes[2]!.props, checked: true };
    expect(pageDefaults([tree])).toEqual({ email: "a@b.co", consent: "true" });
  });

  it("is read in a when as a choice is", () => {
    const thanks = form().nodes[3]!.props.when;
    expect(evaluateWhen(thanks, pageScope({ consent: "true" }))).toBe(true);
    expect(evaluateWhen(thanks, pageScope({ consent: "false" }))).toBe(false);
  });

  it("validates, and refuses a key that is not one name or is written twice", () => {
    const check = (tree: FlatTree) => validate(tree, { registry: registry() });
    expect(check(form()).errors).toEqual([]);
    const bad = form();
    bad.nodes[2]!.props = { ...bad.nodes[2]!.props, key: "email" };
    expect(issuesByCode(check(bad), "S17").map((i) => i.path)).toEqual(["key"]);
    const dotted = form();
    dotted.nodes[1]!.props = { ...dotted.nodes[1]!.props, key: "e.mail" };
    expect(issuesByCode(check(dotted), "S17").map((i) => i.path)).toEqual(["key"]);
  });
});
