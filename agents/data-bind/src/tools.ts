import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolContext } from "@dugout/contracts";
import { REPO_ROOT } from "@dugout/core";
import type { Pool } from "@dugout/db";
import { pageChoicesOf } from "@dugout/db/page-choices";
import { defaultMcpHost, hookOutput, type McpHost } from "@dugout/mcp";
import { BEFORE_RULE, decidedBefore, type MemoryReader } from "@dugout/memory";
import { z } from "zod";
import { describeChoice, describeLink, type KnownChoice, linksOf } from "./choices.ts";
import { asBag, type Dsl, type IrNode, indexIr, loadDsl, loadSigner, type Tree } from "./dsl.ts";
import {
  type DryRun,
  dryRun,
  groups,
  type LeftAsDesigned,
  leftAsDesigned,
  lostLooks,
  memberOf,
  outline,
  ownPictures,
  repeatsOf,
  rowsOf,
  shapeOf,
  someOnly,
  type Unbound,
  unboundCopy,
} from "./facts.ts";
import { type DesignerNote, NOTES_RULE, notesOf } from "./notes.ts";
import { pageKeysRead, plannedSrcs, type Scope, Slot, scopeOf, wordsOf } from "./slot.ts";

export const BIND_DIR = join(REPO_ROOT, ".runs", "data-bind");
/** The registry's server a `cast-hook` data source is read from (config/mcp/cast.json). */
const CAST = "cast";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RunInput = z.object({
  preview: z
    .string()
    .regex(/^https?:\/\//)
    .describe(
      "The preview link frame-match published: /preview/<project>/<tree>?theme=…&surfaces=…",
    ),
  data: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional()
    .describe(
      "The sample data: a sample_data artifact id, or the name of a dataset the API serves. Leave out to find the data in the tenant's Cast hooks and bind against their live output",
    ),
  slot: Slot.optional().describe(
    "Bind one slot of the frame (frame-match's slots): the run works on that slot's nodes only, and ends with bind.done instead of bind.publish",
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
    eqPath: z
      .string()
      .optional()
      .describe("Equals what a path holds: _page.<key>, the choice the page is at"),
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
    slice: z
      .tuple([z.number().int().min(0), z.number().int().min(1)])
      .refine(([start, end]) => start < end, "slice is [start, end) with start < end")
      .optional()
      .describe("The items it draws, [start, end): one row of a grid drawn as rows, [2, 4]"),
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
    keep: z
      .array(
        z
          .object({
            src: z.string().describe("The Figma id of the node, or of the static block around it"),
            why: z
              .string()
              .min(8)
              .describe("Why it stays as designed: a heading, a label, the design's own look"),
          })
          .strict(),
      )
      .optional()
      .describe(
        "What stays as the designer drew it, on purpose: the section's static parts (a heading, a button, a note) and differences the data does not decide. A problem bind.try reports on a node kept here, or under a kept block that holds nothing the plan binds, is accepted, not open",
      ),
  })
  .strict();
export type Plan = z.infer<typeof Plan>;

// ---------------------------------------------------------------------------
// The run's work, on disk so a run resumed after an approval keeps it
// ---------------------------------------------------------------------------

const Tried = z.object({
  plan: Plan,
  /** Problems still open: each a reason not to publish. */
  problems: z.array(z.string()),
  /** What the plan keeps as designed, with why, and the problems each accepted. */
  kept: z.array(z.string()).default([]),
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
  kept: z.array(z.string()).default([]),
  /** Why it was published with problems open, when bind.publish said so. */
  despite: z.string().optional(),
  /** Where the data came from, as the plan's artifacts record it: one entry for each source. */
  sources: z.array(z.record(z.string(), z.unknown())).default([]),
});

/** A Cast hook's live output the run chose as its data, fetched once and kept. */
const Source = z.object({
  hookId: z.string(),
  /** The hook's public flow id: what a page fetches at `/cast/api/flow/<workflowId>`. */
  workflowId: z.string().optional(),
  /** As a page sends them: query parameters, every value a string. */
  input: z.record(z.string(), z.string()),
  /** The name the plan reads the data by: `fixtures.items`. */
  as: z.string(),
  sample: z.unknown(),
});

const State = z.object({
  tried: Tried.optional(),
  refusals: z.number().default(0),
  published: Published.optional(),
  /** The Cast hooks whose live output the run chose as data, by the name the plan reads each by. */
  sources: z.record(z.string(), Source).default({}),
  /** Nothing on the frame is data: what the run said why, when it said so (bind.static). */
  static: z.object({ why: z.string() }).optional(),
});
type State = z.infer<typeof State>;

const stateFile = (dir: string, runId: string) => join(dir, `${runId}.json`);
function readState(dir: string, runId: string): State {
  try {
    const saved = JSON.parse(readFileSync(stateFile(dir, runId), "utf8")) as Record<
      string,
      unknown
    >;
    // a run saved with one `source` has a list of one
    const legacy = saved.source as { as?: string } | undefined;
    if (legacy?.as && saved.sources === undefined) saved.sources = { [legacy.as]: legacy };
    return State.parse(saved);
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
  exportIr(exportId: string): Promise<{ root: IrNode; annotations: unknown[]; doc?: unknown }>;
  /** A Figma IR stored as its own artifact (a Handoff's, stored by frame-match). */
  ir(artifactId: string): Promise<{ root: IrNode; annotations: unknown[]; doc?: unknown }>;
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
  const irOf = async (artifactId: string) => {
    const doc = (await get(`${base}/artifacts/${encodeURIComponent(artifactId)}/content`)) as {
      root: IrNode;
      annotations?: unknown[];
    };
    return { root: doc.root, annotations: doc.annotations ?? [], doc };
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
      return irOf(record.irArtifactId);
    },
    ir: (artifactId) => irOf(artifactId),
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

interface Frame {
  tree: Tree;
  byId: Map<string, IrNode>;
  dsl: Dsl;
  /** The dataset the host named, when it named one. */
  dataset?: unknown;
  /** What the designer wrote on layers in the plugin; every one must be answered. */
  notes: DesignerNote[];
  /** frame-match's read of whether anything on the frame is data, when it published one. */
  content?: { data: string; evidence: string[] };
  /** What the frame's own tabs write to the page. */
  writes: KnownChoice[];
  /** The page's choices other sections write: what this one can follow. */
  choices: KnownChoice[];
  /** The section's structural signature (ADR 0033), and its name, when the IR could be read. */
  signature?: string;
  name?: string;
  /** The slot this run binds, when it binds one: everything below is about its nodes. */
  scope?: Scope;
}

interface Loaded extends Frame {
  /** The data the plan binds: the host's dataset, or the Cast source the run chose. */
  bag: Record<string, unknown> | undefined;
}

const NO_DATA =
  "This run has no data yet. If the frame shows data, call agent.hookMaker with what it shows, then bind.source with the hook and input it returned. If nothing on it is data (a heading, labels, tabs, a button), call bind.static instead.";

/**
 * One thing a person would see wrong on the page. `src` is the node it is about; `keep` says a plan
 * may accept it by keeping that node as designed (a label, the design's own look), where the rest
 * show broken on the page (a picture that loads nothing, a ref with nothing behind it) and are fixed.
 */
export interface Problem {
  message: string;
  src?: string;
  keep?: true;
}

const keepable = (src: string, message: string): Problem => ({ message, src, keep: true });
const fixOnly = (message: string, src?: string): Problem => (src ? { message, src } : { message });

/** Problems a person would see on the page, as words: each is a reason not to publish. */
export function problemsOf(...args: Parameters<typeof findingsOf>): string[] {
  return findingsOf(...args).map((p) => p.message);
}

/** Problems a person would see on the page, each with the node it is about. */
export function findingsOf(
  applied: { drift: Array<{ src: string; message: string; reason?: string }>; tree?: Tree },
  structure: Array<{ message: string }>,
  run: DryRun,
  plan?: z.infer<typeof Plan>,
  design?: Tree,
  left: LeftAsDesigned[] = [],
  unbound: Unbound[] = [],
  unreachable: Array<string | Problem> = [],
): Problem[] {
  // looks by place (the rule every row but the last has) the fold keeps on its template: not lost
  const kept = new Set(
    (applied.tree?.nodes ?? []).filter((n) => n.props.at !== undefined).map((n) => n.src),
  );
  const lost = (plan?.collapse ?? []).flatMap((c) => {
    if (!design) return [];
    const variantRoots = new Set((c.variants ?? []).map((v) => v.src));
    const differ = lostLooks(
      design,
      c.members.filter((m, i) => i === 0 || !variantRoots.has(m)),
      kept,
    );
    const template = c.members[0] ?? "";
    return differ.length
      ? [
          keepable(
            template,
            `the members of ${c.over} differ in look, and a collapse draws every item like ${template}: ${differ.slice(0, 3).join("; ")}. When a list always holds the same number of items and the design gives each position its own look, bind each member by position (${c.over.split(".").pop()}.0, .1) instead of collapsing; when the difference is not one the data decides (the designer restyled one card), keep ${template} with why`,
          ),
        ]
      : [];
  });
  // a picture the plan binds, sets or hides is the plan's choice; one it leaves is the template's
  const handled = new Set([
    ...(plan?.bind ?? []).filter((f) => f.prop === "src").map((f) => f.src),
    ...(plan?.set ?? []).filter((s) => s.prop === "src" || s.prop === "when").map((s) => s.src),
    ...(plan?.collapse ?? []).flatMap((c) =>
      [...(c.fields ?? []), ...(c.variants ?? []).flatMap((v) => v.fields ?? [])]
        .filter((f) => f.prop === "src")
        .map((f) => f.src),
    ),
  ]);
  const samePicture = design ? pictureProblems(design, plan, handled) : [];
  const partial = design ? partProblems(design, plan) : [];
  const overflow = applied.tree ? overflowProblems(applied.tree, plan, run) : [];
  return [
    ...lost,
    ...samePicture,
    ...overflow,
    ...partial,
    ...left.map((l) => keepable(l.src, placeholdersLeft(l))),
    ...unbound.map((u) => keepable(u.src, unboundMessage(u))),
    ...unreachable.map((u) => (typeof u === "string" ? fixOnly(u) : u)),
    ...run.repeated.map((r) =>
      keepable(
        r.src,
        `${r.src} shows the design's "${r.copy}" in all ${r.times} items it draws in: a placeholder. Bind it to what it stands for (time left until an instant is a clock), hide it with a when when the data has nothing for it, or keep it with why it stays`,
      ),
    ),
    ...run.relative.map((r) =>
      fixOnly(
        `${r.src} src shows "${r.shows}" for ${r.times} item(s): a path with no domain, which no browser loads. Bind it with a template that puts the site's domain in front ("https://domain{item.image}"; ask which domain if the question was left unanswered), and read shows to see the whole URL`,
        r.src,
      ),
    ),
    ...run.breaks.map((b) =>
      fixOnly(
        `${b.src} shows "${b.shows}" on one line where the design breaks it (${JSON.stringify(b.design)}): put the break in the template where the design has it ("{item.first}\\n{item.last}")`,
        b.src,
      ),
    ),
    ...run.capitals.map((c) =>
      fixOnly(
        `${c.src} shows "${c.shows}" where the design writes capitals ("${c.design}"): set textCase "upper"`,
        c.src,
      ),
    ),
    ...applied.drift.map((d) =>
      fixOnly(d.reason === "stranded" ? d.message : `not applied: ${d.message}`, d.src),
    ),
    ...structure.map((s) => fixOnly(`the tree is invalid: ${s.message}`)),
    ...run.variants.map((v) =>
      fixOnly(
        v.drew === 0
          ? `${v.times} item(s) of ${v.template} draw no variant, e.g. ${v.example}: no when matches them`
          : `${v.times} item(s) of ${v.template} draw ${v.drew} variants at once, e.g. ${v.example}: the whens overlap`,
        v.template,
      ),
    ),
    ...run.unresolved.map((u) =>
      fixOnly(
        u.prop === "clock.to"
          ? `${u.src} clock reads no instant at ${u.value} for ${u.times} item(s), e.g. ${u.example}: point "to" at a field the data shows as (instant), or hide the block with a when exists`
          : `${u.src} ${u.prop} "${u.value}" has nothing at ${u.missing.join(", ")} for ${u.times} item(s), e.g. ${u.example}: a wrong path, or a field some items lack (hide the node with a when exists, or give the ref a default pipe)`,
        u.src,
      ),
    ),
  ];
}

/** A length a prop gives as a plain number or `{ raw }`: a box the design fixed. */
const fixedPx = (value: unknown): number | undefined =>
  typeof value === "number"
    ? value
    : value && typeof value === "object" && typeof (value as { raw?: unknown }).raw === "number"
      ? (value as { raw: number }).raw
      : undefined;

/**
 * Lists that draw more items than the design did, in a row or column the design sized for its
 * own count and that does not wrap: three stats in a 249 px strip, and the data has five. The
 * extra ones draw past its end or squeeze the rest. A carousel scrolls them: never reported.
 */
function overflowProblems(tree: Tree, plan: Plan | undefined, run: DryRun): Problem[] {
  const out: Problem[] = [];
  for (const c of plan?.collapse ?? []) {
    const drew = run.repeats.find((r) => r.template === c.members[0]);
    if (!drew || drew.most <= c.members.length) continue;
    const template = tree.nodes.find((n) => n.src === c.members[0]);
    const repeater = tree.nodes.find((n) => n.id === template?.parent);
    const box = tree.nodes.find((n) => n.id === repeater?.parent);
    if (box?.type !== "Stack" || box.props.wrap === true) continue;
    const direction = box.props.direction;
    const row =
      (typeof direction === "string" ? direction : (direction as { base?: string })?.base) ===
      "row";
    const size = box.props.size as { w?: unknown; h?: unknown } | undefined;
    const length = fixedPx(row ? size?.w : size?.h);
    if (length === undefined) continue;
    out.push(
      keepable(
        box.src,
        `${c.over} draws up to ${drew.most} items where the design drew ${c.members.length}, in ${box.src}: a ${row ? "row" : "column"} ${Math.round(length)} px long that does not wrap, so ${drew.most - c.members.length} more draw past its end or squeeze the rest. Draw as many as the design (slice [0, ${c.members.length}] on the collapse), or keep ${box.src} with why (the box should grow)`,
      ),
    );
  }
  return out;
}

const PICTURE_FIX =
  'Bind its src to the item\'s picture URL (CMS assets put the ratio before the id: with media.image-ratio set, write it in the template, like /media/{ratio}-{id}.jpg). When the data has none, a house fact media.<what> gives the URL from an item field ("https://…/{id}.png"): use it as a template. With no such fact, ask the person for the URL pattern; if there is none, hide it with a when, or keep it with why it stays';

/**
 * Pictures the design gives each item its own of (a photo, a crest, a thumbnail) that the plan
 * leaves as designed beside data: a collapse draws the first item's on every item, and items bound
 * by position keep the designer's, each the wrong one beside its data. One picture on every item
 * is decoration and never reported.
 */
function pictureProblems(design: Tree, plan: Plan | undefined, handled: Set<string>): Problem[] {
  const out: Problem[] = [];
  const named = (p: { alt: string; ratio?: string | undefined }) =>
    (p.alt ? ` "${p.alt}"` : "") + (p.ratio ? ` (box ratio ${p.ratio})` : "");
  const collapsed = new Set<string>();
  for (const c of plan?.collapse ?? []) {
    for (const m of c.members) collapsed.add(m);
    for (const p of ownPictures(design, c.members)) {
      const src = p.srcs[0] ?? "";
      if (handled.has(src)) continue;
      out.push(
        keepable(
          src,
          `${src} picture${named(p)} is ${p.distinct} different pictures across the design's ${p.srcs.length} items, and the plan draws ${c.members[0]}'s in every item of ${c.over}: the wrong picture on all but one. ${PICTURE_FIX}`,
        ),
      );
    }
  }
  const bound = (plan?.bind ?? []).map((f) => f.src);
  for (const members of repeatsOf(design)) {
    if (members.some((m) => collapsed.has(m))) continue;
    const owner = memberOf(design, members);
    const withData = new Set(bound.map((src) => owner.get(src)).filter((m) => m !== undefined));
    if (withData.size === 0) continue;
    for (const p of ownPictures(design, members)) {
      const left = p.srcs.filter((src) => {
        const member = owner.get(src);
        return member !== undefined && withData.has(member) && !handled.has(src);
      });
      if (left.length === 0) continue;
      out.push(
        keepable(
          left[0] ?? "",
          `${left.join(", ")} still show the design's picture${named(p)} beside data bound by position: the design gives each item its own (${p.distinct} different), so each is the designer's, not the item's. ${PICTURE_FIX}`,
        ),
      );
    }
  }
  return out;
}

/**
 * Parts the design shows on some items only (a captain's badge, an overseas flag) that the plan
 * draws on every item, or on none: a `when` on the data decides them, or a variant draws them.
 */
function partProblems(design: Tree, plan: Plan | undefined): Problem[] {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const bySrc = new Map(design.nodes.map((n) => [n.src, n]));
  const hidden = new Set((plan?.set ?? []).filter((s) => s.prop === "when").map((s) => s.src));
  // a when on the node or on anything around it decides it
  const decided = (src: string) => {
    for (let at = bySrc.get(src); at; at = at.parent === null ? undefined : byId.get(at.parent)) {
      if (hidden.has(at.src)) return true;
    }
    return false;
  };
  return (plan?.collapse ?? []).flatMap((c) => {
    const variants = new Set((c.variants ?? []).map((v) => v.src));
    return someOnly(design, c.members).flatMap((part) => {
      const what = `${part.src} (${part.type}${part.copy ? ` "${part.copy}"` : ""})`;
      const where = `on ${part.in.length} of the design's ${part.of} items (${part.in.join(", ")})`;
      if (part.inTemplate) {
        if (decided(part.src)) return [];
        return [
          keepable(
            part.src,
            `${what} is ${where}, and the plan draws it on every item of ${c.over}. Something in each item decides it: set a when on the field that does (is_captain, has_video), or keep ${part.src} with why every item shows it`,
          ),
        ];
      }
      if (part.in.some((m) => variants.has(m))) return [];
      return [
        keepable(
          part.src,
          `${what} is ${where}, not on ${c.members[0]}, the template, so the plan draws it on none of ${c.over}. If a field decides it, make ${part.in[0]} a variant with a when on that field; otherwise keep ${part.src} with why it is left out`,
        ),
      ];
    });
  });
}

/** Design copy beside data, said so a plan can act on it. */
function unboundMessage(u: Unbound): string {
  return `${u.src} still shows the design's "${u.copy}" inside ${u.within}, which shows data: bind it to what it stands for, hide it with a when if the data has nothing for it, or keep it (or the static block around it) with why it stays (a label)`;
}

const clipUrl = (url: string) => (url.length > 90 ? `${url.slice(0, 89)}…` : url);

/** What a picture's URL answers: its status, and for a 2xx what came back. */
export interface PictureAnswer {
  status: number;
  /** The content type, without parameters. */
  type?: string;
  bytes?: number;
  /** A hash of the body: the same picture on every item is the site's stand-in. */
  digest?: string;
}

/** Below this, a picture is a site's stand-in for one it does not have (a 1×1 PNG is 68 bytes). */
const EMPTY_PICTURE_BYTES = 200;
/** How much of a picture is read to tell it from another. */
const PROBE_BYTES = 256 * 1024;

/** What a picture's URL answers. A network failure is not an answer about the picture. */
async function probePicture(url: string): Promise<PictureAnswer | undefined> {
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, ...(type ? { type } : {}) };
    }
    // the first part of the body is enough to tell two pictures apart; a photo is not read whole
    const hash = createHash("sha1");
    let read = 0;
    const reader = response.body?.getReader();
    while (reader && read < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      hash.update(value);
      read += value.length;
    }
    await reader?.cancel();
    const length = Number(response.headers.get("content-length"));
    return {
      status: response.status,
      ...(type ? { type } : {}),
      bytes: read < PROBE_BYTES || !Number.isFinite(length) || length <= 0 ? read : length,
      digest: hash.digest("hex"),
    };
  } catch {
    return undefined;
  }
}

/**
 * What is wrong with a picture, from what its items' URLs answered: nothing loads, a page comes
 * back, the site answers with its stand-in (a 200 with an empty picture is how a site says it has
 * no picture at that id), or every item gets the same one. A pattern built from one picture's URL
 * (`…/players/26718.png` → `…/players/{p.id}.png`) loads nothing real when the data's ids are
 * another system's, and a status alone does not show it.
 */
export function pictureTrouble(
  src: string,
  urls: readonly string[],
  answers: ReadonlyArray<PictureAnswer | undefined>,
): string | undefined {
  const heard = urls.flatMap((url, i) => {
    const a = answers[i];
    return a ? [{ url, ...a }] : [];
  });
  const failed = heard.find((a) => a.status >= 400);
  if (failed) {
    return `${src} src loads nothing: ${clipUrl(failed.url)} answers ${failed.status}. The domain or the path is wrong; ask a person for the site's domain rather than guessing one`;
  }
  const page = heard.find((a) => a.type !== undefined && !a.type.startsWith("image/"));
  if (page) {
    return `${src} src loads a ${page.type} page, not a picture: ${clipUrl(page.url)}. The path is wrong; ask a person for the URL pattern rather than guessing one`;
  }
  const fix =
    "The URL's id is not one the site knows: a pattern made from one picture's URL needs the id the site names its pictures by, and the data's ids may be another system's. Ask a person for a field or a pattern that gives the site's id, with an id from the data in the question, or hide it with a when";
  // a bitmap that small draws nothing; an SVG icon may be that small and whole
  const empty = heard.find(
    (a) => a.bytes !== undefined && a.bytes < EMPTY_PICTURE_BYTES && a.type !== "image/svg+xml",
  );
  if (empty) {
    return `${src} src loads an empty picture: ${clipUrl(empty.url)} answers ${empty.bytes} bytes, the site's stand-in for a picture it does not have. ${fix}`;
  }
  const digests = new Set(heard.map((a) => a.digest).filter((d) => d !== undefined));
  if (heard.length >= 2 && digests.size === 1 && heard.every((a) => a.digest !== undefined)) {
    return `${src} src draws the same picture for every item: ${heard.length} items' URLs (${clipUrl(heard[0]?.url ?? "")}, …) answer the same bytes, the site's fallback. ${fix}`;
  }
  return undefined;
}

/** A repeat drawn as designed beside one drawn from data, said so a plan can fix it. */
function placeholdersLeft(l: LeftAsDesigned): string {
  const shows = `${l.src} still shows the design's placeholders${l.copy ? ` ("${l.copy}")` : ""} beside ${l.like}, which ${l.over ? `draws ${l.over}` : "draws data"}`;
  if (!l.over || l.items.length === 0) {
    return `${shows}. Give it data as ${l.like} has it, or keep ${l.src} with why it stays`;
  }
  const rows = l.slices?.map(([src, [a, b]]) => `${src} [${a}, ${b}]`).join(", ");
  const fields = l.fields.map(([from, to]) => `${to} as ${from}`).join(", ");
  return `${shows}: one grid drawn as rows, and the data's list is flat. Collapse each row's items over ${l.over} with its own slice, in order${rows ? ` (${rows})` : ""}: here members ${l.items.join(", ")}${fields ? `, fields ${fields}` : ""}, and its own copy of each set entry`;
}

/** What a plan's `keep` does to bind.try's problems. */
export interface Kept {
  /** Problems still open: fixed in the plan, or published `despite`. */
  open: Problem[];
  /** Each keep, with why and the problems it accepted, for the person approving the publish. */
  kept: string[];
  /** A keep that names no node of the frame, or one too wide to accept what is under it. */
  notes: string[];
}

/**
 * Accepts the problems a plan keeps: one on a kept node, or under a kept block that holds nothing
 * the plan binds (the section's heading and button, a newsletter's note beside its form). A block
 * that holds data accepts only problems on itself, so keeping the section's root never hides what
 * is wrong with its cards. Problems that show broken on the page are never accepted.
 */
export function applyKeep(problems: Problem[], design: Tree, plan: Plan): Kept {
  const keep = plan.keep ?? [];
  if (keep.length === 0) return { open: problems, kept: [], notes: [] };
  const bySrc = new Map(design.nodes.map((n) => [n.src, n]));
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const under = (src: string, block: string) => {
    for (let at = bySrc.get(src); at; at = at.parent === null ? undefined : byId.get(at.parent)) {
      if (at.src === block) return true;
    }
    return false;
  };
  const bound = [
    ...(plan.bind ?? []).map((f) => f.src),
    ...(plan.collapse ?? []).flatMap((c) => [
      ...c.members,
      ...(c.fields ?? []).map((f) => f.src),
      ...(c.variants ?? []).flatMap((v) => [v.src, ...(v.fields ?? []).map((f) => f.src)]),
    ]),
  ];
  const notes: string[] = [];
  const valid = keep.filter((k) => {
    if (bySrc.has(k.src)) return true;
    notes.push(`keep names ${k.src}, which is not a node of the frame: use an id from the outline`);
    return false;
  });
  const wide = new Set(
    valid.filter((k) => bound.some((b) => b !== k.src && under(b, k.src))).map((k) => k.src),
  );
  const accepted = new Map<string, Problem[]>();
  const open = problems.filter((p) => {
    if (!p.keep || !p.src) return true;
    const src = p.src;
    const by = valid.find((k) => k.src === src || (!wide.has(k.src) && under(src, k.src)));
    if (!by) return true;
    accepted.set(by.src, [...(accepted.get(by.src) ?? []), p]);
    return false;
  });
  for (const k of valid) {
    if (wide.has(k.src) && !accepted.has(k.src)) {
      notes.push(
        `keep ${k.src} holds nodes the plan binds, so it accepts only problems on ${k.src} itself: keep the static block inside it, or the node`,
      );
    }
  }
  const clipped = (m: string) => (m.length > 120 ? `${m.slice(0, 119)}…` : m);
  const kept = valid.map((k) => {
    const took = accepted.get(k.src) ?? [];
    return `${k.src} kept as designed: ${k.why}${took.length ? ` (accepts: ${took.map((p) => clipped(p.message)).join(" | ")})` : ""}`;
  });
  return { open, kept, notes };
}

/** `the-brave-squad` → `theBraveSquad`: a slot's name as the name its data is read by. */
export const camel = (name: string): string => {
  const out = name.replace(/[^A-Za-z0-9]+([A-Za-z0-9])/g, (_, c: string) => c.toUpperCase());
  const first = out.charAt(0).toLowerCase() + out.slice(1);
  return /^[a-z]/.test(first) ? first : `s${out}`;
};

/** "Not yet"s bind.publish answers before it lets a plan with open problems through anyway. */
const MAX_REFUSALS = 2;

export function createBindTools(
  opts: {
    dir?: string;
    plane?: (project: string) => Plane;
    web?: string;
    /** The MCP servers, for the live output of the Cast hook the run chooses as its data. */
    mcp?: McpHost;
    /** The harness's pool: the page choices other sections write (ADR 0032). */
    pool?: Pool;
    /** What people decided about a section before (ADR 0033), read for bind.load's `before`. */
    decisions?: Pick<MemoryReader, "decisionsOn">;
    /**
     * What a picture's URL answers (a bare number is its status), or undefined when the site
     * cannot be reached at all.
     */
    probe?: (url: string) => Promise<number | PictureAnswer | undefined>;
  } = {},
) {
  const dir = opts.dir ?? BIND_DIR;
  const planeOf = opts.plane ?? createPlane;
  const mcp = opts.mcp ?? defaultMcpHost();
  const probe = opts.probe ?? probePicture;
  const cache = new Map<string, Promise<Frame>>();
  const inputOf = (ctx: Pick<ToolContext, "input">) => RunInput.parse(ctx.input);

  const frameOf = (ctx: Pick<ToolContext, "input" | "runId" | "tenantId">) => {
    let held = cache.get(ctx.runId);
    if (!held) {
      held = (async () => {
        const input = inputOf(ctx);
        const { project, tree: treeId } = previewOf(input.preview);
        const plane = planeOf(project);
        const [tree, meta, dataset, dsl] = await Promise.all([
          plane.json(treeId) as Promise<Tree>,
          plane.meta(treeId),
          input.data ? plane.dataset(input.data) : undefined,
          loadDsl(),
        ]);
        // An export's IR is in the control plane; a Handoff's was stored beside the tree.
        const exportId = typeof meta.exportId === "string" ? meta.exportId : undefined;
        const irArtifactId = typeof meta.irArtifactId === "string" ? meta.irArtifactId : undefined;
        const ir = irArtifactId
          ? await plane.ir(irArtifactId)
          : exportId
            ? await plane.exportIr(exportId)
            : undefined;
        const byId = ir ? indexIr(ir.root) : new Map<string, IrNode>();
        // the section's signature, as frame-match signed it: what a person's decisions are about;
        // a slot's own when the run binds one slot, so its answers are about that slot
        const signed = ir ? (await loadSigner())(ir.doc ?? ir) : undefined;
        const scope = input.slot ? scopeOf(input.slot) : undefined;
        const signature = input.slot?.signature ?? signed;
        const content = (input.slot?.content ?? meta.content) as Frame["content"];
        const written = Array.isArray(meta.choices) ? (meta.choices as KnownChoice[]) : [];
        // a slot follows the choices it draws; a frame's tabs belong to the slot that has them
        const writes = input.slot ? written.filter((w) => w.owner === input.slot?.id) : written;
        // the page's choices other sections write: this one may follow them (a slot only the
        // ones it was told to read)
        const section = typeof meta.handoffId === "string" ? meta.handoffId : exportId;
        const choices = opts.pool
          ? (
              await pageChoicesOf(
                opts.pool,
                ctx.tenantId,
                project,
                section ? { except: section } : {},
              )
            )
              .filter((c) => !written.some((w) => w.key === c.key))
              .filter((c) => !input.slot || input.slot.readFrom.includes(c.key))
              .map((c) => ({
                key: c.key,
                options: c.options,
                initial: c.initial,
                section: c.sectionName,
              }))
          : [];
        const mine = scope?.srcs(tree);
        const notes = ir ? notesOf(ir, byId) : [];
        return {
          tree,
          byId,
          ...(signature ? { signature, name: input.slot?.name ?? ir?.root.name ?? "" } : {}),
          ...(scope ? { scope } : {}),
          notes: mine ? notes.filter((n) => mine.has(n.src)) : notes,
          dsl,
          writes,
          choices,
          ...(content ? { content } : {}),
          ...(input.data ? { dataset } : {}),
        };
      })();
      held.catch(() => cache.delete(ctx.runId));
      cache.set(ctx.runId, held);
    }
    return held;
  };

  /** A Cast hook's output under the name the plan reads it by, unwrapped as a page unwraps it. */
  const sourceBag = (sources: Record<string, z.infer<typeof Source>>, dsl: Dsl) =>
    asBag(
      Object.fromEntries(Object.values(sources).map((s) => [s.as, { castFlow: s.sample }])),
      dsl,
    );

  const loaded = async (
    ctx: Pick<ToolContext, "input" | "runId" | "tenantId">,
  ): Promise<Loaded> => {
    const frame = await frameOf(ctx);
    if (inputOf(ctx).data) return { ...frame, bag: asBag(frame.dataset, frame.dsl) };
    const { sources } = readState(dir, ctx.runId);
    return {
      ...frame,
      bag: Object.keys(sources).length > 0 ? sourceBag(sources, frame.dsl) : undefined,
    };
  };
  /** The data, for the tools that cannot work without it. */
  const withData = async (ctx: Pick<ToolContext, "input" | "runId" | "tenantId">) => {
    const run = await loaded(ctx);
    if (!run.bag) throw new Error(NO_DATA);
    return { ...run, bag: run.bag };
  };

  /** Where the data follows a page choice: lists whose items hold its values. */
  const linked = (bag: unknown, choices: KnownChoice[]) => {
    const links = linksOf(bag, choices);
    return links.length ? { links: links.map(describeLink) } : {};
  };

  const staticTool = defineTool({
    name: "bind.static",
    description:
      "Say that nothing on this frame is data, so there is nothing to bind: a heading, labels, tabs, a button. The frame is handed over as frame-match published it, with no data source. Pass why, in one sentence naming what the frame shows. Only for a frame with no data: a list of players, fixtures, scores, headlines or photos of them is data.",
    input: z.object({ why: z.string().min(10) }).strict(),
    effect: "read",
    timeoutMs: 10_000,
    block(_input, ctx) {
      const state = readState(dir, ctx.runId);
      if (state.published) return "A plan was published: this frame is bound, so it is not static.";
      if (Object.keys(state.sources).length > 0)
        return "This run chose a data source with bind.source: bind it, or say in remaining why it does not fit.";
      return undefined;
    },
    async run({ why }, ctx) {
      writeState(dir, ctx.runId, { ...readState(dir, ctx.runId), static: { why } });
      return {
        static: true,
        previewUrl: inputOf(ctx).preview,
        next: "Call final: previewUrl as here, planArtifactId and dataArtifactId empty, bound and collapsed 0.",
      };
    },
  });

  const load = defineTool({
    name: "bind.load",
    description:
      "Read the frame and the sample data. Returns the frame's outline (each line starts with the Figma id a plan names it by), what repeats in it, and every path in the data, or that the run has no data yet. Call it first, once.",
    input: z.object({}).strict(),
    effect: "read",
    timeoutMs: 60_000,
    alwaysInline: true,
    async run(_input, ctx) {
      const { tree: whole, byId, bag, scope } = await loaded(ctx);
      // a slot sees its own nodes: what repeats and the outline are about them
      const tree = scope ? scope.view(whole) : whole;
      const all = groups(tree, byId);
      const found = all.map((g) => {
        const line =
          g.shapes.length === 1
            ? `${g.parent} holds ${g.members.length} of one shape: ${g.members.join(", ")}`
            : `${g.parent} holds ${g.members.length}${g.component ? ` «${g.component}»` : ""} in ${g.shapes.length} shapes: ${g.shapes.map((s) => `[${s.join(", ")}]`).join(" ")}`;
        // a grid drawn as rows: the cards of every row, not only the first
        const inner = all.find((i) => i.parent === g.members[0]);
        const rows = inner ? rowsOf(tree, g, inner) : undefined;
        return rows?.every((r) => r.length > 0)
          ? `${line} (their items: ${g.members.map((m, i) => `${m} [${rows[i]?.join(", ")}]`).join(", ")})`
          : line;
      });
      const { notes, content, writes, choices, signature, name } = await frameOf(ctx);
      // the section the run works on, so what a person answers is about it (ADR 0033); a child
      // started after this (agent.hookMaker) works on it too
      if (signature) ctx.situate?.({ section: signature, ...(name ? { name } : {}) });
      const decided = await decidedBefore(opts.decisions, ctx.tenantId, signature).catch(() => []);
      return {
        ...(notes.length > 0 ? { designerNotes: notes, designerNotesRule: NOTES_RULE } : {}),
        ...(decided.length > 0 ? { before: decided, beforeRule: BEFORE_RULE } : {}),
        ...(scope
          ? {
              slot: {
                id: scope.slot.id,
                name: scope.slot.name,
                about: `This run binds one slot of the frame: ${scope.slot.name}. Everything here is about its nodes; the rest of the frame belongs to other slots and is not yours to bind, read or ask about. When you look for its data, call agent.hookMaker for this slot alone, with its words as hints.`,
                words: wordsOf(tree),
              },
            }
          : {}),
        ...(content
          ? {
              content: `frame-match read it as ${content.data === "none" ? "showing no data" : content.data === "some" ? "showing data" : "unsure"}: ${content.evidence.join("; ")}`,
            }
          : {}),
        frame: outline(tree, byId).join("\n"),
        repeats: found.length ? found.join("\n") : "nothing repeats",
        ...(writes.length ? { writes: writes.map(describeChoice) } : {}),
        ...(choices.length
          ? {
              pageChoices: choices.map(describeChoice),
              pageChoicesRule:
                "Other sections of the page write these choices. When this frame shows the items of the one chosen there (a strip under a toggle), draw only those: see links once the data is in.",
            }
          : {}),
        data: bag ? shapeOf(bag).join("\n") : NO_DATA,
        ...(bag && (choices.length || (scope && writes.length))
          ? linked(bag, scope ? [...writes, ...choices] : choices)
          : {}),
      };
    },
  });

  const source = defineTool({
    name: "bind.source",
    description:
      "Make a Cast hook's live output this run's data: the hookId and input agent.hookMaker returned, and a short name the plan reads the data by (fixtures, news). Runs the hook once and returns every path in its output, as bind.load does for data it was given. Only for a run given no data.",
    input: z
      .object({
        hookId: z.string().min(1),
        input: z
          .record(z.string(), z.string())
          .optional()
          .describe("The input the researcher returned"),
        as: z
          .string()
          .regex(/^[a-z][a-zA-Z0-9]*$/)
          .optional()
          .describe(
            "The name the plan reads the data by: fixtures. A plain list is fixtures.items; any other shape keeps its own keys (fixtures.days). Left out when the run binds a slot: the slot's name",
          ),
      })
      .strict(),
    effect: "read",
    timeoutMs: 60_000,
    alwaysInline: true,
    block: (_input, ctx) =>
      inputOf(ctx).data ? "This run was given its data: bind.load has it." : undefined,
    async run({ hookId, input, as: named }, ctx) {
      const slot = inputOf(ctx).slot;
      const as = named ?? (slot ? camel(slot.name) : undefined);
      if (!as) throw new Error("name the data: as is the name the plan reads it by (fixtures)");
      // the data is a Cast hook's output: the registry's cast server, under the run's tenant
      const { hook, output } = await hookOutput(
        (tool, args) => mcp.call(CAST, ctx.tenantId, tool, args, ctx.signal),
        hookId,
        input ?? {},
      );
      const chosen = {
        hookId,
        ...(hook.workflowId ? { workflowId: hook.workflowId } : {}),
        input: input ?? {},
        as,
        sample: output,
      };
      // a source with this name is replaced; the others stay, and the plan reads them all
      const state = readState(dir, ctx.runId);
      const sources = { ...state.sources, [as]: chosen };
      writeState(dir, ctx.runId, { ...state, sources });
      const { dsl, choices, writes, scope } = await frameOf(ctx);
      const bag = sourceBag(sources, dsl);
      const follow = scope ? [...writes, ...choices] : choices;
      return { data: shapeOf(bag).join("\n"), ...(follow.length ? linked(bag, follow) : {}) };
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
      const { tree, byId, scope } = await frameOf(ctx);
      if (scope && !scope.srcs(tree).has(src)) {
        throw new Error(
          `${src} is outside the slot ${scope.slot.name}: it belongs to another slot`,
        );
      }
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
      "Apply a binding plan to the frame and draw it against every item of the sample, without publishing. Returns what was bound, what each repeat drew, what the page would show, every problem still open (a node the plan could not reach, an invalid tree, a ref with nothing behind it, design copy beside data), what the plan's keep accepted, and publishable. Fix the problems, or keep what stays as designed, and try again; the last plan tried is the one bind.publish stores. Read its result before calling bind.publish: never call both in one turn.",
    // A JSON string, not a schema: a plan's nested conditions are more optional fields than a
    // model provider takes in one tool schema. It is parsed against `Plan` here instead.
    input: z
      .object({
        plan: z
          .string()
          .min(2)
          .describe(
            'The whole plan as JSON: {"note","collapse":[{"over","as","members","slice","shape","when","variants":[{"src","when","fields"}],"fields":[{"src","prop","path"|"template"}]}],"bind":[…],"set":[{"src","prop","value"}],"keep":[{"src","why"}]}',
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
      const { tree: whole, bag, dsl, byId, scope, writes } = await withData(ctx);
      // keep is the plan's record of what stays as designed: the page never reads it
      const { keep: _keep, ...binding } = plan;
      const full = dsl.applyBindingPlan(whole, binding);
      // a slot's plan is checked on the slot's nodes: the rest of the frame is not its to judge
      const mine = scope?.srcs(whole);
      const tree = scope ? scope.view(whole) : whole;
      const applied = scope
        ? {
            ...full,
            tree: scope.view(full.tree),
            drift: full.drift.filter((d) => mine?.has(d.src)),
          }
        : full;
      const structure = dsl
        .check(full.tree)
        .filter((i) => !scope || !i.nodeId || scope.has(full.tree, i.nodeId));
      const run = dryRun(applied.tree, bag, dsl, tree);
      // the first items' pictures of each node: a domain the site does not serve shows as a 404,
      // an id the site does not know as its empty stand-in, or the same picture on every item
      const broken = (
        await Promise.all(
          run.pictures.slice(0, 6).map(async (p) => {
            const answers = await Promise.all(
              p.urls.map(async (url) => {
                const a = await probe(url);
                return typeof a === "number" ? { status: a } : a;
              }),
            );
            const trouble = pictureTrouble(p.src, p.urls, answers);
            return trouble ? fixOnly(trouble, p.src) : undefined;
          }),
        )
      ).filter((m) => m !== undefined);
      const left = leftAsDesigned(tree, applied.tree, byId, dsl.hasRef);
      const found = findingsOf(
        applied,
        structure,
        run,
        binding,
        tree,
        left,
        unboundCopy(applied.tree, dsl.hasRef),
        broken,
      );
      const { open, kept, notes } = applyKeep(found, tree, plan);
      // a slot's plan touches its own nodes, and reads the choices it owns or was told to read
      const outside = scope
        ? [
            ...plannedSrcs(plan)
              .filter((src) => !mine?.has(src))
              .map(
                (src) =>
                  `the plan names ${src}, which is outside the slot ${scope.slot.name}: bind only the slot's own nodes`,
              ),
            ...pageKeysRead(plan)
              .filter(
                (key) => !writes.some((w) => w.key === key) && !scope.slot.readFrom.includes(key),
              )
              .map(
                (key) =>
                  `the plan reads _page.${key}, a choice slot ${scope.slot.name} does not draw and was not told to read: another slot's tabs filter that slot's items, not this one's`,
              ),
          ]
        : [];
      const problems = [...outside, ...notes, ...open.map((p) => p.message)];
      const state = readState(dir, ctx.runId);
      writeState(dir, ctx.runId, {
        ...state,
        tried: { plan, problems, kept, bound: applied.bound, collapsed: applied.collapsed },
      });
      return {
        bound: applied.bound,
        collapsed: applied.collapsed,
        repeats: run.repeats.map((r) => `${r.template} drew ${r.items} item(s) of ${r.over}`),
        shows: run.samples.map(
          (s) => `${s.src} ${s.prop}: ${s.values.map((v) => JSON.stringify(v)).join(", ")}`,
        ),
        problems: problems.length ? problems : "none",
        ...(kept.length ? { kept } : {}),
        publishable: problems.length === 0,
        next:
          problems.length === 0
            ? "Ready: read shows, then call bind.publish with {}."
            : "Not ready. Fix each problem in the plan, or keep what stays as designed on purpose (keep: [{src, why}]), and call bind.try again with the whole plan. Only when one can be neither fixed nor kept, call bind.publish with despite saying why.",
      };
    },
  });

  const PublishInput = z
    .object({
      despite: z
        .string()
        .min(10)
        .optional()
        .describe(
          "Only when bind.try's last plan still lists problems that can be neither fixed nor kept: why, in one sentence. A person reads it at the approval",
        ),
    })
    .strict();
  /**
   * bind.publish stores the plan and answers the preview link. bind.done is the same for a run that
   * binds one slot of a pass: it stores the plan and the data, and answers them as they are; the
   * preview of the whole frame, with every slot's plan, is published once by the pass.
   */
  const publishAs = (name: "bind.publish" | "bind.done") => {
    const forSlot = name === "bind.done";
    return defineTool<
      z.infer<typeof PublishInput>,
      z.infer<typeof Published>,
      Record<string, unknown>
    >({
      name,
      description: forSlot
        ? "End a run that binds one slot: store the last plan bind.try applied, with the sample data, and return their ids. The frame's preview is published once by the pass, with every slot's plan. Call it with {} once bind.try said publishable; with despite only when it still lists problems that can be neither fixed nor kept."
        : "Store the last plan bind.try applied, with the sample data, and return the preview link of the bound frame. Call it with {} once bind.try said publishable; with despite only when it still lists problems that can be neither fixed nor kept.",
      input: PublishInput,
      effect: "write",
      timeoutMs: 60_000,
      // a "not yet" sends the run back to bind.try, so asking again is the run working: the repeated
      // refused call must not end it. MAX_REFUSALS bounds the loop, so it still ends with a preview
      advisoryBlock: true,
      // the approval shows what code measured, never the model's account of it
      resolve(input, ctx) {
        const tried = readState(dir, ctx.runId).tried;
        return tried
          ? {
              note: tried.plan.note ?? "",
              bound: tried.bound,
              collapsed: tried.collapsed,
              problems: tried.problems,
              kept: tried.kept,
              ...(input.despite && tried.problems.length ? { despite: input.despite } : {}),
            }
          : {};
      },
      // reads what resolve made of the call: despite is there only when problems were open
      block(resolved, ctx) {
        const state = readState(dir, ctx.runId);
        if (state.published) return undefined;
        const slot = inputOf(ctx).slot;
        if (slot && !forSlot) {
          return `This run binds one slot (${slot.name}) of a pass, which publishes the frame once: call bind.done.`;
        }
        if (!slot && forSlot)
          return "bind.done ends a run that binds a slot; this one binds the whole frame: call bind.publish.";
        if (!state.tried) return "Nothing to publish. Call bind.try with a plan first.";
        const open = state.tried.problems;
        if (open.length === 0 || resolved.despite || state.refusals >= MAX_REFUSALS)
          return undefined;
        writeState(dir, ctx.runId, { ...state, refusals: state.refusals + 1 });
        return `Not yet: the last plan bind.try applied has ${open.length} open problem(s): ${open.slice(0, 5).join(" | ")}. Fix each in the plan, or keep what stays as designed on purpose (keep: [{src, why}]), and call bind.try with the whole plan; publish once it says publishable. When one can be neither fixed nor kept, call bind.publish with despite saying why.`;
      },
      // what resolve showed the person: despite is there only when problems were open
      async run(resolved, ctx) {
        const despite = typeof resolved.despite === "string" ? resolved.despite : undefined;
        const state = readState(dir, ctx.runId);
        if (state.published) return state.published;
        if (!state.tried) throw new Error("nothing was tried");
        const { bag } = await withData(ctx);
        const input = inputOf(ctx);
        const { url, project } = previewOf(input.preview);
        const plane = planeOf(project);
        const chosen = Object.values(state.sources);
        const meta = {
          source: "dugout:bind",
          runId: ctx.runId,
          preview: input.preview,
          ...(input.slot ? { slot: { id: input.slot.id, name: input.slot.name } } : {}),
          // where the data came from: what a page fetches live once trees declare their data
          // (a list: a frame of several slots reads several; an older reader takes one object as
          // a list of one)
          data: input.data
            ? [{ kind: "dataset", name: input.data }]
            : chosen.map((c) => ({
                kind: "cast-hook",
                hookId: c.hookId,
                ...(c.workflowId ? { workflowId: c.workflowId } : {}),
                input: c.input,
                as: c.as,
              })),
        };
        // what stays as designed is a record for people, beside the plan: the page never reads it
        const { keep, ...binding } = state.tried.plan;
        const record = keep?.length ? { ...meta, keep } : meta;
        const dataArtifactId = await plane.upload("sample_data", bag, meta);
        const planArtifactId = await plane.upload("binding_plan", binding, record);
        const link = new URL(url.toString());
        if (opts.web) {
          const web = new URL(opts.web);
          link.protocol = web.protocol;
          link.host = web.host;
        }
        // a slot's pass links the frame once, with all the plans: here the preview stays as it was
        if (!forSlot) {
          link.searchParams.set("data", dataArtifactId);
          link.searchParams.set("plan", planArtifactId);
        }
        const published = {
          previewUrl: link.toString(),
          planArtifactId,
          dataArtifactId,
          bound: state.tried.bound,
          collapsed: state.tried.collapsed,
          problems: state.tried.problems,
          kept: state.tried.kept,
          sources: meta.data,
          ...(despite ? { despite } : {}),
        };
        writeState(dir, ctx.runId, { ...state, published });
        return published;
      },
    });
  };

  return [
    load,
    source,
    node,
    tryPlan,
    publishAs("bind.publish"),
    publishAs("bind.done"),
    staticTool,
  ];
}
