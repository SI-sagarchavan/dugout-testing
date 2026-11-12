/**
 * Behaviours, as the model settles them, made into the section's tree and plan (ADR 0038): the
 * machine on the root, the `when`s that draw each look in its state, what a press sends, the list's
 * search, and the boxes that scroll.
 *
 * Two ways in, one result. The common behaviours (toggles, show, restyle, search, scroll) are
 * named by layer and code writes their machine and `when`s. Anything else the model writes itself
 * as DSL (`machine`, and `props` on layers: what a press sends, when a part is drawn, its look per
 * state): the vocabulary is the DSL's, closed and checked, so a new kind of interaction needs no
 * code here (LOAD MORE: a request for more of the section's data source, and a `when` on the
 * button reading the data). PURE.
 */

import { z } from "zod";
import {
  childrenOf,
  clone,
  type Plan,
  type PlanCollapse,
  placeOf,
  placesIn,
  rootOf,
  subtree,
  type Tree,
  type TreeNode,
  withWhen,
} from "./tree.ts";

const NAME = /^[a-z][a-z0-9_]*$/;

export const Toggle = z.object({
  list: z
    .string()
    .regex(NAME)
    .describe("The list in state, named for what it holds: picked, favourite, following"),
  over: z.string().describe("The plan's list whose items it holds (ix.load's lists[].over)"),
  key: z.string().describe("The item field it holds, one value per item (ix.load's lists[].key)"),
  press: z
    .array(z.string())
    .min(1)
    .describe(
      "The layers a press on toggles it, by src: the card's template src for a press anywhere on the card, or parts (each look of a star). A layer only some cards have is put on every card",
    ),
  max: z.number().int().min(0).describe("At most this many items in it; 0 for no limit"),
  share: z.boolean().describe("Other sections of the page read it, as $page.<list>"),
  keep: z
    .enum(["page", "browser"])
    .describe("page: gone on reload. browser: kept in the fan's browser until they change it"),
});
export type Toggle = z.infer<typeof Toggle>;

export const Depends = z.object({
  lists: z.array(z.string().regex(NAME)).min(1).describe("Toggles' lists"),
  is: z
    .enum(["in", "out"])
    .describe("in: the item is in any of the lists. out: it is in none of them"),
});
export type Depends = z.infer<typeof Depends>;

export const Show = z.object({
  src: z
    .string()
    .describe("A layer from ix.load's differences: drawn only in this state (a tick when picked)"),
  when: Depends,
});

export const Restyle = z.object({
  src: z.string().describe("The template's layer (a difference's template src)"),
  look: z.string().describe("The layer, on another card, whose look it takes in this state"),
  when: Depends,
});

export const Search = z.object({
  field: z.string().describe("The page field typed in (ix.load's fields[].key)"),
  over: z.string().describe("The list it filters (lists[].over)"),
  path: z.string().describe("The item field searched (name)"),
});

export const Scroll = z.object({
  src: z.string().describe("The box (ix.load's overflow[].src)"),
  axis: z.enum(["y", "x"]),
});

export const PlanRuleDecision = z.object({
  src: z.string().describe("The layer the plan's rule is on (a conflict's src)"),
  prop: z.enum(["when", "at"]).describe("when: the plan's condition. at: its look by place"),
  decide: z
    .enum(["state", "both"])
    .describe(
      "state: the state decides the layer alone, and the plan's rule is taken off. both: the plan's rule holds as well (a when: drawn only when both hold; an at: the look by place stays)",
    ),
  why: z.string().max(300).optional().describe("A few words: what in the evidence settled it"),
});
export type PlanRuleDecision = z.infer<typeof PlanRuleDecision>;

/** The props the model may write on a layer itself: what drives and draws a behaviour. */
export const MODEL_PROPS = ["on", "when", "statesWhen", "follow"] as const;

