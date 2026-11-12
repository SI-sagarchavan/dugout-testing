"use client";

/**
 * `@fanos/renderer/client` — the renderer's only client components.
 *
 * It reads data through `@fanos/dsl/runtime`, never the package's main entry, which brings the
 * theme loader and its file reads into the browser.
 *
 * Everything else is a Server Component. A carousel needs the browser for one thing: starting
 * Swiper once the server's markup is on the page. So this draws the same markup the server
 * would, and mounts Swiper after hydration. In a host without React on the client (the
 * screenshot harness, a static export) it is plain markup and the first paint is the design.
 *
 * Its own entry, built with the directive intact, so Next.js sees the boundary: the server
 * components import it by package name, never by path.
 */

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import {
  clockTick,
  clockValues,
  evaluateCondition,
  pageScope,
  resolveTemplate,
  stateScope,
  type ClockUnit,
  type Condition,
  type Json,
  type MachineSnapshot,
  type MachineSpec,
  type PageState,
  type PageSystem,
} from "@fanos/dsl/runtime";
import { currentValues, getSystem, registerMachine, seedValues, setValue, subscribe as subscribeStore } from "./state/store.js";
import { wire } from "./state/dom.js";

export { configureRuntime, send } from "./state/store.js";
export type { RequestError, RuntimeConfig } from "./state/store.js";
import { gateSlides } from "./carousel/gate.js";
import type { CarouselSpec } from "./carousel/shared.js";

export interface CarouselRootProps {
  spec: CarouselSpec;
  className: string;
  style: CSSProperties;
  dataAttrs: Record<string, string>;
  /** The page state the server drew at, for slides that follow a page choice. */
  page?: PageState;
  /** The slides, each already a `.swiper-slide`. */
  children: ReactNode;
}

