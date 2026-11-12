/**
 * A node's `when`, split for the server: the conditions it decides now, from the data and the
 * host (`$user`, `$route`), and those that read state that changes in the browser (`$state`,
 * `$page`, `_page`, `$entry`), made to read nothing else. A comparison of an item's field with
 * state becomes a comparison of the state with the item's value here (`player.id` → `"p12"`), so
 * the browser needs only the state to decide it.
 *
 * The page's choices keep ADR 0032's filter rule (a value no item holds lets every item through):
 * those conditions go through `splitPageWhen`.
 *
 * PURE.
 */

import { type Condition, conditionsOf, lookup, type Predicate, predicateSchema, type Scalar } from "../binding.js";
import { splitPageWhen } from "../page.js";
import { isLivePath } from "./system.js";

const isPageRoot = (path: string | undefined) => path !== undefined && /^(?:_page|\$page)(?:\.|$)/.test(path);
const asLegacy = (path: string) => (path.startsWith("$page") ? `_page${path.slice("$page".length)}` : path);

const scalarOf = (v: unknown): Scalar => (v === undefined || typeof v === "object" ? null : (v as Scalar)) ?? null;

/** A condition that never holds, for a list with nothing in it. */
const NEVER = (path: string): Condition => ({ path, in: ["\u0000none"] });

export function splitLiveWhen(when: unknown, data: unknown): { now: unknown; live: Condition[] } {
  if (when === undefined || when === null) return { now: when, live: [] };
  const parsed = predicateSchema.safeParse(when);
  if (!parsed.success) return { now: when, live: [] };
  const all = conditionsOf(parsed.data as Predicate);
  const now: Condition[] = [];
  const live: Condition[] = [];
  for (const c of all) {
    const sides = [c.path, c.eqPath, c.hasPath, c.lacksPath, c.containsPath].filter((p): p is string => p !== undefined);
    const liveSides = sides.filter(isLivePath);
    if (liveSides.length === 0) {
      now.push(c);
      continue;
    }
    if (liveSides.length === sides.length) {
      live.push(c);
      continue;
    }
    // one side live, the other data the server has
    if (c.containsPath !== undefined) {
      if (isPageRoot(c.containsPath)) {
        live.push(...splitPageWhen({ ...c, containsPath: asLegacy(c.containsPath) }, data).page);
        continue;
      }
      if (isLivePath(c.containsPath)) {
        const text = lookup(data, c.path);
        live.push({ path: c.containsPath, within: typeof text === "string" || typeof text === "number" ? String(text) : "" });
        continue;
      }
      // the item's text is live, what it is searched for is data: rare; decided in the browser as is
      live.push(c);
      continue;
    }
    if (c.eqPath !== undefined) {
      if (isPageRoot(c.path) || isPageRoot(c.eqPath)) {
        const legacy = { ...c, path: asLegacy(c.path), eqPath: asLegacy(c.eqPath) };
        live.push(...splitPageWhen(legacy, data).page);
        continue;
      }
      const [livePath, dataPath] = isLivePath(c.path) ? [c.path, c.eqPath] : [c.eqPath, c.path];
      live.push({ path: livePath, eq: scalarOf(lookup(data, dataPath)) });
      continue;
    }
    if (c.lacksPath !== undefined) {
      if (isLivePath(c.path)) {
        live.push({ path: c.path, lacks: scalarOf(lookup(data, c.lacksPath)) });
      } else {
        const list = lookup(data, c.path);
        const values = Array.isArray(list) ? list.filter((x) => x === null || typeof x !== "object").map(scalarOf) : [];
        // the value in state is none of the data's
        live.push(...values.map((v) => ({ path: c.lacksPath as string, ne: v })));
      }
      continue;
    }
    if (c.hasPath !== undefined) {
      if (isLivePath(c.path)) {
        // the list in state holds this item's value
        live.push({ path: c.path, has: scalarOf(lookup(data, c.hasPath)) });
      } else {
        // the data's list holds the value in state
        const list = lookup(data, c.path);
        const values = Array.isArray(list) ? list.filter((x) => x === null || typeof x !== "object").map(scalarOf) : [];
        live.push(values.length ? { path: c.hasPath, in: values } : NEVER(c.hasPath));
      }
      continue;
    }
    live.push(c);
  }
  return { now: now.length ? now : undefined, live };
}

/** Does any condition of a `when` read state that changes in the browser? */
export function readsLive(when: unknown): boolean {
  const parsed = predicateSchema.safeParse(when);
  if (!parsed.success) return false;
  return conditionsOf(parsed.data as Predicate).some((c) => [c.path, c.eqPath, c.hasPath, c.lacksPath, c.containsPath].some((p) => p !== undefined && isLivePath(p)));
}
