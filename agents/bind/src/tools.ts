import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolContext } from "@dugout/contracts";
import { REPO_ROOT } from "@dugout/core";
import { z } from "zod";
import { asBag, type Dsl, type IrNode, indexIr, loadDsl, type Tree } from "./dsl.ts";
import { type DryRun, dryRun, groups, lostLooks, outline, shapeOf } from "./facts.ts";

export const BIND_DIR = join(REPO_ROOT, ".runs", "bind");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RunInput = z.object({
  preview: z
    .string()
    .regex(/^https?:\/\//)
    .describe(
      "The preview link card-match published: /preview/<project>/<tree>?theme=…&surfaces=…",
    ),
  data: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .describe(
      "The sample data: a sample_data artifact id, or the name of a dataset the API serves",
    ),
});
export type RunInput = z.infer<typeof RunInput>;

/** The preview link, taken apart. */
export function previewOf(link: string) {
  const url = new URL(link);
  const match = /^\/preview\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match || !UUID.test(match[2] ?? "")) {
    throw new Error(`not a preview link of a tree: ${link}`);
  }
  return { url, project: decodeURIComponent(match[1] as string), tree: match[2] as string };
}

// ---------------------------------------------------------------------------
// The plan, as the model writes it (the format is `@fanos/dsl` `BindingPlan`)
// ---------------------------------------------------------------------------

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Condition = z
  .object({
    path: z.string().describe("A data path, the item's alias first: match.state"),
    eq: Scalar.optional(),
    ne: Scalar.optional(),
    in: z.array(Scalar).optional(),
    exists: z.boolean().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
  })
  .strict()
  .describe("Exactly one operator");
const Predicate = z.union([Condition, z.array(Condition)]);
const Field = z
  .object({
    src: z.string().describe("The Figma id of the node, from the outline"),
    prop: z.string().describe("content for a text, src or alt for a picture, label for a button"),
    path: z
      .string()
      .optional()
      .describe(
        'Inside a collapse: relative to the item (teams.0.score). Pipes allowed: date | date:"DD MMMM"',
      ),
    template: z
      .string()
      .optional()
      .describe(
        "The whole value when the design writes words around the data: ({match.overs}). Refs name the alias",
      ),
  })
  .strict();
const Variant = z
  .object({
    src: z.string().describe("The root of the other shape, in another member"),
    when: Predicate,
    fields: z.array(Field).optional(),
  })
  .strict();
const Collapse = z
  .object({
    over: z.string().describe("The list: fixtures.items, or an outer alias's field: day.matches"),
    as: z.string().describe("What one item is called: day, match"),
    members: z
      .array(z.string())
      .min(1)
      .describe("Every sibling that is one item, Figma ids, the first is the template"),
    shape: z
      .enum(["identical", "varies"])
      .optional()
      .describe(
        'Leave out: members are folded even when they differ. "identical" refuses members that differ',
      ),
    when: Predicate.optional().describe(
      "When the template draws, when it is one variant of several",
    ),
    variants: z.array(Variant).optional(),
    fields: z.array(Field).optional(),
  })
  .strict();
/** The time left until an instant, or since it, that the nodes under it read by `as`. */
const Clock = z
  .object({
    to: z.string().describe("A ref to the instant, {match.start_time}"),
    as: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .describe("What the digits read it by"),
    units: z
      .array(z.enum(["d", "h", "m", "s"]))
      .min(1)
      .describe("The units the design draws, d h m s"),
  })
  .strict();

export const Plan = z
  .object({
    note: z.string().optional().describe("One line on what this plan binds, for a person"),
    collapse: z.array(Collapse).optional().describe("Lists, innermost first"),
    bind: z
      .array(Field)
      .optional()
      .describe("Fields outside any list: paths from the top of the data"),
    set: z
      .array(
        z
          .object({
            src: z.string(),
            prop: z.string(),
            value: z
              .union([z.string(), z.number(), z.boolean(), Predicate, Clock])
              .describe(
                'A literal ("upper" for textCase); for prop when, a condition; for prop clock, a clock',
              ),
          })
          .strict(),
      )
      .optional()
      .describe(
        "Literal props: textCase, a when that hides a node whose field is missing, a clock on the block that shows a time left",
      ),
  })
  .strict();
export type Plan = z.infer<typeof Plan>;

// ---------------------------------------------------------------------------
// The run's work, on disk so a run resumed after an approval keeps it
// ---------------------------------------------------------------------------

const Tried = z.object({
  plan: Plan,
  problems: z.array(z.string()),
  bound: z.number(),
  collapsed: z.number(),
});

