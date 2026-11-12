/**
 * What compiled behaviours do, checked before they are published: the plan still applies, the
 * machine is sound (S18), the tree keeps its refs in the plan, and each state of an item draws one
 * look of each part. The states are simulated with the DSL's own `when`, so what is reported is
 * what the page will draw.
 */

import type { Behaviours, Compiled } from "./compile.ts";
import { refsInTree } from "./compile.ts";
import { childrenOf, type Plan, type Tree, type TreeNode } from "./tree.ts";

export interface CheckDsl {
  applyBindingPlan(tree: Tree, plan: unknown): { tree: Tree; drift: Array<{ message: string }> };
  checkMachine(tree: Tree): Array<{ severity: string; message: string; nodeId?: string }>;
  evaluateWhen(when: unknown, scope: unknown): boolean;
  evaluate(expr: unknown, scope: unknown): unknown;
  initialStep(spec: unknown): Moment;
  step(
    spec: unknown,
    snapshot: Moment["snapshot"],
    event: { type: string; [k: string]: unknown },
  ): Moment;
}

/** A machine's moment, as the DSL's pure stepping answers it. */
interface Moment {
  snapshot: {
    active: string[];
    tags: string[];
    context: Record<string, unknown>;
    computed: Record<string, unknown>;
    value: unknown;
    invokes: string[];
  };
  effects: Array<{ type: string; [k: string]: unknown }>;
}

export interface Checked {
  problems: string[];
  /** For the first item of each list: what each state draws. */
  states: string[];
}

const lookup = (data: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (at, k) => (at && typeof at === "object" ? (at as Record<string, unknown>)[k] : undefined),
      data,
    );

/** A `when` without what reads the page's fields: a search is not a state of the item. */
const withoutPage = (when: unknown): unknown => {
  if (when === undefined || when === null) return when;
  const list = (Array.isArray(when) ? when : [when]).filter((c) => {
    const s = JSON.stringify(c);
    return !s.includes('"_page.') && !s.includes('"$page.');
  });
  return list.length === 0 ? undefined : list;
};

export function check(compiled: Compiled, b: Behaviours, data: unknown, dsl: CheckDsl): Checked {
  const problems: string[] = [];
  const states: string[] = [];
  const refs = refsInTree(compiled.tree);
  if (refs.length) {
    problems.push(
      `the tree holds refs of its own (${refs.slice(0, 4).join(", ")}): a renderer then skips the plan. Refs go in the plan`,
    );
  }
  let bound: Tree;
  try {
    const applied = dsl.applyBindingPlan(compiled.tree, compiled.plan as Plan);
    bound = applied.tree;
    for (const d of applied.drift) problems.push(`the plan no longer applies: ${d.message}`);
  } catch (err) {
    return {
      problems: [...problems, `the plan no longer applies: ${(err as Error).message}`],
      states,
    };
  }
  for (const issue of dsl.checkMachine(bound)) {
    if (issue.severity === "error")
      problems.push(`S18${issue.nodeId ? ` ${issue.nodeId}` : ""}: ${issue.message}`);
  }
  if (b.machine || b.props?.length) {
    const run = simulate(bound, data, dsl);
    problems.push(...run.problems);
    states.push(...run.states);
  }

  // each list's first item, in every state its toggles make
  const machine = (bound.nodes.find((n) => n.parent === null)?.props.machine ?? {}) as {
    computed?: Record<string, unknown>;
  };
  const byId = new Map(bound.nodes.map((n) => [n.id, n]));
  const kids = childrenOf(bound);
  const repeaters = bound.nodes.filter((n) => n.type === "Repeater");
  const overs = [...new Set(b.toggles.map((t) => t.over))];
  const ever = new Set<string>();
  for (const over of overs) {
    const lists = b.toggles.filter((t) => t.over === over);
    const repeater = repeaters.find((r) => r.props.over === over);
    const items = lookup(data, over);
    const item = Array.isArray(items) ? items[0] : undefined;
    if (!repeater || item === undefined) continue;
    const as = String(repeater.props.as ?? "item");
    const inside = new Set<string>();
    const walk = (n: TreeNode) => {
      inside.add(n.id);
      for (const c of kids.get(n.id) ?? []) walk(c);
    };
    walk(repeater);
    const parts = compiled.managed.filter((m) => inside.has(m.id) && !m.role.startsWith("press"));
    const drawn = (id: string, scope: unknown) => {
      for (
        let at = byId.get(id);
        at && at.id !== repeater.id;
        at = at.parent ? byId.get(at.parent) : undefined
      ) {
        if (!dsl.evaluateWhen(withoutPage(at.props.when), scope)) return false;
      }
      return true;
    };
    const keyOf = (t: (typeof lists)[number]) => (item as Record<string, unknown>)[t.key];
    for (let mask = 0; mask < 2 ** lists.length; mask++) {
      const context: Record<string, unknown[]> = {};
      lists.forEach((t, i) => {
        context[t.list] = mask & (1 << i) ? [keyOf(t)] : [];
      });
      const computed: Record<string, unknown> = {};
      for (const [name, expr] of Object.entries(machine.computed ?? {})) {
        computed[name] = dsl.evaluate(expr, { context, computed });
      }
      const scope = { [as]: item, $state: { context, computed, active: [], tags: [], value: {} } };
      const on = parts.filter((p) => drawn(p.id, scope));
      for (const p of on) ever.add(p.id);
      const label = lists.map((t, i) => (mask & (1 << i) ? t.list : `not ${t.list}`)).join(", ");
      states.push(`${label}: draws ${on.map((p) => p.id).join(", ") || "none of them"}`);
      // two looks of one part never both, and never neither
      for (const r of b.restyle) {
        const pair = parts.filter((p) => p.src === r.src || p.src === `ix:state:${r.src}`);
        const shown = pair.filter((p) => on.includes(p)).length;
        if (pair.length === 2 && shown !== 1) {
          problems.push(`${r.src}: ${shown === 0 ? "no look" : "both looks"} drawn when ${label}`);
        }
      }
    }
    for (const p of parts) {
      if (!ever.has(p.id)) problems.push(`${p.id} (${p.role}) is drawn in no state`);
    }
  }
  return { problems, states };
}