export function CarouselRoot({ spec, className, style, dataAttrs, page, children }: CarouselRootProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Slides of a rail that follows a page choice (`data-fos-gate`, the conditions each shows at):
  // show those the choice now satisfies, and tell Swiper, which skips hidden slides.
  useEffect(() => {
    const root = ref.current;
    if (!root || !root.querySelector("[data-fos-gate]")) return;
    const gate = () => gateSlides(root, { ...(page ?? {}), ...currentChoices() });
    gate();
    return subscribeChoices(gate);
  }, [page]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    // Swiper loads with the first carousel on the page, not with the page.
    void import("./carousel/mount.js").then(({ mountCarousel }) => {
      if (!cancelled) stop = mountCarousel(root);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={style}
      data-fos-carousel={JSON.stringify(spec)}
      {...dataAttrs}
    >
      <div className="swiper fos-carousel-viewport">
        <div className="swiper-wrapper">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

/** A clock as the client needs it: the instant, already read from the data, and its units. */
export interface ClockRef {
  to: number;
  units: ClockUnit[];
}

/** One timer for every clock on the page, running only while something reads it. */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    for (const each of listeners) each();
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * The time, starting at the server's (so the first client render matches the markup), then the
 * browser's, changing once per the smallest unit any of these clocks draws.
 */
function useNow(initial: number, clocks: Record<string, ClockRef>): number {
  const [now, setNow] = useState(initial);
  const tick = clockTick(Object.values(clocks).flatMap((clock) => clock.units));
  useEffect(() => {
    let last = Date.now();
    setNow(last);
    return subscribe(() => {
      const at = Date.now();
      if (Math.floor(at / tick) !== Math.floor(last / tick)) {
        last = at;
        setNow(at);
      }
    });
  }, [tick]);
  return now;
}

const scopeAt = (clocks: Record<string, ClockRef>, now: number) =>
  Object.fromEntries(Object.entries(clocks).map(([as, c]) => [as, clockValues(c.units, c.to, now)]));

export interface ClockTextProps {
  /** The text in pieces: literal text, and the refs that read a clock, as written. */
  parts: Array<string | { ref: string }>;
  clocks: Record<string, ClockRef>;
  /** When the server drew it. */
  now: number;
  timeZone?: string;
  dateOrder?: "mdy" | "dmy";
}

/** The characters of a Text that reads a clock. Its look is the Text's, drawn by the server. */
export function ClockText({ parts, clocks, now: initial, timeZone, dateOrder }: ClockTextProps) {
  const now = useNow(initial, clocks);
  const scope = scopeAt(clocks, now);
  return (
    <>
      {parts
        .map((part) =>
          typeof part === "string"
            ? part
            : resolveTemplate(part.ref, scope, { ...(timeZone ? { timeZone } : {}), ...(dateOrder ? { dateOrder } : {}) }).value,
        )
        .join("")}
    </>
  );
}

export interface ClockGateProps {
  /** The conditions of the node's `when` that read a clock; the rest were decided by the server. */
  conditions: Condition[];
  clocks: Record<string, ClockRef>;
  now: number;
  children: ReactNode;
}

/** Draws its node while every condition holds: the digits until kick-off, a label after. */
export function ClockGate({ conditions, clocks, now: initial, children }: ClockGateProps) {
  const now = useNow(initial, clocks);
  const scope = scopeAt(clocks, now);
  return conditions.every((c) => evaluateCondition(c, scope)) ? <>{children}</> : null;
}

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

/**
 * The page's choices (`select`, `_page`): what one section's options set and any section's `when`
 * reads. They live in the page's one store (`state/store.ts`) beside the sections' machines, so a
 * machine reads a tab as `$page.<key>` and a tab's gate reads what a machine shares the same way.
 */
function subscribeChoices(listener: () => void): () => void {
  return subscribeStore(listener);
}

/** Set a page choice, as pressing one of its options does. */
export function choose(key: string, value: string): void {
  setValue(key, value);
}

let choiceCache: { from: PageSystem | undefined; state: PageState } = { from: undefined, state: {} };

/** The page's choices now, as text: `{ squad: "men" }`. */
export function currentChoices(): PageState {
  const system = getSystem();
  if (choiceCache.from === system) return choiceCache.state;
  const state: PageState = {};
  for (const [k, v] of Object.entries(currentValues())) if (typeof v === "string") state[k] = v;
  choiceCache = { from: system, state };
  return state;
}

/** The documents sections are drawn in: the page, and an iframe a host draws into. */
const documents = new Set<Document>();

const withState = (states: string | null, on: boolean): string =>
  [...(states ?? "").split(/\s+/).filter((s) => s && s !== "active" && s !== "inactive"), on ? "active" : "inactive"].join(" ");

/** Each drawn option says whether it is the chosen one: its `active` or `inactive` look. */
function paintOptions(doc: Document): void {
  const choices = currentChoices();
  for (const el of doc.querySelectorAll<HTMLElement>("[data-fos-select]")) {
    const value = choices[el.dataset.fosSelect ?? ""];
    if (value === undefined) continue;
    const on = el.dataset.fosValue === value;
    el.setAttribute("data-fos-state", withState(el.getAttribute("data-fos-state"), on));
    el.setAttribute("aria-selected", String(on));
    el.tabIndex = on ? 0 : -1;
  }
}

/**
 * Each drawn field shows what the page holds for it: a box another section ticked is ticked here,
 * in its `active` look. A field being typed in is left alone: it is where the value came from.
 */
function paintFields(doc: Document): void {
  const choices = currentChoices();
  for (const el of doc.querySelectorAll<HTMLInputElement>("[data-fos-root] [data-fos-field]")) {
    const value = choices[el.dataset.fosField ?? ""];
    if (value === undefined) continue;
    if (el.type === "checkbox") {
      const on = value === "true";
      el.checked = on;
      const box = el.closest<HTMLElement>('[data-fos-type="Checkbox"]');
      box?.setAttribute("data-fos-state", withState(box.getAttribute("data-fos-state"), on));
    } else if (el.value !== value && el.ownerDocument.activeElement !== el) {
      el.value = value;
    }
  }
}

subscribeChoices(() => {
  for (const doc of documents) {
    paintOptions(doc);
    paintFields(doc);
  }
});

/** The field an event is on, in any realm (see `optionOf`). */
function fieldOf(target: EventTarget | null): HTMLInputElement | null {
  const el = target as { closest?: (selector: string) => HTMLElement | null } | null;
  return typeof el?.closest === "function"
    ? (el.closest("[data-fos-root] [data-fos-field]") as HTMLInputElement | null)
    : null;
}

/** What a field writes to the page: what is typed, or whether the box is ticked. */
function writeField(field: HTMLInputElement): void {
  const key = field.dataset.fosField;
  if (!key) return;
  choose(key, field.type === "checkbox" ? String(field.checked) : field.value);
}

/** The option an event is on, in any realm: an iframe's elements are not this window's `Element`. */
function optionOf(target: EventTarget | null): HTMLElement | null {
  const el = target as { closest?: (selector: string) => HTMLElement | null } | null;
  return typeof el?.closest === "function" ? el.closest("[data-fos-root] [data-fos-select]") : null;
}

/** One listener per document: pressing an option chooses it; arrows move along its choice. */
function listen(doc: Document): void {
  wire(doc);
  if (documents.has(doc)) return;
  documents.add(doc);
  const pick = (option: HTMLElement) => {
    const { fosSelect: key, fosValue: value } = option.dataset;
    if (key && value) choose(key, value);
  };
  doc.addEventListener("click", (event) => {
    const option = optionOf(event.target);
    if (option) pick(option);
  });
  // Typing writes on each keystroke; a tick on change (a click, Space, a label).
  doc.addEventListener("input", (event) => {
    const field = fieldOf(event.target);
    if (field && field.type !== "checkbox") writeField(field);
  });
  doc.addEventListener("change", (event) => {
    const field = fieldOf(event.target);
    if (field) writeField(field);
  });
  doc.addEventListener("keydown", (event) => {
    const option = optionOf(event.target);
    if (!option) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(option);
      return;
    }
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    const root = option.closest("[data-fos-root]");
    const key = option.dataset.fosSelect ?? "";
    const all = [...(root?.querySelectorAll<HTMLElement>("[data-fos-select]") ?? [])].filter((o) => o.dataset.fosSelect === key);
    const next = all[(all.indexOf(option) + step + all.length) % all.length];
    if (!next) return;
    event.preventDefault();
    next.focus();
    pick(next);
  });
}

export interface PageChoicesProps {
  /** Where the page's choices start: this section's options drawn selected, and what the host said. */
  initial: PageState;
}

/**
 * Wires the options and fields of one drawn section. The server drew each one in its state; this
 * makes pressing an option choose it, typing in a field or ticking a box write the page, and starts
 * each key the page has not set yet at its initial value.
 */
export function PageChoices({ initial }: PageChoicesProps) {
  const ref = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a section's choices are its tree's, fixed for its life
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (!doc) return;
    listen(doc);
    const before = getSystem();
    seedValues(initial);
    if (getSystem() === before) {
      paintOptions(doc);
      paintFields(doc);
    }
  }, []);
  return <span ref={ref} hidden data-fos-page="" />;
}

export interface PageGateProps {
  /** The conditions of the node's `when` that read the page, made to read nothing else. */
  conditions: Condition[];
  /** The page state the server drew at. */
  page: PageState;
  children: ReactNode;
}

/** Draws its node while the page's choices satisfy its conditions: the panel of the chosen tab. */
export function PageGate({ conditions, page, children }: PageGateProps) {
  const holds = (state: PageState) => conditions.every((c) => evaluateCondition(c, pageScope({ ...page, ...state })));
  const shown = useSyncExternalStore(
    subscribeChoices,
    () => holds(currentChoices()),
    () => holds({}),
  );
  return shown ? <>{children}</> : null;
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

export interface MachineHostProps {
  /** The section drawn: its machine's name on the page. */
  instance: string;
  spec: MachineSpec;
  /** The machine as the server drew it. */
  snapshot: MachineSnapshot;
  /** The signed-in fan and the route the server drew with. */
  host: { user: Json; route: Json };
  /** The page's values written outside any machine, as the server drew them. */
  free: Record<string, Json>;
}

/**
 * Joins a drawn section's machine to the page, at the snapshot the server drew it at, so the first
 * client render is the server's; then wires the document's presses, typing and keys to it.
 */
export function MachineHost({ instance, spec, snapshot, host, free }: MachineHostProps) {
  const ref = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a section's machine is its tree's, fixed for its life
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (!doc) return;
    listen(doc);
    registerMachine(instance, spec, snapshot, { host, free });
  }, []);
  return <span ref={ref} hidden data-fos-machine={instance} />;
}

