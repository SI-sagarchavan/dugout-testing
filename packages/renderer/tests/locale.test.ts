import { describe, expect, it } from "vitest";
import type { FlatTree } from "@fanos/dsl";

/** One Text drawing a date-only value and an instant, as a feed sends them. */
const tree: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
    { id: "d", parent: "root", idx: 0, type: "Text", src: "1:2", props: { content: '{m.day | date:"DD MMMM"}' } },
    { id: "t", parent: "root", idx: 1, type: "Text", src: "1:3", props: { content: '{m.kickoff | date:"HH:mm"}' } },
  ],
} as never;
const data = { m: { day: "7/22/2026", kickoff: "2026-07-22T13:45:00Z" } };

async function html(config: Record<string, unknown> = {}): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Render } = await import("../src/components/Render.js");
  return renderToStaticMarkup(createElement(Render, { tree, data, ...config } as never));
}

describe("dates and times are the page's, not the machine's", () => {
  it("draws a date-only value as that day and an instant in the zone the render names", async () => {
    const out = await html({ timeZone: "Europe/London" });
    expect(out).toContain("22 July");
    expect(out).toContain("14:45");
    expect(await html({ timeZone: "Asia/Kolkata" })).toContain("19:15");
  });

  it("reads an ambiguous date in the order the render names", async () => {
    const swap = { ...data, m: { ...data.m, day: "07/08/2026" } };
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Render } = await import("../src/components/Render.js");
    const draw = (dateOrder?: string) =>
      renderToStaticMarkup(createElement(Render, { tree, data: swap, ...(dateOrder ? { dateOrder } : {}) } as never));
    expect(draw()).toContain("08 July");
    expect(draw("dmy")).toContain("07 August");
  });
});

describe("the machine's zone is not an input", () => {
  it("draws the same text in processes of three zones", async () => {
    // a tide table and a fixture list: a day, a time with no zone, an instant, and a countdown's label
    const zoned: FlatTree = {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
        { id: "rep", parent: "root", idx: 0, type: "Repeater", src: "1:2", props: { over: "rows", as: "r" } },
        { id: "a", parent: "rep", idx: 0, type: "Text", src: "1:3", props: { content: '{r.v | date:"DDD DD MMM YYYY HH:mm"}' } },
        {
          id: "c",
          parent: "root",
          idx: 1,
          type: "Text",
          src: "1:4",
          props: { clock: { to: "{next.at}", as: "cd", units: ["d", "h"] }, content: '{cd.d}d {cd.h}h to {next.day | date:"DD MMM"}' },
        },
      ],
    } as never;
    const rows = ["7/22/2026", "Wed, 22 Jul 2026", "7/22/26", "2026-07-22 13:45", "7/22/2026 1:45 PM", "2026-07-22T13:45:00Z", "Sept 22, 2026"];
    const props = {
      tree: zoned,
      data: { rows: rows.map((v) => ({ v })), next: { at: "2026-07-23 18:00", day: "07/08/2026" } },
      timeZone: "Europe/London",
      dateOrder: "dmy",
      now: Date.UTC(2026, 6, 22, 12),
    };
    const { build } = await import("esbuild");
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const bundle = await build({
      stdin: {
        contents: `
          import { createElement } from "react";
          import { renderToStaticMarkup } from "react-dom/server";
          import { Render } from "./src/components/Render.tsx";
          console.log(renderToStaticMarkup(createElement(Render, ${JSON.stringify(props)})));`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      jsx: "automatic",
      alias: { "@fanos/renderer/client": "./src/client.tsx" },
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      logLevel: "error",
    });
    const file = join(mkdtempSync(join(tmpdir(), "fos-zone-")), "render.mjs");
    writeFileSync(file, bundle.outputFiles[0]!.text);
    const run = (tz: string) => execFileSync(process.execPath, [file], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    const [utc, ...others] = ["UTC", "Asia/Kolkata", "America/Los_Angeles"].map(run);
    for (const other of others) expect(other).toBe(utc);
    for (const day of ["Wed 22 Jul 2026 00:00", "Wed 22 Jul 2026 13:45", "Wed 22 Jul 2026 14:45", "Tue 22 Sep 2026 00:00"]) {
      expect(utc).toContain(day);
    }
    // the clock counts to 18:00 London (17:00Z) from 12:00Z, and its Text keeps the day-first order
    expect(utc).toContain("1d 5h to 07 Aug");
  }, 60_000);
});