export const NodeProp = z.object({
  src: z.string().describe("The layer, by src (as ix.load names it)"),
  prop: z
    .enum(MODEL_PROPS)
    .describe(
      "on: what a press (click, input, change, submit, outside, escape) sends the machine, { click: { send, payload?, to? } }. when: drawn only while it holds; it reads the data (photos.next), the state ($state.tags, $state.context.<f>, $state.active) and the page ($page.<key>). statesWhen: a look per state ({ disabled: <when> }). follow: a list drawing only the items a list in state holds",
    ),
  value: z.unknown().describe("The prop's value, as DSL JSON"),
});
export type NodeProp = z.infer<typeof NodeProp>;

export const Behaviours = z.object({
  toggles: z.array(Toggle).describe("Lists in state a press adds an item to or takes it out of"),
  show: z.array(Show).describe("Parts drawn only in one state; their other look is another part"),
  restyle: z.array(Restyle).describe("Parts whose look changes with the state"),
  search: z.array(Search),
  scroll: z.array(Scroll),
  planRules: z
    .array(PlanRuleDecision)
    .optional()
    .describe(
      "For each rule the binding plan has on a layer the state now decides (ix.load's lists[].planRules, ix.apply's conflicts): whether the state decides alone or both hold",
    ),
  machine: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The section's machine, written by you as DSL JSON (the machine skill): context, states, on, requests (a host action, or `source` for more of the section's data), computed, exports. It replaces the machine the section had; what toggles write is added to it. Left out: the section's own, if any",
    ),
  props: z
    .array(NodeProp)
    .optional()
    .describe(
      "Props you write on layers yourself, for what the machine does: on, when, statesWhen, follow. Each replaces that prop on that layer; they go in the plan, so the tree keeps no ref",
    ),
});
export type Behaviours = z.infer<typeof Behaviours>;

/** A rule the binding plan has on a layer a behaviour makes the state decide: the model's to settle. */
export interface PlanConflict {
  src: string;
  prop: "when" | "at";
  value: unknown;
  /** The state-decided part it is on, or inside. */
  part: string;
}

export interface Compiled {
  tree: Tree;
  plan: Plan;
  /** What changed, in words. */
  notes: string[];
  /** What could not be done; nothing is published while there are any. */
  problems: string[];
  /** The tree's ids of the parts each state draws, for the check. */
  managed: Array<{ id: string; src: string; role: string }>;
  /** Rules of the plan on parts the state now decides, each with what was decided, or not yet. */
  conflicts: Array<PlanConflict & { decided?: PlanRuleDecision["decide"] }>;
}

/** The props a look is made of; a text's words and a picture's binding stay the template's. */
const LOOK_PROPS = [
  "style",
  "tone",
  "textCase",
  "surface",
  "fill",
  "opacity",
  "border",
  "src",
  "alt",
  "fit",
  "name",
];

/**
 * `placed`: each layer's look by place (`at`) as the binding draws it, by src (the plan applied to
 * the stored tree), so a look by place on a part the state now decides is reported, not lost.
 */
