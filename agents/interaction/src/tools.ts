/**
 * ix.load reads a published section and what it shows about how it behaves; ix.apply makes the
 * behaviours the model settled into the section's tree and plan, checks them and publishes a new
 * version of the preview.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  asBag,
  behaviourObligations,
  loadDsl,
  loadSigner,
  type Unmet,
} from "@dugout/agent-data-bind";
import { defineState, defineTool, type ToolContext } from "@dugout/contracts";
import { describeImage, REPO_ROOT } from "@dugout/core";
import { z } from "zod";
import { type CheckDsl, check } from "./check.ts";
import { Behaviours, compile } from "./compile.ts";
import { type Evidence, evidenceOf } from "./evidence.ts";
import { createPlane, type Plane, previewOf, type VersionStore } from "./store.ts";
import { type Plan, rootOf, type Tree } from "./tree.ts";

export const RunInput = z.object({
  preview: z
    .string()
    .regex(/^https?:\/\//)
    .describe("The preview of the section: /preview/<project>/<tree>?plan=…&data=…"),
  section: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The section's run (the run that built it): its versions are kept under it"),
  request: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "What a person asked the section to do, in their words, each with the element it is on: from ui-editor. Left out, the design is the brief",
    ),
});
export type RunInput = z.infer<typeof RunInput>;

export interface Published {
  previewUrl: string;
  treeArtifactId: string;
  planArtifactId: string;
  notes: string[];
}
export const PUBLISHED = defineState<Published>("ix.published");
/**
 * What the section's settled intent obliges it to do and it does not yet (ADR 0039): from ix.load
 * on the section as it was, and again from each ix.apply that publishes. The check on final reads it.
 */
export const OBLIGED = defineState<Unmet[]>("ix.obliged");

/** The obligations a section's tree and plan leave open over its data. */
export function obligedOf(tree: Tree, plan: Plan, data: unknown) {
  const root = rootOf(tree);
  return behaviourObligations(plan, data, {
    machine: root?.props.machine,
    layers: [tree.nodes.map((n) => n.props), plan.set ?? []],
  });
}

/** The DSL's dist, for the checks: the same code that draws the page decides each state. */
let dslDist: Promise<CheckDsl> | undefined;
const checkDsl = () => {
  dslDist ??= import(
    pathToFileURL(join(REPO_ROOT, "packages/dsl/dist/index.js")).href
  ) as Promise<CheckDsl>;
  return dslDist;
};

/**
 * Each layer's look by place (`at`) as the binding draws it, by src: the plan applied to the stored
 * tree with the DSL's own code. Reported as evidence; empty when the DSL cannot be read.
 */
async function placedLooks(stored: Tree, plan: Plan): Promise<Map<string, unknown>> {
  try {
    const { tree } = (await checkDsl()).applyBindingPlan(stored, plan);
    return new Map(
      tree.nodes
        .filter((n) => n.props.at && typeof n.props.at === "object")
        .filter((n) => Object.keys(n.props.at as object).length > 0)
        .map((n) => [n.src, n.props.at]),
    );
  } catch {
    return new Map();
  }
}

/**
 * The section's data sources, as the page reads them: each by the name its refs start with, the
 * hook and inputs it was bound with, and what it holds at its top (a list's length, a value as it
 * is: `next: 2`), which is where a list says how it pages. Evidence for a request for more of a
 * source; nothing here decides that the section pages.
 */
export function sourcesOf(data: unknown, meta: Record<string, unknown>) {
  const bound = Array.isArray(meta.data) ? (meta.data as Array<Record<string, unknown>>) : [];
  const bag = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return Object.entries(bag).map(([as, value]) => {
    const how = bound.find((b) => b.as === as);
    const top =
      value && typeof value === "object" && !Array.isArray(value) ? value : { items: value };
    const holds = Object.fromEntries(
      Object.entries(top as Record<string, unknown>).map(([k, v]) => [
        k,
        Array.isArray(v) ? `list of ${v.length}` : v && typeof v === "object" ? "object" : v,
      ]),
    );
    return {
      as,
      ...(typeof how?.hookId === "string" ? { hookId: how.hookId } : {}),
      ...(how?.input && typeof how.input === "object" ? { input: how.input } : {}),
      holds,
    };
  });
}

/** The section's buttons outside any list, by src, with their words: what a press could start. */
export function buttonsOf(tree: Tree) {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const inList = (id: string | null): boolean => {
    for (
      let at = id ? byId.get(id) : undefined;
      at;
      at = at.parent ? byId.get(at.parent) : undefined
    ) {
      if (at.type === "Repeater") return true;
    }
    return false;
  };
  return tree.nodes
    .filter((n) => n.type === "Button" && !inList(n.parent))
    .map((n) => ({
      src: n.src,
      label: typeof n.props.label === "string" ? n.props.label : "",
      ...(n.props.when !== undefined ? { when: n.props.when } : {}),
    }));
}

const META_OWN = new Set(["source", "runId", "from", "preview", "comments", "section"]);

/** Asks a vision model what a small picture shows; left out of a test, no picture is described. */
export type See = (png: Buffer, signal?: AbortSignal) => Promise<string>;

