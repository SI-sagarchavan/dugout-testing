import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defineState,
  defineTool,
  NeedsSetup,
  type OpenItem,
  Settled,
  type ToolContext,
} from "@dugout/contracts";
import { describeImage, REPO_ROOT } from "@dugout/core";
import type { Pool } from "@dugout/db";
import { recordPageChoices } from "@dugout/db/page-choices";
import {
  answerText,
  BEFORE_RULE,
  builtFor,
  decidedBefore,
  decisionKey,
  LESSONS_RULE,
  type LikeFinder,
  lessonsFor,
  type MemoryReader,
  PATTERNS_RULE,
  patternsFor,
} from "@dugout/memory";
import { z } from "zod";
import { Content, contentOf, settledContent } from "./content.ts";
import { type ControlPlane, createControlPlane, webUrl } from "./control-plane.ts";
import {
  type Built,
  type Bundle,
  backdropCandidates,
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
  toneAgainstDesign,
  type Unpainted,
  unpaintedLayers,
} from "./frame.ts";
import {
  createHandoffSource,
  type FrameSource,
  handoffConfig,
  readTenantTheme,
} from "./handoff.ts";
import {
  describeChoice,
  describePlatform,
  LAYOUT_FACTS,
  type LayoutBefore,
  LayoutChoice,
  type LayoutIntent,
  type LayoutReport,
  openLayoutItems,
  type PlatformConflict,
  type PlatformRead,
  settledLayout,
  withPlatform,
  withStructure,
} from "./layout.ts";
import { type Looked, LookInputError, look, type See } from "./look.ts";
import { NOTES_RULE } from "./notes.ts";
import { type Read, type Reading, readFrame, unread } from "./read.ts";

import {
  type FoundSlots,
  findFrameSlots,
  type Join,
  ownersOf,
  SlotReport,
  type SlotShape,
  SPLIT_QUESTION,
  slotted,
  splitChoices,
  splitOpen,
} from "./slots.ts";
import { loadToolchain, type PageChoice, type Toolchain } from "./toolchain.ts";

/** This agent's id, as its decisions are kept under (ADR 0033). */
const AGENT_ID = "frame-match";

/**
 * What a person calls a section: its frame's name, or, when Figma named it (`Frame 1984078815`),
 * the first thing it says ("THE BRAVE SQUAD").
 */
export function sectionName(
  frame: string,
  tree: { nodes: Array<{ type: string; props: Record<string, unknown> }> },
): string {
  if (!/^(frame|group|rectangle)\s*\d*$/i.test(frame.trim())) return frame;
  const said = tree.nodes.find((n) => n.type === "Text" && typeof n.props.content === "string");
  return typeof said?.props.content === "string" ? said.props.content : frame;
}

/** What frame.publish made, kept in the run's state for the checks on `final` (ADR 0035). */
export const PUBLISHED = defineState<Record<string, unknown>>("frame.published");
/** The ids of the designer's notes frame.load listed, kept the same way. */
export const LISTED_NOTES = defineState<string[]>("frame.notes");

/** A page choice as published: `_page.<key>`, its options, where it starts. */
export const PageChoiceSchema = z.object({
  key: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })),
  initial: z.string(),
  /** The slot that draws it: only its nodes read the choice, unless a read from elsewhere was asked for. */
  owner: z.string().optional(),
});

export const MATCH_DIR = join(REPO_ROOT, ".runs", "frame-match");

/** Who settled one open item: what a tool that applies a decision is told, beside the decision. */
const SettledBy = z
  .object({
    id: z
      .string()
      .min(1)
      .describe("The open item's id (kind, items, autoplay, loop, platform, section_split ...)"),
    by: z
      .enum(["person", "memory", "agent"])
      .describe(
        "person: a person answered your ask. memory: you took it from the item's `before`. agent: you decided it from the evidence",
      ),
  })
  .strict();
const SETTLED_BY_HELP =
  "For each open item of this call, who settled it: { id, by }. Items you leave out are recorded as settled by you (agent). A claim of memory is kept only when the item has a `before`";

/** The compile, render and compare steps, so a test can run the tools without a built pipeline. */
export interface Engine {
  /** `source` reads the frame's own files when they are not the control plane's (a Handoff). */
  bundle(
    plane: ControlPlane,
    exportId: string,
    themeArtifactId?: string,
    source?: FrameSource,
  ): Promise<Bundle>;
  build(bundle: Bundle, overrides: Overrides): Promise<Built>;
  measure(bundle: Bundle, built: Built): Promise<Measurement>;
  firstPass(
    bundle: Bundle,
    start: Overrides,
    plain?: Measurement,
  ): Promise<{
    overrides: Overrides;
    built: Built;
    measurement: Measurement;
    undone?: string[];
    noPicture?: string[];
    noToken?: string[];
  }>;
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
  /** What each container of the frame is, by the IR alone (`@fanos/compile` `detectLayout`): evidence. */
  layouts?(bundle: Bundle): Promise<LayoutIntent[]>;
  /** The frame read by eye, every claim checked against the IR (`read.ts`). Throws when it cannot. */
  read?(bundle: Bundle, read: Read, signal?: AbortSignal): Promise<Reading>;
  /** The page choices a built frame writes: its tabs (`@fanos/dsl` `pageChoices`). */
  choices?(built: Built): Promise<PageChoice[]>;
  /**
   * The slots of the frame: the parts that each show one kind of data (`findSlots`). `apart` keeps
   * parts the finder would join for sitting side by side.
   */
  slots?(
    bundle: Bundle,
    joins?: readonly Join[],
    shape?: SlotShape,
    apart?: readonly Join[],
  ): Promise<FoundSlots>;
  /** A platform carousel config as Carousel props, its colours checked against the theme. */
  platform?(json: unknown, colors: ReadonlySet<string>): Promise<PlatformRead>;
}

export function pipelineEngine(tools?: Toolchain): Engine {
  const load = async () => tools ?? (await loadToolchain());
  return {
    bundle: async (plane, exportId, theme, source) =>
      loadBundle(await load(), plane, exportId, theme, source),
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
    read: async (bundle, read, signal) =>
      readFrame({ tools: await load(), bundle, read, ...(signal ? { signal } : {}) }),
    choices: async (built) => (await load()).pageChoices(built.tree),
    slots: async (bundle, joins, shape, apart) =>
      findFrameSlots(await load(), bundle, joins, shape, apart),
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
  /**
   * Pictures and icons the export has no picture of on their own, left as compiled. They are never
   * cut from a section's screenshot, which would bake in whatever is painted over them.
   */
  noPicture: z.array(z.string()).default([]),
  /** Gradients the tenant's FanXP theme has no token for, left unpainted: add them to the theme. */
  noToken: z.array(z.string()).default([]),
  before: z.number().optional(),
  match: z.number().optional(),
  /** Whether anything on the section is data: none means there is nothing to bind. */
  content: Content.optional(),
  /** What the section's tabs write to its page, for any section to read (`_page.<key>`). */
  choices: z.array(PageChoiceSchema).default([]),
  /** The parts of the frame that each show one kind of data, and what each owns. */
  slots: z.array(SlotReport).default([]),
  /** How each open item was settled, and by whom (frame.layout, frame.split). */
  settled: z.array(Settled).default([]),
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
  /** Pictures and icons with no picture of their own in the export, left as compiled. */
  noPicture: z.array(z.string()).default([]),
  /** Gradients the tenant's FanXP theme has no token for, left unpainted. */
  noToken: z.array(z.string()).default([]),
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
  /** Changes kept although they cost score or moved nothing measured: what they cost, and the agent's why. */
  despite: z.array(z.string()).default([]),
  /** What each container is: read by frame.load, decided through frame.layout. */
  layouts: z.array(z.custom<LayoutReport>()).default([]),
  /** The frame as frame.load read it: its experience, its parts, what it groups as one. */
  reading: z.custom<Reading>().optional(),
  /** What is open about each container (by its src), as frame.load reported it, with memory's `before`. */
  open: z.record(z.string(), z.array(z.custom<OpenItem>())).default({}),
  /** What is open about which parts are one section, and whether frame.split has settled it. */
  split: z.object({ item: z.custom<OpenItem>(), settled: z.boolean() }).optional(),
  /** How each open item was settled, and by whom. */
  settled: z.array(Settled).default([]),
  /** What the signs propose about whether the whole frame shows data, before its slots are looked at. */
  frameContent: Content.optional(),
  /** What the signs propose about whether the section shows data: the agent settles it at frame.publish. */
  content: Content.optional(),
  /** The frame's slots, read by frame.load (and again by frame.split). */
  slots: z.custom<FoundSlots>().optional(),
  /** What the signs propose for each slot: the agent settles each at frame.publish. */
  slotContent: z.array(Content).default([]),
  published: Published.optional(),
});
type State = z.infer<typeof State>;

