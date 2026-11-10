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

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import {
  clockTick,
  clockValues,
  evaluateCondition,
  pageScope,
  resolveTemplate,
  type ClockUnit,
  type Condition,
  type PageState,
} from "@fanos/dsl/runtime";
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
    const gate = () => gateSlides(root, { ...(page ?? {}), ...choiceSnapshot });
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
 * reads. One store per window, so every section drawn in it shares it, as one page does.
 */
const choices = new Map<string, string>();
const choiceListeners = new Set<() => void>();
let choiceSnapshot: PageState = {};

function subscribeChoices(listener: () => void): () => void {
  choiceListeners.add(listener);
  return () => {
    choiceListeners.delete(listener);
  };
}

function changedChoices(): void {
  choiceSnapshot = Object.fromEntries(choices);
  for (const listener of choiceListeners) listener();
}

/** Set a page choice, as pressing one of its options does. */
export function choose(key: string, value: string): void {
  if (choices.get(key) === value) return;
  choices.set(key, value);
  changedChoices();
}

/** The page's choices now: `{ squad: "men" }`. */
export function currentChoices(): PageState {
  return choiceSnapshot;
}

/** The documents sections are drawn in: the page, and an iframe a host draws into. */
const documents = new Set<Document>();

const withState = (states: string | null, on: boolean): string =>
  [...(states ?? "").split(/\s+/).filter((s) => s && s !== "active" && s !== "inactive"), on ? "active" : "inactive"].join(" ");

/** Each drawn option says whether it is the chosen one: its `active` or `inactive` look. */
function paintOptions(doc: Document): void {
  for (const el of doc.querySelectorAll<HTMLElement>("[data-fos-select]")) {
    const value = choices.get(el.dataset.fosSelect ?? "");
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
  for (const el of doc.querySelectorAll<HTMLInputElement>("[data-fos-root] [data-fos-field]")) {
    const value = choices.get(el.dataset.fosField ?? "");
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
    let started = false;
    for (const [key, value] of Object.entries(initial)) {
      if (choices.has(key)) continue;
      choices.set(key, value);
      started = true;
    }
    if (started) changedChoices();
    else {
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
    () => holds(choiceSnapshot),
    () => holds({}),
  );
  return shown ? <>{children}</> : null;
}