const SEE_PROMPT =
  "This is one small picture from a web page's design, such as an icon or a control. In six words or fewer, say what it shows, with its colours (for example: green circle with white tick; empty grey circle; outlined star; filled blue star). Answer with the words only.";

export const seeWithHaiku: See = (png, signal) =>
  describeImage({ png, prompt: SEE_PROMPT, ...(signal ? { signal } : {}) }).then((t) =>
    t.trim().slice(0, 80),
  );

/**
 * What each picture that differs by card shows: a layer's name ("Frame 1984079177") says nothing,
 * and the model settles from this what a tick or a filled star stands for. One look per picture,
 * at most twelve; a picture that cannot be read keeps its name. A part where every card has its
 * own picture (`everyCard`, a photo each) is not described: one call per card for what the plan's
 * `boundTo` already says.
 */
async function describePictures(
  evidence: Evidence,
  tree: Tree,
  see: See | undefined,
  signal?: AbortSignal,
) {
  if (!see) return;
  const bySrc = new Map(tree.nodes.map((n) => [n.src, n]));
  const asked = new Map<string, Promise<string | undefined>>();
  const groups = evidence.lists.flatMap((l) =>
    l.differences.filter((d) => !d.everyCard).flatMap((d) => d.groups),
  );
  for (const g of groups) {
    const node = g.srcs.map((s) => bySrc.get(s)).find((n) => n?.type === "Image");
    const src = node?.props.src;
    if (typeof src !== "string" || !src.startsWith("data:image/png;base64,")) continue;
    if (!asked.has(src) && asked.size >= 12) continue;
    let answer = asked.get(src);
    if (!answer) {
      answer = see(Buffer.from(src.slice("data:image/png;base64,".length), "base64"), signal).catch(
        () => undefined,
      );
      asked.set(src, answer);
    }
    const shows = await answer;
    if (shows) g.shows = shows;
  }
}