const Published = z.object({
  previewUrl: z.string(),
  planArtifactId: z.string(),
  dataArtifactId: z.string(),
  bound: z.number(),
  collapsed: z.number(),
  problems: z.array(z.string()),
});

const State = z.object({
  tried: Tried.optional(),
  refusals: z.number().default(0),
  published: Published.optional(),
});
type State = z.infer<typeof State>;

const stateFile = (dir: string, runId: string) => join(dir, `${runId}.json`);
function readState(dir: string, runId: string): State {
  try {
    return State.parse(JSON.parse(readFileSync(stateFile(dir, runId), "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return State.parse({});
    throw err;
  }
}
function writeState(dir: string, runId: string, state: State) {
  mkdirSync(dir, { recursive: true });
  const path = stateFile(dir, runId);
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

// ---------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------

export interface Plane {
  json(id: string): Promise<unknown>;
  meta(id: string): Promise<Record<string, unknown>>;
  exportIr(exportId: string): Promise<IrNode>;
  dataset(name: string): Promise<unknown>;
  upload(kind: string, json: unknown, meta: Record<string, unknown>): Promise<string>;
}

export function createPlane(project: string, env: NodeJS.ProcessEnv = process.env): Plane {
  const api = (env.FANOS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");
  const key = env.FANOS_API_KEY?.trim();
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  const base = `${api}/v1/projects/${encodeURIComponent(project)}`;
  const get = async (url: string) => {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`control plane ${url.replace(api, "")}: ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  return {
    json: (id) => get(`${base}/artifacts/${encodeURIComponent(id)}/content`),
    meta: async (id) =>
      (
        (await get(`${base}/artifacts/${encodeURIComponent(id)}`)) as {
          meta?: Record<string, unknown>;
        }
      ).meta ?? {},
    async exportIr(exportId) {
      const record = (await get(`${base}/exports/${encodeURIComponent(exportId)}`)) as {
        irArtifactId: string;
      };
      const doc = (await get(
        `${base}/artifacts/${encodeURIComponent(record.irArtifactId)}/content`,
      )) as { root: IrNode };
      return doc.root;
    },
    dataset: (name) =>
      UUID.test(name)
        ? get(`${base}/artifacts/${name}/content`)
        : get(`${api}/v1/data/${encodeURIComponent(name)}`),
    async upload(kind, json, meta) {
      const response = await fetch(`${base}/artifacts`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ kind, json, meta }),
      });
      if (!response.ok)
        throw new Error(
          `control plane upload ${kind}: ${response.status} ${await response.text()}`,
        );
      return ((await response.json()) as { id: string }).id;
    },
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

interface Loaded {
  tree: Tree;
  byId: Map<string, IrNode>;
  bag: Record<string, unknown>;
  dsl: Dsl;
}

/** Problems a person would see on the page: each is a reason not to publish. */
export function problemsOf(
  applied: { drift: Array<{ src: string; message: string }> },
  structure: Array<{ message: string }>,
  run: DryRun,
  plan?: z.infer<typeof Plan>,
  design?: Tree,
): string[] {
  const lost = (plan?.collapse ?? []).flatMap((c) => {
    if (!design) return [];
    const variantRoots = new Set((c.variants ?? []).map((v) => v.src));
    const differ = lostLooks(
      design,
      c.members.filter((m, i) => i === 0 || !variantRoots.has(m)),
    );
    return differ.length
      ? [
          `the members of ${c.over} differ in look, and a collapse draws every item like ${c.members[0]}: ${differ.slice(0, 3).join("; ")}. When a list always holds the same number of items and the design gives each position its own look, bind each member by position (${c.over.split(".").pop()}.0, .1) instead of collapsing`,
        ]
      : [];
  });
  return [
    ...lost,
    ...run.repeated.map(
      (r) =>
        `${r.src} shows the design's "${r.copy}" in all ${r.times} items it draws in: a placeholder. Bind it to what it stands for (time left until an instant is a clock), or say in remaining why it stays`,
    ),
    ...run.capitals.map(
      (c) =>
        `${c.src} shows "${c.shows}" where the design writes capitals ("${c.design}"): set textCase "upper"`,
    ),
    ...applied.drift.map((d) => `not applied: ${d.message}`),
    ...structure.map((s) => `the tree is invalid: ${s.message}`),
    ...run.variants.map((v) =>
      v.drew === 0
        ? `${v.times} item(s) of ${v.template} draw no variant, e.g. ${v.example}: no when matches them`
        : `${v.times} item(s) of ${v.template} draw ${v.drew} variants at once, e.g. ${v.example}: the whens overlap`,
    ),
    ...run.unresolved.map((u) =>
      u.prop === "clock.to"
        ? `${u.src} clock reads no instant at ${u.value} for ${u.times} item(s), e.g. ${u.example}: point "to" at a field the data shows as (instant), or hide the block with a when exists`
        : `${u.src} ${u.prop} "${u.value}" has nothing at ${u.missing.join(", ")} for ${u.times} item(s), e.g. ${u.example}: a wrong path, or a field some items lack (hide the node with a when exists, or give the ref a default pipe)`,
    ),
  ];
}

const MAX_REFUSALS = 2;

export function createBindTools(
  opts: { dir?: string; plane?: (project: string) => Plane; web?: string } = {},
) {
  const dir = opts.dir ?? BIND_DIR;
  const planeOf = opts.plane ?? createPlane;
  const cache = new Map<string, Promise<Loaded>>();
  const inputOf = (ctx: Pick<ToolContext, "input">) => RunInput.parse(ctx.input);

  const loaded = (ctx: Pick<ToolContext, "input" | "runId">) => {
    let held = cache.get(ctx.runId);
    if (!held) {
      held = (async () => {
        const input = inputOf(ctx);
        const { project, tree: treeId } = previewOf(input.preview);
        const plane = planeOf(project);
        const [tree, meta, raw, dsl] = await Promise.all([
          plane.json(treeId) as Promise<Tree>,
          plane.meta(treeId),
          plane.dataset(input.data),
          loadDsl(),
        ]);
        const exportId = typeof meta.exportId === "string" ? meta.exportId : undefined;
        const root = exportId ? await plane.exportIr(exportId) : undefined;
        return { tree, byId: root ? indexIr(root) : new Map(), bag: asBag(raw, dsl), dsl };
      })();
      held.catch(() => cache.delete(ctx.runId));
      cache.set(ctx.runId, held);
    }
    return held;
  };

  const load = defineTool({
    name: "bind.load",
    description:
      "Read the frame and the sample data. Returns the frame's outline (each line starts with the Figma id a plan names it by), what repeats in it, and every path in the data. Call it first, once.",
    input: z.object({}).strict(),
    effect: "read",
    timeoutMs: 60_000,
    alwaysInline: true,
    async run(_input, ctx) {
      const { tree, byId, bag } = await loaded(ctx);
      const found = groups(tree, byId).map((g) =>
        g.shapes.length === 1
          ? `${g.parent} holds ${g.members.length} of one shape: ${g.members.join(", ")}`
          : `${g.parent} holds ${g.members.length}${g.component ? ` «${g.component}»` : ""} in ${g.shapes.length} shapes: ${g.shapes.map((s) => `[${s.join(", ")}]`).join(" ")}`,
      );
      return {
        frame: outline(tree, byId).join("\n"),
        repeats: found.length ? found.join("\n") : "nothing repeats",
        data: shapeOf(bag).join("\n"),
      };
    },
  });

  const node = defineTool({
    name: "bind.node",
    description:
      "Read one node in full: what Figma says (its layer name, component, text) and what the compiled tree has. Pass src.",
    input: z.object({ src: z.string().min(1) }).strict(),
    effect: "read",
    timeoutMs: 30_000,
    async run({ src }, ctx) {
      const { tree, byId } = await loaded(ctx);
      const ir = byId.get(src);
      const nodes = tree.nodes.filter((n) => n.src === src);
      if (!ir && nodes.length === 0) throw new Error(`no node has src ${src}`);
      return {
        figma: ir
          ? {
              name: ir.name,
              type: ir.type,
              componentKey: ir.componentKey,
              text: ir.text?.characters,
              children: ir.children?.length ?? 0,
            }
          : null,
        tree: nodes.map((n) => {
          const { _meta, ...props } = n.props;
          const kids = tree.nodes.filter((k) => k.parent === n.id).map((k) => `${k.src} ${k.type}`);
          return { type: n.type, props, children: kids };
        }),
      };
    },
  });

  const tryPlan = defineTool({
    name: "bind.try",
    description:
      "Apply a binding plan to the frame and draw it against every item of the sample, without publishing. Returns what was bound, what each repeat drew, what the page would show, and every problem: a node the plan could not reach, an invalid tree, a ref with nothing behind it, an item that draws no variant or two. Fix them and try again; the last plan tried is the one bind.publish stores.",
    // A JSON string, not a schema: a plan's nested conditions are more optional fields than a
    // model provider takes in one tool schema. It is parsed against `Plan` here instead.
    input: z
      .object({
        plan: z
          .string()
          .min(2)
          .describe(
            'The whole plan as JSON: {"note","collapse":[{"over","as","members","shape","when","variants":[{"src","when","fields"}],"fields":[{"src","prop","path"|"template"}]}],"bind":[…],"set":[{"src","prop","value"}]}',
          ),
      })
      .strict(),
    effect: "read",
    timeoutMs: 60_000,
    async run(input, ctx) {
      let json: unknown;
      try {
        json = JSON.parse(input.plan);
      } catch (err) {
        return { problems: [`the plan is not JSON: ${(err as Error).message}`] };
      }
      const parsed = Plan.safeParse(json);
      if (!parsed.success) {
        return {
          problems: parsed.error.issues
            .slice(0, 8)
            .map(
              (i) => `the plan is not in the format: ${i.path.join(".") || "(top)"}: ${i.message}`,
            ),
        };
      }
      // members of one component drawn in several states are the common case: fold them anyway
      const plan = {
        ...parsed.data,
        ...(parsed.data.collapse
          ? { collapse: parsed.data.collapse.map((c) => ({ ...c, shape: c.shape ?? "varies" })) }
          : {}),
      };
      const { tree, bag, dsl } = await loaded(ctx);
      const applied = dsl.applyBindingPlan(tree, plan);
      const structure = dsl.check(applied.tree);
      const run = dryRun(applied.tree, bag, dsl, tree);
      const problems = problemsOf(applied, structure, run, plan, tree);
      const state = readState(dir, ctx.runId);
      writeState(dir, ctx.runId, {
        ...state,
        tried: { plan, problems, bound: applied.bound, collapsed: applied.collapsed },
      });
      return {
        bound: applied.bound,
        collapsed: applied.collapsed,
        repeats: run.repeats.map((r) => `${r.template} drew ${r.items} item(s) of ${r.over}`),
        shows: run.samples.map(
          (s) => `${s.src} ${s.prop}: ${s.values.map((v) => JSON.stringify(v)).join(", ")}`,
        ),
        problems: problems.length ? problems : "none",
      };
    },
  });

  const publish = defineTool<
    Record<string, never>,
    z.infer<typeof Published>,
    Record<string, unknown>
  >({
    name: "bind.publish",
    description:
      "Store the last plan bind.try applied, with the sample data, and return the preview link of the bound frame. Refused while that plan has problems, at most twice.",
    input: z.object({}).strict(),
    effect: "write",
    timeoutMs: 60_000,
    // the approval shows what code measured, never the model's account of it
    resolve(_input, ctx) {
      const tried = readState(dir, ctx.runId).tried;
      return tried
        ? {
            note: tried.plan.note ?? "",
            bound: tried.bound,
            collapsed: tried.collapsed,
            problems: tried.problems,
          }
        : {};
    },
    block(_input, ctx) {
      const state = readState(dir, ctx.runId);
      if (state.published) return undefined;
      if (!state.tried) return "Nothing to publish. Call bind.try with a plan first.";
      if (state.tried.problems.length === 0 || state.refusals >= MAX_REFUSALS) return undefined;
      writeState(dir, ctx.runId, { ...state, refusals: state.refusals + 1 });
      return `Not yet (${state.refusals + 1} of ${MAX_REFUSALS}). The plan has problems: ${state.tried.problems.slice(0, 5).join(" | ")}. Fix their cause and call bind.try with the whole plan before bind.publish: calling bind.publish again now ends the run. If they cannot be fixed, call bind.try with the plan as it is, then bind.publish; after ${MAX_REFUSALS} refusals it goes through with them listed.`;
    },
    async run(_input, ctx) {
      const state = readState(dir, ctx.runId);
      if (state.published) return state.published;
      if (!state.tried) throw new Error("nothing was tried");
      const { bag } = await loaded(ctx);
      const input = inputOf(ctx);
      const { url, project } = previewOf(input.preview);
      const plane = planeOf(project);
      const meta = {
        source: "dugout:bind",
        runId: ctx.runId,
        preview: input.preview,
        data: input.data,
      };
      const dataArtifactId = await plane.upload("sample_data", bag, meta);
      const planArtifactId = await plane.upload("binding_plan", state.tried.plan, meta);
      const link = new URL(url.toString());
      if (opts.web) {
        const web = new URL(opts.web);
        link.protocol = web.protocol;
        link.host = web.host;
      }
      link.searchParams.set("data", dataArtifactId);
      link.searchParams.set("plan", planArtifactId);
      const published = {
        previewUrl: link.toString(),
        planArtifactId,
        dataArtifactId,
        bound: state.tried.bound,
        collapsed: state.tried.collapsed,
        problems: state.tried.problems,
      };
      writeState(dir, ctx.runId, { ...state, published });
      return published;
    },
  });

  return [load, node, tryPlan, publish];
}
