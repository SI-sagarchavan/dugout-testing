// pnpm eval binding [--only id,id] [--frames N] — does binding more values to tokens change the build?
//
// A headless stand-in for "bind the frame fully in Figma, then run `pnpm eval measure` again". It
// takes each frame's stored IR and asks the plugin's own lint what could be bound, in two ways: the
// loose values with an EXACT token (the batches `applyBatch` applies unattended), and then those
// plus the nearest token for every near match (a designer accepting every pick, which can change
// what the layer looks like). The bindings are written into a copy of the IR the way Figma's
// traversal would have reported them, and the copy is compiled and measured next to the original.
// It cannot capture what a designer would also change by hand while binding.
//
// Second section: for every eval frame, the plugin's structure and token signals next to the code-only
// result recorded in evals/baseline.json, with their correlation. Nothing is written to the baseline.
import { readFileSync } from "node:fs";
import { walkNodes } from "../../../packages/surface-canvas/src/health/slots.ts";
import {
  DEFAULT_LINT_OPTIONS,
  isFixProposal,
  type LintReport,
  type ThemeSnapshot,
  type TokenBinding,
} from "../../../packages/surface-canvas/src/health/types.ts";
import {
  type FrameIRNode,
  parseFrameIRDocument,
} from "../../../packages/surface-canvas/src/ir/schema.ts";
import { colorFamily } from "../../../packages/surface-canvas/src/match/color.ts";
import { lint } from "../../../packages/surface-canvas/src/rules/index.ts";
import { FRAMES, HOLDOUT } from "../evals/frames.ts";
import { createControlPlane } from "../src/control-plane.ts";
import {
  type Bundle,
  buildFrame,
  firstPass,
  loadBundle,
  measureFrame,
  noOverrides,
  type Overrides,
} from "../src/frame.ts";
import { type IrNode, loadToolchain, type Toolchain } from "../src/toolchain.ts";

const DEFAULT_FRAMES = ["fixtures-strip", "hospitality", "team-page", "ho-spider", "ho-standings"];
const MOVED = 0.1;
const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const only = flag("--only")?.split(",");
const limit = Number(flag("--frames") ?? Number.POSITIVE_INFINITY);

// biome-ignore lint/suspicious/noExplicitAny: the raw IR is edited by path, before any schema sees it
type Json = Record<string, any>;

interface NormalizedTheme {
  id: string;
  name: string;
  slug: string;
  color: { light: Map<string, string> };
  space: Map<string, number>;
  radius: Map<string, number>;
  type: Record<"mobile" | "tablet" | "desktop", Map<string, unknown>>;
  shadow: {
    light: Map<
      string,
      {
        x: number;
        y: number;
        blur: number;
        spread: number;
        color: string;
        opacity: number;
        inset?: boolean;
      }
    >;
  };
  gradient: { light: Map<string, unknown> };
  names: { toRaw(ref: string, category: string): string | undefined };
}

/** The plugin's reconciled theme as it reads when every token has a matching variable or style. */
function snapshotOf(t: NormalizedTheme): ThemeSnapshot {
  const rawOf = (ref: string, category: string) =>
    t.names.toRaw(ref, category) ?? ref.slice(ref.indexOf(".") + 1);
  const bound = (ref: string, raw: string, medium: TokenBinding["medium"]): TokenBinding => ({
    medium,
    id: `sim:${ref}`,
    figmaName: raw,
    valueMatches: true,
  });
  const number = (map: Map<string, number>, category: "space" | "radius") =>
    [...map].map(([leaf, px]) => {
      const ref = `${category}.${leaf}`;
      const raw = rawOf(ref, category);
      return { ref, raw, px, binding: bound(ref, raw, "variable") };
    });
  const leaves = new Set<string>();
  for (const bp of ["mobile", "tablet", "desktop"] as const)
    for (const leaf of t.type[bp].keys()) leaves.add(leaf);

  return {
    themeId: t.id,
    themeName: t.name,
    slug: t.slug,
    colors: [...t.color.light].map(([leaf, hex]) => {
      const ref = `color.${leaf}`;
      const raw = rawOf(ref, "color");
      const rgb: [number, number, number] = [1, 3, 5].map((at) =>
        Number.parseInt(hex.slice(at, at + 2), 16),
      ) as [number, number, number];
      return { ref, raw, hex, rgb, family: colorFamily(raw), binding: bound(ref, raw, "variable") };
    }),
    spaces: number(t.space, "space"),
    radii: number(t.radius, "radius"),
    types: [...leaves].map((leaf) => {
      const ref = `type.${leaf}`;
      const raw = rawOf(ref, "type");
      const byBreakpoint: Record<string, unknown> = {};
      for (const bp of ["mobile", "tablet", "desktop"] as const) {
        const style = t.type[bp].get(leaf);
        if (style) byBreakpoint[bp] = style;
      }
      return {
        ref,
        raw,
        byBreakpoint: byBreakpoint as ThemeSnapshot["types"][number]["byBreakpoint"],
        binding: bound(ref, raw, "textStyle"),
      };
    }),
    shadows: [...t.shadow.light].map(([leaf, s]) => {
      const ref = `shadow.${leaf}`;
      const raw = rawOf(ref, "shadow");
      return {
        ref,
        raw,
        value: `${s.x} ${s.y} ${s.blur} ${s.spread} ${s.color}@${s.opacity}%`,
        x: s.x,
        y: s.y,
        blur: s.blur,
        spread: s.spread,
        color: s.color,
        opacity: s.opacity,
        inset: s.inset ?? false,
        binding: bound(ref, raw, "effectStyle"),
      };
    }),
    gradients: [...t.gradient.light].map(([leaf]) => {
      const ref = `gradient.${leaf}`;
      const raw = rawOf(ref, "gradient");
      return { ref, raw, value: "linear", binding: bound(ref, raw, "variable") };
    }),
    orphans: [],
    reconciled: true,
    localCollections: 1,
    libraryCollections: 0,
    valueMismatches: 0,
  };
}