export function createInteractionTools(
  opts: {
    plane?: (project: string) => Plane;
    versions?: VersionStore;
    web?: string;
    see?: See | false;
  } = {},
) {
  const planeOf = opts.plane ?? createPlane;
  const see = opts.see === false ? undefined : (opts.see ?? seeWithHaiku);
  const cache = new Map<
    string,
    Promise<{
      stored: Tree;
      plan: Plan;
      data: unknown;
      dataMeta: Record<string, unknown>;
      meta: Record<string, unknown>;
      planMeta: Record<string, unknown>;
      evidence: Evidence;
      placed: Map<string, unknown>;
    }>
  >();
  const inputOf = (ctx: Pick<ToolContext, "input">) => RunInput.parse(ctx.input);

  const loaded = (ctx: ToolContext) => {
    let held = cache.get(ctx.runId);
    if (!held) {
      held = (async () => {
        const link = previewOf(inputOf(ctx).preview);
        const plane = planeOf(link.project);
        const [stored, meta] = await Promise.all([
          plane.json(link.tree) as Promise<Tree>,
          plane.meta(link.tree).catch(() => ({}) as Record<string, unknown>),
        ]);
        const plan = (link.plan ? await plane.json(link.plan) : {}) as Plan;
        const planMeta = link.plan ? await plane.meta(link.plan).catch(() => ({})) : {};
        const raw = link.data ? await plane.json(link.data).catch(() => undefined) : undefined;
        const dataMeta = link.data ? await plane.meta(link.data).catch(() => ({})) : {};
        const data = raw === undefined ? undefined : asBag(raw, await loadDsl());
        const irId = typeof meta.irArtifactId === "string" ? meta.irArtifactId : undefined;
        const ir = irId ? await plane.json(irId).catch(() => undefined) : undefined;
        if (ir) {
          // what a person decides here is about this section, as frame-match and data-bind name it
          const section = (await loadSigner())(ir);
          const name = (ir as { root?: { name?: unknown } }).root?.name;
          if (section) ctx.situate?.({ section, ...(typeof name === "string" ? { name } : {}) });
        }
        const placed = await placedLooks(stored, plan);
        const evidence = evidenceOf(stored, plan, data, ir, placed);
        await describePictures(evidence, stored, see, ctx.signal);
        return { stored, plan, data, dataMeta, meta, planMeta, evidence, placed };
      })();
      cache.set(ctx.runId, held);
    }
    return held;
  };

  const load = defineTool({
    name: "ix.load",
    description:
      "Read the published section and what it shows about how it behaves. lists: each list the plan repeats, with an item's fields, a proposed field that tells items apart (key, and every field that would do: keys), every part of the design's cards that differs from card to card (each look, the cards with it, the layer drawing it on each, what the plan binds there: boundTo, and everyCard when each card has its own look), and what the binding plan already decides about the card's layers (planRules: a when, a look by place). fields: what a person can type or tick (each writes _page.<key>). overflow: boxes the design clips whose content runs past them. machine: what the section does already. sources: the section's data sources, each by the name its refs start with, the hook and inputs it was bound with, and what it holds at its top (lists' lengths, values such as next: 2): where a list says how it pages. buttons: the buttons outside any list, by src, with their words. obligations: what the section's settled intent (a paged list) obliges it to do and it does not yet, built whatever the data holds today; final is refused while one is open, unless unmet names it with a reason. request: what a person asked, when one did. Call it first, once.",
    input: z.object({}).strict(),
    effect: "read",
    timeoutMs: 60_000,
    async run(_input, ctx) {
      const { evidence, stored, plan, data, dataMeta } = await loaded(ctx);
      const request = inputOf(ctx).request;
      const obliged = obligedOf(stored, plan, data);
      ctx.state.set(OBLIGED, obliged);
      return {
        ...evidence,
        ...(obliged.length ? { obligations: obliged.map((o) => o.problem) } : {}),
        sources: sourcesOf(data, dataMeta),
        buttons: buttonsOf(stored),
        ...(request ? { request } : {}),
        rule: "This is evidence, and none of it is settled. Settle what each difference stands for from it (and from memory, through ask under a stable id), and ask a person only what the design cannot say. When there is nothing to make behave, call final without ix.apply.",
      };
    },
  });

  const apply = defineTool({
    name: "ix.apply",
    description:
      "Make the behaviours you settled into the section and publish it as a new version of the preview. toggles: lists in state a press adds an item to or takes out (picked, favourite), with the layers a press on toggles them. show: a part drawn only when an item is in (or in none of) some lists: each look of a part that changes is its own layer from the evidence (the tick when picked, the empty circle when not). restyle: a template layer that takes another card's layer's look when an item is in (or in none of) some lists (a name in bold blue). search: a field that filters a list by an item field. scroll: a box that scrolls. planRules: for each rule the binding plan has on a part the state now decides (a when on it or on the card around it, a look by place on it), whether the state decides alone or both hold; one left out is reported in conflicts and nothing is published. Code writes the machine, the conditions and what each press sends for those. machine and props: anything else, written by you in the DSL (the machine skill): the section's machine, and on layers what a press sends (on), when a part is drawn (when), a look per state (statesWhen). Then every state of an item is checked to draw one look of each part, the machine is checked (S18) and run event by event (states: what each press does, what it asks for, what is drawn after), and it is published only when nothing is wrong; with problems nothing is published. Send everything each time: it replaces the last call.",
    input: Behaviours,
    effect: "write",
    // a new version of a preview, to go back to: not a gate
    noApproval: true,
    timeoutMs: 60_000,
    latestOnly: true,
    async run(input, ctx) {
      const { stored, plan, data, meta, planMeta, placed } = await loaded(ctx);
      const compiled = compile(stored, plan, input, placed);
      const conflicts = compiled.conflicts.length ? { conflicts: compiled.conflicts } : {};
      if (compiled.problems.length)
        return {
          published: false,
          problems: compiled.problems,
          ...conflicts,
          notes: compiled.notes,
        };
      const checked = check(compiled, input, data, await checkDsl());
      if (checked.problems.length) {
        return {
          published: false,
          problems: checked.problems,
          states: checked.states,
          ...conflicts,
          notes: compiled.notes,
        };
      }
      const run = inputOf(ctx);
      const link = previewOf(run.preview);
      const plane = planeOf(link.project);
      const carried = Object.fromEntries(Object.entries(meta).filter(([k]) => !META_OWN.has(k)));
      const treeArtifactId = await plane.upload("dsl_tree", compiled.tree, {
        ...carried,
        source: "dugout:interaction",
        runId: ctx.runId,
        from: link.tree,
        preview: run.preview,
        ...(run.section ? { section: run.section } : {}),
      });
      const planArtifactId = await plane.upload("binding_plan", compiled.plan, {
        ...planMeta,
        source: "dugout:interaction",
        runId: ctx.runId,
        ...(link.plan ? { from: link.plan } : {}),
      });
      const url = new URL(link.url.toString());
      if (opts.web) {
        const web = new URL(opts.web);
        url.protocol = web.protocol;
        url.host = web.host;
      }
      url.pathname = `/preview/${encodeURIComponent(link.project)}/${treeArtifactId}`;
      url.searchParams.set("plan", planArtifactId);
      const previewUrl = url.toString();
      if (run.section && opts.versions) {
        await opts.versions.add(ctx.tenantId, {
          section: run.section,
          project: link.project,
          tree: treeArtifactId,
          plan: planArtifactId,
          ...(link.data ? { data: link.data } : {}),
          ...(url.searchParams.get("surfaces")
            ? { surfaces: url.searchParams.get("surfaces") as string }
            : {}),
          preview: previewUrl,
          fromTree: link.tree,
          runId: ctx.runId,
          what: compiled.notes.join("; "),
        });
      }
      const obliged = obligedOf(compiled.tree, compiled.plan, data);
      ctx.state.set(OBLIGED, obliged);
      ctx.state.set(PUBLISHED, {
        previewUrl,
        treeArtifactId,
        planArtifactId,
        notes: compiled.notes,
      });
      return {
        published: true,
        previewUrl,
        notes: compiled.notes,
        states: checked.states,
        ...conflicts,
        ...(obliged.length ? { obligations: obliged.map((o) => o.problem) } : {}),
      };
    },
  });

  return [load, apply];
}