/** A node's scope outside any list: the data, and the machine's state at a moment. */
const momentScope = (data: unknown, m: Moment | undefined) => ({
  ...(data && typeof data === "object" ? (data as Record<string, unknown>) : {}),
  $state: m
    ? {
        active: m.snapshot.active,
        tags: m.snapshot.tags,
        context: m.snapshot.context,
        computed: m.snapshot.computed,
        value: m.snapshot.value,
      }
    : { active: [], tags: [], context: {}, computed: {}, value: {} },
});

/**
 * What a machine the model wrote does, run with the DSL's own pure stepping: from the first moment,
 * each event a node sends, what the machine asks the runtime for, what an answer moves it to, and
 * which of the parts outside a list that a `when` decides are drawn at each moment, with the data
 * the section was bound to. The next page is not fetched here: what a part reads of it is named, so
 * the model can see a LOAD MORE's `when` reads a field each page answers. An expression that fails
 * is a problem.
 */
export function simulate(bound: Tree, data: unknown, dsl: CheckDsl): Checked {
  const problems: string[] = [];
  const states: string[] = [];
  const root = bound.nodes.find((n) => n.parent === null);
  const spec = root?.props.machine;
  const byId = new Map(bound.nodes.map((n) => [n.id, n]));
  const inList = (n: TreeNode): boolean => {
    for (
      let at = n.parent ? byId.get(n.parent) : undefined;
      at;
      at = at.parent ? byId.get(at.parent) : undefined
    ) {
      if (at.type === "Repeater") return true;
    }
    return false;
  };
  const gated = bound.nodes.filter((n) => n.props.when !== undefined && !inList(n));
  const drawnAt = (m: Moment | undefined, bag: unknown) =>
    gated.map(
      (n) => `${n.id} ${dsl.evaluateWhen(n.props.when, momentScope(bag, m)) ? "drawn" : "hidden"}`,
    );
  const errorsOf = (m: Moment, what: string) => {
    for (const e of m.effects)
      if (e.type === "error") problems.push(`${what}: ${String(e.message)}`);
  };

  let first: Moment | undefined;
  if (spec !== undefined) {
    try {
      first = dsl.initialStep(spec);
      errorsOf(first, "the first moment");
    } catch (err) {
      problems.push(`the machine does not start: ${(err as Error).message}`);
    }
  }
  states.push(
    `at first: ${first ? `${first.snapshot.active.join(", ") || "(no states)"}; ` : ""}${drawnAt(first, data).join(", ") || "nothing outside a list is decided by a when"}`,
  );
  if (!first) return { problems, states };

  const sent = new Map<string, string>();
  for (const n of bound.nodes) {
    const on = n.props.on as Record<string, { send?: unknown; to?: unknown }> | undefined;
    for (const [what, h] of Object.entries(on ?? {})) {
      if (typeof h?.send === "string" && h.to !== "page" && !sent.has(h.send))
        sent.set(h.send, `${n.id} ${what}`);
    }
  }
  for (const [event, by] of sent) {
    let m: Moment;
    try {
      m = dsl.step(spec, first.snapshot, { type: event });
    } catch (err) {
      problems.push(`${event} (from ${by}): ${(err as Error).message}`);
      continue;
    }
    errorsOf(m, `${event} (from ${by})`);
    const asks = m.effects.filter((e) => e.type === "request");
    const said = asks.map((e) =>
      e.source !== undefined
        ? `asks for more of ${String(e.source)} with ${JSON.stringify(e.input)}`
        : `asks ${String(e.action)} with ${JSON.stringify(e.input)}`,
    );
    states.push(
      `${event} (from ${by}): ${m.snapshot.active.join(", ")}${m.snapshot.tags.length ? ` [${m.snapshot.tags.join(", ")}]` : ""}${said.length ? `; ${said.join("; ")}` : ""}`,
    );
    for (const ask of asks) {
      let done: Moment;
      try {
        done = dsl.step(spec, m.snapshot, { type: `done.invoke.${String(ask.id)}`, output: null });
      } catch (err) {
        problems.push(`the answer to ${String(ask.request)}: ${(err as Error).message}`);
        continue;
      }
      errorsOf(done, `the answer to ${String(ask.request)}`);
      const source = typeof ask.source === "string" ? ask.source : undefined;
      const reads = source
        ? gated
            .filter((n) => JSON.stringify(n.props.when).includes(`"${source}.`))
            .map(
              (n) =>
                `${n.id} reads ${JSON.stringify(n.props.when)}, which each page of ${source} answers anew`,
            )
        : [];
      states.push(
        `after ${String(ask.request)} answers: ${done.snapshot.active.join(", ")}${source ? `; ${source}'s next page is added to the data (lists appended, the rest replaced)` : ""}${reads.length ? `; ${reads.join("; ")}` : source ? `; no part outside a list reads ${source}: nothing hides when it runs out` : ""}`,
      );
    }
  }
  return { problems, states };
}