/** A followed item's entry in the list in state: `$entry` for what is drawn inside it. */
const EntryContext = createContext<{ entry: Json } | undefined>(undefined);

/**
 * The scope a node of `instance`'s section reads state in, live; `undefined` until its machine has
 * joined the page (a gate then keeps the server's answer, so hydration matches the markup).
 */
function useLiveScope(instance: string | undefined): Record<string, unknown> | undefined {
  const entry = useContext(EntryContext);
  const system = useSyncExternalStore(subscribeStore, getSystem, () => undefined);
  if (!system || (instance !== undefined && !system.specs[instance] && Object.keys(system.free).length === 0)) return undefined;
  const scope = stateScope(system, instance);
  return entry ? { ...scope, $entry: entry.entry } : scope;
}

export interface StateGateProps {
  instance?: string;
  /** The conditions of the node's `when` that read state, made to read nothing else. */
  conditions: Condition[];
  /** Whether they held when the server drew the page. */
  initial: boolean;
  children: ReactNode;
}

/** Draws its node while the state satisfies its conditions: a menu's panel while the menu is open. */
export function StateGate({ instance, conditions, initial, children }: StateGateProps) {
  const scope = useLiveScope(instance);
  const shown = scope === undefined ? initial : conditions.every((c) => evaluateCondition(c, scope));
  return shown ? <>{children}</> : null;
}

