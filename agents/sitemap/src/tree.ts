import { createHash } from "node:crypto";
import { z } from "zod";
import { HEADER_NAVIGATION_NAME, type NavigationNode, toNavigationNodes } from "./tools.ts";
import type { PageNode, Sitemap } from "./validation.ts";

// The run's result: the pages as the backend's sitemap tree (what its sitemap API returns, one
// `Home` root with every page under it) and the header menu as a backend navigation. The model
// never writes this. It writes the compact `Sitemap`, and `toSiteResult` builds the rest, so the
// ids and the fixed fields can't be got wrong.
//
// The fields follow the admin app's onboarding builder
// (wnm-fanxp-frontend: features/client-onboarding/lib/buildSitemapTree.ts).

/** The url segment the sitemap uses for a dynamic page (`/news/$*`). */
export const DYNAMIC_SEGMENT = "$*";
export const HOME_NAME = "Home";

/** One page of the backend's sitemap tree. */
export interface SitePageNode {
  id: string;
  /** This page's own segment, not the full path; `""` for home, `$*` for a dynamic page. */
  url: string;
  name: string;
  plugin: string[];
  children: SitePageNode[];
  /** Not known when the sitemap is designed: onboarding sets it. */
  theme_id: string | null;
  app_title: string;
  published: boolean;
  plugin_config: Record<string, unknown>;
  micro_theme_id: string | null;
  /** Not known when the sitemap is designed: the page's layout is created at import. */
  page_layout_id: string | null;
  breadcrumb_title: string;
  seo_complete: boolean;
}

const sitePageNodeSchema: z.ZodType<SitePageNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    url: z.string(),
    name: z.string(),
    plugin: z.array(z.string()),
    children: z.array(sitePageNodeSchema),
    theme_id: z.string().nullable(),
    app_title: z.string(),
    published: z.boolean(),
    plugin_config: z.record(z.string(), z.unknown()),
    micro_theme_id: z.string().nullable(),
    page_layout_id: z.string().nullable(),
    breadcrumb_title: z.string(),
    seo_complete: z.boolean(),
  }),
);

const navigationNodeSchema: z.ZodType<NavigationNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    icon_url: z.string(),
    route_name: z.string(),
    url: z.string(),
    open_in_new_tab: z.boolean(),
    is_external: z.boolean(),
    is_webview: z.boolean(),
    children: z.array(navigationNodeSchema),
  }),
);

/** What a sitemap run returns to the host. */
export const SiteResultSchema = z.object({
  /** One root, the home page, with every other page under it. */
  pages: z.array(sitePageNodeSchema).length(1),
  navigation: z.object({ name: z.string(), nodes: z.array(navigationNodeSchema) }),
});
export type SiteResult = z.infer<typeof SiteResultSchema>;

/**
 * A uuid made from the run and the page's path, so the same run always gives the same ids: a run
 * resumed after a crash returns the result it would have returned.
 */
export function pageId(runId: string, path: string): string {
  const hex = createHash("sha256").update(`${runId}:${path}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

const node = (id: string, name: string, url: string, children: SitePageNode[]): SitePageNode => ({
  id,
  url,
  name,
  plugin: [],
  children,
  theme_id: null,
  app_title: "",
  published: true,
  plugin_config: {},
  micro_theme_id: null,
  page_layout_id: null,
  breadcrumb_title: "",
  seo_complete: false,
});

/** The pages under one `Home` root. A home entry the model listed is that root (as the importer reads it). */
export function toSiteTree(pages: PageNode[], runId: string): SitePageNode[] {
  const build = (nodes: PageNode[], parentPath: string): SitePageNode[] =>
    nodes.map((page) => {
      const url = page.dynamic ? DYNAMIC_SEGMENT : (page.slug ?? "");
      const path = `${parentPath}/${url}`;
      return node(pageId(runId, path), page.name, url, build(page.children ?? [], path));
    });
  const isHome = (page: PageNode) => !page.dynamic && !page.slug;
  const home = pages.find(isHome);
  const top = pages.flatMap((page) => (isHome(page) ? (page.children ?? []) : [page]));
  return [node(pageId(runId, "/"), home?.name ?? HOME_NAME, "", build(top, ""))];
}

/** The run's result from the sitemap the model saved. */
export function toSiteResult(sitemap: Sitemap, runId: string): SiteResult {
  return {
    pages: toSiteTree(sitemap.pages, runId),
    navigation: { name: HEADER_NAVIGATION_NAME, nodes: toNavigationNodes(sitemap.navigation) },
  };
}
