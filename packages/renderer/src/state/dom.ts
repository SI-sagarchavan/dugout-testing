/**
 * What a drawn section says to its machine, and how its nodes' looks follow it, wired with one set
 * of listeners per document. Every node stays a Server Component: the server writes what each node
 * sends (`data-fos-on`) and which of its looks depend on state (`data-fos-looks`), and this reads
 * the attributes.
 *
 *   data-fos-instance  on a section's root: the machine its nodes talk to
 *   data-fos-on        { click|input|change|submit|outside|escape: { send, payload?, to? } }, payload resolved
 *   data-fos-looks     { active|inactive|disabled|expanded: conditions on state }, already split from data
 *   data-fos-entry     on a followed item: its entry in the list in state, for `$entry`
 *
 * `outside` is a press anywhere no handler of the same section took: so the arrow that toggles a
 * menu toggles it, and does not also close it as a press outside the panel. Escape is offered to
 * the whole page as `key.escape`, and to each shown node with an `escape` handler.
 *
 * Browser only.
 */

import { type Condition, evaluateCondition, type Json, stateScope } from "@fanos/dsl/runtime";
import { documents, getSystem, send, subscribe } from "./store.js";

interface Handler {
  send: string;
  payload?: Record<string, Json>;
  to?: "self" | "page";
}
type Handlers = Partial<Record<"click" | "input" | "change" | "submit" | "outside" | "escape", Handler>>;
type Looks = Partial<Record<"active" | "inactive" | "disabled" | "expanded", Condition[]>>;

const asElement = (target: EventTarget | null): Element | null => {
  const el = target as { closest?: unknown; parentElement?: Element | null } | null;
  return el && typeof el.closest === "function" ? (el as Element) : (el?.parentElement ?? null);
};

const parse = <T>(raw: string | undefined): T | undefined => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

const instanceOf = (el: Element): string | undefined => (el.closest("[data-fos-instance]") as HTMLElement | null)?.dataset.fosInstance;

/** The nearest element at or above `from` with a handler for `kind`, and that handler. */
function handlerAt(from: Element | null, kind: keyof Handlers): { el: HTMLElement; handler: Handler } | undefined {
  for (let el = from?.closest<HTMLElement>("[data-fos-on]"); el; el = el.parentElement?.closest<HTMLElement>("[data-fos-on]")) {
    const handler = parse<Handlers>(el.dataset.fosOn)?.[kind];
    if (handler) return { el, handler };
  }
  return undefined;
}

function fire(el: Element, handler: Handler, extra: Record<string, Json> = {}): string | undefined {
  const instance = instanceOf(el);
  if (!instance && handler.to !== "page") return undefined;
  send(instance ?? null, { ...(handler.payload ?? {}), ...extra, type: handler.send }, { page: handler.to === "page" });
  return instance;
}

/** Is this element drawn (not under a gate that hides it, not display: none)? */
const shown = (el: HTMLElement) => el.isConnected && el.getClientRects().length > 0;

function fieldValue(el: Element): Record<string, Json> {
  const field = (el.matches("input, textarea, select") ? el : el.querySelector("input, textarea, select")) as HTMLInputElement | null;
  if (!field) return {};
  return field.type === "checkbox" ? { checked: field.checked, value: field.checked } : { value: field.value };
}

/** One set of listeners per document. */
export function wire(doc: Document): void {
  if (documents.has(doc)) return;
  documents.add(doc);

  doc.addEventListener("click", (event) => {
    const target = asElement(event.target);
    const hit = handlerAt(target, "click");
    const took = hit ? fire(hit.el, hit.handler) : undefined;
    // a press outside: every shown node with an `outside` handler that does not hold the target,
    // unless a handler of its own section took the press
    for (const el of doc.querySelectorAll<HTMLElement>("[data-fos-root] [data-fos-on]")) {
      const handler = parse<Handlers>(el.dataset.fosOn)?.outside;
      if (!handler || !shown(el) || (target && el.contains(target))) continue;
      if (took !== undefined && took === instanceOf(el)) continue;
      fire(el, handler);
    }
  });

  doc.addEventListener("input", (event) => {
    const target = asElement(event.target);
    const hit = handlerAt(target, "input");
    if (hit && target) fire(hit.el, hit.handler, fieldValue(target));
  });

  doc.addEventListener("change", (event) => {
    const target = asElement(event.target);
    const hit = handlerAt(target, "change");
    if (hit && target) fire(hit.el, hit.handler, fieldValue(target));
  });

  doc.addEventListener("keydown", (event) => {
    const target = asElement(event.target);
    if (event.key === "Escape") {
      send(null, { type: "key.escape" });
      for (const el of doc.querySelectorAll<HTMLElement>("[data-fos-root] [data-fos-on]")) {
        const handler = parse<Handlers>(el.dataset.fosOn)?.escape;
        if (handler && shown(el)) fire(el, handler);
      }
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.key === "Enter") {
      const submit = handlerAt(target, "submit");
      if (submit && target) {
        event.preventDefault();
        fire(submit.el, submit.handler, fieldValue(target));
        return;
      }
    }
    // a node that is pressed and is not a button or a link: Enter and Space press it
    const el = target as HTMLElement | null;
    if (!el?.dataset?.fosOn || el.matches("button, a, input, textarea, select")) return;
    const hit = handlerAt(el, "click");
    if (hit?.el === el) {
      event.preventDefault();
      el.click();
    }
  });

  paint(doc);
}

const LOOK_STATES = ["active", "inactive", "disabled"] as const;

/** The scope a node's look is decided in: its section's state, and its followed item's entry. */
function scopeAt(el: HTMLElement): Record<string, unknown> {
  const scope = stateScope(getSystem(), instanceOf(el));
  const entry = el.closest<HTMLElement>("[data-fos-entry]")?.dataset.fosEntry;
  return entry === undefined ? scope : { ...scope, $entry: parse<Json>(entry) ?? null };
}

/** Each node whose look follows state, in the look the state gives it now. */
export function paint(doc: Document): void {
  for (const el of doc.querySelectorAll<HTMLElement>("[data-fos-looks]")) {
    const looks = parse<Looks>(el.dataset.fosLooks);
    if (!looks) continue;
    const scope = scopeAt(el);
    const holds = (cs: Condition[] | undefined) => cs !== undefined && cs.every((c) => evaluateCondition(c, scope));
    const on = new Set<string>();
    if (looks.active) on.add(holds(looks.active) ? "active" : "inactive");
    if (looks.inactive && holds(looks.inactive)) on.add("inactive");
    if (looks.disabled && holds(looks.disabled)) on.add("disabled");
    const kept = (el.getAttribute("data-fos-state") ?? "").split(/\s+/).filter((s) => s && !(LOOK_STATES as readonly string[]).includes(s));
    const next = [...kept, ...on].join(" ");
    if ((el.getAttribute("data-fos-state") ?? "") !== next) el.setAttribute("data-fos-state", next);
    if (looks.disabled) el.setAttribute("aria-disabled", String(on.has("disabled")));
    if (looks.expanded) el.setAttribute("aria-expanded", String(holds(looks.expanded)));
  }
}

subscribe(() => {
  for (const doc of documents) paint(doc);
});
