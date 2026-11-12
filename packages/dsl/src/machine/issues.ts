/**
 * What is wrong with a machine, and with a page of them, before anything runs: what the validator
 * reports on a tree's `machine` (S18) and what a host checks when it puts sections on one page.
 *
 * PURE.
 */

import { exprIssues, exprReads } from "./expr.js";
import { allTransitions, build, MachineError, stateAt, targetPath } from "./interpret.js";
import { type MachineAction, type MachineSpec, machineSchema, type StateNodeSpec } from "./schema.js";
import type { MachineEntry } from "./system.js";

export interface MachineIssue {
  severity: "error" | "warning";
  /** Where, as a path into the machine: `states.drawer.on.drawer.open`. */
  at: string;
  message: string;
}

/** What an expression on a transition or an action may read. */
const ACTION_ROOTS = ["context", "event", "computed", "state", "$page", "$user", "$route"];
/** What a computed value or an export may read: no event. */
const DERIVED_ROOTS = ["context", "computed", "state", "$page", "$user", "$route"];

const childPath = (parent: string, name: string) => (parent ? `${parent}.${name}` : name);
const parentOf = (path: string) => (path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "");

/** Every state of a spec with its path, the root first. */
function statesOf(spec: MachineSpec): Array<[string, StateNodeSpec]> {
  const out: Array<[string, StateNodeSpec]> = [];
  const walk = (s: StateNodeSpec, path: string) => {
    out.push([path, s]);
    for (const [name, child] of Object.entries(s.states ?? {})) walk(child, childPath(path, name));
  };
  walk(spec as StateNodeSpec, "");
  return out;
}

/** Every action list of a spec, with where it is. */
function actionLists(spec: MachineSpec): Array<[string, MachineAction[]]> {
  const out: Array<[string, MachineAction[]]> = [];
  for (const [path, s] of statesOf(spec)) {
    const at = path ? `states.${path}` : "root";
    if (s.entry) out.push([`${at}.entry`, s.entry]);
    if (s.exit) out.push([`${at}.exit`, s.exit]);
  }
  for (const [path, t] of allTransitions(spec)) if (t.actions) out.push([`${path ? `states.${path}` : "root"} transition`, t.actions]);
  return out;
}

/** Each action, the ones inside an `if` too. */
function eachAction(actions: MachineAction[], fn: (a: MachineAction) => void): void {
  for (const a of actions) {
    fn(a);
    if ("if" in a) {
      eachAction(a.if.then, fn);
      eachAction(a.if.else ?? [], fn);
    }
  }
}

/** The expressions an action evaluates. */
function exprsOf(a: MachineAction): unknown[] {
  if ("assign" in a) return Object.values(a.assign);
  if ("raise" in a) return Object.values(a.raise.payload ?? {});
  if ("send" in a) return Object.values(a.send.payload ?? {});
  if ("emit" in a) return Object.values(a.emit.params ?? {});
  if ("navigate" in a) return [a.navigate.href];
  if ("call" in a) return a.call.input === undefined ? [] : [a.call.input];
  if ("if" in a) return [a.if.cond];
  return [];
}

/** Which of a parallel state's regions a path is in, or undefined. */
function regionOf(parallel: string, path: string): string | undefined {
  const prefix = parallel ? `${parallel}.` : "";
  if (!path.startsWith(prefix) || path === parallel) return undefined;
  return path.slice(prefix.length).split(".")[0];
}

