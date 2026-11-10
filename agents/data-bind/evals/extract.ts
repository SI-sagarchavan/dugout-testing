import type { RunEvent } from "@dugout/contracts";
import type { DataOutcome, ShownText } from "@dugout/evals";

type Json = Record<string, unknown>;

/** The nodes of a published tree, by the Figma id a plan names them by: what they say as designed. */
export function placeholders(tree: unknown): Map<string, string> {
  const found = new Map<string, string>();
  const nodes = (tree as { nodes?: Array<{ src?: string; id?: string; props?: Json }> })?.nodes;
  for (const node of nodes ?? []) {
    const content = node.props?.content;
    if (typeof content === "string") found.set(node.src ?? node.id ?? "", content);
  }
  return found;
}

/**
 * What the last `bind.try` of the run showed: its `shows` lines are `<node> content: "a", "b"`,
 * each value what one item draws there.
 */
export function shownIn(events: RunEvent[], tree: unknown): ShownText[] {
  const designed = placeholders(tree);
  let last: string[] = [];
  for (const event of events) {
    if (event.type !== "tool.completed" || event.data.tool !== "bind.try" || !event.data.ok)
      continue;
    try {
      const shows = (JSON.parse(String(event.data.content)) as { shows?: string[] }).shows;
      if (Array.isArray(shows)) last = shows;
    } catch {
      // not a result
    }
  }
  return last.flatMap((line) => {
    const at = /^(\S+) content: (.*)$/.exec(line);
    if (!at) return [];
    const node = at[1] as string;
    const shown = [...(at[2] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      (m[1] ?? "").replace(/\\"/g, '"'),
    );
    const placeholder = designed.get(node);
    return placeholder === undefined || shown.length === 0 ? [] : [{ node, placeholder, shown }];
  });
}

/** Every `path` of a published plan, and the leaf of each: `matches.0.venue` is `venue`. */
export function boundFieldsOf(plan: unknown): string[] {
  const leaves = new Set<string>();
  const add = (path: unknown) => {
    if (typeof path !== "string") return;
    const leaf = (path.split("|")[0] ?? "")
      .trim()
      .split(".")
      .filter((p) => !/^\d+$/.test(p))
      .at(-1);
    if (leaf) leaves.add(leaf);
  };
  const template = (text: unknown) => {
    if (typeof text !== "string") return;
    for (const m of text.matchAll(/\{[A-Za-z_]\w*\.([\w.]+)(?:\s*\|[^}]*)?\}/g)) add(m[1]);
  };
  const field = (f: Json) => {
    add(f.path);
    template(f.template);
  };
  const p = plan as { bind?: Json[]; collapse?: Json[] };
  for (const b of p?.bind ?? []) field(b);
  for (const c of p?.collapse ?? []) {
    for (const f of (c.fields as Json[] | undefined) ?? []) field(f);
    for (const v of (c.variants as Json[] | undefined) ?? [])
      for (const f of (v.fields as Json[] | undefined) ?? []) field(f);
  }
  return [...leaves];
}

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>(
      (v, key) => (v && typeof v === "object" ? (v as Json)[key] : undefined),
      value,
    );

/** Lists at a path, flattened one level: `day.matches` over days holding matches. */
function itemsAt(bag: unknown, over: string): unknown[] {
  const parts = over.split(".");
  let level: unknown[] = [bag];
  for (const [i, part] of parts.entries()) {
    level = level.flatMap((v) => {
      const next = at(v, part);
      return Array.isArray(next)
        ? i === parts.length - 1
          ? next
          : next
        : next === undefined
          ? []
          : [next];
    });
    if (i < parts.length - 1) level = level.flatMap((v) => (Array.isArray(v) ? v : [v]));
  }
  return level;
}

/**
 * The variants of the plan some item of the sample draws: each variant's `when` compared with the
 * items. Named by the value it equals (`R`, `U`), the way a case lists them.
 */
export function variantsDrawn(plan: unknown, bag: unknown): string[] {
  const drawn = new Set<string>();
  for (const c of (plan as { collapse?: Json[] })?.collapse ?? []) {
    const alias = String(c.as ?? "");
    const items = itemsAt(bag, String(c.over ?? ""));
    for (const variant of (c.variants as Json[] | undefined) ?? []) {
      const when = variant.when as { path?: string; eq?: unknown } | undefined;
      if (!when?.path || when.eq === undefined) continue;
      const path = when.path.startsWith(`${alias}.`)
        ? when.path.slice(alias.length + 1)
        : when.path;
      if (items.some((item) => at(item, path) === when.eq)) drawn.add(String(when.eq));
    }
  }
  return [...drawn];
}

/**
 * Each list the plan draws that holds dated items: the first field the plan binds from its items
 * that `timeOf` reads as a time for most of them, each item's time in the list's order. A list
 * with no such field is left out.
 */
export function datedLists(
  plan: unknown,
  bag: unknown,
  timeOf: (value: unknown) => number | undefined,
): Array<{ list: string; times: number[] }> {
  const out: Array<{ list: string; times: number[] }> = [];
  for (const c of (plan as { collapse?: Json[] })?.collapse ?? []) {
    const alias = String(c.as ?? "");
    const items = itemsAt(bag, String(c.over ?? ""));
    const fields = [
      ...((c.fields as Json[] | undefined) ?? []),
      ...((c.variants as Json[] | undefined) ?? []).flatMap(
        (v) => (v.fields as Json[] | undefined) ?? [],
      ),
    ];
    const paths: string[] = [];
    for (const f of fields) {
      const refs = [
        typeof f.path === "string" ? f.path : "",
        ...[...String(f.template ?? "").matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] ?? ""),
      ];
      for (const ref of refs) {
        const bare = (ref.split("|")[0] ?? "").trim();
        if (bare.startsWith(`${alias}.`)) paths.push(bare.slice(alias.length + 1));
      }
    }
    for (const path of paths) {
      const times = items.flatMap((item) => {
        const t = timeOf(at(item, path));
        return t === undefined ? [] : [t];
      });
      if (times.length >= 2 && times.length >= items.length / 2) {
        out.push({ list: String(c.over), times });
        break;
      }
    }
  }
  return out;
}

