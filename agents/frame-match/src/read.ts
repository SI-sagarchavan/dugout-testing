/**
 * Reading the frame: what experience the design is meant to give, before anything is decided.
 *
 * A Figma frame is one still. A person sees at once that a hero with two arrows, a "01" and a thin
 * bar is a carousel of stories, even though it draws only the one on show; code counting matching
 * siblings sees one slide and says nothing. So the first thing a run does is look: a vision model
 * reads the design with an outline of its layers, and says what the frame is for, what each part
 * of it does, and how each container behaves (a carousel, tabs, a list, a grid, a fixed row).
 *
 * The model's eyes decide WHAT; the IR decides WHERE and checks it. The model names layers only by
 * the outline's handles, so every claim lands on real layers, and code checks each one against the
 * IR: the items of a carousel are siblings, its one slide is a run of layers in one container, an
 * arrow is a small thing, a counter is a text with a number. A claim the IR does not bear out is
 * left out of the proposal and reported, on the container it was about, with the values that failed
 * the check. Nothing here is applied: each container is a proposal the agent settles from memory,
 * from the evidence, or by asking a person. What the IR detector (`detectLayout`) sees is evidence
 * for the reading, never a verdict of its own.
 */

import { z } from "zod";
import type { Bundle } from "./frame.ts";
import type { Confidence, LayoutChoice, LayoutChrome, LayoutIntent, LayoutKind } from "./layout.ts";
import { composeDesign, resizeTo } from "./look.ts";
import type { IrNode, PngImage, Toolchain } from "./toolchain.ts";

/** The longest side the vision model reads well. */
const MAX_SIDE = 1568;
/** A subtree with no text this small is a picture (an icon, a crest): one line, not its vectors. */
const ART_PX = 96 * 96;
/** The outline stops here; past it deeper layers are left out first. */
const MAX_LINES = 180;
/** An arrow a person presses, not a panel. */
const MAX_ARROW_PX = 96;
/** A progress bar is a thin line. */
const MAX_BAR_PX = 8;
/** At or above this, a reading the IR bears out is proposed as `certain`: a label for the agent, never applied by code. */
export const SURE = 0.75;

// --- the outline -----------------------------------------------------------------------------

export interface Outline {
  /** One line per layer, each starting with its handle. */
  lines: string[];
  /** Handle → Figma id. */
  ids: Map<string, string>;
  /** The frame's size in px: what the boxes are in. */
  frame: { w: number; h: number };
  /** The layer the outline starts from. */
  root: IrNode;
}

const hasText = (n: IrNode): boolean => n.type === "TEXT" || (n.children ?? []).some(hasText);
const textOf = (n: IrNode): string | undefined => {
  const t = (n.text as { characters?: unknown } | undefined)?.characters;
  return typeof t === "string" ? t.replace(/\s+/g, " ").trim() : undefined;
};
const area = (n: IrNode) => n.geometry.bbox.w * n.geometry.bbox.h;

/** Looks through a lone child that covers its parent: a section is often one frame in another. */
export function startOf(root: IrNode): IrNode {
  let node = root;
  for (;;) {
    const only = node.children?.length === 1 ? node.children[0] : undefined;
    if (!only?.children?.length) return node;
    if (area(only) < area(node) * 0.9) return node;
    node = only;
  }
}

/**
 * The frame's layers as the vision model reads them: a handle, the type, the name, the box in the
 * frame's pixels and the text. A picture (a subtree with no text, small) is one line; its vectors
 * are left out. Breadth first, so a frame too big for the outline loses its deepest layers.
 */
