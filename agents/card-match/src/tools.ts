import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolContext } from "@dugout/contracts";
import { describeImage, REPO_ROOT } from "@dugout/core";
import { z } from "zod";
import { type ControlPlane, createControlPlane, studioUrl } from "./control-plane.ts";
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
import { type Looked, LookInputError, look, type See } from "./look.ts";
import { loadToolchain, type Toolchain } from "./toolchain.ts";

export const MATCH_DIR = join(REPO_ROOT, ".runs", "card-match");

/** The compile, render and compare steps, so a test can run the tools without a trial checkout. */
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
}

export function trialEngine(tools?: Toolchain): Engine {
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
  };
}

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
});

export function createMatchTools(
  opts: {
    dir?: string;
    engine?: Engine;
    plane?: (project: string) => ControlPlane;
    studio?: string;
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
  } = {},
) {
  const dir = opts.dir ?? MATCH_DIR;
  const engine = opts.engine ?? trialEngine();
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
        const state: State = {
          exportId: bundle.exportId,
          themeArtifactId: bundle.themeArtifactId,
          overrides: first.overrides,
          found: Object.fromEntries(bundle.found ?? []),
          before: {
            match: before.match,
            conformErrors: before.conformErrors,
            placeholderIcons: before.placeholderIcons,
          },
          current: first.measurement,
          ...(unmeasured ? { unmeasured } : {}),
          standIns: first.built.cropped.length,
          undone: first.undone ?? [],
          unpainted: engine.unpainted?.(bundle, first.built) ?? [],
          looks: 0,
          lookFailures: 0,
          examined: [],
          examinedSurfaces: [],
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
    input: Overrides,
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
        const overrides = merge(state.overrides, change);
        const built = await engine.build(bundle, overrides);
        const stale = built.errors.length > 0 || built.missing.length > 0;
        const measured = stale ? state.current : await engine.measure(bundle, built);
        const refused = refusal(state.current, measured, built, paintsUnpainted(state, change));
        if (refused) {
          return { kept: false, reason: refused, match: state.current.match };
        }
        const next: State = {
          ...state,
          overrides,
          current: measured,
          standIns: built.cropped.length,
        };
        const { published: _stale, ...unpublished } = next;
        writeState(dir, ctx.runId, unpublished);
        return { kept: true, was: state.current.match, ...standing(next) };
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
        rawGradients: state.overrides.gradients.length,
        remaining: state.current.findings
          .slice(0, 5)
          .map((f) => `${f.src} ${f.type}: ${f.mismatch}px`),
      };
    },
    block(_input, ctx) {
      const state = readState(dir, ctx.runId);
      if (!state) return "Nothing is loaded. Call frame.load first.";
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
      return waiting.length > 0
        ? `Not yet. Examine these with frame.node, and fix what has a cause: ${waiting.join(", ")}`
        : undefined;
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
        const meta = { exportId: state.exportId, source: "dugout:card-match", runId: ctx.runId };
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
          previewUrl: `${opts.studio ?? studioUrl()}/v1/preview/${treeArtifactId}?${query}`,
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

  return [load, node, tokens, override, opts.vision === false ? noEyes : lookTool, publish];
}
