import { describe, expect, it } from "vitest";
import { pageId, type Sitemap, type SitePageNode, toSiteResult, toSiteTree } from "../src/index.ts";

const sitemap: Sitemap = {
  pages: [
    { name: "News", slug: "news", children: [{ name: "News Detail", dynamic: true }] },
    { name: "Club", slug: "club", children: [{ name: "History", slug: "history" }] },
    { name: "404", slug: "404" },
  ],
  navigation: [
    { name: "Home", url: "/" },
    { name: "News", url: "/news", children: [{ name: "History", url: "/club/history" }] },
  ],
};

const ids = (nodes: SitePageNode[]): string[] => nodes.flatMap((n) => [n.id, ...ids(n.children)]);

describe("toSiteTree", () => {
  it("hangs every page off one Home root, each with its own segment", () => {
    const [home] = toSiteTree(sitemap.pages, "run-1");
    expect(home?.url).toBe("");
    expect(home?.children.map((c) => [c.name, c.url])).toEqual([
      ["News", "news"],
      ["Club", "club"],
      ["404", "404"],
    ]);
    expect(home?.children[0]?.children[0]?.url).toBe("$*");
    expect(home?.children[1]?.children[0]?.url).toBe("history");
  });

  it("gives each page a uuid, the same for the same run and different for another", () => {
    const first = ids(toSiteTree(sitemap.pages, "run-1"));
    expect(new Set(first).size).toBe(first.length);
    for (const id of first) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(ids(toSiteTree(sitemap.pages, "run-1"))).toEqual(first);
    expect(ids(toSiteTree(sitemap.pages, "run-2"))).not.toContain(first[1]);
    expect(pageId("run-1", "/news")).toBe(first[1]);
  });

  it("uses a listed home entry as the root rather than nesting a second home", () => {
    const [home, ...rest] = toSiteTree(
      [{ name: "Start", slug: "", children: [{ name: "News", slug: "news" }] }],
      "run-1",
    );
    expect(rest).toEqual([]);
    expect(home).toMatchObject({ name: "Start", url: "" });
    expect(home?.children.map((c) => c.url)).toEqual(["news"]);
  });
});

describe("toSiteResult", () => {
  it("carries the menu as the backend's Header navigation", () => {
    const { navigation } = toSiteResult(sitemap, "run-1");
    expect(navigation.name).toBe("Header");
    expect(navigation.nodes[1]?.children[0]).toMatchObject({
      url: "/club/history",
      is_external: false,
    });
  });
});
