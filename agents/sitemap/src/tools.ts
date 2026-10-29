import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@dugout/contracts";
import { z } from "zod";
import { describeCatalog } from "./catalog.ts";
import {
  type NavItem,
  type Sitemap,
  SitemapSchema,
  SitemapShape,
  sitemapIssues,
} from "./validation.ts";

/** A menu item in the backend's navigation format (`wnm-fanxp-backend` `NavigationNode`). */
export interface NavigationNode {
  name: string;
  icon_url: string;
  route_name: string;
  url: string;
  open_in_new_tab: boolean;
  is_external: boolean;
  is_webview: boolean;
  children: NavigationNode[];
}

/** The agent writes name, url and children; the rest is fixed for an internal page link. */
export function toNavigationNodes(items: NavItem[]): NavigationNode[] {
  return items.map((item) => ({
    name: item.name,
    icon_url: "",
    route_name: "",
    url: item.url,
    open_in_new_tab: false,
    is_external: false,
    is_webview: false,
    children: toNavigationNodes(item.children ?? []),
  }));
}

export const HEADER_NAVIGATION_NAME = "Header";

/**
 * Writes one tenant's sitemap files. `pages.json` is what the admin app's AI import takes as it is;
 * `meta.json` goes last, so a half-written save is never taken for a finished one.
 */
export async function writeSitemap(
  dir: string,
  sitemap: Sitemap,
  runId: string,
): Promise<{ unchanged: boolean }> {
  const hash = createHash("sha256").update(JSON.stringify(sitemap)).digest("hex").slice(0, 12);
  const existing = await readFile(join(dir, "meta.json"), "utf8")
    .then((s) => JSON.parse(s) as { hash: string })
    .catch(() => undefined);
  if (existing?.hash === hash) return { unchanged: true };

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pages.json"), JSON.stringify({ pages: sitemap.pages }, null, 2));
  await writeFile(
    join(dir, "navigation.json"),
    JSON.stringify(
      { name: HEADER_NAVIGATION_NAME, nodes: toNavigationNodes(sitemap.navigation) },
      null,
      2,
    ),
  );
  await writeFile(join(dir, "meta.json"), JSON.stringify({ hash, runId }, null, 2));
  return { unchanged: false };
}

export function createSitemapTools(opts: { sitemapsDir: string }) {
  const pagesCatalog = defineTool({
    name: "pages.catalog",
    description:
      "The standard pages a club site can have: name, url slug, whether it needs a sport, and the dynamic child page it takes.",
    input: z.object({}),
    effect: "read",
    timeoutMs: 5_000,
    async run() {
      return { pages: describeCatalog() };
    },
  });

  const sitemapValidate = defineTool({
    name: "sitemap.validate",
    description:
      "Check pages and menu against the importer's rules. Returns the problems, or valid: true. Does not save anything.",
    input: SitemapShape,
    effect: "read",
    timeoutMs: 5_000,
    async run(sitemap) {
      const issues = sitemapIssues(sitemap);
      return issues.length ? { valid: false, issues } : { valid: true, issues: [] };
    },
  });

  const sitemapSave = defineTool({
    name: "sitemap.save",
    description:
      "Save the validated pages and menu for an editor to import. Saving the same sitemap twice changes nothing.",
    input: SitemapSchema,
    effect: "write",
    timeoutMs: 5_000,
    retries: 1, // idempotent by content hash
    async run(sitemap, ctx) {
      const { unchanged } = await writeSitemap(
        join(opts.sitemapsDir, ctx.tenantId),
        sitemap,
        ctx.runId,
      );
      return { saved: true, unchanged };
    },
  });

  return [pagesCatalog, sitemapValidate, sitemapSave];
}