export function compile(
  stored: Tree,
  given: Plan,
  b: Behaviours,
  placed: Map<string, unknown> = new Map(),
): Compiled {
  const tree = clone(stored);
  const plan: Plan = clone(given);
  plan.set ??= [];
  const notes: string[] = [];
  const problems: string[] = [];
  const managed: Compiled["managed"] = [];
  const conflicts: Compiled["conflicts"] = [];
  const root = rootOf(tree);
  if (!root) return { tree, plan, notes, problems: ["the tree has no root"], managed, conflicts };

  const collapseOf = (over: string): PlanCollapse | undefined =>
    plan.collapse?.find((c) => c.over === over);
  const kidsNow = () => childrenOf(tree);
  const bySrc = () => new Map(tree.nodes.map((n) => [n.src, n]));
  const ids = new Set(tree.nodes.map((n) => n.id));
  const freshId = (base: string) => {
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}_${i}`;
    ids.add(id);
    return id;
  };
  const templateOf = (c: PlanCollapse) => tree.nodes.find((n) => n.src === c.members[0]);
  const inTemplate = (c: PlanCollapse, src: string) => {
    const t = templateOf(c);
    return t ? subtree(tree, t.id, kidsNow()).some((n) => n.src === src) : false;
  };

  /** Room after `after` among its siblings, for a node put beside it. */
  const roomAfter = (after: TreeNode) => {
    for (const n of tree.nodes) if (n.parent === after.parent && n.idx > after.idx) n.idx += 1;
    return after.idx + 1;
  };

  /** A copy of a node and what is under it, under `parent` at `idx`. */
  const copyInto = (
    from: TreeNode,
    parent: string,
    idx: number,
    suffix: string,
    srcOf: (src: string) => string,
  ) => {
    const nodes = subtree(tree, from.id, kidsNow());
    const idMap = new Map<string, string>();
    for (const n of nodes) idMap.set(n.id, freshId(`${n.id}${suffix}`));
    const copies = nodes.map((n) => ({
      ...clone(n),
      id: idMap.get(n.id) as string,
      parent: n.id === from.id ? parent : (idMap.get(n.parent as string) as string),
      idx: n.id === from.id ? idx : n.idx,
      src: srcOf(n.src),
    }));
    tree.nodes.push(...copies);
    return copies[0] as TreeNode;
  };

  /**
   * The template's layer for `src`: itself, or a copy of a layer only another card has, put where
   * that card has it (beside the template's own layer there, when it has one).
   */
  const templateLayer = (c: PlanCollapse, src: string): TreeNode | undefined => {
    const all = bySrc();
    if (inTemplate(c, src)) return all.get(src);
    const copied = all.get(`ix:${src}`);
    if (copied) return copied;
    const kids = kidsNow();
    const at = placeOf(tree, src, c.members, kids);
    const template = templateOf(c);
    if (!at || !template) {
      problems.push(`${src} is not a layer of ${c.over}'s cards`);
      return undefined;
    }
    const places = placesIn(template, kids);
    const parentPath = at.path.split("/").slice(0, -1).join("/");
    const parent = places.get(parentPath);
    if (!parent) {
      problems.push(
        `${src} sits where ${c.over}'s template card has no layer (${parentPath || "/"})`,
      );
      return undefined;
    }
    const twin = places.get(at.path);
    const idx =
      twin && twin.parent === parent.id ? roomAfter(twin) : (kids.get(parent.id)?.length ?? 0);
    const copy = copyInto(at.node, parent.id, idx, "_ix", (s) => `ix:${s}`);
    notes.push(`${src} (on another card) is now on every card, as ${copy.id}`);
    return copy;
  };

  // --- the machine -----------------------------------------------------------------------------
  const machine = clone(
    (b.machine ?? (root.props.machine as Record<string, unknown> | undefined) ?? {}) as Record<
      string,
      unknown
    >,
  ) as {
    context?: Record<string, unknown>;
    computed?: Record<string, unknown>;
    exports?: Record<string, unknown>;
    on?: Record<string, unknown>;
    persist?: { storage: string; fields: string[] };
  };
  const toggles = new Map(b.toggles.map((t) => [t.list, t]));
  const v = (path: string) => ({ var: path });
  for (const t of b.toggles) {
    const c = collapseOf(t.over);
    if (!c) {
      problems.push(`toggle ${t.list}: the plan repeats no list ${t.over}`);
      continue;
    }
    machine.context = { ...(machine.context ?? {}), [t.list]: machine.context?.[t.list] ?? [] };
    const event = `${t.list}.toggle`;
    if (machine.on?.[event]) notes.push(`${event} was handled already; it now toggles ${t.list}`);
    const toggle = { assign: { [t.list]: { toggle: [v(`context.${t.list}`), v("event.id")] } } };
    machine.on = {
      ...(machine.on ?? {}),
      [event]:
        t.max > 0
          ? {
              guard: {
                or: [
                  { includes: [v(`context.${t.list}`), v("event.id")] },
                  { "<": [{ len: [v(`context.${t.list}`)] }, t.max] },
                ],
              },
              actions: [toggle],
            }
          : { actions: [toggle] },
    };
    if (t.share) machine.exports = { ...(machine.exports ?? {}), [t.list]: v(`context.${t.list}`) };
    if (t.keep === "browser") {
      const fields = [...new Set([...(machine.persist?.fields ?? []), t.list])];
      machine.persist = { storage: "local", fields };
    }
    // what a press sends: the item's key, read where the card is drawn
    for (const src of t.press) {
      const node = src === c.members[0] ? templateOf(c) : templateLayer(c, src);
      if (!node) continue;
      const on = { click: { send: event, payload: { id: `{${c.as}.${t.key}}` } } };
      const had = plan.set?.find((s) => s.src === node.src && s.prop === "on");
      if (had && JSON.stringify(had.value) !== JSON.stringify(on)) {
        problems.push(
          `${node.src} already sends ${JSON.stringify(had.value)}: one press sends one event`,
        );
        continue;
      }
      if (!had) plan.set?.push({ src: node.src, prop: "on", value: on });
      managed.push({ id: node.id, src: node.src, role: `press: ${event}` });
    }
    notes.push(
      `${t.list}: a list of ${t.over}'s ${t.key}s in the section's state, toggled by ${t.press.join(", ")}${t.max ? `, at most ${t.max}` : ""}${t.share ? ", shared with the page" : ""}${t.keep === "browser" ? ", kept in the browser" : ""}`,
    );
  }

  /** The condition an item's look is drawn in: its key in any, or none, of the lists. */
  const conditionOf = (c: PlanCollapse, d: Depends): Record<string, unknown> | undefined => {
    const missing = d.lists.filter((l) => !toggles.has(l));
    if (missing.length) {
      problems.push(`no toggle holds ${missing.join(", ")}: add it to toggles`);
      return undefined;
    }
    const keys = new Set(d.lists.map((l) => toggles.get(l)?.key));
    if (keys.size > 1) {
      problems.push(
        `${d.lists.join(", ")} hold different fields (${[...keys].join(", ")}): a look reads one`,
      );
      return undefined;
    }
    const key = `${c.as}.${[...keys][0]}`;
    let path: string;
    if (d.lists.length === 1) path = `$state.context.${d.lists[0]}`;
    else {
      const name = [...d.lists].sort().join("_or_");
      machine.computed = {
        ...(machine.computed ?? {}),
        [name]: { uniq: [{ concat: [...d.lists].sort().map((l) => v(`context.${l}`)) }] },
      };
      path = `$state.computed.${name}`;
    }
    return d.is === "in" ? { path, hasPath: key } : { path, lacksPath: key };
  };
  const flip = (d: Depends): Depends => ({ ...d, is: d.is === "in" ? "out" : "in" });

  // --- parts drawn in one state ------------------------------------------------------------------
  const overOfToggle = (d: Depends) => toggles.get(d.lists[0] as string)?.over;
  for (const s of b.show) {
    const over = overOfToggle(s.when);
    const c = over ? collapseOf(over) : undefined;
    if (!c) {
      problems.push(`${s.src}: its when names no toggle`);
      continue;
    }
    const node = templateLayer(c, s.src);
    const cond = conditionOf(c, s.when);
    if (!node || !cond) continue;
    node.props.when = withWhen(node.props.when, cond);
    managed.push({
      id: node.id,
      src: node.src,
      role: `shown when ${s.when.is} ${s.when.lists.join("|")}`,
    });
  }

  // --- looks that change with the state --------------------------------------------------------------
  for (const r of b.restyle) {
    const over = overOfToggle(r.when);
    const c = over ? collapseOf(over) : undefined;
    if (!c) {
      problems.push(`${r.src}: its when names no toggle`);
      continue;
    }
    if (!inTemplate(c, r.src)) {
      problems.push(
        `${r.src} is not a layer of ${c.over}'s template card: restyle the template's layer`,
      );
      continue;
    }
    const all = bySrc();
    const orig = all.get(r.src) as TreeNode;
    const look = all.get(r.look);
    if (!look) {
      problems.push(`${r.look} is not a layer of the tree`);
      continue;
    }
    const onCond = conditionOf(c, r.when);
    const offCond = conditionOf(c, flip(r.when));
    if (!onCond || !offCond) continue;
    const dup = copyInto(
      orig,
      orig.parent as string,
      roomAfter(orig),
      "_state",
      (s) => `ix:state:${s}`,
    );
    for (const k of LOOK_PROPS) {
      if (k === "src" && orig.type !== "Image") continue;
      if (look.props[k] !== undefined) dup.props[k] = clone(look.props[k]);
    }
    dup.props.when = withWhen(dup.props.when, onCond);
    orig.props.when = withWhen(orig.props.when, offCond);
    // the copy shows what the template's layer is bound to
    for (const f of c.fields?.filter((f) => f.src === orig.src) ?? [])
      c.fields?.push({ ...f, src: dup.src });
    for (const s of plan.set?.filter(
      (s) => s.src === orig.src && s.prop !== "when" && s.prop !== "at" && s.prop !== "on",
    ) ?? []) {
      plan.set?.push({ ...s, src: dup.src });
    }
    managed.push({
      id: orig.id,
      src: orig.src,
      role: `look when ${flip(r.when).is} ${r.when.lists.join("|")}`,
    });
    managed.push({
      id: dup.id,
      src: dup.src,
      role: `look when ${r.when.is} ${r.when.lists.join("|")} (from ${r.look})`,
    });
    notes.push(
      `${orig.id} takes ${r.look}'s look when the item is ${r.when.is === "in" ? "in" : "in none of"} ${r.when.lists.join(" or ")}`,
    );
  }

  // --- what the plan already decides about them: reported, and settled by the model ------------------
  // A `when` the plan set on a managed part, or on a layer of the card around it, and a look by place
  // on a managed part, were the binding's reading of the same cards. The state decides those parts
  // now; whether the plan's rule goes or holds as well is the model's (planRules), never code's.
  const parentOf = new Map(tree.nodes.map((n) => [n.id, n.parent]));
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const guarded = new Map<string, string>();
  for (const m of managed) {
    for (let at: string | null | undefined = m.id; at; at = parentOf.get(at)) {
      const node = byId.get(at);
      if (!node) break;
      if (!guarded.has(node.src)) guarded.set(node.src, m.src);
      if (b.toggles.some((t) => collapseOf(t.over)?.members[0] === node.src)) break;
    }
  }
  const decisionOf = (src: string, prop: "when" | "at") =>
    b.planRules?.find((d) => d.src === src && d.prop === prop);
  const states = (src: string) =>
    tree.nodes.filter((n) => n.src === src || n.src === `ix:state:${src}`);
  for (const rule of plan.set?.filter((s) => s.prop === "when" && guarded.has(s.src)) ?? []) {
    const d = decisionOf(rule.src, "when");
    const part = guarded.get(rule.src) as string;
    conflicts.push({
      src: rule.src,
      prop: "when",
      value: rule.value,
      part,
      ...(d ? { decided: d.decide } : {}),
    });
    if (!d) continue;
    plan.set = plan.set?.filter((s) => s !== rule);
    if (d.decide === "state") {
      notes.push(
        `took off the plan's when on ${rule.src} (${JSON.stringify(rule.value)}): the state decides it${d.why ? ` (${d.why})` : ""}`,
      );
      continue;
    }
    // both hold: the plan's `when` replaces a node's own when it is drawn, so the state's goes with it
    for (const n of states(rule.src)) {
      plan.set?.push({
        src: n.src,
        prop: "when",
        value:
          n.props.when === undefined
            ? clone(rule.value)
            : withWhen(clone(rule.value), n.props.when as Record<string, unknown>),
      });
    }
    notes.push(
      `kept the plan's when on ${rule.src} (${JSON.stringify(rule.value)}) with the state's: drawn only when both hold${d.why ? ` (${d.why})` : ""}`,
    );
  }
  for (const src of new Set(managed.map((m) => m.src))) {
    // a layer code copied in is code's own: the binding never read it, so no look by place is its
    if (src.startsWith("ix:")) {
      const original = src.replace(/^ix:(state:)?/, "");
      const kept = src.startsWith("ix:state:") && decisionOf(original, "at")?.decide === "both";
      plan.set = (plan.set ?? []).filter((s) => !(s.src === src && s.prop === "at"));
      plan.set.push({ src, prop: "at", value: kept ? clone(placed.get(original) ?? {}) : {} });
      continue;
    }
    const value = plan.set?.find((s) => s.src === src && s.prop === "at")?.value ?? placed.get(src);
    if (
      value === undefined ||
      (typeof value === "object" && value !== null && Object.keys(value).length === 0)
    )
      continue;
    const d = decisionOf(src, "at");
    conflicts.push({ src, prop: "at", value, part: src, ...(d ? { decided: d.decide } : {}) });
    if (!d || d.decide === "both") continue;
    plan.set = (plan.set ?? []).filter((s) => !(s.src === src && s.prop === "at"));
    plan.set.push({ src, prop: "at", value: {} });
    notes.push(
      `took off the binding's look by place on ${src} (${JSON.stringify(value)}): the state decides it${d.why ? ` (${d.why})` : ""}`,
    );
  }
  const open = conflicts.filter((c) => !c.decided);
  if (open.length) {
    problems.push(
      ...open.map(
        (c) =>
          `the binding plan has ${c.prop === "when" ? `a when on ${c.src}` : `a look by place on ${c.src}`} (${JSON.stringify(c.value)})${c.src === c.part ? "" : `, around ${c.part}`}, which the state now decides: say in planRules whether the state decides alone (state) or both hold (both)`,
      ),
    );
  }

  // --- search ------------------------------------------------------------------------------------------
  const fields = new Set(
    tree.nodes.filter((n) => n.type === "Input").map((n) => String(n.props.key ?? "")),
  );
  for (const s of b.search) {
    const c = collapseOf(s.over);
    if (!c) {
      problems.push(`search: the plan repeats no list ${s.over}`);
      continue;
    }
    if (!fields.has(s.field)) {
      problems.push(
        `search: no field writes ${s.field} (the fields: ${[...fields].join(", ") || "none"})`,
      );
      continue;
    }
    c.when = withWhen(c.when, { path: `${c.as}.${s.path}`, containsPath: `_page.${s.field}` });
    notes.push(`${s.over} shows the items whose ${s.path} has what is typed in ${s.field}`);
  }

  // --- scroll ----------------------------------------------------------------------------------------------
  for (const s of b.scroll) {
    const node = bySrc().get(s.src);
    if (!node) {
      problems.push(`scroll: ${s.src} is not a layer of the tree`);
      continue;
    }
    if (node.type !== "Stack") {
      problems.push(`scroll: ${s.src} is a ${node.type}; only a Stack scrolls`);
      continue;
    }
    node.props.scroll = s.axis;
    notes.push(`${node.id} scrolls on ${s.axis} instead of cutting what is past it`);
  }

  // --- what the model wrote itself ---------------------------------------------------------------------
  if (b.machine) notes.push("the section's machine is the one written for it");
  const layers = bySrc();
  for (const p of b.props ?? []) {
    if (!layers.has(p.src)) {
      problems.push(`${p.prop} on ${p.src}: no layer of the tree has that src`);
      continue;
    }
    const had = plan.set?.find((s) => s.src === p.src && s.prop === p.prop);
    if (had) notes.push(`${p.prop} on ${p.src} replaces the plan's (${JSON.stringify(had.value)})`);
    plan.set = (plan.set ?? []).filter((s) => !(s.src === p.src && s.prop === p.prop));
    plan.set.push({ src: p.src, prop: p.prop, value: clone(p.value) });
    notes.push(`${p.prop} on ${p.src}: ${JSON.stringify(p.value)}`);
  }

  if (b.toggles.length || b.machine) root.props.machine = machine;
  return { tree, plan, notes, problems, managed, conflicts };
}

/** A tree whose own props hold `{refs}` is drawn without its plan by SCRE: keep refs in the plan. */
export function refsInTree(tree: Tree): string[] {
  const REF = /\{\s*[$A-Za-z_][A-Za-z0-9_.]*/;
  return tree.nodes.filter((n) => REF.test(JSON.stringify(n.props))).map((n) => n.id);
}
