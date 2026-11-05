import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolContext } from "@dugout/contracts";
import { describeImage, REPO_ROOT } from "@dugout/core";
import { z } from "zod";
import { type ControlPlane, createControlPlane, webUrl } from "./control-plane.ts";
import {
  type Built,
  type Bundle,
  buildFrame,
  firstPass,
  gradientOf,
  loadBundle,
  type Measurement,
  measureFrame,
  noOverrides,
  Overrides,
  PAGE,
  TokenKind,
  tokensOf,
  type Unpainted,
  unpaintedLayers,
} from "./frame.ts";
import {
  describeChoice,
  describePlatform,
  LayoutChoice,
  type LayoutIntent,
  type LayoutReport,
  type PlatformRead,
  questionCard,
  withPlatform,
} from "./layout.ts";
import { type Looked, LookInputError, look, type See } from "./look.ts";
import { loadToolchain, type Toolchain } from "./toolchain.ts";

export const MATCH_DIR = join(REPO_ROOT, ".runs", "frame-match");

/** The compile, render and compare steps, so a test can run the tools without a built pipeline. */
export interface Engine {
  bundle(plane: ControlPlane, exportId: string, themeArtifactId?: string): Promise<Bundle>;
  build(bundle: Bundle, overrides: Overrides): Promise<Built>;
  measure(bundle: Bundle, built: Built): Promise<Measurement>;
  firstPass(
    bundle: Bundle,
    start: Overrides,
    plain?: Measurement,
  ): Promise<{ overrides: Overrides; built: Built; measurement: Measurement; undone?: string[] }>;
  /** The design beside the rebuild, read by a vision model. Absent where there is no render. */
  look?(
    bundle: Bundle,
    built: Built,
    input: {
      region?: { x: number; y: number; w: number; h: number } | undefined;
      focus?: string | undefined;
    },
    see: See,
    signal?: AbortSignal,
  ): Promise<Looked>;
  unpainted?(bundle: Bundle, built: Built): Unpainted[];
  /** What each container of the frame is (`@fanos/compile` `detectLayout`). */
  layouts?(bundle: Bundle): Promise<LayoutIntent[]>;
  /** A platform carousel config as Carousel props, its colours checked against the theme. */
  platform?(json: unknown, colors: ReadonlySet<string>): Promise<PlatformRead>;
}

export function pipelineEngine(tools?: Toolchain): Engine {
  const load = async () => tools ?? (await loadToolchain());
  return {
    bundle: async (plane, exportId, theme) => loadBundle(await load(), plane, exportId, theme),
    build: async (bundle, overrides) => buildFrame(await load(), bundle, overrides),
    measure: async (bundle, built) => measureFrame(await load(), bundle, built),
    firstPass: async (bundle, start, plain) => firstPass(await load(), bundle, start, plain),
    look: async (bundle, built, input, see, signal) =>
      look({
        tools: await load(),
        bundle,
        built,
        see,
        ...(input.region ? { region: input.region } : {}),
        ...(input.focus ? { focus: input.focus } : {}),
        ...(signal ? { signal } : {}),
      }),
    unpainted: (bundle, built) => unpaintedLayers(bundle, built.tree, built.themeRaw),
    layouts: async (bundle) => (await load()).detectLayout(bundle.doc),
    platform: async (json, colors) => (await load()).fromPlatformCarousel(json, { colors }),
  };
}

const Published = z.object({
  treeArtifactId: z.string(),
  surfaceArtifactId: z.string(),
  themeArtifactId: z.string(),
  previewUrl: z.string(),
  /** False when no screenshot fit, so nothing was compared: there is no before or match. */
  measured: z.boolean(),
  /** Share of the frame a compared screenshot covers, 0 to 100. */
  coverage: z.number(),
  /** A screenshot was placed by search, so the numbers are close and not exact. */
  estimated: z.boolean(),
  /** Layers on show that no compared screenshot holds. */
  unchecked: z.array(z.string()),
  /** Icons on show with no art: the export has no vectors and no screenshot holds them. */
  placeholderIcons: z.number(),
  before: z.number().optional(),
  match: z.number().optional(),
});

/** A run's work so far. On disk, so a run resumed after an approval keeps its overrides. */
const State = z.object({
  exportId: z.string(),
  themeArtifactId: z.string(),
  overrides: Overrides,
  /**
   * Where a search placed screenshots with padding. A crop from one needs this, so a rebuild after
   * a resume, or from a bundle loaded fresh, draws the same crops as the one that was measured.
   */
  found: z.record(z.string(), z.object({ dx: z.number(), dy: z.number() })).default({}),
  before: z.object({ match: z.number(), conformErrors: z.number(), placeholderIcons: z.number() }),
  current: z.custom<Measurement>(),
  /** Figma ids the model has read or tried to change. */
  /** Why nothing could be compared, when that is so. */
  unmeasured: z.string().optional(),
  standIns: z.number().default(0),
  /** Tokenless gradients drawn with a token the theme did not have. */
  rawGradients: z.number().default(0),
  /** Fixes the first pass took back out because the frame scored worse with them. */
  undone: z.array(z.string()).default([]),
  /** Layers the design paints and the compile does not: the score cannot see these. */
  unpainted: z.array(z.custom<Unpainted>()).default([]),
  /** How many times frame.look was called, so a run can be told apart by whether it looked. */
  looks: z.number().default(0),
  /** Times the vision call or the render behind frame.look failed. */
  lookFailures: z.number().default(0),
  examined: z.array(z.string()).default([]),
  examinedSurfaces: z.array(z.string()).default([]),
  /** Times frame.publish was refused for findings not yet examined. */
  publishRefusals: z.number().default(0),
  /** What each container is: detected by frame.load, decided through frame.layout. */
  layouts: z.array(z.custom<LayoutReport>()).default([]),
  published: Published.optional(),
});
type State = z.infer<typeof State>;

