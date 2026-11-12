import { type Pool, withTenant } from "@dugout/db";
import type { Captioner } from "./caption.ts";
import type { CropStore } from "./crops.ts";
import { type BindingPlan, dataShapeOf } from "./data-shape.ts";
import type { FanosTools } from "./fanos.ts";
import { type IndexReport, indexHandoff } from "./indexer.ts";
import { type IrDoc, indexNodes } from "./ir.ts";
import {
  addPaintVotes,
  emptyVotes,
  PALETTE_FACT,
  paletteFact,
  paletteFromVotes,
  parsePaletteFact,
  themeColours,
} from "./palette.ts";
import type { SkeletonPalette } from "./skeleton.ts";
import {
  createControlPlaneSource,
  createSurfaceHandoffSource,
  type HandoffSource,
} from "./source.ts";
import type { SectionLibrary } from "./store.ts";
import { sectionTree } from "./tree.ts";

/** The agents whose finished runs are a preview of a Handoff: frame-match publishes the frame. */
export const PREVIEW_AGENTS = ["frame-match", "section-builder"] as const;
/**
 * The agents that bind a published preview to data. Their input is the preview, so the Handoff is
 * the one the run that published it read. `bind` is data-bind's id before the renaming.
 */
export const BIND_AGENTS = ["data-bind", "bind"] as const;
/** Every agent whose completed run the library follows. */
export const LIBRARY_AGENTS: readonly string[] = [...PREVIEW_AGENTS, ...BIND_AGENTS];

export interface PreviewRun {
  runId: string;
  agentId: string;
  /** A FanXP Handoff (`handoffId`) or a control-plane export (`exportId`). */
  handoff: { kind: "handoff" | "export"; id: string; project: string };
  previewUrl: string;
  /** The binding plan and the data it bound, when the run bound the preview to data. */
  bound?: { project: string; planId: string; dataId: string };
  /** The theme the preview was drawn in, an artifact of its project. */
  theme?: { project: string; id: string };
  at: string;
}

