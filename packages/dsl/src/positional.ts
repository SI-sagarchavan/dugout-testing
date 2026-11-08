/**
 * Looks by place in a list: the rule on every item but the last, the stripe on every other one.
 *
 * A design draws a list as its items, and an item's look may depend on where it sits: a row's
 * bottom rule stops at the last row, a stat's end rule stops at the last stat, a first card has
 * no leading space, odd rows are tinted. Folding the items into one template keeps the template's
 * look on every item, so the last row grows a rule the design never drew, or every row loses it.
 *
 * A node says such looks with `at` (see `universal.ts`): props written over its own at a place in
 * the nearest Repeater's items. `positionalLooks` reads them off the design's items before they
 * are folded; `propsAtPlace` is what a renderer draws. A place is the item's index in what the
 * Repeater draws, so the rule holds however many items the data has.
 *
 * PURE. No filesystem, no process, no clock.
 */

import { childrenOf, type FlatNode, type FlatTree } from "./flat.js";
import { stableJson } from "./subtree-signature.js";

/** Where an item sits among those its Repeater draws. */
export interface ItemPlace {
  index: number;
  count: number;
}

/** The places `at` names, in the order they are applied: a later one wins. */
export const PLACES = ["even", "odd", "middle", "first", "last"] as const;
export type Place = (typeof PLACES)[number];

/** Props written over a node's own at one place. `null` removes one; `hidden: true` draws nothing. */
export type PlaceLook = Record<string, unknown>;
export type AtPlaces = Partial<Record<Place, PlaceLook>>;

/** Which places an item is in. The first item is even. */
export function placesOf({ index, count }: ItemPlace): Place[] {
  const first = index === 0;
  const last = index === count - 1;
  return PLACES.filter((place) => {
    switch (place) {
      case "even":
        return index % 2 === 0;
      case "odd":
        return index % 2 === 1;
      case "middle":
        return !first && !last;
      case "first":
        return first;
      case "last":
        return last;
    }
  });
}

/**
 * A node's props at its item's place, or undefined when it is hidden there. Without a place (not
 * in a Repeater) or without `at`, its own props, as they are.
 */
export function propsAtPlace(
  props: Record<string, unknown>,
  place: ItemPlace | undefined,
): Record<string, unknown> | undefined {
  const at = props.at as AtPlaces | undefined;
  if (!at || typeof at !== "object" || !place) return props;
  let out: Record<string, unknown> | undefined;
  let hidden = false;
  for (const p of placesOf(place)) {
    const look = at[p];
    if (!look || typeof look !== "object") continue;
    out ??= { ...props };
    for (const [key, value] of Object.entries(look)) {
      if (key === "hidden") hidden = value === true;
      else if (value === null) delete out[key];
      else out[key] = value;
    }
  }
  return hidden ? undefined : (out ?? props);
}

/**
 * What a node's look is not: what it says (the data), its box and where it sits (text widths
 * differ item to item), and what the tree keeps about it. Everything else is a look.
 */
const NOT_LOOK = new Set([
  "content",
  "alt",
  "src",
  "href",
  "label",
  "testId",
  "size",
  "place",
  "_meta",
  "when",
  "at",
  "controlFor",
  "clock",
  "semantics",
  "platform",
]);

const MISSING = "∅";

function lookOf(node: FlatNode): PlaceLook {
  return Object.fromEntries(Object.entries(node.props).filter(([key]) => !NOT_LOOK.has(key)));
}

/**
 * Every node under `rootId`, by where it sits: the path of each type and its count among siblings
 * of that type. Instances of one component line up by it, and a node one item lacks (the last
 * row's rule) leaves the others' keys as they are.
 */
function byPath(tree: FlatTree, rootId: string): Map<string, FlatNode> {
  const out = new Map<string, FlatNode>();
  const walk = (id: string, key: string) => {
    const node = tree.nodes.find((n) => n.id === id);
    if (!node) return;
    out.set(key, node);
    const seen = new Map<string, number>();
    for (const child of childrenOf(tree, id)) {
      const n = seen.get(child.type) ?? 0;
      seen.set(child.type, n + 1);
      walk(child.id, `${key}/${child.type}#${n}`);
    }
  };
  walk(rootId, "");
  return out;
}