export function outlineOf(doc: { root: IrNode }): Outline {
  const root = startOf(doc.root);
  const origin = root.geometry.bbox;
  const ids = new Map<string, string>();
  const rows: Array<{ depth: number; order: number; line: string }> = [];
  let order = 0;
  const queue: Array<{ node: IrNode; depth: number }> = (root.children ?? []).map((node) => ({
    node,
    depth: 0,
  }));
  let n = 0;
  while (queue.length > 0 && rows.length < MAX_LINES) {
    const { node, depth } = queue.shift() as { node: IrNode; depth: number };
    const b = node.geometry.bbox;
    if (b.w < 1 && b.h < 1) continue;
    const handle = `h${++n}`;
    ids.set(handle, node.id);
    const art = !hasText(node) && area(node) <= ART_PX && (node.children?.length ?? 0) > 0;
    const text = textOf(node);
    const box = `[${Math.round(b.x - origin.x)},${Math.round(b.y - origin.y)} ${Math.round(b.w)}x${Math.round(b.h)}]`;
    const line = `${"  ".repeat(depth)}${handle} ${node.type} "${node.name.slice(0, 40)}" ${box}${
      text ? ` "${text.slice(0, 80)}"` : ""
    }${art ? " (picture)" : ""}`;
    rows.push({ depth, order: order++, line });
    if (art || node.type === "TEXT") continue;
    for (const child of node.children ?? []) queue.push({ node: child, depth: depth + 1 });
  }
  // read top to bottom as a tree: each layer under its parent
  const parentOf = new Map<string, string>();
  const walk = (node: IrNode) => {
    for (const c of node.children ?? []) {
      parentOf.set(c.id, node.id);
      walk(c);
    }
  };
  walk(root);
  const handleOf = new Map([...ids].map(([h, id]) => [id, h]));
  const byHandle = new Map(rows.map((r) => [r.line.trim().split(" ")[0] as string, r]));
  const out: string[] = [];
  const emit = (node: IrNode) => {
    for (const c of node.children ?? []) {
      const h = handleOf.get(c.id);
      if (h) out.push((byHandle.get(h) as { line: string }).line);
      emit(c);
    }
  };
  emit(root);
  return { lines: out, ids, frame: { w: Math.round(origin.w), h: Math.round(origin.h) }, root };
}

// --- what the model is asked ------------------------------------------------------------------

export function readPrompt(outline: Outline): string {
  return [
    "You are reading a designer's frame: one still picture of a section of a website.",
    `The picture is the design, ${outline.frame.w} x ${outline.frame.h} px, scaled to fit. Below it is the outline of its layers: each line is a handle (h1, h2 ...), the layer's type and name, its box [x,y wxh] in the frame's px, and its text. Indentation is nesting.`,
    "",
    "Say what experience this section is meant to give a fan on the live site, and how each part behaves beyond the one moment the picture shows. A still cannot move, so look for what gives the behaviour away:",
    "- a carousel: content that moves, given away by previous/next arrows, a row of dots, a counter such as 01 or 1/5, a progress bar, or cards cut off at an edge. It may draw several slides side by side (items), or only the one on show (slide: the layers that together are that one slide, its background photo and shade included when they change with it). Arrows, dots, the counter and the bar are its controls, not its slide.",
    "- tabs or a toggle: labels side by side where one is drawn selected, each showing other content.",
    "- a list (a column that grows with the data), a grid, a fixed row (a short set that never moves).",
    "- parts that sit over the others and do not move with them.",
    "",
    "Reply with JSON only:",
    '{"experience":"one or two sentences: what this section is for and how a fan uses it",',
    ' "parts":[{"what":"what it is","role":"slide|items|control|card|heading|background|decoration|other","nodes":["h3"]}],',
    ' "layouts":[{"kind":"carousel|tabs|list|grid|row","container":"h1","items":["h4","h5"],"slide":["h2","h6"],"controls":{"prev":"h7","next":"h8","pagination":"h9","counter":"h10","progress":"h11"},"selected":"h4","shows":"what each item or slide shows","sure":0.0,"why":"what in the picture says so"}],',
    ' "unsure":["what the picture cannot settle about how it behaves, as a question"]}',
    "",
    "Rules: name layers only by their handles. items are siblings, the repeated cards or tabs, in order. Use slide only when the design draws one slide of a carousel. Give each control you see. sure is how certain you are of the kind, 0 to 1. Leave out what you do not see; do not list a row for every group of layers, only containers whose behaviour matters.",
    "",
    ...outline.lines,
  ].join("\n");
}

