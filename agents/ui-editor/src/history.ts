/**
 * Why an element looks the way it does (ADR 0034): what the runs that built the section did to it,
 * read from their build records. frame-match's kept overrides and stand-ins on the element's layer,
 * the surface it was given, data-bind's bindings and lists on it, and what each run left open that
 * names it. A comment on an element is often about one of these: "the border is missing" on a node
 * whose border frame-match removed on purpose is a choice to undo, not a prop to guess.
 */
import { BuildRecord } from "@dugout/contracts";
import type { TreeNode } from "./dsl.ts";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A read field as it is written in a plan: `content ← {player.name}`. */
function reads(f: Record<string, unknown>): string {
  const from = typeof f.template === "string" ? f.template : `{${text(f.path)}}`;
  return `${text(f.prop)} ← ${from}`;
}

/** What frame-match did to the layer `src` (and the surface the node draws). */
function matchLines(did: Record<string, unknown>, node: TreeNode): string[] {
  const lines: string[] = [];
  const surface = typeof node.props.surface === "string" ? node.props.surface : undefined;
  for (const o of list(did.overrides)) {
    if (!isObject(o) || !isObject(o.change)) continue;
    const gained =
      typeof o.gained === "number"
        ? ` (the match moved ${o.gained >= 0 ? "+" : ""}${o.gained})`
        : "";
    for (const p of list(o.change.props)) {
      if (isObject(p) && p.src === node.src) {
        lines.push(
          `frame-match set ${clip(JSON.stringify(p.props))} on it to match the design${gained}`,
        );
      }
    }
    if (surface && isObject(o.change.surfaces) && surface in o.change.surfaces) {
      lines.push(
        `frame-match gave its surface ${surface} ${clip(JSON.stringify(o.change.surfaces[surface]))}${gained}`,
      );
    }
    if (list(o.change.crops).includes(node.src)) {
      lines.push(`frame-match draws it as a picture cut from the design (a stand-in)${gained}`);
    }
    if (list(o.change.gradients).includes(node.src)) {
      lines.push(`frame-match draws its gradient from the design${gained}`);
    }
  }
  return lines;
}

/** What data-bind bound on the layer `src`. */
function bindLines(did: Record<string, unknown>, node: TreeNode): string[] {
  const plan = isObject(did.plan) ? did.plan : undefined;
  if (!plan) return [];
  const lines: string[] = [];
  for (const f of list(plan.bind)) {
    if (isObject(f) && f.src === node.src) lines.push(`data-bind binds ${reads(f)}`);
  }
  for (const l of list(plan.lists)) {
    if (!isObject(l)) continue;
    const members = list(l.members);
    if (members[0] === node.src) {
      lines.push(
        `data-bind repeats it once for each item of ${text(l.over)} (as ${text(l.as)}): it is the card every item draws in${members.length > 1 ? `, and the ${members.length - 1} other cards the design drew are gone` : ""}`,
      );
    } else if (members.includes(node.src)) {
      lines.push(
        `it was one of the cards of ${text(l.over)}; data-bind draws every card from the first`,
      );
    }
    for (const f of [
      ...list(l.fields),
      ...list(l.variants).flatMap((v) => (isObject(v) ? list(v.fields) : [])),
    ]) {
      if (isObject(f) && f.src === node.src)
        lines.push(`data-bind binds ${reads(f)} for each item`);
    }
    for (const v of list(l.variants)) {
      if (isObject(v) && v.src === node.src) {
        lines.push(`data-bind draws it for the items where ${clip(JSON.stringify(v.when))}`);
      }
    }
  }
  for (const k of list(plan.keep)) {
    if (isObject(k) && k.src === node.src)
      lines.push(`data-bind keeps it as designed: ${text(k.why)}`);
  }
  for (const s of list(plan.set)) {
    if (isObject(s) && s.src === node.src) {
      lines.push(`data-bind sets ${text(s.prop)} to ${clip(JSON.stringify(s.value))}`);
    }
  }
  return lines;
}

/** Whether a line of what a run left open is about this node. */
function names(line: string, node: TreeNode): boolean {
  const surface = typeof node.props.surface === "string" ? node.props.surface : undefined;
  return (
    (node.src.length > 2 && line.includes(node.src)) ||
    new RegExp(`\\b${node.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(line) ||
    (!!surface && line.includes(surface))
  );
}

/**
 * The element's story, from the build records of the preview (newest first, as memory lists
 * them): one line each, at most `limit`. Records that do not parse are skipped.
 */
export function historyOf(records: Array<{ value: unknown }>, node: TreeNode, limit = 8): string[] {
  const lines: string[] = [];
  for (const r of records) {
    const parsed = BuildRecord.safeParse(r.value);
    if (!parsed.success) continue;
    const { agent, did, outcome, corrected } = parsed.data;
    if (isObject(did)) {
      if (agent === "frame-match") lines.push(...matchLines(did, node));
      if (agent === "data-bind") lines.push(...bindLines(did, node));
    }
    for (const left of outcome.remaining) {
      if (names(left, node)) lines.push(`${agent} left open: ${clip(left)}`);
    }
    for (const c of corrected ?? []) {
      if (names(c.what, node)) lines.push(`a person asked before: ${clip(c.what)}`);
    }
  }
  return [...new Set(lines)].slice(0, limit);
}