const rootNotColumn = (root: FrameIRNode) => {
  if (root.layout.mode === "vertical") return false;
  const absolute = root.children.filter((c) => c.layout.positioning === "absolute").length;
  return !(root.children.length > 0 && absolute * 2 >= root.children.length);
};
const noMobileFrame = (nodes: FrameIRNode[]) =>
  !nodes.some(
    (n) =>
      n.depth <= 1 &&
      (n.type === "FRAME" || n.type === "COMPONENT") &&
      n.geometry.bbox.w >= 320 &&
      n.geometry.bbox.w <= 480,
  );

const lintIr = (ir: unknown, theme: ThemeSnapshot): LintReport =>
  lint(parseFrameIRDocument(ir), { theme, breakpoint: "desktop", options: DEFAULT_LINT_OPTIONS });

/** What binding would write into the IR, by the name Figma would report for the variable or style. */
function bindBatches(ir: Json, report: LintReport, theme: ThemeSnapshot, acceptNear: boolean) {
  const figmaName = new Map<string, string>();
  for (const entry of [
    ...theme.colors,
    ...theme.spaces,
    ...theme.radii,
    ...theme.types,
    ...theme.shadows,
  ])
    figmaName.set(entry.ref, entry.binding?.figmaName ?? entry.raw);

  const byId = new Map<string, Json>();
  const index = (node: Json) => {
    byId.set(node.id, node);
    for (const child of node.children ?? []) index(child);
  };
  index(ir.root);

  const applied: Record<string, number> = {};
  const left: Record<string, number> = {};
  for (const batch of report.batches) {
    const proposal = batch.proposal;
    const name = proposal && isFixProposal(proposal) ? figmaName.get(proposal.tokenRef) : undefined;
    const takes = batch.safe || (acceptNear && proposal?.kind === "near" && proposal.bindable);
    if (!takes || !name) {
      left[batch.scope] = (left[batch.scope] ?? 0) + batch.count;
      continue;
    }
    for (const { nodeId, propPath } of batch.items) {
      const node = byId.get(nodeId);
      if (!node) continue;
      const [head, ...rest] = propPath.split(".");
      if (head === "fill" || head === "stroke") {
        const { raw: _raw, ...paint } = node[head];
        node[head] = { ...paint, tokenRef: name, unbound: false };
      } else if (head === "radius") {
        node.radius = { ...node.radius, tokenRef: name, unbound: false };
      } else if (head === "layout") {
        const holder = rest[0] === "padding" ? node.layout.padding : node.layout;
        const key = rest[0] === "padding" ? String(rest[1]) : "gap";
        holder[key] = { ...holder[key], tokenRef: name, unbound: false };
      } else if (head === "effects") {
        const at = Number(rest[0]);
        node.effects[at] = { ...node.effects[at], styleRef: name, unbound: false };
      } else if (head === "text") {
        node.text = { ...node.text, styleRef: name, unbound: false };
      } else continue;
      applied[batch.scope] = (applied[batch.scope] ?? 0) + 1;
    }
  }
  return { applied, left };
}

function withIr(tools: Toolchain, bundle: Bundle, ir: unknown): Bundle {
  const doc = tools.parseIr(ir);
  const byId = new Map<string, IrNode>();
  const order = new Map<string, number>();
  const parents = new Map<string, string | null>();
  const walk = (node: IrNode, parent: string | null) => {
    byId.set(node.id, node);
    order.set(node.id, order.size);
    parents.set(node.id, parent);
    for (const child of node.children ?? []) walk(child, node.id);
  };
  walk(doc.root, null);
  const { found: _found, ...rest } = bundle;
  return { ...rest, ir, doc, byId, order, parents };
}