/** What turns `base` into `other`: the props that differ, `null` for one `other` lacks. */
function difference(base: PlaceLook, other: PlaceLook | typeof MISSING): PlaceLook {
  if (other === MISSING) return { hidden: true };
  const out: PlaceLook = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(other)])) {
    if (stableJson(base[key]) === stableJson(other[key])) continue;
    out[key] = key in other ? other[key] : null;
  }
  return out;
}

/** What folding needs to keep each item's looks: the `at` of each template node, and nodes to adopt. */
export interface PositionalLooks {
  /** The `at` each node needs, by node id: the template's, and those adopted into it. */
  looks: Map<string, AtPlaces>;
  /**
   * Nodes some items have and the template lacks (a rule before every item but the first, when
   * the first is the template), to move into the template before the others are folded away:
   * each under the template's node at the same place, at `idx`. Their `at` hides them where the
   * design has none.
   */
  adopt: Array<{ id: string; parent: string; idx: number }>;
}

/**
 * The looks each node of the template needs by place, read off the items the design drew, before
 * they are folded: `memberIds` are the items, `templateId` the one that stays.
 *
 * A look counts as by place only when the items show a rule a place can say: every other item
 * alike (a stripe), or every item between the ends alike, with the first, the last or both drawn
 * otherwise (a rule that stops at the last row, a first card without its leading space). Three
 * items at least: two cannot tell which. Anything else is not said by place and is left as the
 * template draws it. A node with `states` is left too: its looks change with what a person does
 * (the active tab, the slide on show), never with where it sits.
 */
export function positionalLooks(
  tree: FlatTree,
  memberIds: readonly string[],
  templateId: string,
): PositionalLooks {
  const out: PositionalLooks = { looks: new Map(), adopt: [] };
  const members = memberIds
    .map((id) => tree.nodes.find((n) => n.id === id))
    .filter((n): n is FlatNode => n !== undefined)
    .sort((a, b) => a.idx - b.idx);
  const n = members.length;
  const t = members.findIndex((m) => m.id === templateId);
  if (n < 3 || t < 0) return out;

  const paths = members.map((m) => byPath(tree, m.id));
  const template = paths[t];
  if (!template) return out;
  // every place a node sits in any item, parents before children
  const keys = [...new Set(paths.flatMap((p) => [...p.keys()]))].sort(
    (a, b) => a.split("/").length - b.split("/").length,
  );
  /** Keys under an adopted node: they move with it, and are not read on their own. */
  const carried = new Set<string>();

  for (const key of keys) {
    if ([...carried].some((c) => key.startsWith(`${c}/`))) continue;
    let node = template.get(key);
    let adopted = false;
    if (!node) {
      const parentKey = key.slice(0, key.lastIndexOf("/"));
      const parent = template.get(parentKey);
      const source = paths.map((p) => p.get(key)).find((x) => x !== undefined);
      if (!parent || !source) continue;
      node = source;
      adopted = true;
      carried.add(key);
      out.adopt.push({ id: source.id, parent: parent.id, idx: source.idx });
    }
    if (node.props.states !== undefined) continue;
    const looks = paths.map((p) => {
      const at = p.get(key);
      return at ? lookOf(at) : MISSING;
    });
    const sigs = looks.map((l) => (l === MISSING ? MISSING : stableJson(l)));
    if (!adopted && sigs.every((s) => s === sigs[0])) continue;
    const base = lookOf(node);
    const baseSig = stableJson(base);
    const at: AtPlaces = {};
    const put = (place: Place, i: number) => {
      const look = looks[i];
      if (look === undefined || sigs[i] === baseSig) return;
      at[place] = difference(base, look);
    };
    const alike = (from: number, step: number) => {
      const seen = sigs.filter((_, i) => i >= from && (i - from) % step === 0);
      return seen.every((s) => s === seen[0]);
    };

    if (alike(0, 2) && alike(1, 2) && sigs[0] !== sigs[1]) {
      put("even", 0);
      put("odd", 1);
    } else if (sigs.slice(1, n - 1).every((s) => s === sigs[1])) {
      put("first", 0);
      put("middle", 1);
      put("last", n - 1);
    } else {
      // no place says it: an adopted node stays where it was, to be folded away with its item
      if (adopted) {
        out.adopt.pop();
        carried.delete(key);
      }
      continue;
    }
    if (Object.keys(at).length > 0) out.looks.set(node.id, at);
  }
  return out;
}