const stateFile = (dir: string, runId: string) => join(dir, `${runId}.json`);

function readState(dir: string, runId: string): State | undefined {
  try {
    return State.parse(JSON.parse(readFileSync(stateFile(dir, runId), "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function writeState(dir: string, runId: string, state: State) {
  mkdirSync(dir, { recursive: true });
  const path = stateFile(dir, runId);
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

export const RunInput = z.object({
  exportId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .describe("The export a designer's Send stored"),
  project: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("default")
    .describe("The control plane project the export is in"),
  receivedAt: z.string().optional().describe("When the control plane received the export"),
});

const inputOf = (ctx: Pick<ToolContext, "input">) => RunInput.parse(ctx.input);
const noArgs = z.object({}).strict();

/** What the model reads about where the frame stands. Findings are worst first. */
function standing(state: State) {
  const { current } = state;
  if (state.unmeasured) {
    return {
      measured: false,
      why: state.unmeasured,
      coverage: current.coverage,
      placeholderIcons: current.placeholderIcons,
      ...layoutsOf(state),
    };
  }
  return {
    measured: true,
    coverage: current.coverage,
    estimated: current.estimated,
    unchecked: current.unchecked,
    match: current.match,
    before: state.before.match,
    plates: current.plates,
    conformErrors: current.conformErrors,
    totalDelta: current.totalDelta,
    worstDelta: current.worstDelta,
    placeholderIcons: current.placeholderIcons,
    ...(state.unpainted.length > 0 ? { unpainted: state.unpainted } : {}),
    surfaces: current.surfaces,
    findings: current.findings,
    ...layoutsOf(state),
  };
}

/** The layouts, as the model reads them: what each container is, and what is still to ask. */
function layoutsOf(state: State) {
  if (state.layouts.length === 0) return {};
  return {
    layouts: state.layouts.map((l) => ({
      src: l.src,
      name: l.name,
      kind: l.choice.kind,
      confidence: l.confidence,
      applied: l.applied,
      decided: l.decided,
      choice: l.choice,
      ...(l.ask.length > 0 && !l.decided ? { ask: l.ask } : {}),
      ...(l.note ? { note: l.note } : {}),
    })),
  };
}

/** Layouts with a question nobody has been asked yet. */
const undecided = (state: Pick<State, "layouts">) =>
  state.layouts.filter((l) => l.ask.length > 0 && !l.decided);

/**
 * A lowering must leave the first paint as it was: the carousel's server markup IS the design
 * until Swiper runs. Within this, it is the same picture (anti-aliasing, a subpixel offset).
 */
const FIRST_PAINT_TOLERANCE = 0.05;

/** Is this change worth keeping? Pixels must not drop, and layout must not get worse. */
function refusal(
  from: Measurement,
  to: Measurement,
  built: Built,
  /** The change paints a layer the IR says is painted: evidence enough where no picture measures it. */
  evidenced = false,
): string | undefined {
  if (built.errors.length > 0) return `the validator refused it: ${built.errors.join("; ")}`;
  if (built.missing.length > 0) {
    return `nothing to apply it to, or the IR has no usable paint: ${built.missing.join(", ")}`;
  }
  if (to.match < from.match) return `match would drop from ${from.match} to ${to.match}`;
  if (to.placeholderIcons > from.placeholderIcons) {
    return `placeholder icons would rise from ${from.placeholderIcons} to ${to.placeholderIcons}`;
  }
  if (to.conformErrors > from.conformErrors) {
    return `conform errors would rise from ${from.conformErrors} to ${to.conformErrors}`;
  }
  if (!evidenced && to.match === from.match && to.conformErrors === from.conformErrors) {
    return `it changed nothing measurable (match ${to.match}, conform errors ${to.conformErrors})`;
  }
  return undefined;
}

/**
 * Does this change give a layer the paint the design has and the compile dropped?
 *
 * No screenshot holds the root's own fill in an export from before 1.9.0, so painting it moves no
 * measured pixel and would be refused as a no-op. The evidence is not a picture there: the IR says
 * the layer has that fill, and the validator has checked the token. A change that does nothing but
 * that, to a layer `frame.load` listed as unpainted, is kept without a measurement.
 */
function paintsUnpainted(state: { unpainted: Unpainted[] }, change: Overrides): boolean {
  if (state.unpainted.length === 0 || change.props.length === 0) return false;
  const only =
    change.crops.length === 0 &&
    change.drops.length === 0 &&
    change.gradients.length === 0 &&
    change.texts.length === 0;
  return (
    only &&
    change.props.every(
      (p) =>
        typeof p.props.surface === "string" &&
        Object.keys(p.props).length === 1 &&
        state.unpainted.some((u) => u.src === p.src),
    )
  );
}

/** Worth a look: enough pixels, and not just glyph edges with the box in the right place. */
/** Below this share of the frame, a match is over too little of it to be a result. */
const MIN_COVERAGE = 25;
/**
 * After this many failures of frame.look itself, a publish is no longer held for it. A step the run
 * cannot do must not be one it cannot finish without: a vision model that is down, a credential that
 * has lapsed, or a render that fails would otherwise stop every run at the gate.
 */
const MAX_LOOK_FAILURES = 2;
const ACTIONABLE_PIXELS = 100;
const GLYPH_EDGE_OFF = 15;
const MUST_EXAMINE = 5;
/** Enough looking: past this a run must be able to finish whatever is left. */
const EXAMINED_ENOUGH = 12;
/**
 * Every fix reshuffles which findings are worst, so a gate that keeps naming new nodes can use up
 * the whole step budget before the run is let publish, and then there is no preview link at all.
 * After this many refusals frame.publish goes through, and the reviewer sees what was left.
 */
const MAX_PUBLISH_REFUSALS = 2;

function unexamined(state: State): string[] {
  if (state.unmeasured) return [];
  if (state.examined.length >= EXAMINED_ENOUGH) return [];
  const nodes = state.current.findings
    .filter(
      (f) =>
        f.mismatch >= ACTIONABLE_PIXELS &&
        // a crop is the screenshot's own pixels, so frame.node has no cause to find in it
        f.type !== "Image" &&
        (f.conform.length > 0 || f.off >= GLYPH_EDGE_OFF || f.type !== "Text"),
    )
    .map((f) => f.src);
  // a surface a run has read through any of its nodes is examined
  const surfaces = (state.current.surfaces ?? [])
    .filter((f) => !state.examinedSurfaces.includes(f.surface))
    .map((f) => f.src);
  return [...new Set([...surfaces, ...nodes])]
    .slice(0, MUST_EXAMINE)
    .filter((src) => !state.examined.includes(src));
}

const merge = (a: Overrides, b: Overrides): Overrides => ({
  icons: { ...a.icons, ...b.icons },
  crops: [...new Set([...a.crops, ...b.crops])],
  drops: [...new Set([...a.drops, ...b.drops])],
  gradients: [...new Set([...a.gradients, ...b.gradients])],
  texts: [...new Set([...a.texts, ...b.texts])],
  surfaces: { ...a.surfaces, ...b.surfaces },
  props: [...a.props.filter((p) => !b.props.some((q) => q.src === p.src)), ...b.props],
  layouts: [...a.layouts.filter((l) => !b.layouts.some((m) => m.src === l.src)), ...b.layouts],
});

export function createMatchTools(
  opts: {
    dir?: string;
    engine?: Engine;
    plane?: (project: string) => ControlPlane;
    /** Where the preview link points: the Next.js site, `FANOS_WEB_URL` by default. */
    web?: string;
    /** `false` leaves frame.look out, which is how a run without eyes is made to compare with. */
    vision?: boolean;
    /** The vision call, replaceable in a test. */
    see?: See;
    /**
     * When frame.look may be called. `first` is any time. `last` refuses it until the findings the
     * publish gate asks to be examined have been, so it is the final check and not the first
     * lead: a model handed a list of leads early can follow them in place of the measured findings.
     */
    lookOrder?: "first" | "last";
    /** Cast MCP client (ADR 0022). Its read tools are added; writes are never given to this agent. */
  } = {},
) {
  const dir = opts.dir ?? MATCH_DIR;
  const engine = opts.engine ?? pipelineEngine();
  const planeOf = opts.plane ?? ((project: string) => createControlPlane(project));
  const bundles = new Map<string, Promise<Bundle>>();
  const turns = new Map<string, Promise<unknown>>();

  /** One change at a time per run: each is measured against the one before it. */
  function inTurn<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const next = (turns.get(runId) ?? Promise.resolve()).then(work, work);
    turns.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
  }

  const bundleFor = (ctx: Pick<ToolContext, "input">, themeArtifactId?: string) => {
    const { exportId, project } = inputOf(ctx);
    const key = `${project}/${exportId}/${themeArtifactId ?? ""}`;
    let held = bundles.get(key);
    if (!held) {
      held = engine.bundle(planeOf(project), exportId, themeArtifactId);
      held.catch(() => bundles.delete(key));
      bundles.set(key, held);
    }
    return held;
  };

  /** The bundle this run measured, with the placements it found. */
  const bundleOf = async (ctx: Pick<ToolContext, "input">, state: State) => {
    const bundle = await bundleFor(ctx, state.themeArtifactId);
    bundle.found ??= new Map();
    for (const [id, at] of Object.entries(state.found)) bundle.found.set(id, at);
    return bundle;
  };

  const requireState = (ctx: Pick<ToolContext, "runId">) => {
    const state = readState(dir, ctx.runId);
    if (!state) throw new Error("Nothing is loaded. Call frame.load first.");
    return state;
  };

  const noteExamined = (runId: string, src: string, surfaces: string[]) => {
    const state = readState(dir, runId);
    if (!state) return;
    writeState(dir, runId, {
      ...state,
      examined: [...new Set([...state.examined, src])],
      examinedSurfaces: [...new Set([...state.examinedSurfaces, ...surfaces])],
    });
  };

  /**
   * What each container is, and the carousels the frame shows applied.
   *
   * A `certain` carousel (a card cut off by the clip, designed arrows or dots) is applied with no
   * question: the frame shows it. It is kept only if the first paint is still the frame, measured;
   * a lowering that moves pixels is reported and left out, never shipped. Everything else is a
   * proposal until a person decides it through frame.layout.
   */
  async function detectLayouts(
    bundle: Bundle,
    overrides: Overrides,
    current: Measurement,
    measured: boolean,
  ): Promise<{
    layouts: LayoutReport[];
    overrides: Overrides;
    current: Measurement;
    built?: Built;
  }> {
    const intents = (await engine.layouts?.(bundle)) ?? [];
    const layouts: LayoutReport[] = intents.map((i) => ({
      src: i.src,
      name: i.name,
      kind: i.kind,
      confidence: i.confidence,
      evidence: i.evidence,
      ask: i.ask,
      choice: i.choice,
      // a list or a row is what the compiler drew already
      applied: i.choice.kind === "list" || i.choice.kind === "row",
      decided: false,
      ...(i.alternative ? { alternative: i.alternative } : {}),
      ...(Object.keys(i.chrome ?? {}).length > 0 ? { chrome: i.chrome } : {}),
    }));
    const certain = intents
      .filter((i) => i.confidence === "certain" && i.choice.kind === "carousel")
      .map((i) => i.choice);
    if (certain.length === 0) return { layouts, overrides, current };
    const next = { ...overrides, layouts: [...overrides.layouts, ...certain] };
    const built = await engine.build(bundle, next);
    const leftOut = (why: string) => {
      for (const l of layouts) if (certain.some((c) => c.src === l.src)) l.note = why;
      return { layouts, overrides, current };
    };
    if (built.errors.length > 0)
      return leftOut(`not applied: the validator refused it: ${built.errors.join("; ")}`);
    const after = measured ? await engine.measure(bundle, built) : current;
    if (
      measured &&
      (after.match < current.match - FIRST_PAINT_TOLERANCE ||
        after.conformErrors > current.conformErrors)
    ) {
      return leftOut(
        `not applied: as a carousel the first paint moved (match ${current.match} → ${after.match}, conform errors ${current.conformErrors} → ${after.conformErrors}), so it stays as compiled`,
      );
    }
    for (const l of layouts) {
      const note = built.layoutNotes.find((n) => n.src === l.src);
      if (!note) continue;
      l.applied = note.applied;
      if (!note.applied) l.note = note.message;
    }
    return { layouts, overrides: next, current: after, built };
  }

  const load = defineTool({
    name: "frame.load",
    description:
      "Load this run's Figma export, compile it, apply the fixes that need no judgement (tokenless gradients, placeholder icons cropped from the screenshot) and measure it against the screenshot. Takes no arguments. Returns the match, and the nodes that differ most. When no screenshot lines up with the frame it returns measured: false: publish it as it is.",
    input: noArgs,
    effect: "read",
    // A big frame measures, fixes, checks each fix and measures again; on a busy machine that
    // was past five minutes, and the model's retry only waits for the first call to finish.
    timeoutMs: 600_000,
    alwaysInline: true,
    run: (_input, ctx) =>
      inTurn(ctx.runId, async () => {
        const saved = readState(dir, ctx.runId);
        if (saved) return standing(saved);
        const bundle = await bundleFor(ctx);
        const base = await engine.build(bundle, noOverrides());
        const before = await engine.measure(bundle, base);
        // nothing to compare against: the frame can still be published, as unmeasured
        const unmeasured =
          bundle.plates.length === 0
            ? "The export has no screenshot."
            : before.coverage < MIN_COVERAGE
              ? `Only ${before.coverage}% of the frame has a screenshot that lines up with it, so a match over that says nothing about the rest.${before.plates.some((p) => p.problem) ? ` ${before.plates.map((p) => `${p.name}: ${p.problem ?? "compared"}`).join("; ")}` : ""}`
              : undefined;
        const first = await engine.firstPass(bundle, noOverrides(), before);
        const laid = await detectLayouts(bundle, first.overrides, first.measurement, !unmeasured);
        const state: State = {
          exportId: bundle.exportId,
          themeArtifactId: bundle.themeArtifactId,
          overrides: laid.overrides,
          found: Object.fromEntries(bundle.found ?? []),
          before: {
            match: before.match,
            conformErrors: before.conformErrors,
            placeholderIcons: before.placeholderIcons,
          },
          current: laid.current,
          ...(unmeasured ? { unmeasured } : {}),
          standIns: first.built.cropped.length,
          rawGradients: first.built.rawGradients,
          undone: first.undone ?? [],
          unpainted: engine.unpainted?.(bundle, first.built) ?? [],
          looks: 0,
          lookFailures: 0,
          examined: [],
          examinedSurfaces: [],
          publishRefusals: 0,
          layouts: laid.layouts,
        };
        writeState(dir, ctx.runId, state);
        return {
          frame: bundle.rootName,
          nodes: first.built.tree.nodes.length,
          applied: {
            gradients: first.overrides.gradients,
            crops: first.built.cropped.length,
            texts: first.built.addedTexts,
            // fixes tried and taken back because they made the match worse: leave them out
            undone: first.undone ?? [],
          },
          ...(undecided(state).length > 0
            ? {
                layoutNote:
                  "Some containers have questions the frame cannot answer (each layout's ask). Call frame.layout once for each, with its choice as proposed: a person reads the question and approves, or answers in plain words. Make the answer the choice and call frame.layout again.",
                layoutEvidence: Object.fromEntries(state.layouts.map((l) => [l.src, l.evidence])),
              }
            : {}),
          ...(state.unpainted.length > 0
            ? {
                unpainted: state.unpainted,
                unpaintedNote:
                  "The design paints these and the compile does not. No score sees a layer with no screenshot of its own. Give one a paint with frame.override: a surface under a new name, then props { surface } on the layer.",
              }
            : {}),
          ...standing(state),
        };
      }),
  });

  const node = defineTool({
    name: "frame.node",
    description:
      "Read one node: what the Figma IR says and what the compiled tree has. Pass src, a Figma id from a finding. Compare the two to find why it differs.",
    input: z.object({ src: z.string().min(1) }).strict(),
    effect: "read",
    timeoutMs: 30_000,
    async run({ src }, ctx) {
      const state = requireState(ctx);
      const bundle = await bundleOf(ctx, state);
      const built = await engine.build(bundle, state.overrides);
      const ir = bundle.byId.get(src);
      const nodes = built.tree.nodes.filter((n) => n.src === src);
      if (!ir && nodes.length === 0) throw new Error(`no node has src ${src}`);
      const surfaceNames = nodes.flatMap((n) =>
        n.props.surface ? [String(n.props.surface).replace(/^surface\./, "")] : [],
      );
      await inTurn(ctx.runId, async () => noteExamined(ctx.runId, src, surfaceNames));
      const { children, ...own } = ir ?? ({} as NonNullable<typeof ir>);
      return {
        ir: ir ? { ...own, childCount: children?.length ?? 0 } : null,
        gradient: ir ? (gradientOf(ir) ?? null) : null,
        tree: nodes.map((n) => ({
          ...n,
          props: typeof n.props.src === "string" ? { ...n.props, src: "<crop>" } : n.props,
        })),
        surfaces: Object.fromEntries(
          nodes.flatMap((n) => {
            const name = String(n.props.surface ?? "").replace(/^surface\./, "");
            return built.surfaces.surfaces[name] ? [[name, built.surfaces.surfaces[name]]] : [];
          }),
        ),
        notes: built.notes
          .filter((n) => n.irId === src || nodes.some((m) => m.id === n.nodeId))
          .map((n) => n.message),
      };
    },
  });

  const tokens = defineTool({
    name: "frame.tokens",
    description:
      "List the theme's tokens, as a node refers to them. Pass kind: color, space, radius, type, shadow or gradient. For color, near: a hex from a finding puts the closest first.",
    input: z
      .object({
        kind: TokenKind,
        near: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
      })
      .strict(),
    effect: "read",
    timeoutMs: 30_000,
    alwaysInline: true,
    async run({ kind, near }, ctx) {
      const state = requireState(ctx);
      const bundle = await bundleFor(ctx, state.themeArtifactId);
      return tokensOf(bundle.themeRaw, kind, near);
    },
  });

  const override = defineTool({
    name: "frame.override",
    description:
      "Add overrides, recompile and measure again. Pass any of props: [{ src, props }], surfaces: { name: spec }, crops: [src], gradients: [src], icons: { slug: glyph }. It is kept only if the match does not drop, conform errors do not rise, and something improved. Otherwise it is undone and the reason returned.",
    // A layout is not the model's to set: frame.layout, behind an approval, is the only way.
    input: Overrides.omit({ layouts: true }),
    effect: "read",
    timeoutMs: 120_000,
    alwaysInline: true,
    run: (change, ctx) =>
      inTurn(ctx.runId, async () => {
        const state = requireState(ctx);
        if (state.unmeasured) {
          return {
            kept: false,
            reason: `nothing to measure a change against: ${state.unmeasured} Call frame.publish.`,
          };
        }
        const bundle = await bundleOf(ctx, state);
        const asked = { ...change, layouts: [] };
        const overrides = merge(state.overrides, asked);
        const built = await engine.build(bundle, overrides);
        const stale = built.errors.length > 0 || built.missing.length > 0;
        const measured = stale ? state.current : await engine.measure(bundle, built);
        const refused = refusal(state.current, measured, built, paintsUnpainted(state, asked));
        if (refused) {
          return { kept: false, reason: refused, match: state.current.match };
        }
        const next: State = {
          ...state,
          overrides,
          current: measured,
          standIns: built.cropped.length,
          rawGradients: built.rawGradients,
        };
        const { published: _stale, ...unpublished } = next;
        writeState(dir, ctx.runId, unpublished);
        return { kept: true, was: state.current.match, ...standing(next) };
      }),
  });

  /** What the reviewer is shown, and what the call then runs with: the choice, in the card. */
  type LayoutAsk = {
    card: string[];
    layout: string;
    choice: LayoutChoice;
    /** A platform carousel config the reviewer gave, applied in run with the design first. */
    platform?: Record<string, unknown>;
  };
  // What the model sees is small: { src, kind, config } with config an open object. The full
  // LayoutChoice is a union of kinds with many optional fields, and as a strict tool schema its
  // grammar is more than Bedrock compiles. An open object leaves the tool out of strict mode (as
  // frame.override is), and the pipe still refuses any choice LayoutChoice does not take.
  const LayoutCall = z.object({
    choice: LayoutChoice,
    platform: z.record(z.string(), z.unknown()).optional(),
  });
  const layoutInput = z
    .object({
      choice: z
        .object({
          src: z.string().min(1),
          kind: z.enum(["carousel", "grid", "tabs", "list", "row"]),
          config: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'carousel: { slidesPerView: number or "auto", slidesPerGroup, centered, initialSlide, pages, loop, autoplay: false or { delayMs }, controls: { arrows: { placement: "edges" or "as-drawn", states }, pagination: { states } }, props: { effect, speed, easing, freeMode }, platform }. platform: a platform carousel config (slides_per_view, nav_arrows, nav_indicator, autoplay_progress, ...) the reviewer gave, passed whole as given. grid: { columns, rows }. tabs: { options, active }. list and row: none',
            ),
        })
        .strict(),
    })
    .strict()
    // A platform config rides beside the choice; code applies it, the model never translates it.
    .transform(({ choice }) => {
      const { platform, ...config } = (choice.config ?? {}) as Record<string, unknown>;
      const bare = choice.kind === "list" || choice.kind === "row";
      const kept =
        choice.config && !(bare && Object.keys(config).length === 0)
          ? { ...choice, config }
          : { src: choice.src, kind: choice.kind };
      // Pasted JSON may arrive as the text it was pasted as.
      let given: unknown = platform;
      if (typeof given === "string") {
        try {
          given = JSON.parse(given);
        } catch {
          // left as text: the pipe below refuses it, with zod's message
        }
      }
      return { choice: kept, platform: given } as z.input<typeof LayoutCall>;
    })
    .pipe(LayoutCall);
  const layout = defineTool<z.infer<typeof layoutInput>, Record<string, unknown>, LayoutAsk>({
    name: "frame.layout",
    description:
      "Decide what one container is: a carousel, a fixed row, a list, a grid or tabs. Pass { choice: { src, kind, config } }: frame.load lists each container with its evidence, the questions the frame cannot answer (ask) and a proposed choice. Call it once for each layout with questions, with the proposal as it stands. When the reviewer gives a platform carousel config (JSON with slides_per_view, nav_arrows, nav_indicator ...), call it with the proposal's config and that JSON whole as config.platform: code applies it, the design first. Needs approval: the reviewer reads the question card and approves, or answers in plain words; make that answer the choice ('autoplay every 5 seconds' is autoplay { delayMs: 5000 }, 'keep it a row' is kind row) and call it again. A carousel's first paint is the frame, so the match should not move.",
    input: layoutInput,
    effect: "write",
    timeoutMs: 120_000,
    alwaysInline: true,
    // the reviewer reads what the frame showed and what is proposed, not the model's account
    resolve({ choice, platform }, ctx) {
      const state = readState(dir, ctx.runId);
      const report = state?.layouts.find((l) => l.src === choice.src);
      const card = questionCard(report, choice);
      if (platform) card.splice(card.length - 1, 0, ...describePlatform(platform));
      return { card, choice, layout: describeChoice(choice), ...(platform ? { platform } : {}) };
    },
    run: ({ choice: asked, platform }, ctx) =>
      inTurn(ctx.runId, async () => {
        const state = requireState(ctx);
        const report = state.layouts.find((l) => l.src === asked.src);
        if (!report) {
          return {
            kept: false,
            reason: `frame.load found no repeated items in ${asked.src}. Pass the src of one of its layouts: ${state.layouts.map((l) => l.src).join(", ") || "it found none"}`,
          };
        }
        const bundle = await bundleOf(ctx, state);
        let choice: LayoutChoice = asked;
        let platformNotes: string[] | undefined;
        if (platform) {
          if (asked.kind !== "carousel") {
            return {
              kept: false,
              reason:
                "a platform carousel config applies to a carousel: pass kind carousel with it",
            };
          }
          if (!engine.platform)
            return {
              kept: false,
              reason: "platform configs are read by the pipeline, which is not loaded",
            };
          const colors = new Set(
            tokensOf(bundle.themeRaw, "color", undefined, 10_000).map((t) =>
              t.ref.replace(/^color\./, ""),
            ),
          );
          const read: PlatformRead = await engine.platform(platform, colors);
          const applied = withPlatform(asked, read, {
            arrows: Boolean(report.chrome?.prev || report.chrome?.next),
            indicator: Boolean(report.chrome?.pagination),
          });
          choice = applied.choice;
          platformNotes = applied.notes;
        }
        const overrides = {
          ...state.overrides,
          layouts: [...state.overrides.layouts.filter((l) => l.src !== choice.src), choice],
        };
        const built = await engine.build(bundle, overrides);
        if (built.errors.length > 0) {
          return {
            kept: false,
            reason: `the validator refused it: ${built.errors.join("; ")}`,
            match: state.current.match,
          };
        }
        const note = built.layoutNotes.find((n) => n.src === choice.src);
        const applied = choice.kind === "list" || choice.kind === "row" || note?.applied === true;
        const measured = state.unmeasured ? state.current : await engine.measure(bundle, built);
        const layouts = state.layouts.map((l): LayoutReport => {
          if (l.src !== choice.src) return l;
          const { note: _was, ...rest } = l;
          return {
            ...rest,
            choice,
            decided: true,
            applied,
            ...(applied || !note ? {} : { note: note.message }),
          };
        });
        const next: State = {
          ...state,
          overrides,
          current: measured,
          layouts,
          standIns: built.cropped.length,
          rawGradients: built.rawGradients,
        };
        const { published: _stale, ...unpublished } = next;
        writeState(dir, ctx.runId, unpublished);
        return {
          kept: true,
          layout: describeChoice(choice),
          applied,
          ...(note && !applied ? { note: note.message } : {}),
          ...(platformNotes
            ? { platform: platformNotes.length > 0 ? platformNotes : ["applied as given"] }
            : {}),
          ...(state.unmeasured ? {} : { was: state.current.match }),
          ...standing(next),
        };
      }),
  });

  const publish = defineTool<
    z.infer<typeof noArgs>,
    z.infer<typeof Published>,
    Record<string, unknown>
  >({
    name: "frame.publish",
    description:
      "Store the frame in the control plane and return its preview link. Takes no arguments. Needs approval, and the reviewer sees the measured numbers, or that none could be measured.",
    input: noArgs,
    effect: "write",
    timeoutMs: 60_000,
    // the approval shows numbers measured by code, never the model's account of them
    resolve(_input, ctx) {
      const state = readState(dir, ctx.runId);
      if (!state) return {};
      return {
        exportId: state.exportId,
        measured: !state.unmeasured,
        coverage: state.current.coverage,
        estimated: state.current.estimated,
        ...(state.unmeasured
          ? { unmeasured: state.unmeasured }
          : { before: state.before.match, match: state.current.match }),
        conformErrors: state.current.conformErrors,
        placeholderIcons: state.current.placeholderIcons,
        standIns: state.standIns,
        rawGradients: state.rawGradients,
        unexamined: unexamined(state),
        remaining: state.current.findings
          .slice(0, 5)
          .map((f) => `${f.src} ${f.type}: ${f.mismatch}px`),
      };
    },
    block(_input, ctx) {
      const state = readState(dir, ctx.runId);
      if (!state) return "Nothing is loaded. Call frame.load first.";
      // What a container is can only be asked of a person; a frame published without asking ships
      // a guess. Each question is asked once: an answer, or an approval of the proposal, settles it.
      const open = undecided(state);
      if (open.length > 0) {
        return `Not yet. Ask about these layouts with frame.layout, with each one's proposed choice: ${open.map((l) => `"${l.name}" (${l.src})`).join(", ")}`;
      }
      // The score is blind to some of the worst defects, and a model that is only told to look
      // sometimes doesn't. A run made without eyes answers the call too, so the two read the same.
      if (
        engine.look &&
        !state.unmeasured &&
        state.looks === 0 &&
        state.lookFailures < MAX_LOOK_FAILURES
      ) {
        return "Not yet. Call frame.look once: it shows what the score cannot, such as text on the wrong edge or a background nothing compares.";
      }
      const waiting = unexamined(state);
      if (waiting.length === 0 || state.publishRefusals >= MAX_PUBLISH_REFUSALS) return undefined;
      const refusals = state.publishRefusals + 1;
      writeState(dir, ctx.runId, { ...state, publishRefusals: refusals });
      return `Not yet (${refusals} of ${MAX_PUBLISH_REFUSALS}; the next frame.publish goes through). Examine these with frame.node, and fix what has a cause: ${waiting.join(", ")}`;
    },
    async run(_input, ctx) {
      return inTurn(ctx.runId, async () => {
        const state = requireState(ctx);
        if (state.published) return state.published;
        const { project } = inputOf(ctx);
        const plane = planeOf(project);
        const bundle = await bundleOf(ctx, state);
        const built = await engine.build(bundle, state.overrides);
        if (built.errors.length > 0) throw new Error(built.errors.join("; "));
        // the numbers shown are of the tree that was measured, so this has to be that tree
        if (built.cropped.length !== state.standIns) {
          throw new Error(
            `the rebuilt frame has ${built.cropped.length} crops and the measured one had ${state.standIns}, so its numbers would not be about it`,
          );
        }
        const meta = { exportId: state.exportId, source: "dugout:frame-match", runId: ctx.runId };
        const themeArtifactId =
          state.overrides.gradients.length > 0
            ? await plane.upload("token_set", built.themeRaw, meta)
            : state.themeArtifactId;
        const surfaceArtifactId = await plane.upload("surface_set", built.surfaces, meta);
        const treeArtifactId = await plane.upload("dsl_tree", built.tree, meta);
        const width = Math.round(bundle.doc.root.geometry.bbox.w);
        const query = new URLSearchParams({
          theme: themeArtifactId,
          surfaces: surfaceArtifactId,
          width: String(width),
          bg: PAGE.slice(1),
        });
        const published = {
          treeArtifactId,
          surfaceArtifactId,
          themeArtifactId,
          previewUrl: `${opts.web ?? webUrl()}/preview/${encodeURIComponent(project)}/${treeArtifactId}?${query}`,
          measured: !state.unmeasured,
          coverage: state.current.coverage,
          estimated: state.current.estimated,
          unchecked: state.current.unchecked,
          placeholderIcons: state.current.placeholderIcons,
          ...(state.unmeasured ? {} : { before: state.before.match, match: state.current.match }),
        };
        writeState(dir, ctx.runId, { ...state, published });
        return published;
      });
    },
  });

  const see: See =
    opts.see ??
    ((png, prompt, signal) =>
      describeImage({ png, prompt, model: "sonnet", ...(signal ? { signal } : {}) }));

  const lookInput = z
    .object({
      region: z
        .object({
          x: z.number().min(0),
          y: z.number().min(0),
          w: z.number().positive(),
          h: z.number().positive(),
        })
        .strict()
        .optional(),
      focus: z.string().max(200).optional(),
    })
    .strict();

  const lookLast = opts.lookOrder === "last";
  const lookWhen = lookLast
    ? "Call it LAST, once you have worked through the measured findings and before frame.publish: it is the final check for what the score cannot see, and it is refused until then. Do not call it again after every change."
    : "It costs a vision call per band, so look after frame.load and once more before frame.publish, not after every change.";
  const lookTool = defineTool({
    name: "frame.look",
    description: `Compare the design with the rebuild by eye. A vision model reads them side by side and lists what a person would notice and the score cannot: text drawn from the wrong edge, a missing background or gradient, a picture cropped differently, something overlapping. Pass nothing to look at the whole frame (a tall one is read in bands), or region { x, y, w, h } in frame pixels to look closer, or focus to say what to check. Each difference comes with where it is and the layers under that place: read one with frame.node, then fix it with frame.override. A vision model invents differences, so a lead that frame.node does not bear out is not one. ${lookWhen}`,
    input: lookInput,
    effect: "read",
    timeoutMs: 240_000,
    run: (input, ctx) =>
      inTurn(ctx.runId, async () => {
        if (!engine.look) throw new Error("this run cannot render a comparison");
        const state = requireState(ctx);
        if (state.unmeasured) {
          throw new Error(
            "No screenshot lines up with the frame, so there is no design picture to compare. Publish what the compiler made.",
          );
        }
        if (lookLast) {
          const waiting = unexamined(state);
          if (waiting.length > 0) {
            throw new Error(
              `Not yet. frame.look is the last check: work the measured findings first. Still to examine with frame.node: ${waiting.join(", ")}`,
            );
          }
        }
        const bundle = await bundleOf(ctx, state);
        const built = await engine.build(bundle, state.overrides);
        let looked: Looked;
        try {
          looked = await engine.look(bundle, built, input, see, ctx.signal);
        } catch (err) {
          // a region outside the frame is the caller's mistake, not a vision model that is down
          if (err instanceof LookInputError) throw err;
          const failures = state.lookFailures + 1;
          writeState(dir, ctx.runId, { ...state, lookFailures: failures });
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(
            failures >= MAX_LOOK_FAILURES
              ? `${why} frame.look has failed ${failures} times, so frame.publish is no longer held for it. Publish, and say in remaining that nothing looked at the frame.`
              : why,
          );
        }
        writeState(dir, ctx.runId, { ...state, looks: state.looks + 1 });
        return {
          bands: looked.bands,
          differences: looked.differences.slice(0, 12),
          ...(looked.differences.length === 0
            ? { note: "The vision model sees no difference a person would notice." }
            : {
                note: "Where a difference falls on a layer you can change, read it with frame.node. A vision model can be wrong: a difference it names that frame.node does not bear out is not one.",
              }),
        };
      }),
  });

  /**
   * The same tool name with no eyes behind it. A run made to compare against must read the same
   * instructions as one that can look, so the call is answered rather than unknown: the one wasted
   * step is the price of a fair comparison, and it is counted against the run without eyes.
   */
  const noEyes = defineTool({
    name: "frame.look",
    description: lookTool.description,
    input: lookInput,
    effect: "read",
    timeoutMs: 10_000,
    run: (_input, ctx) =>
      inTurn(ctx.runId, async () => {
        const state = readState(dir, ctx.runId);
        if (state) writeState(dir, ctx.runId, { ...state, looks: state.looks + 1 });
        return {
          available: false,
          note: "frame.look is not available in this run. Go on without it.",
        };
      }),
  });

  return [load, node, tokens, override, layout, opts.vision === false ? noEyes : lookTool, publish];
}