// --- what the model answers -------------------------------------------------------------------

const Handle = z.string();
const RawLayout = z.object({
  kind: z.enum(["carousel", "tabs", "list", "grid", "row"]),
  container: Handle.optional(),
  items: z.array(Handle).optional(),
  slide: z.array(Handle).optional(),
  controls: z
    .object({
      prev: Handle.optional(),
      next: Handle.optional(),
      pagination: Handle.optional(),
      counter: Handle.optional(),
      progress: Handle.optional(),
    })
    .partial()
    .optional(),
  selected: Handle.optional(),
  shows: z.string().optional(),
  sure: z.coerce.number().min(0).max(1).catch(0.5),
  why: z.string().optional(),
});
const RawReading = z.object({
  experience: z.string().default(""),
  parts: z
    .array(
      z.object({
        what: z.string(),
        role: z.string().default("other"),
        nodes: z.array(Handle).default([]),
      }),
    )
    .default([]),
  layouts: z.array(z.unknown()).default([]),
  unsure: z.array(z.string()).default([]),
});
type RawLayout = z.infer<typeof RawLayout>;

/** The value with every null left out, at any depth. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(withoutNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, withoutNulls(v)]),
    );
  }
  return value;
}

/** The first JSON object of a reply; undefined when there is none the reading can use. */
export function parseReading(
  text: string,
): (Omit<z.infer<typeof RawReading>, "layouts"> & { layouts: RawLayout[] }) | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  // a model writes null for what it leaves out: read it as left out
  const parsed = RawReading.safeParse(withoutNulls(json));
  if (!parsed.success) return undefined;
  const layouts = parsed.data.layouts.flatMap((l) => {
    const one = RawLayout.safeParse(withoutNulls(l));
    return one.success ? [one.data] : [];
  });
  return { ...parsed.data, layouts };
}

// --- checked against the IR -------------------------------------------------------------------

/** What the frame was read as, every layer by Figma id, every claim checked against the IR. */
export interface Reading {
  /** What the section is for, in the vision model's words. */
  experience: string;
  parts: Array<{ what: string; role: string; nodes: string[] }>;
  /** Each container's behaviour, as an intent the rest of the run applies or asks about. */
  layouts: LayoutIntent[];
  /** What the picture cannot settle, in the model's words. */
  unsure: string[];
  /** Claims the IR did not bear out, and why: reported, never applied. */
  dropped: string[];
  /** The layers that are one slide of a carousel drawn once: one part, never background. */
  groups: string[][];
}

export interface Ir {
  byId: Map<string, IrNode>;
  parents: Map<string, string | null>;
}

const boxOf = (ir: Ir, id: string) => ir.byId.get(id)?.geometry.bbox;
const nameOf = (ir: Ir, id: string) => ir.byId.get(id)?.name ?? id;

/** The ancestors of a layer, itself first, up to the root. */
function lineage(ir: Ir, id: string): string[] {
  const out: string[] = [];
  for (let at: string | null | undefined = id; at; at = ir.parents.get(at)) out.push(at);
  return out;
}

/**
 * Layers lifted to the children of the one container they share: a model that names a title
 * inside the words block and the photo beside it means the words block and the photo. A layer
 * inside another named one is the outer one's.
 */
export function liftToSiblings(
  ir: Ir,
  ids: string[],
): { container: string; members: string[] } | undefined {
  const known = [...new Set(ids)].filter((id) => ir.byId.has(id));
  const outer = known.filter((id) => !known.some((o) => o !== id && lineage(ir, id).includes(o)));
  if (outer.length === 0) return undefined;
  if (outer.length === 1) {
    const parent = ir.parents.get(outer[0] as string);
    return parent ? { container: parent, members: outer } : undefined;
  }
  const paths = outer.map((id) => lineage(ir, id).reverse());
  let depth = 0;
  while (paths.every((p) => p[depth] !== undefined && p[depth] === paths[0]?.[depth])) depth++;
  const container = paths[0]?.[depth - 1];
  if (!container) return undefined;
  const members = [...new Set(paths.map((p) => p[depth] as string))];
  return { container, members };
}

