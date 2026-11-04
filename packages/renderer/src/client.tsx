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

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  clockTick,
  clockValues,
  evaluateCondition,
  resolveTemplate,
  type ClockUnit,
  type Condition,
} from "@fanos/dsl/runtime";
import type { CarouselSpec } from "./carousel/shared.js";

export interface CarouselRootProps {
  spec: CarouselSpec;
  className: string;
  style: CSSProperties;
  dataAttrs: Record<string, string>;
  /** The slides, each already a `.swiper-slide`. */
  children: ReactNode;
}

export function CarouselRoot({ spec, className, style, dataAttrs, children }: CarouselRootProps) {
  const ref = useRef<HTMLDivElement>(null);
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
}

/** The characters of a Text that reads a clock. Its look is the Text's, drawn by the server. */
export function ClockText({ parts, clocks, now: initial, timeZone }: ClockTextProps) {
  const now = useNow(initial, clocks);
  const scope = scopeAt(clocks, now);
  return (
    <>
      {parts
        .map((part) =>
          typeof part === "string" ? part : resolveTemplate(part.ref, scope, timeZone ? { timeZone } : {}).value,
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