/** The issues of one machine. */
export function machineIssues(raw: unknown): MachineIssue[] {
  const parsed = machineSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ severity: "error", at: i.path.join("."), message: i.message }));
  }
  const spec = parsed.data;
  const out: MachineIssue[] = [];
  try {
    build(spec);
  } catch (e) {
    return [{ severity: "error", at: "", message: e instanceof MachineError ? e.message : String(e) }];
  }
  const context = new Set(Object.keys(spec.context ?? {}));

  // expressions: known ops, roots in scope
  for (const [name, expr] of Object.entries(spec.computed ?? {})) {
    for (const i of exprIssues(expr, DERIVED_ROOTS)) out.push({ severity: "error", at: `computed.${name}${i.at}`, message: i.message });
  }
  for (const [name, expr] of Object.entries(spec.exports ?? {})) {
    for (const i of exprIssues(expr, DERIVED_ROOTS)) out.push({ severity: "error", at: `exports.${name}${i.at}`, message: i.message });
  }
  for (const [path, t] of allTransitions(spec)) {
    if (t.guard !== undefined) {
      for (const i of exprIssues(t.guard, ACTION_ROOTS)) out.push({ severity: "error", at: `${path || "root"} guard${i.at}`, message: i.message });
    }
  }
  for (const [at, list] of actionLists(spec)) {
    eachAction(list, (a) => {
      for (const e of exprsOf(a)) for (const i of exprIssues(e, ACTION_ROOTS)) out.push({ severity: "error", at: `${at}${i.at}`, message: i.message });
      if ("assign" in a) {
        for (const p of Object.keys(a.assign)) {
          const field = p.split(".")[0]!;
          if (!context.has(field)) out.push({ severity: "warning", at, message: `assigns "${field}", which context does not start with: give it a starting value` });
        }
      }
    });
  }
  for (const [path, s] of statesOf(spec)) {
    if (s.invoke?.input !== undefined) {
      for (const i of exprIssues(s.invoke.input, ACTION_ROOTS)) out.push({ severity: "error", at: `states.${path}.invoke.input${i.at}`, message: i.message });
    }
    if (s.invoke && !s.invoke.onError) {
      out.push({ severity: "warning", at: `states.${path}.invoke`, message: `"${s.invoke.request}" can fail and nothing says what the section shows then: give it onError` });
    }
  }

  // requests nobody makes, and persisted fields that are not remembered
  const invoked = new Set(statesOf(spec).flatMap(([, s]) => (s.invoke ? [s.invoke.request] : [])));
  for (const name of Object.keys(spec.requests ?? {})) {
    if (!invoked.has(name)) out.push({ severity: "warning", at: `requests.${name}`, message: `"${name}" is declared and no state makes it` });
  }
  for (const f of spec.persist?.fields ?? []) {
    if (!context.has(f)) out.push({ severity: "error", at: "persist.fields", message: `"${f}" is persisted and is not in context` });
  }

  // a target in another region resets the region the transition leaves (XState's semantics)
  for (const [source, t] of allTransitions(spec)) {
    for (const to of t.target === undefined ? [] : Array.isArray(t.target) ? t.target : [t.target]) {
      const target = targetPath(source, to);
      for (let p = parentOf(source); ; p = parentOf(p)) {
        const s = p === "" ? (spec as StateNodeSpec) : stateAt(spec, p);
        const kind = p === "" ? (spec.type ?? "parallel") : s?.type;
        if (kind === "parallel" && source !== p) {
          const a = regionOf(p, source);
          const b = regionOf(p, target);
          if (a && b && a !== b) {
            out.push({
              severity: "warning",
              at: `states.${source}`,
              message: `goes to "${to}" in region "${b}" from region "${a}": both regions start again. Send an event the other region handles instead`,
            });
          }
          break;
        }
        if (p === "") break;
      }
    }
  }

  // states nothing goes to: not initial, not a region, no transition targets them
  const targeted = new Set<string>();
  for (const [source, t] of allTransitions(spec)) {
    for (const to of t.target === undefined ? [] : Array.isArray(t.target) ? t.target : [t.target]) targeted.add(targetPath(source, to));
  }
  for (const [path] of statesOf(spec)) {
    if (path === "") continue;
    const parent = parentOf(path);
    const ps = parent === "" ? (spec as StateNodeSpec) : stateAt(spec, parent)!;
    const parentKind = parent === "" ? (spec.type ?? "parallel") : (ps.type ?? "compound");
    const name = path.slice(parent ? parent.length + 1 : 0);
    const first = ps.initial ?? Object.keys(ps.states ?? {})[0];
    if (parentKind === "parallel" || first === name) continue;
    const reached = [...targeted].some((t) => t === path || t.startsWith(`${path}.`));
    if (!reached) out.push({ severity: "warning", at: `states.${path}`, message: `nothing goes to "${path}"` });
  }
  return out;
}

export interface PageIssue extends MachineIssue {
  instance?: string;
}

/**
 * The issues of the machines put on one page: a page key two sections both share, an event sent
 * that no section handles, a `$page` key read that nobody shares.
 */
export function systemIssues(entries: MachineEntry[], free: readonly string[] = []): PageIssue[] {
  const out: PageIssue[] = [];
  const owners = new Map<string, string>();
  for (const { instance, spec } of entries) {
    for (const key of Object.keys(spec.exports ?? {})) {
      const other = owners.get(key);
      if (other) out.push({ severity: "error", instance, at: `exports.${key}`, message: `"${key}" is already shared by "${other}": a page key has one owner` });
      else owners.set(key, instance);
    }
  }
  const handled = new Set<string>();
  for (const { spec } of entries) for (const [, s] of statesOf(spec)) for (const e of Object.keys(s.on ?? {})) handled.add(e);
  const shared = new Set([...owners.keys(), ...free]);
  for (const { instance, spec } of entries) {
    for (const [at, list] of actionLists(spec)) {
      eachAction(list, (a) => {
        if ("send" in a && !handled.has(a.send.event)) {
          out.push({ severity: "warning", instance, at, message: `sends "${a.send.event}", which no section on the page handles` });
        }
      });
    }
    const exprs: unknown[] = [
      ...Object.values(spec.computed ?? {}),
      ...Object.values(spec.exports ?? {}),
      ...allTransitions(spec).flatMap(([, t]) => (t.guard === undefined ? [] : [t.guard])),
      ...actionLists(spec).flatMap(([, list]) => {
        const all: unknown[] = [];
        eachAction(list, (a) => all.push(...exprsOf(a)));
        return all;
      }),
    ];
    for (const path of exprs.flatMap(exprReads)) {
      const [root, key] = path.split(".");
      if (root === "$page" && key && !shared.has(key)) {
        out.push({ severity: "warning", instance, at: "", message: `reads $page.${key}, which no section on the page shares` });
      }
    }
  }
  return out;
}