const isRaw = (v: unknown) =>
  typeof v === "object" && v !== null && (v as { _unbound?: unknown })._unbound === true;
const countRaws = (v: unknown): number =>
  isRaw(v)
    ? 1
    : Array.isArray(v)
      ? v.reduce<number>((a, x) => a + countRaws(x), 0)
      : typeof v === "object" && v !== null
        ? Object.values(v).reduce<number>((a, x) => a + countRaws(x), 0)
        : 0;

const overrideKinds = (o: Overrides) => ({
  props: o.props.length,
  surfaces: Object.keys(o.surfaces).length,
  crops: o.crops.length,
  drops: o.drops.length,
  gradients: o.gradients.length,
  texts: o.texts.length,
  icons: Object.keys(o.icons).length,
  layouts: o.layouts.length,
});
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const shown = (o: Record<string, number>) =>
  Object.entries(o)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "none";

async function measure(tools: Toolchain, bundle: Bundle) {
  const plain = buildFrame(tools, bundle, noOverrides());
  const compiled = await measureFrame(tools, bundle, plain);
  const first = await firstPass(tools, bundle, noOverrides(), compiled);
  return {
    compiledMatch: compiled.match,
    conform: compiled.conformErrors,
    raws: countRaws(plain.tree.nodes.map((n) => n.props)),
    notes: plain.notes.length,
    firstMatch: first.measurement.match,
    overrides: overrideKinds(first.overrides),
  };
}

const tools = await loadToolchain();
const plane = createControlPlane("default");
const ALL = [...FRAMES, ...HOLDOUT];
const chosen = (
  only ? ALL.filter((f) => only.includes(f.id)) : ALL.filter((f) => DEFAULT_FRAMES.includes(f.id))
).slice(0, limit);
if (chosen.length === 0) throw new Error(`no eval frame matches ${only?.join(",")}`);

console.log(
  "BINDING EXPERIMENT — bindings written into a copy of each stored IR, then recompiled\n",
);
console.log(
  "A stand-in for binding in Figma: nothing a designer would also change by hand is captured.\n" +
    " 'screenshot coverage' is how much of the frame a compared\n" +
    "screenshot covers; 'binding coverage' is the plugin's share of slots bound to tokens.\n",
);

const MODES = [
  { label: "exact matches only", acceptNear: false },
  {
    label: "exact + the nearest token for every near match (a designer accepting every pick)",
    acceptNear: true,
  },
];
const verdicts: string[] = [];
const d = (x: number, y: number) =>
  y - x === 0 ? "=" : `${y - x > 0 ? "+" : ""}${+(y - x).toFixed(2)}`;
for (const frame of chosen) {
  const bundle = await loadBundle(tools, plane, frame.exportId);
  const theme = snapshotOf(tools.parseTheme(bundle.themeRaw) as NormalizedTheme);
  const before = lintIr(bundle.ir, theme);
  const a = await measure(tools, bundle);
  console.log(`${frame.id}  (${frame.kind})`);
  console.log(
    `  as stored: binding coverage ${before.coverage.percent}%, ${before.coverage.loose} loose; compiled match ${a.compiledMatch}%, first-pass ${a.firstMatch}%, conform ${a.conform}, raw values ${a.raws}, overrides ${sum(a.overrides)} (${shown(a.overrides)})`,
  );

  for (const mode of MODES) {
    const ir = structuredClone(bundle.ir) as Json;
    const { applied, left } = bindBatches(ir, before, theme, mode.acceptNear);
    console.log(`\n  [${mode.label}]`);
    console.log(
      `  bound ${sum(applied)} slots (${shown(applied)}); left loose ${sum(left)} (${shown(left)})`,
    );
    if (sum(applied) === 0) {
      console.log("  nothing to bind, so nothing to compare.");
      verdicts.push(
        `${mode.acceptNear ? "near" : "exact"}: match did not move (nothing bound); raw count did not change`,
      );
      continue;
    }
    const after = lintIr(ir, theme);
    const b = await measure(tools, withIr(tools, bundle, ir));
    const row = (label: string, x: number | string, y: number | string, delta: string) =>
      console.log(
        `  ${label.padEnd(22)}${String(x).padStart(9)} ->${String(y).padStart(9)}   ${delta}`,
      );
    row(
      "binding coverage %",
      before.coverage.percent,
      after.coverage.percent,
      d(before.coverage.percent, after.coverage.percent),
    );
    row(
      "loose slots",
      before.coverage.loose,
      after.coverage.loose,
      d(before.coverage.loose, after.coverage.loose),
    );
    row("compiled match %", a.compiledMatch, b.compiledMatch, d(a.compiledMatch, b.compiledMatch));
    row("first-pass match %", a.firstMatch, b.firstMatch, d(a.firstMatch, b.firstMatch));
    row("conform errors", a.conform, b.conform, d(a.conform, b.conform));
    row("raw values in tree", a.raws, b.raws, d(a.raws, b.raws));
    row("compile notes", a.notes, b.notes, d(a.notes, b.notes));
    row(
      "overrides needed",
      sum(a.overrides),
      sum(b.overrides),
      d(sum(a.overrides), sum(b.overrides)),
    );
    console.log(`  overrides after: ${shown(b.overrides)}`);
    const matchMoved =
      Math.abs(b.compiledMatch - a.compiledMatch) >= MOVED ||
      Math.abs(b.firstMatch - a.firstMatch) >= MOVED;
    const verdict =
      `${mode.acceptNear ? "near" : "exact"}: match ${matchMoved ? `moved (compiled ${d(a.compiledMatch, b.compiledMatch)}, first-pass ${d(a.firstMatch, b.firstMatch)})` : "did not move"}; conform ${a.conform === b.conform ? "same" : `${a.conform} -> ${b.conform}`}; ` +
      `raw count ${b.raws < a.raws ? "dropped" : b.raws > a.raws ? "rose" : "did not change"}; ` +
      `overrides ${sum(b.overrides) < sum(a.overrides) ? "fewer" : sum(b.overrides) > sum(a.overrides) ? "more" : "same"}`;
    console.log(`  verdict: ${verdict}`);
    verdicts.push(verdict);
  }
  console.log();
}
const movedAny = verdicts.some((v) => v.includes("match moved"));
const rawDropped = verdicts.some((v) => v.includes("raw count dropped"));
console.log(
  `OVERALL over ${chosen.length} frames: match ${movedAny ? "moved on at least one frame" : "did not move on any"}; ` +
    `raw values ${rawDropped ? "dropped on at least one frame" : "did not drop on any"}.`,
);

