/**
 * Putting the slots' bindings of one frame back together (`.scratch/page-sections/spec.md`).
 *
 * Each slot is bound on its own, against its own data, and touches only its own nodes. The pass
 * publishes the frame once: one plan, one data map. The plans are put side by side and their
 * parts never overlap; a plan that names a node another plan names, or data under a name another
 * has taken, is refused and said so, never merged over.
 */

import { plannedSrcs } from "@dugout/agent-data-bind";

/** A binding plan, as data-bind writes it: lists, bindings, fixed values. */
export interface PlanParts {
  note?: string;
  collapse?: unknown[];
  bind?: unknown[];
  set?: unknown[];
}

export interface SlotBinding {
  /** The slot, as a person names it. */
  name: string;
  plan: PlanParts;
  /** The data the plan reads: `{ [as]: … }`. */
  bag: Record<string, unknown>;
}

export interface Merged {
  plan: PlanParts;
  bag: Record<string, unknown>;
  /** The slots whose bindings are in `plan`, in the order they were put in. */
  merged: string[];
  /** The slots left out, and why. */
  refused: Array<{ name: string; why: string }>;
}

export function mergeBindings(parts: SlotBinding[]): Merged {
  const nodes = new Map<string, string>();
  const names = new Map<string, string>();
  const plan: Required<Pick<PlanParts, "collapse" | "bind" | "set">> & { note: string[] } = {
    note: [],
    collapse: [],
    bind: [],
    set: [],
  };
  const bag: Record<string, unknown> = {};
  const merged: string[] = [];
  const refused: Merged["refused"] = [];
  for (const part of parts) {
    const touched = plannedSrcs(part.plan);
    const clash = touched.find((src) => nodes.has(src));
    if (clash) {
      refused.push({
        name: part.name,
        why: `its plan names ${clash}, which the plan of ${nodes.get(clash)} already binds`,
      });
      continue;
    }
    const taken = Object.keys(part.bag).find((key) => names.has(key));
    if (taken) {
      refused.push({
        name: part.name,
        why: `its data is named "${taken}", which the data of ${names.get(taken)} already has`,
      });
      continue;
    }
    for (const src of touched) nodes.set(src, part.name);
    for (const key of Object.keys(part.bag)) names.set(key, part.name);
    Object.assign(bag, part.bag);
    plan.collapse.push(...(part.plan.collapse ?? []));
    plan.bind.push(...(part.plan.bind ?? []));
    plan.set.push(...(part.plan.set ?? []));
    if (part.plan.note) plan.note.push(`${part.name}: ${part.plan.note}`);
    merged.push(part.name);
  }
  const { note, ...lists } = plan;
  return {
    plan: {
      ...(note.length ? { note: note.join(" · ") } : {}),
      // empty lists are left out: the plan is what the page reads
      ...Object.fromEntries(Object.entries(lists).filter(([, v]) => v.length > 0)),
    },
    bag,
    merged,
    refused,
  };
}