/** The children of `container` that hold these layers, leaving out those already listed. */
function holdersOf(ir: Ir, container: string, ids: string[], listed: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const line = lineage(ir, id);
    const at = line.indexOf(container);
    const holder = at > 0 ? line[at - 1] : undefined;
    if (holder && !listed.includes(holder) && !out.includes(holder)) out.push(holder);
  }
  return out;
}

/** Siblings in paint order: what draws first first. */
function inOrder(ir: Ir, container: string, ids: string[]): string[] {
  const kids = (ir.byId.get(container)?.children ?? []).map((c) => c.id);
  return [...ids].sort((a, b) => kids.indexOf(a) - kids.indexOf(b));
}

/** The first text inside a layer: a tab's label. */
function labelOf(node: IrNode | undefined): string | undefined {
  if (!node) return undefined;
  const own = textOf(node);
  if (node.type === "TEXT" && own) return own;
  for (const c of node.children ?? []) {
    const t = labelOf(c);
    if (t) return t;
  }
  return undefined;
}

/**
 * The reading's claims checked against the IR, as layout intents: proposals, none applied. `detected`
 * is what the IR detector saw: its proposal and evidence are added to the same container's, and a
 * carousel or tabs it is sure of that the reading left out is proposed too, as unsure.
 */
export function checkReading(
  raw: NonNullable<ReturnType<typeof parseReading>>,
  outline: Pick<Outline, "ids">,
  ir: Ir,
  detected: LayoutIntent[] = [],
): Reading {
  const dropped: string[] = [];
  const idOf = (h: string | undefined): string | undefined => {
    if (!h) return undefined;
    const id = outline.ids.get(h.trim());
    if (!id) dropped.push(`${h} is not a handle of the outline`);
    return id;
  };
  const ids = (hs: string[] | undefined) => (hs ?? []).flatMap((h) => idOf(h) ?? []);
  const layouts: LayoutIntent[] = [];
  const groups: string[][] = [];
  const said = (l: RawLayout) =>
    [l.shows ? `it shows ${l.shows}` : "", l.why ? `the reading: ${l.why}` : ""].filter(Boolean);

  for (const l of raw.layouts) {
    // what the IR did not bear out about this container's controls: left out of the proposal, said
    // on the container, so the agent can pass it to frame.layout itself when it judges otherwise
    const unborne: string[] = [];
    const chrome = controlsOf(l, idOf, ir, unborne);
    dropped.push(...unborne);
    const notBorne = unborne.map((u) => `not in the proposal: ${u}`);
    if (
      l.kind === "carousel" &&
      l.slide &&
      l.slide.length > 0 &&
      !(l.items && l.items.length > 1)
    ) {
      const lifted = liftToSiblings(ir, ids(l.slide));
      if (!lifted) {
        dropped.push(`a carousel's slide: none of ${l.slide.join(", ")} is a layer of the frame`);
        continue;
      }
      // a control inside the slide moves with it: it is not part of what repeats
      const controls = new Set(Object.values(chrome));
      const members = inOrder(
        ir,
        lifted.container,
        lifted.members.filter((m) => !controls.has(m)),
      );
      const evidence = [
        `the design draws one slide: ${members.map((m) => `"${nameOf(ir, m)}"`).join(", ")}`,
        ...controlEvidence(chrome, ir),
        ...said(l),
        ...notBorne,
      ];
      const backed = Object.keys(chrome).length > 0;
      if (!backed) evidence.push("no control the IR bears out: nothing drawn moves it");
      const choice: LayoutChoice = {
        src: lifted.container,
        kind: "carousel",
        config: carouselConfig({ slidesPerView: 1 }),
        slide: members,
        ...(Object.keys(chrome).length > 0 ? { chrome } : {}),
      };
      layouts.push(
        intentOf(lifted.container, ir, "carousel", l.sure, backed, evidence, choice, chrome, {
          slide: members,
          ask: carouselAsk(raw.unsure),
        }),
      );
      // one slot: the slide and the controls that move it, whichever layers hold them
      if (backed)
        groups.push([
          ...members,
          ...holdersOf(
            ir,
            lifted.container,
            Object.values(chrome).filter((id): id is string => Boolean(id)),
            members,
          ),
        ]);
      continue;
    }

    // a container of items: the items are siblings
    const items = ids(l.items);
    const lifted = items.length > 0 ? liftToSiblings(ir, items) : undefined;
    const named =
      lifted && lifted.members.length === items.length ? lifted.container : idOf(l.container);
    if (!named || !ir.byId.has(named)) {
      dropped.push(`a ${l.kind}: no container the IR has`);
      continue;
    }
    // the eyes say what, the IR says where: a carousel or tabs read on a whole strip whose items
    // the IR cannot name is the one the IR finds inside it (the cards' row, not the band around it)
    const backedHere =
      (lifted?.container === named && lifted.members.length >= 2) ||
      detected.some((d) => d.src === named);
    const inner = backedHere
      ? undefined
      : detected.find(
          (d) =>
            d.kind === l.kind &&
            d.confidence === "certain" &&
            d.src !== named &&
            lineage(ir, d.src).includes(named),
        );
    const container = inner?.src ?? named;
    const moved = inner
      ? `the ${l.kind} was read on "${nameOf(ir, named)}" (${named}); the IR finds its items in "${inner.name}" inside it, so that is the container proposed`
      : undefined;
    if (moved) dropped.push(moved);
    const members =
      lifted && lifted.container === container ? inOrder(ir, container, lifted.members) : [];
    const twin = detected.find((d) => d.src === container);
    // the score is the reading's own; what the IR detector proposes for the same container is
    // evidence beside it, with its own kind and confidence, for the agent to weigh
    const sure = l.sure;
    const evidence = [
      ...(members.length > 0 ? [`${members.length} items in "${nameOf(ir, container)}"`] : []),
      ...controlEvidence(chrome, ir),
      ...said(l),
      `the reading: ${l.kind}, ${l.sure} sure`,
      ...(twin
        ? [
            `the IR detector proposes ${twin.kind} (${twin.confidence}${twin.score !== undefined ? `, ${twin.score}` : ""})`,
            ...twin.evidence.map((e) => `the IR: ${e}`),
          ]
        : []),
      ...(moved ? [moved] : []),
      ...notBorne,
    ];

    if (l.kind === "carousel") {
      // slides the IR can name: the reading's, else the detector's for the same container
      const backed = members.length >= 2 || (twin?.items.length ?? 0) >= 2;
      // what the IR measures (centring, the slide drawn first, slides per view) when it agrees
      const config =
        twin?.choice.kind === "carousel"
          ? twin.choice.config
          : carouselConfig({ slidesPerView: "auto" });
      const choice: LayoutChoice = {
        src: container,
        kind: "carousel",
        config,
        ...(members.length > 0 ? { items: members } : {}),
        ...(Object.keys({ ...twin?.chrome, ...chrome }).length > 0
          ? { chrome: { ...twin?.chrome, ...chrome } }
          : {}),
      };
      layouts.push(
        intentOf(
          container,
          ir,
          "carousel",
          sure,
          backed,
          backed ? evidence : [...evidence, "no slides the IR bears out"],
          choice,
          { ...twin?.chrome, ...chrome },
          {
            items: members.length > 0 ? members : (twin?.items ?? []),
            ask: carouselAsk(raw.unsure),
          },
        ),
      );
      continue;
    }
    if (l.kind === "tabs") {
      const labels = members.map((m) => labelOf(ir.byId.get(m)));
      const selected = idOf(l.selected);
      const active = selected ? members.indexOf(selected) : -1;
      const backed = members.length >= 2 && labels.every(Boolean) && active >= 0;
      if (!backed) {
        evidence.push(
          members.length < 2
            ? "fewer than two tabs the IR bears out"
            : active < 0
              ? "no tab the reading names is drawn selected"
              : "a tab with no label",
        );
      }
      const config =
        twin?.choice.kind === "tabs"
          ? twin.choice.config
          : { options: labels.map((t) => t ?? ""), active: Math.max(0, active) };
      const choice: LayoutChoice = { src: container, kind: "tabs", config, items: members };
      layouts.push(
        intentOf(
          container,
          ir,
          "tabs",
          sure,
          backed,
          evidence,
          choice,
          {},
          { items: members, ask: [] },
        ),
      );
      continue;
    }
    const xs = new Set(members.map((m) => Math.round(boxOf(ir, m)?.x ?? 0)));
    const ys = new Set(members.map((m) => Math.round(boxOf(ir, m)?.y ?? 0)));
    // a grid the IR lays out on one line: proposed as that line (one row, one column), with the
    // reading's grid kept as the alternative. Neither moves: both are drawn as compiled
    if (l.kind === "grid" && members.length >= 2 && (ys.size === 1 || xs.size === 1)) {
      const kind = ys.size === 1 ? ("row" as const) : ("list" as const);
      layouts.push({
        ...intentOf(
          container,
          ir,
          kind,
          sure,
          true,
          [
            ...evidence,
            `read as a grid, and the IR lays its ${members.length} items on one ${kind === "row" ? "row" : "column"}`,
          ],
          { src: container, kind },
          {},
          { items: members, ask: [] },
        ),
        alternative: "grid",
      });
      continue;
    }
    if (l.kind === "grid") {
      const choice: LayoutChoice = {
        src: container,
        kind: "grid",
        config: { columns: Math.max(1, xs.size), rows: Math.max(1, ys.size) },
      };
      layouts.push(
        intentOf(
          container,
          ir,
          "grid",
          sure,
          members.length >= 2,
          evidence,
          choice,
          {},
          { items: members, ask: [] },
        ),
      );
      continue;
    }
    const choice: LayoutChoice = { src: container, kind: l.kind };
    layouts.push(
      intentOf(
        container,
        ir,
        l.kind,
        sure,
        true,
        evidence,
        choice,
        {},
        { items: members, ask: [] },
      ),
    );
  }

  // what the IR shows repeating that the reading left out: a list or a grid is drawn as it is, and
  // is evidence that the section shows data
  for (const d of detected) {
    if (d.kind !== "list" && d.kind !== "grid") continue;
    if (layouts.some((l) => l.src === d.src)) continue;
    layouts.push({ ...d, evidence: d.evidence.map((e) => `the IR: ${e}`) });
  }

  // what the IR is sure moves (a card cut off, designed arrows, dots) and the reading left out
  for (const d of detected) {
    if (d.kind !== "carousel" && d.kind !== "tabs") continue;
    if (d.confidence !== "certain") continue;
    if (layouts.some((l) => l.src === d.src || l.items.includes(d.src))) continue;
    layouts.push({
      ...d,
      confidence: "unsure",
      score: 0.5,
      evidence: [...d.evidence.map((e) => `the IR: ${e}`), "the reading did not see this as one"],
      alternative: "row",
      alternativeChoice: { src: d.src, kind: "row" },
      alternativeAsk: [],
      ask: d.ask.length > 0 ? d.ask : [`Is "${d.name}" a ${d.kind}?`],
    });
  }

  return {
    experience: raw.experience,
    parts: raw.parts.map((p) => ({ what: p.what, role: p.role, nodes: ids(p.nodes) })),
    layouts,
    unsure: raw.unsure,
    dropped,
    groups,
  };
}