type SlottedNode = Parameters<typeof slotted>[0]["nodes"][number];

/** The slots' choices: each slot's own nodes asked what they write. */
async function slottedBy(
  choicesOf: NonNullable<Engine["choices"]>,
  built: Built,
  found: FoundSlots,
) {
  const tree = built.tree as unknown as { nodes: SlottedNode[] };
  const byNodes = new Map<SlottedNode[], PageChoice[]>();
  // slotted asks synchronously, so the answers are read first: each slot's nodes in turn
  const owners = ownersOf(tree.nodes, found);
  const several = found.slots.length > 1;
  const sets = several
    ? found.slots.map((_, i) => tree.nodes.filter((n) => owners.get(n.id) === i))
    : [tree.nodes];
  for (const nodes of sets) {
    byNodes.set(
      nodes,
      await choicesOf({ ...built, tree: { ...built.tree, nodes } as Built["tree"] }),
    );
  }
  return slotted(tree, found, (nodes) => {
    for (const [set, answer] of byNodes) {
      if (set.length === nodes.length && set.every((n, i) => n === nodes[i])) return answer;
    }
    return [];
  });
}

/** What the run says of each slot: the tree nodes it owns, whether it shows data, what it writes and reads. */
function reportOf(
  state: State,
  split: { owners: Map<string, number>; writes: string[][]; reads: string[][] },
  contents: readonly Content[],
): SlotReport[] {
  return (state.slots?.slots ?? []).map((s, i) => ({
    id: s.id,
    name: s.name,
    nodes: [...split.owners].filter(([, at]) => at === i).map(([id]) => id),
    content: contents[i] ?? { data: "unsure", evidence: [] },
    writes: split.writes[i] ?? [],
    reads: split.reads[i] ?? [],
    signature: s.signature,
    confidence: s.confidence,
    ...(s.why ? { why: s.why } : {}),
  }));
}

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RunInput = z
  .object({
    exportId: z
      .string()
      .regex(UUID)
      .optional()
      .describe("The export a designer's Handoff stored in the control plane"),
    handoffId: z
      .string()
      .regex(UUID)
      .optional()
      .describe(
        "A Handoff the FanXP backend received: its files are read from S3 through the backend",
      ),
    project: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default("default")
      .describe("The control plane project the export is in, and where results are stored"),
    receivedAt: z.string().optional().describe("When the control plane received the export"),
  })
  .refine((input) => Boolean(input.exportId) !== Boolean(input.handoffId), {
    message: "Give exportId or handoffId, not both",
  });

/** The frame a run works on: a Handoff's id, or an export's. */
export const frameIdOf = (input: z.infer<typeof RunInput>): string =>
  (input.handoffId ?? input.exportId) as string;

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
      ...openNote(state),
    };
  }
  // what frame.publish will refuse over, said with every result: a model told only at the refusal
  // spends a turn on a publish that cannot go through
  const examine = unexamined(state);
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
    ...(examine.length > 0 ? { examineBeforePublish: examine } : {}),
    ...layoutsOf(state),
    ...openNote(state),
  };
}

/** What the slot finder takes from the reading: each container's kind, and the layers that are one part. */
function shapeOf(reading: Reading): SlotShape {
  return {
    layouts: reading.layouts.map((l) => ({ src: l.src, kind: l.choice.kind })),
    groups: reading.groups,
  };
}

/** The reading, as the model reads it: what the frame is for, its parts, what was not borne out. */
function readingOf(reading: Reading) {
  return {
    ...(reading.experience ? { experience: reading.experience } : {}),
    parts: reading.parts,
    ...(reading.unsure.length > 0 ? { unsure: reading.unsure } : {}),
    ...(reading.dropped.length > 0 ? { notBorneOut: reading.dropped } : {}),
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
      ...(l.score !== undefined ? { score: l.score } : {}),
      applied: l.applied,
      decided: l.decided,
      choice: l.choice,
      evidence: l.evidence,
      ...(l.note ? { note: l.note } : {}),
    })),
  };
}

/** Containers with open items that frame.layout has not settled yet. */
const undecided = (state: Pick<State, "layouts" | "open">) =>
  state.layouts.filter((l) => (state.open[l.src]?.length ?? 0) > 0 && !l.decided);

/** The candidates for whether a section shows data. */
const CONTENT_CANDIDATES = [
  { value: "none", does: "nothing on it is data: published as it is, nothing is bound" },
  { value: "some", does: "it shows data: the binding stage finds its source after publishing" },
];

type ContentState = Pick<State, "content" | "slots" | "slotContent">;

/**
 * Whether the section shows data, as an open item: the signs code read, with its proposal, for the
 * whole frame or for each of its parts. The agent settles it in frame.publish's `content` (and
 * `slots`, one for each part when there are several).
 */
export function contentOpen(state: ContentState): OpenItem | undefined {
  const content = state.content;
  if (!content) return undefined;
  const parts = state.slots?.slots ?? [];
  const several = parts.length > 1;
  const signs = (c: Content | undefined) =>
    c ? `proposed ${c.data}: ${c.evidence.join("; ") || "no signs"}` : "no signs read";
  return {
    id: "content",
    about: several
      ? "whether each part of the frame shows data, to be bound to a source"
      : "whether anything on the section is data, to be bound to a source",
    evidence: several
      ? `The frame has ${parts.length} parts, each bound to its own data. ${parts.map((p, i) => `${p.name} [${p.id}]: ${signs(state.slotContent[i])}`).join(" | ")}`
      : `The signs: ${signs(content)}.`,
    candidates: CONTENT_CANDIDATES,
    ...(content.data === "unsure" ? {} : { proposed: content.data }),
    canTake: several
      ? "frame.publish's content { data, why, by } for the whole frame (some when any part is), and its slots: one { id, data, why, by } for each part above"
      : "frame.publish's content { data, why, by }, with slots []",
    holds: "section",
  };
}

type OpenState = Pick<State, "layouts" | "open" | "split" | "published"> & ContentState;

/** What is still open: each undecided container's items, the split while it is not settled, and the content until it is published. */
function openOf(state: OpenState): OpenItem[] {
  const content = state.published ? undefined : contentOpen(state);
  return [
    ...undecided(state).flatMap((l) => state.open[l.src] ?? []),
    ...(state.split && !state.split.settled ? [state.split.item] : []),
    ...(content ? [content] : []),
  ];
}