/** What a finished run did, from its result, its events and the artifacts it published. */
export function outcomeOf(run: {
  status: string;
  output?: unknown;
  events: RunEvent[];
  tree?: unknown;
  plan?: unknown;
  bag?: unknown;
  steps: number;
  costUsd: number;
  /** Reads a value as a time (epoch ms) the way the page reads dates; without it no order is graded. */
  timeOf?: (value: unknown) => number | undefined;
  /** The time the run is judged at. Defaults to now. */
  now?: number;
}): DataOutcome {
  const out = (run.output ?? {}) as {
    data?: "bound" | "stand-in" | "none";
    static?: boolean;
    remaining?: string[];
    sources?: Array<{ hookId?: string }>;
  };
  const completed = run.status === "completed";
  return {
    status: completed ? "completed" : run.status === "waiting" ? "waiting" : "failed",
    ...(completed ? { ending: out.data ?? (out.static ? "none" : "bound") } : {}),
    hookId: out.sources?.find((s) => typeof s.hookId === "string")?.hookId ?? null,
    hookOutput: run.bag,
    shown: shownIn(run.events, run.tree),
    boundFields: boundFieldsOf(run.plan),
    problems: out.remaining ?? [],
    variantsDrawn: variantsDrawn(run.plan, run.bag),
    ...(run.timeOf
      ? { dated: datedLists(run.plan, run.bag, run.timeOf), at: run.now ?? Date.now() }
      : {}),
    steps: run.steps,
    costUsd: run.costUsd,
  };
}