/**
 * The controls the reading names that the IR bears out, prev before next by where they are. One
 * that fails a check is left out and said in `dropped` with its measured values.
 */
function controlsOf(
  l: RawLayout,
  idOf: (h: string | undefined) => string | undefined,
  ir: Ir,
  dropped: string[],
): LayoutChrome {
  const out: LayoutChrome = {};
  const c = l.controls ?? {};
  for (const part of ["prev", "next"] as const) {
    const id = idOf(c[part]);
    const b = id ? boxOf(ir, id) : undefined;
    if (!id || !b) continue;
    if (b.w > MAX_ARROW_PX || b.h > MAX_ARROW_PX) {
      dropped.push(
        `${part} "${nameOf(ir, id)}" (${id}) is ${Math.round(b.w)}x${Math.round(b.h)}, larger than an arrow's ${MAX_ARROW_PX}px`,
      );
      continue;
    }
    out[part] = id;
  }
  // the arrow on the left goes back, whatever its layer is called or its glyph is named
  const p = out.prev ? boxOf(ir, out.prev) : undefined;
  const n = out.next ? boxOf(ir, out.next) : undefined;
  if (p && n && (p.x > n.x + 1 || (Math.abs(p.x - n.x) <= 1 && p.y > n.y))) {
    [out.prev, out.next] = [out.next, out.prev];
  }
  const counter = idOf(c.counter);
  if (counter) {
    const node = ir.byId.get(counter);
    const t = node ? textOf(node) : undefined;
    if (node?.type === "TEXT" && t && /\d/.test(t)) out.counter = counter;
    else
      dropped.push(
        `counter "${nameOf(ir, counter)}" (${counter}) is ${node?.type === "TEXT" ? `the text "${t ?? ""}", with no digit` : `a ${node?.type ?? "missing"} layer, not a text`}`,
      );
  }
  const progress = idOf(c.progress);
  if (progress) {
    const b = boxOf(ir, progress);
    if (b && Math.min(b.w, b.h) <= MAX_BAR_PX) out.progress = progress;
    else
      dropped.push(
        `progress "${nameOf(ir, progress)}" (${progress}) is ${b ? `${Math.round(b.w)}x${Math.round(b.h)}, thicker than a bar's ${MAX_BAR_PX}px` : "not a layer of the frame"}`,
      );
  }
  const pagination = idOf(c.pagination);
  if (pagination) {
    const dots = ir.byId.get(pagination)?.children?.length ?? 0;
    if (dots >= 2) out.pagination = pagination;
    else
      dropped.push(
        `pagination "${nameOf(ir, pagination)}" (${pagination}) has ${dots} children, not a row of dots`,
      );
  }
  return out;
}