/** `/preview/<project>/<tree id>?...`: the project and the published tree, from a preview link. */
export function previewTarget(
  url: string,
): { project: string; tree: string; params: URLSearchParams } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return undefined;
  }
  const m = /\/preview\/([^/]+)\/([^/?#]+)/.exec(parsed.pathname);
  if (!m?.[1] || !m[2]) return undefined;
  return {
    project: decodeURIComponent(m[1]),
    tree: decodeURIComponent(m[2]),
    params: parsed.searchParams,
  };
}

/**
 * The tenant's finished runs that built a preview of a Handoff, or bound one to data, oldest
 * first; with `runId`, only that one.
 */
export async function previewRuns(
  pool: Pool,
  tenantId: string,
  opts: { runId?: string } = {},
): Promise<PreviewRun[]> {
  const rows = await withTenant(pool, tenantId, async (db) => {
    const { rows } = await db.query(
      `select id, agent_id, input, result->'output' as output, updated_at
       from runs
       where tenant_id = $1 and status = 'completed' and agent_id = any($2)
         and result->'output' ? 'previewUrl'
       order by updated_at`,
      [tenantId, [...LIBRARY_AGENTS]],
    );
    return rows;
  });
  // a bound preview's Handoff is the one the run that published its tree read
  const byTree = new Map<string, PreviewRun["handoff"]>();
  const runs: PreviewRun[] = [];
  for (const r of rows) {
    const agentId = String(r.agent_id);
    const output = (r.output ?? {}) as Record<string, unknown>;
    const previewUrl = typeof output.previewUrl === "string" ? output.previewUrl : "";
    if (!previewUrl) continue;
    const target = previewTarget(previewUrl);
    const input = (r.input ?? {}) as Record<string, unknown>;
    let handoff: PreviewRun["handoff"] | undefined;
    if ((PREVIEW_AGENTS as readonly string[]).includes(agentId)) {
      const project = typeof input.project === "string" ? input.project : "default";
      if (typeof input.handoffId === "string") {
        handoff = { kind: "handoff", id: input.handoffId, project };
      } else if (typeof input.exportId === "string") {
        handoff = { kind: "export", id: input.exportId, project };
      }
      if (handoff && target) byTree.set(target.tree, handoff);
    } else {
      const from = typeof input.preview === "string" ? previewTarget(input.preview) : undefined;
      const tree = from?.tree ?? target?.tree;
      handoff = tree ? byTree.get(tree) : undefined;
    }
    if (!handoff) continue;
    const planId = str(output.planArtifactId) ?? target?.params.get("plan") ?? undefined;
    const dataId = str(output.dataArtifactId) ?? target?.params.get("data") ?? undefined;
    const project = target?.project ?? handoff.project;
    const theme = target?.params.get("theme");
    runs.push({
      runId: String(r.id),
      agentId,
      handoff,
      previewUrl,
      ...(planId && dataId ? { bound: { project, planId, dataId } } : {}),
      ...(theme ? { theme: { project, id: theme } } : {}),
      at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    });
  }
  return opts.runId ? runs.filter((r) => r.runId === opts.runId) : runs;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** How the data shape's inputs are read: the Handoff's IR and the run's stored plan and data. */
export interface ShapeReader {
  /** The Handoff's IR, by the ref a section's source keeps. */
  ir(run: PreviewRun, irRef: string): Promise<IrDoc>;
  /** A stored artifact of the preview's project: the binding plan, the bound data. */
  artifact(run: PreviewRun, id: string): Promise<unknown>;
  /** The DSL tree the run's preview link shows (a flat tree); without it, no trees. */
  tree?(run: PreviewRun): Promise<unknown>;
}

export interface PreviewSync {
  runs: number;
  /** Handoffs indexed because a preview was built from one not yet in the library. */
  indexed: IndexReport[];
  /** Sections marked previewed, by run. */
  marked: Array<{ runId: string; handoffId: string; sections: number }>;
  /** Sections given the DSL subtree that draws them, by run. */
  treed: Array<{ runId: string; handoffId: string; sections: number }>;
  /** Sections given their data shape, by run. */
  shaped: Array<{ runId: string; handoffId: string; sections: number }>;
  failed: Array<{ runId: string; handoffId: string; error: string }>;
}

/**
 * Every preview the tenant's runs built puts the sections of its Handoff in the shared pool:
 * the Handoff is indexed first when the library has not seen it, then its sections are marked.
 * A run that bound the preview to data gives each section it bound its data shape. Safe to run
 * again: a run already counted changes nothing. `runId`: that run alone, as the worker calls it.
 */
export async function syncPreviews(opts: {
  pool: Pool;
  tenantId: string;
  library: SectionLibrary;
  /** Indexes one Handoff, read from where the run read it. */
  index: (run: PreviewRun) => Promise<IndexReport>;
  /** Reads what a data shape is made from; without it, no shapes. */
  shapes?: ShapeReader;
  /** Index every previewed Handoff again, even one the library has seen, and shape again. */
  reindex?: boolean;
  runId?: string;
}): Promise<PreviewSync> {
  const { tenantId, library } = opts;
  const runs = await previewRuns(opts.pool, tenantId, opts.runId ? { runId: opts.runId } : {});
  const out: PreviewSync = {
    runs: runs.length,
    indexed: [],
    marked: [],
    treed: [],
    shaped: [],
    failed: [],
  };
  const known = new Map<string, boolean>();
  for (const run of runs) {
    const handoffId = run.handoff.id;
    try {
      if (!known.has(handoffId)) {
        if (opts.reindex || !(await library.hasHandoff(tenantId, handoffId))) {
          out.indexed.push(await opts.index(run));
        }
        known.set(handoffId, true);
      }
      const sections = await library.markPreviewed(tenantId, {
        runId: run.runId,
        agentId: run.agentId,
        handoffId,
        previewUrl: run.previewUrl,
        at: run.at,
      });
      out.marked.push({ runId: run.runId, handoffId, sections });
      // a run counted before was treed and shaped then; the latest preview's tree is the one kept
      if (opts.shapes?.tree && (sections > 0 || opts.reindex)) {
        const treed = await treeSections(tenantId, run, library, opts.shapes).catch(
          (err: unknown) => {
            throw new Error(
              `shared, but no tree: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        );
        out.treed.push({ runId: run.runId, handoffId, sections: treed });
      }
      if (run.bound && opts.shapes && (sections > 0 || opts.reindex)) {
        const shaped = await shapeSections(tenantId, run, library, opts.shapes).catch(
          (err: unknown) => {
            throw new Error(
              `shared, but no data shape: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        );
        out.shaped.push({ runId: run.runId, handoffId, sections: shaped });
      }
    } catch (err) {
      known.set(handoffId, true);
      out.failed.push({
        runId: run.runId,
        handoffId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * The run's Handoff's sections, each with whether a layer (an IR node id) is inside it: the
 * layer is the section's node or below it.
 */
async function scopedSections(
  tenantId: string,
  run: PreviewRun,
  library: SectionLibrary,
  read: ShapeReader,
) {
  const sections = await library.ofHandoff(tenantId, run.handoff.id);
  const irs = new Map<string, Promise<ReturnType<typeof indexNodes>>>();
  const out: Array<{
    section: (typeof sections)[number];
    nodeId: string;
    within: (src: string) => boolean;
  }> = [];
  for (const section of sections) {
    const source = section.sources.find((s) => s.handoffId === run.handoff.id);
    if (!source) continue;
    let nodes = irs.get(source.irRef);
    if (!nodes) {
      nodes = read.ir(run, source.irRef).then((doc) => indexNodes(doc.root));
      irs.set(source.irRef, nodes);
    }
    const byId = await nodes;
    if (!byId.has(source.nodeId)) continue;
    const within = (src: string) => {
      for (let id: string | null | undefined = src; id; id = byId.get(id)?.parent) {
        if (id === source.nodeId) return true;
      }
      return false;
    };
    out.push({ section, nodeId: source.nodeId, within });
  }
  return out;
}

/** Gives each section of the run's Handoff the DSL subtree its preview draws it with. */
async function treeSections(
  tenantId: string,
  run: PreviewRun,
  library: SectionLibrary,
  read: ShapeReader,
): Promise<number> {
  if (!read.tree) return 0;
  const tree = await read.tree(run);
  let treed = 0;
  for (const { section, nodeId, within } of await scopedSections(tenantId, run, library, read)) {
    const subtree = sectionTree(tree, nodeId, within);
    if (!subtree) continue;
    await library.setTree(tenantId, section.id, subtree);
    treed++;
  }
  return treed;
}

/** Gives each section of the run's Handoff that its plan binds the shape of that data. */
async function shapeSections(
  tenantId: string,
  run: PreviewRun,
  library: SectionLibrary,
  read: ShapeReader,
): Promise<number> {
  const bound = run.bound;
  if (!bound) return 0;
  const [plan, data] = await Promise.all([
    read.artifact(run, bound.planId),
    read.artifact(run, bound.dataId),
  ]);
  let shaped = 0;
  for (const { section, within } of await scopedSections(tenantId, run, library, read)) {
    const shape = dataShapeOf({ plan: plan as BindingPlan, data, within });
    if (!shape) continue;
    await library.setDataShape(tenantId, section.id, shape);
    shaped++;
  }
  return shaped;
}

/**
 * Where a preview run's Handoff and artifacts are read: the FanXP backend for a `handoffId`
 * (`surface`: SURFACE_API_URL, SURFACE_SERVICE_KEY), the control plane for an `exportId`; the
 * binding plan and data from the control plane's project the preview is in.
 */
export function previewReaders(opts: {
  tenantId: string;
  surface?: { url: string; key: string } | undefined;
  tools: () => Promise<FanosTools>;
}) {
  const sources = new Map<string, Pick<HandoffSource, "getExport" | "json" | "bytes">>();
  const source = (run: PreviewRun) => {
    const key = `${run.handoff.kind}:${run.handoff.id}:${run.handoff.project}`;
    let s = sources.get(key);
    if (!s) {
      if (run.handoff.kind === "handoff") {
        if (!opts.surface) {
          throw new Error("set SURFACE_API_URL and SURFACE_SERVICE_KEY to read FanXP Handoffs");
        }
        s = createSurfaceHandoffSource(opts.tenantId, run.handoff.id, opts.surface);
      } else {
        s = createControlPlaneSource(run.handoff.project);
      }
      sources.set(key, s);
    }
    return s;
  };
  const shapes: ShapeReader = {
    ir: async (run, irRef) => (await opts.tools()).parseIr(await source(run).json(irRef)) as IrDoc,
    artifact: (run, id) =>
      createControlPlaneSource(run.bound?.project ?? run.theme?.project ?? "default").json(id),
    tree: (run) => {
      const target = previewTarget(run.previewUrl);
      if (!target) throw new Error(`not a preview link: ${run.previewUrl}`);
      return createControlPlaneSource(target.project).json(target.tree);
    },
  };
  return { source, shapes };
}

/**
 * What the worker calls after each completed run (`onCompleted`): a preview or a binding run
 * shares its Handoff's sections, indexing the Handoff first when the library has not seen it,
 * and gives them their data shape. Any other agent's run is passed over.
 */
export function libraryFollowUp(opts: {
  pool: Pool;
  library: SectionLibrary;
  crops: CropStore;
  /** Loaded at the first preview, so a worker starts without the built `@fanos` packages. */
  tools: () => Promise<FanosTools>;
  captioner?: Captioner;
  surface?: { url: string; key: string } | undefined;
  /** With it, a tenant's first shared preview with a theme proposes its skeleton palette. */
  memory?: PaletteFacts;
}) {
  return async (run: {
    tenantId: string;
    runId: string;
    agentId: string;
  }): Promise<(PreviewSync & { paletteProposed: boolean }) | undefined> => {
    if (!LIBRARY_AGENTS.includes(run.agentId)) return undefined;
    const read = previewReaders({
      tenantId: run.tenantId,
      surface: opts.surface,
      tools: opts.tools,
    });
    const sync = await syncPreviews({
      pool: opts.pool,
      tenantId: run.tenantId,
      library: opts.library,
      runId: run.runId,
      shapes: read.shapes,
      index: async (preview) =>
        indexHandoff({
          tenantId: run.tenantId,
          handoffId: preview.handoff.id,
          source: read.source(preview),
          library: opts.library,
          crops: opts.crops,
          tools: await opts.tools(),
          ...(opts.captioner ? { captioner: opts.captioner } : {}),
        }),
    });
    let paletteProposed = false;
    if (opts.memory && sync.marked.some((m) => m.sections > 0)) {
      const memory = opts.memory;
      const facts = [
        ...(await memory.activeFacts(run.tenantId)),
        ...(await memory.listProposals(run.tenantId)),
      ];
      if (!facts.some((f) => f.key === PALETTE_FACT)) {
        const { palette } = await learnPalette({
          pool: opts.pool,
          tenantId: run.tenantId,
          library: opts.library,
          shapes: read.shapes,
        });
        if (palette) {
          paletteProposed = await proposePalette({
            memory,
            tenantId: run.tenantId,
            palette,
            sourceRunId: run.runId,
            onlyFirst: true,
          });
        }
      }
    }
    return { ...sync, paletteProposed };
  };
}

/**
 * The palette a tenant's own designs are painted in, from the sections of its latest previewed
 * Handoffs (`handoffs`, 10 unless named), each read through the theme its preview used.
 */
export async function learnPalette(opts: {
  pool: Pool;
  tenantId: string;
  library: SectionLibrary;
  shapes: ShapeReader;
  handoffs?: number;
}): Promise<{ palette: SkeletonPalette | undefined; handoffs: number; sections: number }> {
  const runs = (await previewRuns(opts.pool, opts.tenantId)).filter((r) => r.theme).reverse();
  const votes = emptyVotes();
  const seen = new Set<string>();
  let sections = 0;
  for (const run of runs) {
    if (seen.size >= (opts.handoffs ?? 10)) break;
    if (seen.has(run.handoff.id) || !run.theme) continue;
    seen.add(run.handoff.id);
    try {
      const colourOf = themeColours(await opts.shapes.artifact(run, run.theme.id));
      const own = await opts.library.ofHandoff(opts.tenantId, run.handoff.id);
      const irs = new Map<string, ReturnType<typeof indexNodes>>();
      for (const section of own) {
        const source = section.sources.find((s) => s.handoffId === run.handoff.id);
        if (!source) continue;
        let byId = irs.get(source.irRef);
        if (!byId) {
          byId = indexNodes((await opts.shapes.ir(run, source.irRef)).root);
          irs.set(source.irRef, byId);
        }
        const node = byId.get(source.nodeId)?.node;
        if (!node) continue;
        addPaintVotes(votes, node, colourOf);
        sections++;
      }
    } catch {
      // a Handoff that can no longer be read adds nothing
      seen.delete(run.handoff.id);
    }
  }
  return { palette: paletteFromVotes(votes), handoffs: seen.size, sections };
}

/** The part of the memory store a palette fact is read and proposed through. */
export interface PaletteFacts {
  activeFacts(tenantId: string): Promise<Array<{ key: string | null; content: string }>>;
  listProposals(tenantId: string): Promise<Array<{ key: string | null; content: string }>>;
  proposeFact(f: {
    tenantId: string;
    agentId: string | null;
    key: string;
    content: string;
    confidence: number;
    sourceRunId: string | null;
  }): Promise<unknown>;
}

/** The tenant's approved palette, or undefined until a person approved one. */
export async function approvedPalette(
  memory: Pick<PaletteFacts, "activeFacts">,
  tenantId: string,
): Promise<SkeletonPalette | undefined> {
  const fact = (await memory.activeFacts(tenantId)).find((f) => f.key === PALETTE_FACT);
  return fact ? parsePaletteFact(fact.content) : undefined;
}

/**
 * Proposes the palette as the tenant's `library.palette` fact, for a person to approve
 * (`pnpm agent memory review`). Nothing when the approved or a pending fact says the same, or,
 * with `onlyFirst`, when there is either already.
 */
export async function proposePalette(opts: {
  memory: PaletteFacts;
  tenantId: string;
  palette: SkeletonPalette;
  sourceRunId?: string | null;
  onlyFirst?: boolean;
}): Promise<boolean> {
  const content = paletteFact(opts.palette);
  const [active, proposed] = await Promise.all([
    opts.memory.activeFacts(opts.tenantId),
    opts.memory.listProposals(opts.tenantId),
  ]);
  const facts = [...active, ...proposed].filter((f) => f.key === PALETTE_FACT);
  if (facts.some((f) => f.content === content) || (opts.onlyFirst && facts.length)) return false;
  await opts.memory.proposeFact({
    tenantId: opts.tenantId,
    agentId: null,
    key: PALETTE_FACT,
    content,
    confidence: 0.8,
    sourceRunId: opts.sourceRunId ?? null,
  });
  return true;
}
