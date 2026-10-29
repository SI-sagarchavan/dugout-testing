import { describe, expect, it } from "vitest";
import { parseReply, renamePath, type Sitemap } from "../src/index.ts";

const sitemap: Sitemap = {
  pages: [
    { name: "News", slug: "news", children: [{ name: "News Detail", dynamic: true }] },
    { name: "Fan Zone", slug: "fan-zone", children: [{ name: "Quiz", slug: "quiz" }] },
    { name: "About", slug: "about" },
  ],
  navigation: [
    { name: "Home", url: "/" },
    { name: "News", url: "/news" },
    {
      name: "Fan Zone",
      url: "/fan-zone",
      children: [{ name: "Quiz", url: "/fan-zone/quiz" }],
    },
  ],
};

describe("renamePath", () => {
  it("changes the slug and every menu link to the page and the pages under it", () => {
    const result = renamePath(sitemap, "/fan-zone", "/fanzone");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sitemap.pages[1]).toMatchObject({ name: "Fan Zone", slug: "fanzone" });
    expect(result.sitemap.navigation[2]).toMatchObject({
      url: "/fanzone",
      children: [{ url: "/fanzone/quiz" }],
    });
  });

  it("changes a page below the top level", () => {
    const result = renamePath(sitemap, "/fan-zone/quiz", "/fan-zone/quizzes");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sitemap.pages[1]?.children?.[0]?.slug).toBe("quizzes");
    expect(result.sitemap.navigation[2]?.children?.[0]?.url).toBe("/fan-zone/quizzes");
  });

  it("accepts a path without the leading slash, in any case", () => {
    const result = renamePath(sitemap, "about", "About-Us");
    expect(result.ok && result.sitemap.pages[2]?.slug).toBe("about-us");
  });

  it("leaves the original untouched", () => {
    renamePath(sitemap, "/fan-zone", "/fanzone");
    expect(sitemap.pages[1]?.slug).toBe("fan-zone");
  });

  it.each([
    ["a page that is not there", "/shop", "/store", "No page at /shop"],
    ["the home page", "/", "/start", "The home page has no path to change"],
    ["a move to another parent", "/fan-zone/quiz", "/quiz", "To move a page"],
    ["a slug that is already used", "/about", "/news", 'Duplicate slug "news"'],
    ["a slug the importer rejects", "/about", "/About_Us!", "Use lowercase letters"],
    [
      "a standard page slug under another page",
      "/fan-zone/quiz",
      "/fan-zone/news",
      "standard page",
    ],
  ])("refuses %s", (_name, from, to, message) => {
    const result = renamePath(sitemap, from, to);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toContain(message);
  });

  it("refuses a rename that would leave a menu link pointing nowhere", () => {
    // the dynamic page has no url of its own, so it cannot be renamed
    const result = renamePath(sitemap, "/news/$*", "/news/story");
    expect(result.ok).toBe(false);
  });
});

describe("parseReply", () => {
  it.each([
    ["y", { kind: "approve" }],
    ["YES", { kind: "approve" }],
    ["n", { kind: "reject" }],
    ["", { kind: "reject" }],
    ["path /fan-zone /fanzone", { kind: "path", from: "/fan-zone", to: "/fanzone" }],
    ["path /fan-zone to /fanzone", { kind: "path", from: "/fan-zone", to: "/fanzone" }],
    ["change: put Fan Zone under About", { kind: "change", request: "put Fan Zone under About" }],
    ["change rename the menu label", { kind: "change", request: "rename the menu label" }],
    ["maybe", { kind: "unknown" }],
    ["path /only-one", { kind: "unknown" }],
  ])("reads %j", (line, reply) => {
    expect(parseReply(line)).toEqual(reply);
  });
});