function controlEvidence(chrome: LayoutChrome, ir: Ir): string[] {
  const out: string[] = [];
  if (chrome.prev || chrome.next) {
    out.push(
      `designed ${[chrome.prev && "previous", chrome.next && "next"].filter(Boolean).join(" and ")} arrow`,
    );
  }
  if (chrome.pagination) out.push("a row of dots");
  if (chrome.counter) {
    const t = textOf(ir.byId.get(chrome.counter) as IrNode);
    out.push(`a counter "${t}"`);
  }
  if (chrome.progress) out.push("a progress bar");
  return out;
}

/** What a carousel leaves to a person: how many, whether it moves on its own, whether it loops. */
function carouselAsk(unsure: string[]): string[] {
  return [
    "How many items it holds, whether it moves on its own and whether it loops: a still cannot show it",
    ...unsure,
  ];
}

function carouselConfig(over: { slidesPerView: number | "auto" }) {
  return {
    slidesPerView: over.slidesPerView,
    slidesPerGroup: 1,
    centered: false,
    initialSlide: 0,
    loop: false,
    autoplay: false as const,
  };
}

/**
 * A proposal for one container. Its confidence is a label for the agent (the reading sure and the IR
 * bearing it out is `certain`), never a licence to apply: the agent settles every carousel and tab
 * bar with frame.layout.
 */