/** What `open` is, and what to do with it (the same rule data-bind's open items follow). */
const OPEN_RULE =
  "These are what the tools could not settle about the frame. For each one: settle it from memory when `before` holds an active answer; decide it yourself, saying why, when the evidence settles it; or ask a person with `ask`, using the item's id, with remember set to the item's holds and fact to its fact (empty when it has none). Write the question, its options and its why yourself from the evidence, the candidates and canTake: offer every candidate, and say what else canTake accepts (a text option, or the question itself). Pass what was decided to the tool that acts on it as ordinary input: frame.layout for a container (its choice and config), frame.split for which parts are one section, frame.publish's content for whether the section shows data; say who decided each item (person, memory or agent) in `settled`, or in content's `by`.";

/** What the model reads of what is open: the items, and the rule for them. Nothing when none is. */
function openNote(state: OpenState) {
  const open = openOf(state);
  return open.length > 0 ? { open, openRule: OPEN_RULE } : {};
}

/** Why a change cannot be applied at all: the validator refused it, or it names nothing to apply to. */
function unappliable(built: Built): string | undefined {
  if (built.errors.length > 0) return `the validator refused it: ${built.errors.join("; ")}`;
  if (built.missing.length > 0) {
    return `nothing to apply it to, or the IR has no usable paint: ${built.missing.join(", ")}`;
  }
  return undefined;
}

/**
 * What a change costs, measured against the frame before it: each way it is worse, or that it
 * moved nothing measured. Empty when it helped. One rule for every change: a change with a cost is
 * kept only when the agent says why (`keep`), and the cost and the why are kept for the reviewer.
 */
function costOf(from: Measurement, to: Measurement): string[] {
  const out: string[] = [];
  if (to.match < from.match) out.push(`match drops from ${from.match} to ${to.match}`);
  if (to.placeholderIcons > from.placeholderIcons) {
    out.push(`placeholder icons rise from ${from.placeholderIcons} to ${to.placeholderIcons}`);
  }
  if (to.conformErrors > from.conformErrors) {
    out.push(`conform errors rise from ${from.conformErrors} to ${to.conformErrors}`);
  }
  if (out.length === 0 && to.match === from.match && to.conformErrors === from.conformErrors) {
    out.push(`it moves nothing measured (match ${to.match}, conform errors ${to.conformErrors})`);
  }
  return out;
}

/** A change in a few words, for the reviewer's list of what was kept despite its cost. */
function changeLine(change: Partial<Overrides>): string {
  const parts = [
    ...(change.props ?? []).map((p) => `props on ${p.src}: ${Object.keys(p.props).join(", ")}`),
    ...Object.keys(change.surfaces ?? {}).map((n) => `surface ${n}`),
    ...(change.crops ?? []).map((src) => `crop ${src}`),
    ...(change.backdrops ?? []).map((src) => `backdrop ${src}`),
    ...(change.drops ?? []).map((src) => `drop ${src}`),
    ...(change.gradients ?? []).map((src) => `gradient ${src}`),
    ...(change.texts ?? []).map((src) => `text ${src}`),
    ...Object.keys(change.icons ?? {}).map((slug) => `icon ${slug}`),
  ];
  return parts.join("; ") || "an empty change";
}

/** Below this share of the frame, a match is over too little of it to be a result. */
const MIN_COVERAGE = 25;
/**
 * After this many failures of frame.look itself, a publish is no longer held for it. A step the run
 * cannot do must not be one it cannot finish without: a vision model that is down, a credential that
 * has lapsed, or a render that fails would otherwise stop every run at the gate.
 */
const MAX_LOOK_FAILURES = 2;
/** A finding this many pixels off or more is listed for examining before publishing. */
const ACTIONABLE_PIXELS = 100;
/** At most this many findings are listed at once: a bounded nudge, not a gate on every pixel. */
const MUST_EXAMINE = 5;
/** Enough looking: past this a run must be able to finish whatever is left. */
const EXAMINED_ENOUGH = 12;
/**
 * Every fix reshuffles which findings are worst, so a gate that keeps naming new nodes can use up
 * the whole step budget before the run is let publish, and then there is no preview link at all.
 * After this many refusals frame.publish goes through, and the reviewer sees what was left.
 *
 * Each refusal sends the run back to examine the findings it names and fix their causes, and then
 * it asks again: that is the loop, so the gate is advisory (`advisoryBlock`) and asking again does
 * not end the run as a repeated refused call would. It is still bounded, so a model that will not
 * examine anything costs a few steps and no more, and a run always ends with a preview link.
 */
export const MAX_PUBLISH_REFUSALS = 4;

/** One line for a finding the gate wants looked at: where it is and how far off. */
function describeFinding(state: State, src: string): string {
  const node = state.current.findings.find((f) => f.src === src);
  if (node)
    return `${src} (${node.type}, ${node.mismatch}px off, design ${node.design} but renders ${node.render})`;
  const surface = (state.current.surfaces ?? []).find((f) => f.src === src);
  if (surface) {
    return `${src} (surface ${surface.surface}, ${surface.mismatch}px off, ${Math.round(surface.offShare * 100)}% of what it draws, design ${surface.design} but renders ${surface.render})`;
  }
  return src;
}