console.log(
  "\nSIGNALS — every eval frame: the plugin's lint next to the code-only result in baseline.json\n",
);
const baseline = JSON.parse(
  readFileSync(new URL("../evals/baseline.json", import.meta.url), "utf8"),
).frames as Record<string, { compiled: { match: number; conformErrors: number } }>;
const rows: Array<{
  id: string;
  nodes: number;
  groups: number;
  absPct: number;
  pinned: number;
  structure: string;
  bindPct: number;
  compiled: number;
  conform: number;
}> = [];
for (const frame of ALL) {
  const bundle = await loadBundle(tools, plane, frame.exportId);
  const theme = snapshotOf(tools.parseTheme(bundle.themeRaw) as NormalizedTheme);
  const report = lintIr(bundle.ir, theme);
  const root = parseFrameIRDocument(bundle.ir).root;
  const nodes = walkNodes(root);
  const recorded = baseline[frame.id]?.compiled;
  if (!recorded) continue;
  rows.push({
    id: frame.id,
    nodes: nodes.length,
    groups: nodes.filter((n) => n.type === "GROUP").length,
    absPct: Math.round(
      (100 * nodes.filter((n) => n.layout.positioning === "absolute").length) / nodes.length,
    ),
    pinned: report.sizing.pinnedText.length,
    structure: [
      ...(rootNotColumn(root) ? ["B1"] : []),
      ...(report.structure.some((x) => x.ruleId === "groups-instead-of-frames") ? ["S1"] : []),
      ...(noMobileFrame(nodes) ? ["B3"] : []),
    ].join(" "),
    bindPct: report.coverage.percent,
    compiled: recorded.match,
    conform: recorded.conformErrors,
  });
}
await tools.closeBrowser();
console.table(rows);

const corr = (xs: number[], ys: number[]) => {
  const n = xs.length;
  const mx = xs.reduce((p, c) => p + c, 0) / n;
  const my = ys.reduce((p, c) => p + c, 0) / n;
  let s = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    s += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
    vx += ((xs[i] ?? 0) - mx) ** 2;
    vy += ((ys[i] ?? 0) - my) ** 2;
  }
  return Number((s / Math.sqrt(vx * vy)).toFixed(2));
};
console.table(
  (["groups", "absPct", "pinned", "bindPct", "nodes"] as const).map((key) => ({
    signal: key,
    "r vs compiled match": corr(
      rows.map((r) => r[key]),
      rows.map((r) => r.compiled),
    ),
    "r vs conform errors": corr(
      rows.map((r) => r[key]),
      rows.map((r) => r.conform),
    ),
  })),
);
console.log(
  `n = ${rows.length} frames; structure = which of B1 (root not a column), S1 (groups) and B3 (no mobile frame) fire. B1 and B3 are computed here, not by the plugin.`,
);
process.exit(0);