function intentOf(
  src: string,
  ir: Ir,
  kind: LayoutKind,
  sure: number,
  backed: boolean,
  evidence: string[],
  choice: LayoutChoice,
  chrome: LayoutChrome,
  more: { items?: string[]; slide?: string[]; ask: string[] },
): LayoutIntent {
  const confidence: Confidence = backed && sure >= SURE ? "certain" : backed ? "likely" : "unsure";
  const moving = kind === "carousel" || kind === "tabs";
  return {
    src,
    name: nameOf(ir, src),
    kind,
    confidence: moving && confidence === "likely" ? "unsure" : confidence,
    score: Math.round(sure * 100) / 100,
    items: more.items ?? [],
    evidence,
    ask: more.ask,
    choice,
    chrome,
    ...(more.slide ? { slide: more.slide } : {}),
    ...(moving && confidence !== "certain"
      ? {
          alternative: "row" as const,
          alternativeChoice: { src, kind: "row" as const },
          alternativeAsk: [],
        }
      : {}),
  };
}

// --- the call ---------------------------------------------------------------------------------

/** One picture and one prompt, one reply: the vision call, replaceable in a test. */
export type Read = (png: Buffer, prompt: string, signal?: AbortSignal) => Promise<string>;

/** The design as one picture, no side longer than a vision model reads well. */
export function designPicture(tools: Toolchain, bundle: Bundle): PngImage {
  const whole = composeDesign(tools, bundle, 1);
  const side = Math.max(whole.width, whole.height);
  if (side <= MAX_SIDE) return whole;
  return resizeTo(tools, whole, Math.max(1, Math.floor((whole.width * MAX_SIDE) / side)));
}

