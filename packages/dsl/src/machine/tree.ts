/**
 * S18: a tree's machine and what its nodes say to it and read from it.
 *
 * - `machine` is on the root only, and is a machine (`machineIssues`)
 * - an event a node sends its own section is one the machine handles (`to: "page"` for another's)
 * - a node reads `$state` only in a section with a machine, and only what it remembers or derives
 * - `follow` follows a list in state, and a Repeater's `over` is the data's (never state's)
 * - a machine's `focus` and `scrollTo` name nodes of this tree
 *
 * PURE.
 */

import { conditionsOf, parseRefs, predicateSchema } from "../binding.js";
import type { FlatNode, FlatTree } from "../flat.js";
import type { Issue } from "../validate.js";
import { handlesEvent } from "./interpret.js";
import { machineIssues } from "./issues.js";
import { type MachineAction, type MachineSpec, machineSchema, type StateNodeSpec } from "./schema.js";
import { isLivePath } from "./system.js";

const EVENT_KEYS = ["click", "input", "change", "submit", "outside", "escape"] as const;

interface Handler {
  send?: unknown;
  payload?: unknown;
  to?: unknown;
}

/** The section's machine: the root's `machine`, when it is one. */
export function machineOf(tree: FlatTree): MachineSpec | undefined {
  const root = tree.nodes.find((n) => n.parent === null);
  const raw = root?.props.machine;
  if (raw === undefined) return undefined;
  const parsed = machineSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The paths a node reads: in `when`, `statesWhen`, templates, `follow.list`. */
function readsOf(node: FlatNode): Array<{ prop: string; path: string }> {
  const out: Array<{ prop: string; path: string }> = [];
  const predicates: Array<[string, unknown]> = [["when", node.props.when]];
  const looks = node.props.statesWhen;
  if (looks && typeof looks === "object") for (const [k, v] of Object.entries(looks)) predicates.push([`statesWhen.${k}`, v]);
  for (const [prop, p] of predicates) {
    if (p === undefined) continue;
    const parsed = predicateSchema.safeParse(p);
    if (!parsed.success) continue;
    for (const c of conditionsOf(parsed.data)) {
      for (const path of [c.path, c.eqPath, c.hasPath, c.lacksPath, c.containsPath]) if (path !== undefined) out.push({ prop, path });
    }
  }
  const walk = (v: unknown, prop: string) => {
    if (typeof v === "string") {
      if (v.includes("{")) for (const ref of parseRefs(v)) out.push({ prop, path: ref.path });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${prop}.${i}`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, prop ? `${prop}.${k}` : k);
  };
  for (const [k, v] of Object.entries(node.props)) {
    if (k === "when" || k === "statesWhen" || k === "machine" || k === "_meta") continue;
    walk(v, k);
  }
  const follow = node.props.follow as { list?: unknown } | undefined;
  if (typeof follow?.list === "string") out.push({ prop: "follow.list", path: follow.list });
  return out;
}

/** Every node id a machine's actions name. */
function nodesNamed(spec: MachineSpec): string[] {
  const out: string[] = [];
  const each = (actions: MachineAction[] | undefined) => {
    for (const a of actions ?? []) {
      if ("focus" in a) out.push(a.focus);
      if ("scrollTo" in a) out.push(a.scrollTo);
      if ("if" in a) {
        each(a.if.then);
        each(a.if.else);
      }
    }
  };
  const walk = (s: StateNodeSpec) => {
    each(s.entry);
    each(s.exit);
    const transitions = [...Object.values(s.on ?? {}), s.always, s.onDone, s.invoke?.onDone, s.invoke?.onError, ...Object.values(s.after ?? {})];
    for (const t of transitions) {
      if (t === undefined) continue;
      for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "object") each(x.actions);
    }
    for (const child of Object.values(s.states ?? {})) walk(child);
  };
  walk(spec as StateNodeSpec);
  return out;
}

export function checkMachine(tree: FlatTree): Issue[] {
  const issues: Issue[] = [];
  const add = (nodeId: string, path: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ code: "S18", severity, nodeId, path, message });
  const root = tree.nodes.find((n) => n.parent === null);
  let spec: MachineSpec | undefined;

  for (const node of tree.nodes) {
    if (node.props.machine === undefined) continue;
    if (node !== root) {
      add(node.id, "machine", "a section has one machine, on its root: move it there");
      continue;
    }
    const found = machineIssues(node.props.machine);
    for (const i of found) add(node.id, `machine${i.at ? `.${i.at}` : ""}`, i.message, i.severity);
    if (!found.some((i) => i.severity === "error")) spec = machineOf(tree);
  }

  const context = new Set(Object.keys(spec?.context ?? {}));
  const computed = new Set(Object.keys(spec?.computed ?? {}));
  const ids = new Set(tree.nodes.map((n) => n.id));

  for (const node of tree.nodes) {
    // events
    const on = node.props.on as Record<string, Handler> | undefined;
    if (on && typeof on === "object") {
      for (const key of EVENT_KEYS) {
        const h = on[key];
        if (!h || typeof h.send !== "string") continue;
        const toPage = h.to === "page";
        if (!toPage && !spec && node.props.machine === undefined && root?.props.machine === undefined) {
          add(node.id, `on.${key}`, `sends "${h.send}" to its section, which has no machine: give the root one, or send it to: "page"`);
        } else if (!toPage && spec && !handlesEvent(spec, h.send)) {
          add(node.id, `on.${key}`, `sends "${h.send}", which the section's machine never handles: handle it, or send it to: "page" for another section's`);
        }
        const payload = h.payload;
        if (payload && typeof payload === "object") {
          for (const [k, v] of Object.entries(payload)) {
            if (typeof v === "string" && parseRefs(v).some((r) => isLivePath(r.path))) {
              add(node.id, `on.${key}.payload.${k}`, `reads state, which a payload has as it was drawn: the machine reads its own state, so leave it out`, "warning");
            }
          }
        }
      }
    }

    // reads
    for (const { prop, path } of readsOf(node)) {
      const [rootName, part, field] = path.split(".");
      if (rootName !== "$state") continue;
      if (!spec) {
        add(node.id, prop, `reads ${path}, and the section has no machine`);
        continue;
      }
      if (part === "context" && field && !context.has(field)) add(node.id, prop, `reads ${path}: the machine remembers no "${field}"`, "warning");
      if (part === "computed" && field && !computed.has(field)) add(node.id, prop, `reads ${path}: the machine derives no "${field}"`, "warning");
    }

    // lists
    if (node.type === "Repeater") {
      const over = node.props.over;
      if (typeof over === "string" && over.startsWith("$")) {
        add(node.id, "over", `over "${over}" is state: a Repeater draws items the data has. Give over the data's list and follow the list in state ({ follow: { list: "${over}", key: "id" } })`);
      }
      const follow = node.props.follow as { list?: unknown } | undefined;
      if (follow && typeof follow.list === "string" && !/^(?:\$page|\$state)\./.test(follow.list)) {
        add(node.id, "follow.list", `follow.list "${follow.list}" is not state: $page.<key> or $state.context.<field>`);
      }
    }
  }

  if (spec && root) {
    // a request for more of a source runs a source the section reads: the head of its refs, its
    // lists' `over`, its `when`s
    const sources = new Set<string>();
    for (const node of tree.nodes) {
      for (const { path } of readsOf(node)) sources.add(path.split(".")[0] ?? "");
      if (typeof node.props.over === "string") sources.add(node.props.over.split(".")[0] ?? "");
    }
    for (const [name, request] of Object.entries(spec.requests ?? {})) {
      const source = request.source;
      if (source !== undefined && (source.startsWith("$") || source.startsWith("_") || !sources.has(source))) {
        add(root.id, `machine.requests.${name}.source`, `"${name}" loads more of "${source}", which no node of this section reads: name the data source its refs start with`);
      }
    }
    for (const id of nodesNamed(spec)) {
      if (!ids.has(id)) add(root.id, "machine", `focuses or scrolls to "${id}", which is no node of this section`);
    }
  }
  return issues;
}
