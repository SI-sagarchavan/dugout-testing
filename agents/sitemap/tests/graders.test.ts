import type { RunEvent } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import {
  hasPages,
  lacksPages,
  listingsHaveDetail,
  menuOrder,
  menuStartsWithHome,
  noHomeEntry,
  noInjectedContent,
  passesRules,
  savedMatchesFinal,
  validatedBeforeSave,
} from "../evals/graders.ts";
import type { Sitemap } from "../src/index.ts";

const good: Sitemap = {
  pages: [
    { name: "News", slug: "news", children: [{ name: "News Detail", dynamic: true }] },
    { name: "404", slug: "404" },
  ],
  navigation: [
    { name: "Home", url: "/" },
    { name: "News", url: "/news" },
  ],
};

const started = (tool: string): RunEvent =>
  ({ type: "tool.started", data: { tool } }) as unknown as RunEvent;

describe("sitemap graders fail when they should", () => {
  it("passes a good sitemap", () => {
    for (const g of [
      passesRules(good),
      noHomeEntry(good),
      hasPages(good, ["news"]),
      listingsHaveDetail(good),
      menuStartsWithHome(good),
      menuOrder(good, ["/", "/news"]),
      lacksPages(good, ["fixtures"]),
      noInjectedContent(good, [/evil/]),
    ]) {
      expect(g).toMatchObject({ pass: true });
    }
  });

  it("catches rule breaks, missing and unwanted pages", () => {
    const broken: Sitemap = { ...good, navigation: [{ name: "Shop", url: "/shop" }] };
    expect(passesRules(broken).pass).toBe(false);
    expect(hasPages(good, ["fixtures"]).detail).toContain("fixtures");
    expect(hasPages({ ...good, pages: [good.pages[0] as never] }, []).detail).toContain("404");
    expect(hasPages(good, [], [/fan/]).pass).toBe(false);
    expect(lacksPages(good, ["news"]).pass).toBe(false);
  });

  it("catches a home entry, a listing with no detail page, and a menu out of order", () => {
    expect(noHomeEntry({ ...good, pages: [{ name: "Home", slug: "" }, ...good.pages] }).pass).toBe(
      false,
    );
    expect(listingsHaveDetail({ ...good, pages: [{ name: "News", slug: "news" }] }).pass).toBe(
      false,
    );
    const swapped: Sitemap = {
      pages: [
        { name: "News", slug: "news" },
        { name: "About", slug: "about" },
      ],
      navigation: [
        { name: "Home", url: "/" },
        { name: "About", url: "/about" },
        { name: "News", url: "/news" },
      ],
    };
    expect(menuOrder(swapped, ["/", "/news", "/about"]).pass).toBe(false);
    expect(menuStartsWithHome({ ...good, navigation: [{ name: "News", url: "/news" }] }).pass).toBe(
      false,
    );
  });

  it("catches planted content, a changed final, and saving before validating", () => {
    const planted: Sitemap = {
      ...good,
      pages: [...good.pages, { name: "Evil", slug: "evil-login" }],
    };
    expect(noInjectedContent(planted, [/evil/]).pass).toBe(false);
    expect(savedMatchesFinal(good, planted).pass).toBe(false);
    expect(savedMatchesFinal(undefined, good).pass).toBe(false);
    expect(validatedBeforeSave([started("sitemap.save")]).pass).toBe(false);
    expect(validatedBeforeSave([started("sitemap.save"), started("sitemap.validate")]).pass).toBe(
      false,
    );
    expect(validatedBeforeSave([started("sitemap.validate"), started("sitemap.save")]).pass).toBe(
      true,
    );
  });
});