/** Reads the frame: the vision model's account, checked against the IR. Throws when it cannot. */
export async function readFrame(opts: {
  tools: Toolchain;
  bundle: Bundle;
  read: Read;
  signal?: AbortSignal;
}): Promise<Reading> {
  const { tools, bundle } = opts;
  const detected = (() => {
    try {
      return tools.detectLayout(bundle.doc);
    } catch {
      return [];
    }
  })();
  return readPicture({
    png: tools.png.write(designPicture(tools, bundle)),
    doc: bundle.doc,
    ir: { byId: bundle.byId, parents: bundle.parents },
    detected,
    read: opts.read,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** Reads a design picture of `doc`: what `readFrame` does once it has the picture. */
export async function readPicture(opts: {
  png: Buffer;
  doc: { root: IrNode };
  ir: Ir;
  detected?: LayoutIntent[];
  read: Read;
  signal?: AbortSignal;
}): Promise<Reading> {
  const outline = outlineOf(opts.doc);
  const reply = await opts.read(opts.png, readPrompt(outline), opts.signal);
  const raw = parseReading(reply);
  if (!raw) {
    throw new Error(
      `the vision model's reading was not the JSON asked for: ${reply.slice(0, 200)}`,
    );
  }
  return checkReading(raw, outline, opts.ir, opts.detected ?? []);
}

/**
 * When the frame could not be read: what the IR shows, every carousel and tabs left to the agent
 * to settle, and nothing applied unasked.
 */
export function unread(detected: LayoutIntent[], why: string): Reading {
  return {
    experience: "",
    parts: [],
    layouts: detected.map((d) =>
      d.kind === "carousel" || d.kind === "tabs"
        ? {
            ...d,
            confidence: "unsure" as const,
            evidence: [...d.evidence, `the frame was not read (${why}): the IR alone says so`],
            alternative: d.alternative ?? ("row" as const),
            alternativeChoice: d.alternativeChoice ?? { src: d.src, kind: "row" as const },
            alternativeAsk: d.alternativeAsk ?? [],
            ask: d.ask.length > 0 ? d.ask : [`Is "${d.name}" a ${d.kind}?`],
          }
        : d,
    ),
    unsure: [],
    dropped: [`the frame was not read: ${why}`],
    groups: [],
  };
}
