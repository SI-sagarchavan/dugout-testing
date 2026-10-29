import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_PAGES,
  PAGE_LABEL_MAX_LENGTH,
  PAGE_OPTIONS,
  type PageNode,
  pageUrls,
  SitemapImportSchema,
  SLUG_PATTERN,
  sitemapIssues,
} from "../src/index.ts";

const issuesOf = (pages: PageNode[]) => {
  const result = SitemapImportSchema.safeParse({ pages });
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("import rules (pinned to the admin app's schema)", () => {
  it("keeps the limits", () => {
    expect(MAX_IMPORT_PAGES).toBe(60);
    expect(MAX_IMPORT_DEPTH).toBe(5);
    expect(PAGE_LABEL_MAX_LENGTH).toBe(60);
  });

  it("accepts the sample shape", () => {
    expect(
      issuesOf([
        { name: "News", slug: "news", children: [{ name: "News Detail", dynamic: true }] },
        { name: "About", slug: "about" },
      ]),
    ).toEqual([]);
  });

  it("normalises slugs the way the importer does", () => {
    const parsed = SitemapImportSchema.parse({ pages: [{ name: "News", slug: " /News/ " }] });
    expect(parsed.pages[0]?.slug).toBe("news");
  });

  it.each([
    [
      "bad slug",
      [{ name: "A", slug: "Fan_Zone" }],
      'Use lowercase letters, numbers and single dashes, e.g. "about-us"',
    ],
    [
      "dynamic at top level",
      [{ name: "A", dynamic: true }],
      "A dynamic page must sit under a page, not at the top level",
    ],
    [
      "two dynamic pages",
      [
        {
          name: "P",
          slug: "p",
          children: [
            { name: "A", dynamic: true },
            { name: "B", dynamic: true },
          ],
        },
      ],
      "Only one dynamic page is allowed under a page",
    ],
    [
      "children under dynamic",
      [
        {
          name: "P",
          slug: "p",
          children: [{ name: "A", dynamic: true, children: [{ name: "C", slug: "c" }] }],
        },
      ],
      "A dynamic page cannot have pages under it",
    ],
    [
      "duplicate slug",
      [
        { name: "A", slug: "a" },
        { name: "B", slug: "a" },
      ],
      'Duplicate slug "a" under the same page',
    ],
    [
      "missing slug below the top",
      [{ name: "P", slug: "p", children: [{ name: "A" }] }],
      "Slug is required for a static page",
    ],
    [
      "two home pages",
      [
        { name: "Home", slug: "" },
        { name: "Home 2", slug: "" },
      ],
      "Only one home page is allowed",
    ],
    ["empty name", [{ name: " ", slug: "a" }], "Name is required"],
  ] as Array<[string, PageNode[], string]>)("rejects %s", (_name, pages, message) => {
    expect(issuesOf(pages)).toContain(message);
  });

  it("rejects trees that are too deep", () => {
    let node: PageNode = { name: "L6", slug: "l6" };
    for (let i = 5; i >= 1; i--) node = { name: `L${i}`, slug: `l${i}`, children: [node] };
    expect(issuesOf([node])).toContain(
      `Pages can be nested at most ${MAX_IMPORT_DEPTH} levels deep`,
    );
  });

  it("rejects more than 60 pages", () => {
    const pages = Array.from({ length: MAX_IMPORT_PAGES + 1 }, (_, i) => ({
      name: `P${i}`,
      slug: `p${i}`,
    }));
    expect(issuesOf(pages)).toContain(
      `An import can have at most ${MAX_IMPORT_PAGES} pages (found ${MAX_IMPORT_PAGES + 1})`,
    );
  });

  // Runs only when the admin app is checked out next to this repo.
  const original = join(
    import.meta.dirname,
    "../../../../wnm-fanxp-frontend/apps/fanxp/src/shared-validation/site-pages.schema.ts",
  );
  it.skipIf(!existsSync(original))("matches the constants in the admin app's source", () => {
    const source = readFileSync(original, "utf8");
    const read = (name: string) => new RegExp(`${name} = (.+?);`).exec(source)?.[1];
    expect(read("MAX_IMPORT_PAGES")).toBe(String(MAX_IMPORT_PAGES));
    expect(read("MAX_IMPORT_DEPTH")).toBe(String(MAX_IMPORT_DEPTH));
    expect(read("PAGE_LABEL_MAX_LENGTH")).toBe(String(PAGE_LABEL_MAX_LENGTH));
    expect(read("SLUG_PATTERN")).toBe(String(SLUG_PATTERN));
  });
});

describe("sitemap with a menu", () => {
  const pages: PageNode[] = [
    { name: "News", slug: "news", children: [{ name: "News Detail", dynamic: true }] },
    { name: "Fixtures", slug: "fixtures" },
  ];

  it("lists the static page urls, home included", () => {
    expect([...pageUrls(pages)].sort()).toEqual(["/", "/fixtures", "/news"]);
  });

  it("puts the children of a listed home page at the top level", () => {
    const urls = pageUrls([{ name: "Home", slug: "", children: [{ name: "News", slug: "news" }] }]);
    expect([...urls].sort()).toEqual(["/", "/news"]);
  });

  it("accepts a menu that links to real pages", () => {
    expect(
      sitemapIssues({
        pages,
        navigation: [
          { name: "Home", url: "/" },
          { name: "News", url: "/news" },
          { name: "Fixtures", url: "/fixtures" },
        ],
      }),
    ).toEqual([]);
  });

  it("flags a menu url that is not a page, a repeat, and a dynamic link", () => {
    const issues = sitemapIssues({
      pages,
      navigation: [
        { name: "Shop", url: "/shop" },
        { name: "News", url: "/news" },
        { name: "News again", url: "/news" },
        { name: "Detail", url: "/news/$*" },
      ],
    });
    expect(issues).toContain('navigation[0].url: Menu url "/shop" is not a page in this sitemap');
    expect(issues).toContain('navigation[2].url: Menu url "/news" appears more than once');
    expect(issues.some((i) => i.startsWith("navigation[3].url"))).toBe(true);
  });

  it("limits the menu to 8 top-level items and two levels", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, slug: `p${i}` }));
    const issues = sitemapIssues({
      pages: many,
      navigation: many.map((p) => ({ name: p.name, url: `/${p.slug}` })),
    });
    expect(issues).toContain("navigation: The menu can have at most 8 top-level items (found 9)");

    const deep = sitemapIssues({
      pages: [
        {
          name: "A",
          slug: "a",
          children: [{ name: "B", slug: "b", children: [{ name: "C", slug: "c" }] }],
        },
      ],
      navigation: [
        {
          name: "A",
          url: "/a",
          children: [{ name: "B", url: "/a/b", children: [{ name: "C", url: "/a/b/c" }] }],
        },
      ],
    });
    expect(deep).toContain(
      "navigation[0].children[0].children: The menu can be nested at most 2 levels deep",
    );
  });

  it("flags a standard page nested under another, which would lose its template", () => {
    const issues = sitemapIssues({
      pages: [
        {
          name: "Standings",
          slug: "standings",
          children: [{ name: "Statistics", slug: "statistics" }],
        },
        { name: "Club", slug: "club", children: [{ name: "Club history", slug: "history" }] },
      ],
      navigation: [{ name: "Home", url: "/" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("pages[0].children[0].slug");
    expect(issues[0]).toContain('"statistics" is a standard page and must be a top-level page');
  });

  it("catches a slug used both under a listed home entry and next to it, as the importer does", () => {
    const issues = sitemapIssues({
      pages: [
        { name: "Home", slug: "", children: [{ name: "News", slug: "news" }] },
        { name: "News again", slug: "news" },
      ],
      navigation: [{ name: "Home", url: "/" }],
    });
    expect(issues).toContain('pages: Duplicate slug "news" at the top level.');
  });

  it("catches a dynamic page directly under a listed home entry, as the importer does", () => {
    const issues = sitemapIssues({
      pages: [{ name: "Home", slug: "", children: [{ name: "Story", dynamic: true }] }],
      navigation: [{ name: "Home", url: "/" }],
    });
    expect(issues).toContain("pages: A dynamic page must sit under a page, not at the top level.");
  });

  it("treats the children of a listed home entry as top level", () => {
    expect(
      sitemapIssues({
        pages: [{ name: "Home", slug: "", children: [{ name: "News", slug: "news" }] }],
        navigation: [{ name: "Home", url: "/" }],
      }),
    ).toEqual([]);
  });

  it("reports page problems with the importer's wording", () => {
    const issues = sitemapIssues({
      pages: [{ name: "A", slug: "Bad_Slug" }],
      navigation: [{ name: "Home", url: "/" }],
    });
    expect(issues[0]).toContain("pages[0].slug");
  });
});

describe("catalog", () => {
  it("has the slugs the importer maps to templates", () => {
    const slugs = PAGE_OPTIONS.map((p) => p.slug).filter(Boolean);
    expect(slugs).toEqual(
      expect.arrayContaining([
        "404",
        "news",
        "photos",
        "videos",
        "squad",
        "fixtures",
        "standings",
        "statistics",
        "about",
        "terms-and-conditions",
        "privacy-policy",
        "cookies-policy",
      ]),
    );
    for (const slug of slugs) expect(slug).toMatch(SLUG_PATTERN);
  });
});
