import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Sitemap, writeSitemap } from "../src/index.ts";

const a: Sitemap = {
  pages: [{ name: "News", slug: "news" }],
  navigation: [{ name: "News", url: "/news" }],
};
const b: Sitemap = {
  pages: [{ name: "Fixtures", slug: "fixtures" }],
  navigation: [{ name: "Fixtures", url: "/fixtures" }],
};

describe("writeSitemap", () => {
  it("reports unchanged only when the files already hold this sitemap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitemap-"));
    expect(await writeSitemap(dir, a, "run-1")).toEqual({ unchanged: false });
    expect(await writeSitemap(dir, a, "run-2")).toEqual({ unchanged: true });
    expect(JSON.parse(await readFile(join(dir, "meta.json"), "utf8")).runId).toBe("run-1");
  });

  it("rewrites the files when a save died after pages.json but before meta.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitemap-"));
    await writeSitemap(dir, a, "run-1");
    // save B got as far as pages.json; meta.json still describes A
    await writeFile(join(dir, "pages.json"), JSON.stringify({ pages: b.pages }, null, 2));
    expect(await writeSitemap(dir, a, "run-3")).toEqual({ unchanged: false });
    expect(JSON.parse(await readFile(join(dir, "pages.json"), "utf8"))).toEqual({ pages: a.pages });
  });
});