export interface StateTextProps {
  instance?: string;
  /** The text in pieces: literal text and everything else resolved, the refs to state as written. */
  parts: Array<string | { ref: string }>;
  /** The characters as the server drew them. */
  initial: string;
  timeZone?: string;
  dateOrder?: "mdy" | "dmy";
}

/** The characters of a Text that reads state: `0/2` as favourites are picked, a cart's count. */
export function StateText({ instance, parts, initial, timeZone, dateOrder }: StateTextProps) {
  const scope = useLiveScope(instance);
  if (scope === undefined) return <>{initial}</>;
  const options = { ...(timeZone ? { timeZone } : {}), ...(dateOrder ? { dateOrder } : {}) };
  return <>{parts.map((part) => (typeof part === "string" ? part : resolveTemplate(part.ref, scope, options).value)).join("")}</>;
}

export interface FollowItemProps {
  instance?: string;
  /** The list in state: `$page.followed`, `$state.context.lines`. */
  list: string;
  /** This item's key: the value its entry is, or holds under `by`. */
  itemKey: Json;
  by?: string;
  /** Its entry when the server drew the page, or undefined when it was not in the list. */
  initial?: Json;
  /** The repetition's attributes, as the server drew them. */
  attrs: Record<string, string | number>;
  children: ReactNode;
}

const entryIn = (list: unknown, key: Json, by: string | undefined): Json | undefined => {
  if (!Array.isArray(list)) return undefined;
  const hit = list.find((e) => (by ? e && typeof e === "object" && (e as Record<string, unknown>)[by] === key : e === key));
  return hit as Json | undefined;
};

/**
 * One item of a Repeater that follows a list in state (`follow`): drawn while the list holds it,
 * with its entry as `$entry` (a cart line's quantity). The server drew every item the data has, in
 * the data's order, each shown or not as the state stood; the browser shows and hides them.
 */
export function FollowItem({ instance, list, itemKey, by, initial, attrs, children }: FollowItemProps) {
  const scope = useLiveScope(instance);
  const entry = scope === undefined ? initial : entryIn(readList(scope, list), itemKey, by);
  if (entry === undefined) return null;
  return (
    <EntryContext.Provider value={{ entry }}>
      <div style={{ display: "contents" }} data-fos-entry={JSON.stringify(entry)} {...attrs}>
        {children}
      </div>
    </EntryContext.Provider>
  );
}

function readList(scope: Record<string, unknown>, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