function unexamined(state: State): string[] {
  if (state.unmeasured) return [];
  if (state.examined.length >= EXAMINED_ENOUGH) return [];
  const nodes = state.current.findings
    .filter(
      (f) =>
        f.mismatch >= ACTIONABLE_PIXELS &&
        // a crop is the screenshot's own pixels: there is nothing in the tree to read about them
        f.type !== "Image",
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
  backdrops: [...new Set([...a.backdrops, ...b.backdrops])],
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
    /** Reads a Handoff's files for the run's tenant. The FanXP backend (`SURFACE_API_URL`) by default. */
    handoffs?: (tenantId: string, handoffId: string) => FrameSource;
    /**
     * The tenant's active FanXP theme, as a token set: what a Handoff is built against. FanXP is the
     * source of truth for tokens, and Surface Studio draws with nothing else. The FanXP backend
     * (`SURFACE_API_URL`) by default.
     */
    tenantTheme?: (tenantId: string) => ReturnType<typeof readTenantTheme>;
    /** Where the preview link points: the host of the link, `FANOS_WEB_URL` by default; it names the tree and need not be served. */
    web?: string;
    /** `false` leaves frame.look out, which is how a run without eyes is made to compare with. */
    vision?: boolean;
    /** The vision call, replaceable in a test. */
    see?: See;
    /**
     * The first look at the frame (`read.ts`), replaceable in a test. `false` (or
     * `FRAME_MATCH_READ=off`) leaves it out: what the IR shows is put to the agent instead.
     */
    read?: Read | false;
    /**
     * When frame.look may be called. `first` is any time. `last` refuses it until the findings the
     * publish gate asks to be examined have been, so it is the final check and not the first
     * lead: a model handed a list of leads early can follow them in place of the measured findings.
     */
    lookOrder?: "first" | "last";
    /**
     * The harness's pool: where a published section's page choices are recorded, for sections
     * built later to read (ADR 0032). Without it nothing is recorded.
     */
    pool?: Pool;
    /**
     * What people decided about a section before (ADR 0033), and the club's facts: read for
     * frame.load's `before` and for each open item's own `before`. Code never applies them: the
     * model settles an item from memory, or asks.
     */
    decisions?: Pick<MemoryReader, "decisionsOn"> &
      Partial<Pick<MemoryReader, "decision" | "fact" | "builds" | "lessonsOn" | "activeFacts">>;
    /** Which of the tenant's sections are like one, for `built.like` (ADR 0034). */
    like?: LikeFinder;
    /** Cast MCP client (ADR 0022). Its read tools are added; writes are never given to this agent. */
  } = {},
) {
  const dir = opts.dir ?? MATCH_DIR;
  const engine = opts.engine ?? pipelineEngine();

  /**
   * What memory holds for one open item (ADR 0033): a person's decision on this section, else the
   * club's active fact for it. Told as a line, for the model to settle the item from or to ask
   * about; never applied by code.
   */
  const beforeOf = async (
    tenantId: string,
    section: string | undefined,
    id: string,
    fact?: string,
  ): Promise<string | undefined> => {
    const decided = section
      ? await opts.decisions
          ?.decision?.(tenantId, decisionKey(AGENT_ID, id, section))
          .catch(() => undefined)
      : undefined;
    if (decided?.value !== undefined && decided.value !== null) {
      return `decided on this section before: ${answerText(decided.value)}`;
    }
    const known = fact
      ? await opts.decisions?.fact?.(tenantId, fact, "active").catch(() => undefined)
      : undefined;
    if (known?.value !== undefined && known.value !== null) {
      return `the club's active fact ${fact}: ${answerText(known.value)}`;
    }
    return undefined;
  };

  /** What memory holds for each open item a container has. */
  const layoutBefore = async (
    tenantId: string,
    section: string | undefined,
  ): Promise<LayoutBefore> => {
    const found: LayoutBefore = {};
    for (const id of ["kind", "items", "autoplay", "loop", "platform"]) {
      const line = await beforeOf(tenantId, section, id, LAYOUT_FACTS[id]);
      if (line) found[id] = line;
    }
    return found;
  };

  /**
   * What is open about which parts of the frame are one section (ticket 04): the parts the finder
   * was unsure of, as an open item, and the joins its own proposal makes, which stand until
   * frame.split says otherwise. Nothing is open when the finder is sure of every part.
   */
  const readSplit = async (
    bundle: Bundle,
    ctx: Pick<ToolContext, "tenantId">,
    shape?: SlotShape,
  ) => {
    const found = await engine.slots?.(bundle, [], shape).catch(() => undefined);
    if (!found) return { joins: [] as Join[] };
    const before = await beforeOf(ctx.tenantId, bundle.section, SPLIT_QUESTION);
    const item = splitOpen(found, before);
    return { joins: item ? splitChoices(found).proposed : [], ...(item ? { item } : {}) };
  };

  const planeOf = opts.plane ?? ((project: string) => createControlPlane(project));
  const handoffsOf =
    opts.handoffs ??
    ((tenantId: string, handoffId: string) => {
      const config = handoffConfig();
      if (!config) {
        throw new Error(
          "This run is for a Handoff, and reading one needs SURFACE_API_URL and SURFACE_SERVICE_KEY",
        );
      }
      return createHandoffSource(tenantId, handoffId, config);
    });
  const tenantThemeOf =
    opts.tenantTheme ??
    (async (tenantId: string) => {
      const config = handoffConfig();
      if (!config) throw new Error("reading it needs SURFACE_API_URL and SURFACE_SERVICE_KEY");
      return readTenantTheme(tenantId, config);
    });

  /**
   * The token set a Handoff is built against: the tenant's FanXP theme, stored in the control plane
   * so its preview and the agents after this one read the same tokens by id. A tenant with no active
   * theme has to set one up: nothing else is the theme its pages are drawn with.
   */
  const handoffTheme = async (tenantId: string, plane: ControlPlane): Promise<string> => {
    const found = await tenantThemeOf(tenantId).catch((err: unknown) => {
      throw new NeedsSetup(
        `an active FanXP theme for ${tenantId}, which every section is built against (${err instanceof Error ? err.message : String(err)})`,
      );
    });
    // not the project's own token set: `newestArtifactId` passes over a `dugout:` source
    return plane.upload("token_set", found.raw, {
      source: "dugout:fanxp-theme",
      client: tenantId,
      themeId: found.theme.themeId,
      themeName: found.theme.themeName,
    });
  };

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

  const bundleFor = (ctx: Pick<ToolContext, "input" | "tenantId">, themeArtifactId?: string) => {
    const input = inputOf(ctx);
    const frameId = frameIdOf(input);
    const key = `${ctx.tenantId}/${input.project}/${frameId}/${themeArtifactId ?? ""}`;
    let held = bundles.get(key);
    if (!held) {
      const plane = planeOf(input.project);
      const source = input.handoffId ? handoffsOf(ctx.tenantId, input.handoffId) : undefined;
      held = (async () => {
        const theme =
          themeArtifactId ??
          (input.handoffId ? await handoffTheme(ctx.tenantId, plane) : undefined);
        const bundle = await engine.bundle(plane, frameId, theme, source);
        // a Handoff's tokens are the tenant's: the frame can't add one of its own
        if (input.handoffId) bundle.themeFixed = true;
        return bundle;
      })();
      held.catch(() => bundles.delete(key));
      bundles.set(key, held);
    }
    return held;
  };

  /** The bundle this run measured, with the placements it found. */
  const bundleOf = async (ctx: Pick<ToolContext, "input" | "tenantId">, state: State) => {
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
   * What each container is, as proposals: the reading's, its claims checked against the IR. Nothing
   * is applied here. A list or a row is what the compiler drew already; a carousel, tabs, or a row
   * that may be one of them is an open item the agent settles with frame.layout, however sure the
   * reading and the IR are (their confidence and evidence are what it settles from).
   */
  function reportsOf(reading: Reading): LayoutReport[] {
    return reading.layouts.map((i) => ({
      src: i.src,
      name: i.name,
      kind: i.kind,
      confidence: i.confidence,
      ...(i.score !== undefined ? { score: i.score } : {}),
      evidence: i.evidence,
      left: i.ask,
      choice: i.choice,
      // a list or a row is what the compiler drew already
      applied: i.choice.kind === "list" || i.choice.kind === "row",
      decided: false,
      ...(i.alternative ? { alternative: i.alternative } : {}),
      ...(Object.keys(i.chrome ?? {}).length > 0 ? { chrome: i.chrome } : {}),
      ...(i.items.length > 0 ? { items: i.items } : {}),
      ...(i.slide && i.slide.length > 0 ? { slide: i.slide } : {}),
    }));
  }

  /**
   * The frame read by eye, first, before anything is decided (`read.ts`). When the vision model is
   * off, down or answers nothing usable, what the IR shows is put to the agent instead: every
   * carousel and tabs as a question, nothing applied unasked.
   */
  async function readOf(bundle: Bundle, signal?: AbortSignal): Promise<Reading> {
    const fallback = async (why: string) =>
      unread((await engine.layouts?.(bundle).catch(() => [])) ?? [], why);
    if (!reader || !engine.read) return fallback("reading by eye is off in this run");
    try {
      return await engine.read(bundle, reader, signal);
    } catch (err) {
      return fallback(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The signs of whether anything on the section is data, and what they propose. A proposal: the
   * agent settles it in frame.publish's `content`.
   */
  function readContent(bundle: Bundle, tree: Built["tree"], layouts: LayoutReport[]): Content {
    const nodes = (tree as { nodes: Parameters<typeof contentOf>[0]["nodes"] }).nodes;
    const boxOf = (src: string) => bundle.byId.get(src)?.geometry.bbox;
    const nameOf = (src: string) => bundle.byId.get(src)?.name;
    return contentOf({ nodes }, layouts, boxOf, nameOf);
  }

  /**
   * The frame's slots for these joins, and what the signs propose for each. The frame shows data
   * when any slot does, so `framed` is the whole frame's proposal with the slots' put in it.
   */
  async function readSlots(
    bundle: Bundle,
    builtTree: Built["tree"],
    layouts: LayoutReport[],
    content: Content,
    joins: readonly Join[],
    shape: SlotShape | undefined,
    apart: readonly Join[] = [],
  ): Promise<{ slots?: FoundSlots; slotContent: Content[]; framed: Content }> {
    const slots = await engine.slots?.(bundle, joins, shape, apart).catch(() => undefined);
    const slotContent: Content[] = [];
    let framed = content;
    if (slots) {
      const tree = builtTree as unknown as {
        nodes: Array<{
          id: string;
          parent: string | null;
          type: string;
          props: Record<string, unknown>;
        }>;
      };
      const owners = ownersOf(tree.nodes, slots);
      for (const [i, slot] of slots.slots.entries()) {
        const inside = new Set(slot.ir);
        slotContent.push(
          readContent(
            bundle,
            { nodes: tree.nodes.filter((n) => owners.get(n.id) === i) } as Built["tree"],
            // a carousel drawn once is the slot's when its slide is
            layouts.filter(
              (l) => inside.has(l.src) || (l.slide ?? []).some((id) => inside.has(id)),
            ),
          ),
        );
      }
      const withData = slots.slots.filter((_, i) => slotContent[i]?.data === "some");
      if (withData.length > 0 && content.data !== "some") {
        framed = {
          data: "some",
          evidence: [
            ...content.evidence,
            ...withData.map((s) => `the part ${s.name} [${s.id}] is proposed as showing data`),
          ],
        };
      }
    }
    return { ...(slots ? { slots } : {}), slotContent, framed };
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
        const bundle = await bundleFor(ctx);
        const designer =
          bundle.notes.length > 0
            ? { designerNotes: bundle.notes, designerNotesRule: NOTES_RULE }
            : {};
        // the notes `final` must answer, where its check reads them
        ctx.state.set(
          LISTED_NOTES,
          bundle.notes.map((n) => n.id),
        );
        // the section the run works on, so what a person answers is about it (ADR 0033)
        if (bundle.section) ctx.situate?.({ section: bundle.section, name: bundle.rootName });
        const decided = await decidedBefore(opts.decisions, ctx.tenantId, bundle.section).catch(
          () => [],
        );
        // how this agent built the section before, as an index (ADR 0034)
        const alike = bundle.section
          ? await (opts.like?.(ctx.tenantId, bundle.section) ?? Promise.resolve([])).catch(() => [])
          : [];
        const built = await builtFor(
          opts.decisions,
          ctx.tenantId,
          bundle.section,
          AGENT_ID,
          async () => alike,
        ).catch(() => undefined);
        const lessons = await lessonsFor(opts.decisions, ctx.tenantId, [
          bundle.section,
          ...alike.map((a) => a.signature),
        ]).catch(() => []);
        // what the club approved from several sections' builds (ADR 0034, section 8)
        const patterns = await patternsFor(opts.decisions, ctx.tenantId, ["layout."]).catch(
          () => [],
        );
        const earlier = {
          ...(decided.length > 0 ? { before: decided, beforeRule: BEFORE_RULE } : {}),
          ...(patterns.length > 0 ? { patterns, patternsRule: PATTERNS_RULE } : {}),
          ...(built ? { built } : {}),
          ...(lessons.length > 0 ? { lessons, lessonsRule: LESSONS_RULE } : {}),
        };
        if (saved) return { ...standing(saved), ...designer, ...earlier };

        // the frame read by eye first: what it is for, what each part does, what moves
        const reading = await readOf(bundle, ctx.signal);
        const shape = shapeOf(reading);
        // which parts are one section: the finder's proposal stands until frame.split settles it
        const split = await readSplit(bundle, ctx, shape);
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
        // what each container is: proposals, applied only when the agent settles them
        const layouts = reportsOf(reading);
        const content = readContent(bundle, first.built.tree, layouts);
        const layoutMemory = await layoutBefore(ctx.tenantId, bundle.section);
        // the frame's slots, and what the signs propose for each: a frame of two sections binds twice
        const { slots, slotContent, framed } = await readSlots(
          bundle,
          first.built.tree,
          layouts,
          content,
          split.joins,
          shape,
        );
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
          rawGradients: first.built.rawGradients,
          undone: first.undone ?? [],
          noPicture: first.noPicture ?? [],
          noToken: first.noToken ?? [],
          unpainted: engine.unpainted?.(bundle, first.built) ?? [],
          looks: 0,
          lookFailures: 0,
          examined: [],
          examinedSurfaces: [],
          publishRefusals: 0,
          despite: [],
          layouts,
          reading,
          settled: [],
          open: Object.fromEntries(
            layouts.flatMap((l) => {
              const items = openLayoutItems(l, l.choice, layoutMemory);
              return items.length > 0 ? [[l.src, items]] : [];
            }),
          ),
          ...(split.item ? { split: { item: split.item, settled: false } } : {}),
          frameContent: content,
          content: framed,
          slotContent,
          ...(slots ? { slots } : {}),
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
            // no picture of their own: left as compiled, never cut from a section's screenshot
            noPicture: first.noPicture ?? [],
            // gradients the tenant's FanXP theme has no token for: left unpainted, said in remaining
            noToken: first.noToken ?? [],
          },
          ...(state.unpainted.length > 0
            ? {
                unpainted: state.unpainted,
                unpaintedNote:
                  "The design paints these and the compile does not. No score sees a layer with no screenshot of its own, so painting one moves nothing measured. frame.override paints one: a surface under a new name, then props { surface } on the layer; keep says why a change that moves nothing is kept.",
              }
            : {}),
          content: {
            ...framed,
            note: "What the signs propose, not settled: you settle whether the section shows data (open item content) and pass it to frame.publish. none: it is published as it is, nothing bound. some: the binding stage finds its source after you publish.",
          },
          reading: readingOf(reading),
          ...designer,
          ...earlier,
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
        ...(bundle.notes.some((n) => n.src === src)
          ? { designerNotes: bundle.notes.filter((n) => n.src === src) }
          : {}),
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
      "Add overrides, recompile and measure again. Pass any of props: [{ src, props }], surfaces: { name: spec }, crops: [src], backdrops: [src], gradients: [src], icons: { slug: glyph }. A change that measures better is kept. One that costs (the match drops, conform errors or placeholder icons rise) or moves nothing measured is undone and its cost returned, unless you pass keep: why you keep it anyway (the IR says the layer has that paint, the score cannot see it); then it is kept, and its cost and your why are listed for the reviewer. Every result also reports what bears on the change: a text tone beside the colour the design paints it, and crops that span a band with no text.",
    // A layout is set through frame.layout only.
    input: Overrides.omit({ layouts: true }).extend({
      keep: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Why to keep this change even if it costs score or moves nothing measured. Left out: such a change is undone",
        ),
    }),
    effect: "read",
    timeoutMs: 120_000,
    alwaysInline: true,
    // a change that was kept returns the frame's findings as they now stand, which replace the
    // ones an earlier change returned; one that was undone changed nothing
    latestOnly: (output) => (output as { kept?: boolean }).kept === true,
    run: ({ keep, ...change }, ctx) =>
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
        // what bears on the change, reported whether it is kept or not: the design's own text
        // colour beside each tone, and which crops span a band with no text in it
        const tones = toneAgainstDesign(bundle, change.props ?? []);
        const backdrops = backdropCandidates(
          bundle,
          built.tree.nodes as Parameters<typeof backdropCandidates>[1],
          change.crops ?? [],
        );
        const report = {
          ...(tones.length > 0 ? { tones } : {}),
          ...(backdrops.length > 0 ? { backdrops } : {}),
          ...(built.cropNotes?.length ? { crops: built.cropNotes } : {}),
        };
        const cannot = unappliable(built);
        if (cannot) return { kept: false, reason: cannot, match: state.current.match, ...report };
        const measured = await engine.measure(bundle, built);
        const cost = costOf(state.current, measured);
        if (cost.length > 0 && !keep) {
          return {
            kept: false,
            reason: cost.join("; "),
            match: state.current.match,
            tried: measured.match,
            ...report,
          };
        }
        const next: State = {
          ...state,
          overrides,
          current: measured,
          standIns: built.cropped.length,
          rawGradients: built.rawGradients,
          despite:
            cost.length > 0
              ? [
                  ...state.despite,
                  `${changeLine(change)}: ${cost.join("; ")}. Kept because: ${keep}`,
                ]
              : state.despite,
        };
        const { published: _stale, ...unpublished } = next;
        writeState(dir, ctx.runId, unpublished);
        return {
          kept: true,
          was: state.current.match,
          ...(cost.length > 0 ? { despite: cost } : {}),
          ...report,
          ...standing(next),
        };
      }),
  });

  // What the model sees is small: { src, kind, config } with config an open object, and the
  // structure (items, slide, chrome) when it changes what frame.load found. The full LayoutChoice
  // is a union of kinds with many optional fields, and as a strict tool schema its grammar is more
  // than Bedrock compiles. An open object leaves the tool out of strict mode (as frame.override
  // is); the run fills what the choice leaves out from frame.load's proposal for the same kind and
  // refuses any choice LayoutChoice does not take.
  const ids = (what: string) => z.array(z.string()).optional().describe(what);
  const LayoutCall = z.object({
    choice: z.object({
      src: z.string(),
      kind: z.enum(["carousel", "grid", "tabs", "list", "row"]),
      config: z.record(z.string(), z.unknown()),
      items: z.array(z.string()).optional(),
      slide: z.array(z.string()).optional(),
      chrome: z.record(z.string(), z.string()).optional(),
    }),
    // an object, or pasted text that is not JSON: the run refuses the text with why
    platform: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
    settled: z.array(SettledBy),
  });
  const layoutInput = z
    .object({
      settled: z.array(SettledBy).optional().describe(SETTLED_BY_HELP),
      choice: z
        .object({
          src: z.string().min(1),
          kind: z.enum(["carousel", "grid", "tabs", "list", "row"]),
          config: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'carousel: { slidesPerView: number or "auto", slidesPerGroup, centered, initialSlide, pages, loop, autoplay: false or { delayMs }, controls: { arrows: { placement: "edges" or "as-drawn", states }, pagination: { states } }, props: { effect, speed, easing, freeMode }, platform }. platform: a platform carousel config (slides_per_view, nav_arrows, nav_indicator, autoplay_progress, ...) a person gave, passed whole as given. grid: { columns, rows }. tabs: { options, active }. list and row: none. For the kind frame.load proposed, what you leave out is its proposal',
            ),
          items: ids(
            "The repeated items, by Figma id, in order. Left out: as frame.load reported them",
          ),
          slide: ids(
            "A carousel that draws only the slide on show: the layers that are that one slide. Left out: as frame.load reported them",
          ),
          chrome: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              "A carousel's designed controls by Figma id: prev, next, pagination, counter, progress. Left out: as frame.load reported them",
            ),
        })
        .strict(),
    })
    .strict()
    // A platform config rides beside the choice; code applies it, the model never translates it.
    .transform(({ choice, settled }) => {
      // a setting the model has nothing to say about (pages for "whatever the data holds") may
      // arrive as null: it is left out, as if it were not passed
      const { platform, ...given0 } = (choice.config ?? {}) as Record<string, unknown>;
      const config = Object.fromEntries(Object.entries(given0).filter(([, v]) => v !== null));
      // Pasted JSON may arrive as the text it was pasted as.
      let given: unknown = platform;
      if (typeof given === "string") {
        try {
          given = JSON.parse(given);
        } catch {
          // left as text: refused below, with zod's message
        }
      }
      // anything else is refused by LayoutCall, with zod's message
      return { choice: { ...choice, config }, platform: given, settled: settled ?? [] } as z.input<
        typeof LayoutCall
      >;
    })
    .pipe(LayoutCall);

  /**
   * The choice as LayoutChoice takes it: what the model passed, over frame.load's proposal when it
   * is the kind proposed (a model that settles autoplay passes only autoplay). A carousel chosen in
   * place of another kind keeps each slide at its designed width unless the model says otherwise.
   */
  const fullChoice = (
    given: z.output<typeof layoutInput>["choice"],
    report: LayoutReport,
  ): { choice: LayoutChoice } | { error: string } => {
    const same = report.choice.kind === given.kind ? report.choice : undefined;
    const base = same && "config" in same ? (same.config as Record<string, unknown>) : {};
    const structure = {
      ...(given.items ? { items: given.items } : {}),
      ...(given.slide ? { slide: given.slide } : {}),
      ...(given.chrome ? { chrome: given.chrome } : {}),
    };
    const draft =
      given.kind === "list" || given.kind === "row"
        ? { src: given.src, kind: given.kind }
        : given.kind === "carousel"
          ? {
              src: given.src,
              kind: given.kind,
              config: { slidesPerView: "auto", ...base, ...given.config },
              ...structure,
            }
          : given.kind === "tabs"
            ? {
                src: given.src,
                kind: given.kind,
                config: { ...base, ...given.config },
                ...(given.items ? { items: given.items } : {}),
              }
            : { src: given.src, kind: given.kind, config: { ...base, ...given.config } };
    // the member of the union for this kind, so a refusal names the field that is wrong
    const member = LayoutChoice.options.find((o) => o.shape.kind.value === given.kind);
    const parsed = (member ?? LayoutChoice).safeParse(draft);
    if (!parsed.success) {
      return {
        error: `${given.kind} needs ${given.kind === "tabs" ? "config { options, active }" : given.kind === "grid" ? "config { columns, rows }" : "a valid config"}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      };
    }
    return { choice: parsed.data };
  };
  const PlatformInput = z.record(z.string(), z.unknown());

  const layout = defineTool<z.infer<typeof layoutInput>, Record<string, unknown>>({
    name: "frame.layout",
    description:
      "Apply what one container is: a carousel, a fixed row, a list, a grid or tabs. Pass { choice: { src, kind, config }, settled }: frame.load's `layouts` list each container with its evidence and proposed choice, and its `open` items say what is still to settle about it (what it is, how many items, autoplay, loop, a platform config), each with the answers a tool can act on and what else this call takes. Nothing is applied until you call this. Settle each item first (from `before` in memory, from the evidence, or by asking a person with `ask`), then pass the result as the choice: config.pages for a number of items, config.autoplay (false or { delayMs }), config.loop, config.platform (a platform carousel config as JSON, a person's word: where it and the frame disagree its value is applied and the disagreement reported). For the kind frame.load proposed, config you leave out is its proposal; items, slide and chrome change which layers are the items, the slide and the controls. Say in `settled` who decided each item. It never asks anything: it applies the choice, measures it and returns what was applied, with the match before and after. Call it once for each container with open items.",
    input: layoutInput,
    // it writes nothing outside the run: what a person says about the frame is the question
    effect: "read",
    timeoutMs: 120_000,
    alwaysInline: true,
    run: ({ choice: proposal, platform: modelPlatform, settled: told }, ctx) =>
      inTurn(ctx.runId, async () => {
        const state = requireState(ctx);
        const report = state.layouts.find((l) => l.src === proposal.src);
        if (!report) {
          return {
            kept: false,
            reason: `frame.load found no repeated items in ${proposal.src}. Pass the src of one of its layouts: ${state.layouts.map((l) => l.src).join(", ") || "it found none"}`,
          };
        }
        const full = fullChoice(proposal, report);
        if ("error" in full) return { kept: false, reason: full.error };
        // the items, the one slide and the controls frame.load found, where the choice leaves them out
        const asked: LayoutChoice = withStructure(full.choice, report);
        const given =
          modelPlatform === undefined ? undefined : PlatformInput.safeParse(modelPlatform);
        if (given && !given.success) {
          return {
            kept: false,
            reason: `config.platform is not a JSON object: ${given.error.issues.map((i) => i.message).join("; ")}`,
          };
        }
        const platform = given?.data;
        const bundle = await bundleOf(ctx, state);
        let choice: LayoutChoice = asked;
        let platformNotes: string[] | undefined;
        let platformConflicts: PlatformConflict[] | undefined;
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
          platformConflicts = applied.conflicts;
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
        // how each open item of this container was settled, from what was applied
        const recorded = settledLayout(
          choice.src,
          state.open[choice.src] ?? [],
          choice,
          Boolean(platform),
          told,
        );
        const next: State = {
          ...state,
          overrides,
          current: measured,
          layouts,
          settled: [
            ...state.settled.filter((r) => !r.value.startsWith(`${choice.src}: `)),
            ...recorded,
          ],
          standIns: built.cropped.length,
          rawGradients: built.rawGradients,
        };
        const { published: _stale, ...unpublished } = next;
        writeState(dir, ctx.runId, unpublished);
        return {
          kept: true,
          layout: describeChoice(choice),
          ...(recorded.length > 0 ? { settled: recorded } : {}),
          applied,
          ...(note && !applied ? { note: note.message } : {}),
          ...(platformNotes
            ? { platform: platformNotes.length > 0 ? platformNotes : ["applied as given"] }
            : {}),
          ...(platform ? { platformSets: describePlatform(platform) } : {}),
          // where the person's config and the frame disagree: the config's value is applied where
          // the Carousel takes one; the rest is the frame's until you change it
          ...(platformConflicts && platformConflicts.length > 0 ? { platformConflicts } : {}),
          ...(state.unmeasured ? {} : { was: state.current.match }),
          ...standing(next),
        };
      }),
  });

  const splitInput = z
    .object({
      joins: z
        .array(z.object({ upper: z.string().min(1), lower: z.string().min(1) }).strict())
        .describe(
          "The parts that are one section, by the ids frame.load's section_split item lists: each pair joins two parts, the upper one first. [] keeps every part apart",
        ),
      apart: z
        .array(z.object({ first: z.string().min(1), second: z.string().min(1) }).strict())
        .optional()
        .describe(
          "Parts the finder joined for sitting side by side that are two sections, by the pair's ids as section_split lists them. Left out: the finder's joins stand",
        ),
      settled: z.array(SettledBy).optional().describe(SETTLED_BY_HELP),
    })
    .strict();
  const split = defineTool({
    name: "frame.split",
    description:
      "Apply which parts of the frame are one section. frame.load's open item section_split lists the parts the finder was unsure of and each join it could make, the parts it joined itself for sitting side by side, the finder's proposal and what memory holds: settle it (from memory, from the evidence, or by asking a person with `ask`), then pass the joins here, and in apart any pair the finder joined that is two sections. Parts joined share one data source. It never asks anything: it re-reads the frame's slots with these and returns them. Call it once; frame.publish waits for it when frame.load reported the item. Say in `settled` who decided it.",
    input: splitInput,
    // it writes nothing outside the run
    effect: "read",
    timeoutMs: 120_000,
    alwaysInline: true,
    run: ({ joins, apart = [], settled: told }, ctx) =>
      inTurn(ctx.runId, async () => {
        const state = requireState(ctx);
        if (!state.split) {
          return {
            kept: false,
            reason: "frame.load left nothing open about which parts are one section",
          };
        }
        const bundle = await bundleOf(ctx, state);
        const shape = state.reading ? shapeOf(state.reading) : undefined;
        const kept = apart.map((a): Join => [a.first, a.second]);
        const parts =
          (await engine.slots?.(bundle, [], shape, kept).catch(() => undefined))?.slots ?? [];
        const known = new Set(parts.map((p) => p.id));
        const unknown = joins.flatMap((j) => [j.upper, j.lower]).filter((id) => !known.has(id));
        if (unknown.length > 0) {
          return {
            kept: false,
            reason: `no part has the id ${[...new Set(unknown)].join(", ")}. The parts are: ${parts.map((p) => `${p.name} [${p.id}]`).join(", ") || "none found"}`,
          };
        }
        const pairs = joins.map((j): Join => [j.upper, j.lower]);
        const built = await engine.build(bundle, state.overrides);
        const read = await readSlots(
          bundle,
          built.tree,
          state.layouts,
          state.frameContent ?? state.content ?? { data: "unsure", evidence: [] },
          pairs,
          shape,
          kept,
        );
        const said = told?.find((t) => t.id === SPLIT_QUESTION)?.by ?? "agent";
        const recorded: Settled = {
          id: SPLIT_QUESTION,
          by: said === "memory" && !state.split.item.before ? "agent" : said,
          value: [
            pairs.length > 0 ? pairs.map(([a, b]) => `${a}+${b}`).join(", ") : "apart",
            ...kept.map(([a, b]) => `${a}|${b}`),
          ].join(", "),
        };
        const next: State = {
          ...state,
          split: { item: state.split.item, settled: true },
          settled: [...state.settled.filter((r) => r.id !== SPLIT_QUESTION), recorded],
          ...(read.slots ? { slots: read.slots } : {}),
          slotContent: read.slotContent,
          content: read.framed,
        };
        const { published: _stale, ...unpublished } = next;
        writeState(dir, ctx.runId, unpublished);
        return {
          kept: true,
          settled: [recorded],
          slots: (read.slots?.slots ?? []).map((s, i) => ({
            id: s.id,
            name: s.name,
            confidence: s.confidence,
            proposed: read.slotContent[i]?.data ?? "unsure",
          })),
          ...openNote(next),
        };
      }),
  });

  const SettledContent = z
    .object({
      data: z.enum(["none", "some"]).describe("none: nothing on it is data; some: it shows data"),
      why: z.string().min(1).describe("What in the evidence settles it"),
      by: z
        .enum(["person", "memory", "agent"])
        .optional()
        .describe(
          "person: a person answered your ask; memory: from `before`; agent (default): you",
        ),
    })
    .strict();
  const publishInput = z
    .object({
      content: SettledContent.describe(
        "Whether anything on the section is data (frame.load's open item content): settled by you, from its evidence",
      ),
      slots: z
        .array(SettledContent.extend({ id: z.string().min(1).describe("The part's id") }))
        .describe(
          "When the content item lists several parts: one entry for each, by its id. [] when the frame is one part",
        ),
    })
    .strict();
  type PublishInput = z.infer<typeof publishInput>;

  /** What the agent settled about content that does not fit the frame's parts, or none. */
  const contentGap = (state: State, input: PublishInput): string | undefined => {
    const parts = state.slots?.slots ?? [];
    if (parts.length < 2) return undefined;
    const given = new Set(input.slots.map((s) => s.id));
    const missing = parts.filter((p) => !given.has(p.id));
    const unknown = input.slots.filter((s) => !parts.some((p) => p.id === s.id));
    const anySome = input.slots.some((s) => s.data === "some");
    const lines = [
      ...(missing.length > 0
        ? [`slots has no entry for ${missing.map((p) => `${p.name} [${p.id}]`).join(", ")}`]
        : []),
      ...(unknown.length > 0
        ? [
            `no part has the id ${unknown.map((s) => s.id).join(", ")}; the parts are ${parts.map((p) => `${p.name} [${p.id}]`).join(", ")}`,
          ]
        : []),
      ...(missing.length === 0 && anySome !== (input.content.data === "some")
        ? [
            `content says ${input.content.data} for the whole frame and the parts say ${anySome ? "one shows data" : "none shows data"}`,
          ]
        : []),
    ];
    return lines.length > 0 ? lines.join("; ") : undefined;
  };

  const publish = defineTool<PublishInput, z.infer<typeof Published>, Record<string, unknown>>({
    name: "frame.publish",
    description:
      "Store the frame in the control plane and return its preview link. Pass content: whether anything on the section is data, as you settled it from frame.load's open item content ({ data: none or some, why, by }), and slots: one { id, data, why, by } for each part when the item lists several ([] otherwise). Needs approval, and the reviewer sees the measured numbers, or that none could be measured, and your content.",
    input: publishInput,
    effect: "write",
    timeoutMs: 60_000,
    // "not yet" here sends the run back to examine and fix, so asking again is the run working
    advisoryBlock: true,
    // the approval shows numbers measured by code, never the model's account of them
    resolve(input, ctx) {
      const state = readState(dir, ctx.runId);
      if (!state) return {};
      return {
        exportId: state.exportId,
        // the content as the agent settled it: what the reviewer approves, and what block checks
        content: input.content,
        slots: input.slots,
        ...(state.despite.length > 0 ? { keptDespite: state.despite } : {}),
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
    block(input, ctx) {
      const state = readState(dir, ctx.runId);
      if (!state) return "Nothing is loaded. Call frame.load first.";
      // What a container is, and which parts are one section, are settled before the frame is
      // published: from memory, from the evidence, or by asking a person. A frame published
      // without that ships a guess.
      const open = undecided(state);
      if (open.length > 0) {
        return `Not yet. Settle what is open about these layouts (frame.load's open items), then apply each with frame.layout: ${open.map((l) => `"${l.name}" (${l.src})`).join(", ")}`;
      }
      if (state.split && !state.split.settled) {
        return "Not yet. Settle which parts of the frame are one section (frame.load's open item section_split), then apply it with frame.split.";
      }
      const said = publishInput.safeParse({ content: input.content, slots: input.slots ?? [] });
      const gap = said.success ? contentGap(state, said.data) : undefined;
      if (gap) return `Not yet. The content you passed does not cover the frame's parts: ${gap}.`;
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
      return `Not yet (${refusals} of ${MAX_PUBLISH_REFUSALS}): ${waiting.length} of the largest findings have not been read with frame.node.\n${waiting.map((src) => `- ${describeFinding(state, src)}`).join("\n")}\nAfter ${MAX_PUBLISH_REFUSALS} of these it publishes with whatever is unread listed for the reviewer.`;
    },
    // `resolve` replaced the arguments with what the reviewer sees, the content among them
    async run(resolved, ctx) {
      return inTurn(ctx.runId, async () => {
        const state = requireState(ctx);
        const said = publishInput.parse({
          content: resolved.content,
          slots: resolved.slots ?? [],
        });
        if (state.published) {
          ctx.state.set(PUBLISHED, state.published);
          return state.published;
        }
        const input = inputOf(ctx);
        const { project } = input;
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
        const by = { source: "dugout:frame-match", runId: ctx.runId };
        // A Handoff is not in the control plane, so its IR is stored beside the tree: bind reads
        // the designer's notes and the layers from it, as it reads an export's.
        const meta = input.handoffId
          ? {
              ...by,
              handoffId: input.handoffId,
              irArtifactId: await plane.upload("figma_ir", bundle.ir, {
                ...by,
                handoffId: input.handoffId,
              }),
            }
          : { ...by, exportId: state.exportId };
        // a copy of the theme only when the frame added a gradient token of its own, which a
        // Handoff's tenant theme never takes
        const themeArtifactId =
          built.rawGradients > 0
            ? await plane.upload("token_set", built.themeRaw, meta)
            : state.themeArtifactId;
        const surfaceArtifactId = await plane.upload("surface_set", built.surfaces, meta);
        const written = (await engine.choices?.(built)) ?? [];
        // whether the section shows data, as the agent settled it, over the signs it read
        const proposal = state.content ?? { data: "unsure" as const, evidence: [] };
        const content = settledContent(proposal, said.content);
        const parts = state.slots?.slots ?? [];
        const slotContent = parts.map((p, i) => {
          const part = said.slots.find((s) => s.id === p.id);
          const signs = state.slotContent[i] ?? { data: "unsure" as const, evidence: [] };
          // a frame of one part: that part is the frame
          return part
            ? settledContent(signs, part)
            : parts.length === 1
              ? settledContent(signs, said.content)
              : signs;
        });
        const contentSettled: Settled[] = [
          { id: "content", by: said.content.by ?? "agent", value: said.content.data },
          ...(parts.length > 1
            ? said.slots.map(
                (s): Settled => ({
                  id: "content",
                  by: s.by ?? "agent",
                  value: `${s.id}: ${s.data}`,
                }),
              )
            : []),
        ];
        // each choice belongs to the slot that draws it, and is named for it when there are several
        const split =
          state.slots && engine.choices
            ? await slottedBy(engine.choices, built, state.slots)
            : undefined;
        const choices = split ? split.choices : written;
        const tree = split ? (split.tree as unknown as Built["tree"]) : built.tree;
        const slots = split && state.slots ? reportOf(state, split, slotContent) : [];
        const treeArtifactId = await plane.upload("dsl_tree", tree, {
          ...meta,
          content,
          ...(choices.length ? { choices } : {}),
          ...(slots.length ? { slots } : {}),
        });
        // what this section's tabs write, for a section built later to read
        if (opts.pool) {
          await recordPageChoices(opts.pool, ctx.tenantId, {
            project,
            section: input.handoffId ?? state.exportId,
            name: sectionName(bundle.rootName, tree),
            treeArtifactId,
            runId: ctx.runId,
            choices,
          });
        }
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
          noPicture: state.noPicture,
          noToken: state.noToken,
          ...(state.unmeasured ? {} : { before: state.before.match, match: state.current.match }),
          content,
          choices,
          slots,
          settled: [...state.settled, ...contentSettled],
        };
        writeState(dir, ctx.runId, { ...state, published });
        ctx.state.set(PUBLISHED, published);
        return published;
      });
    },
  });

  const see: See =
    opts.see ??
    ((png, prompt, signal) =>
      describeImage({ png, prompt, model: "haiku", ...(signal ? { signal } : {}) }));

  /** The first look at the design, which everything after reads: a stronger model than frame.look's. */
  const reader: Read | undefined =
    opts.read === false || (opts.read === undefined && process.env.FRAME_MATCH_READ === "off")
      ? undefined
      : (opts.read ??
        ((png, prompt, signal) =>
          describeImage({
            png,
            prompt,
            model: process.env.FRAME_MATCH_READ_MODEL ?? "sonnet",
            ...(signal ? { signal } : {}),
          })));

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
        // a look is often the last call before frame.publish, so it says what publish waits on
        const examine = unexamined(state);
        return {
          bands: looked.bands,
          differences: looked.differences.slice(0, 12),
          ...(examine.length > 0 ? { examineBeforePublish: examine } : {}),
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

  return [
    load,
    node,
    tokens,
    override,
    layout,
    split,
    opts.vision === false ? noEyes : lookTool,
    publish,
  ];
}
