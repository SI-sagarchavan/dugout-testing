"use client";

/**
 * `@fanos/renderer/client` — the renderer's only client components.
 *
 * Everything else is a Server Component. A carousel needs the browser for one thing: starting
 * Swiper once the server's markup is on the page. So this draws the same markup the server
 * would, and mounts Swiper after hydration. In a host without React on the client (the
 * screenshot harness, a static export) it is plain markup and the first paint is the design.
 *
 * Its own entry, built with the directive intact, so Next.js sees the boundary: the server
 * components import it by package name, never by path.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
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
