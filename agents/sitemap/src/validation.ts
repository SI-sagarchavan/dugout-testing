import { z } from "zod";
import { KNOWN_SLUGS, PAGE_DETAILS, PAGE_OPTIONS } from "./catalog.ts";

// The page rules are a port of the admin app's import validation
// (wnm-fanxp-frontend: apps/fanxp/src/shared-validation/site-pages.schema.ts). The agent's output
// must pass the same rules the importer applies, so keep them identical; tests/validation.test.ts
// pins the constants and the error messages.

export const PAGE_LABEL_MAX_LENGTH = 60;
/** Most pages one import may create; each one becomes a layout per platform. */
export const MAX_IMPORT_PAGES = 60;
/** Deepest nesting an import may have (home > section > page > ...). */
export const MAX_IMPORT_DEPTH = 5;
/** `news`, `terms-and-conditions`: lowercase words joined by single dashes. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The header menu rules are ours: the admin app has no limits for navigation.
export const MAX_NAV_ITEMS = 8;
/** A top-level item and one row of items under it. */
export const MAX_NAV_DEPTH = 2;

const labelSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(PAGE_LABEL_MAX_LENGTH, `Name must be at most ${PAGE_LABEL_MAX_LENGTH} characters`);

const slugSchema = z
  .string()
  .trim()
  .regex(SLUG_PATTERN, 'Use lowercase letters, numbers and single dashes, e.g. "about-us"');

/** One page in an import file. `children` nest it, `dynamic` marks a `/$*` detail page. */
export interface PageNode {
  name: string;
  slug?: string | undefined;
  dynamic?: boolean | undefined;
  children?: PageNode[] | undefined;
}

const pageNodeSchema: z.ZodType<PageNode> = z.lazy(() =>
  z.object({
    name: labelSchema,
    slug: z
      .string()
      .transform((value) =>
        value
          .trim()
          .replace(/(?:^\/+)|(?:\/+$)/g, "")
          .toLowerCase(),
      )
      .pipe(z.union([z.literal(""), slugSchema]))
      .optional()
      .describe(
        'One url segment: lowercase letters, numbers and single dashes, e.g. "fan-zone". Omit for a dynamic page.',
      ),
    dynamic: z
      .boolean()
      .optional()
      .describe("True for one template that renders many items. No slug, no children."),
    children: z.array(pageNodeSchema).optional(),
  }),
);

type Path = (string | number)[];

interface WalkContext {
  ctx: z.RefinementCtx;
  count: number;
}

const checkSiblings = (nodes: PageNode[], path: Path, depth: number, walk: WalkContext) => {
  const seen = new Set<string>();
  let dynamicCount = 0;
  nodes.forEach((node, index) => {
    const nodePath = [...path, index];
    walk.count += 1;
    if (node.dynamic) {
      dynamicCount += 1;
      if (depth === 1) {
        walk.ctx.addIssue({
          code: "custom",
          path: nodePath,
          message: "A dynamic page must sit under a page, not at the top level",
        });
      }
      if (dynamicCount > 1) {
        walk.ctx.addIssue({
          code: "custom",
          path: nodePath,
          message: "Only one dynamic page is allowed under a page",
        });
      }
      if (node.children?.length) {
        walk.ctx.addIssue({
          code: "custom",
          path: [...nodePath, "children"],
          message: "A dynamic page cannot have pages under it",
        });
      }
      return;
    }
    // An empty slug is the home page: allowed once, at the top level only.
    if (!node.slug && (depth > 1 || seen.has(""))) {
      walk.ctx.addIssue({
        code: "custom",
        path: [...nodePath, "slug"],
        message: depth > 1 ? "Slug is required for a static page" : "Only one home page is allowed",
      });
    } else if (node.slug && seen.has(node.slug)) {
      walk.ctx.addIssue({
        code: "custom",
        path: [...nodePath, "slug"],
        message: `Duplicate slug "${node.slug}" under the same page`,
      });
    }
    seen.add(node.slug ?? "");
  });
};

const walkTree = (nodes: PageNode[], path: Path, depth: number, walk: WalkContext) => {
  if (depth > MAX_IMPORT_DEPTH) {
    walk.ctx.addIssue({
      code: "custom",
      path,
      message: `Pages can be nested at most ${MAX_IMPORT_DEPTH} levels deep`,
    });
    return;
  }
  checkSiblings(nodes, path, depth, walk);
  nodes.forEach((node, index) => {
    if (node.children?.length && !node.dynamic) {
      walkTree(node.children, [...path, index, "children"], depth + 1, walk);
    }
  });
};

/** The admin app's import file: `{ "pages": [ ... ] }`. A home entry (empty slug) is optional. */
export const SitemapImportSchema = z
  .object({
    pages: z.array(pageNodeSchema).min(1, "Add at least one page"),
  })
  .superRefine(({ pages }, ctx) => {
    const walk: WalkContext = { ctx, count: 0 };
    walkTree(pages, ["pages"], 1, walk);
    if (walk.count > MAX_IMPORT_PAGES) {
      ctx.addIssue({
        code: "custom",
        path: ["pages"],
        message: `An import can have at most ${MAX_IMPORT_PAGES} pages (found ${walk.count})`,
      });
    }
  });
export type SitemapImport = z.infer<typeof SitemapImportSchema>;

/** One header menu item. `url` is the path of a static page, e.g. `/fixtures`; home is `/`. */
export interface NavItem {
  name: string;
  url: string;
  children?: NavItem[] | undefined;
}

const navItemSchema: z.ZodType<NavItem> = z.lazy(() =>
  z.object({
    name: labelSchema,
    url: z
      .string()
      .trim()
      .regex(/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$/, {
        message: 'A menu url is a path such as "/" or "/fixtures"',
      }),
    children: z.array(navItemSchema).optional(),
  }),
);

/** The shape only. The tools take this so a bad tree gets a rule-by-rule answer, not a parse error. */
export const SitemapShape = z.object({
  pages: z.array(pageNodeSchema).min(1, "Add at least one page"),
  navigation: z.array(navItemSchema).min(1, "Add at least one menu item"),
});

/**
 * Paths of the static pages in a tree. The home page is `/` whether or not the tree lists it, and
 * a listed home entry's children sit at the top level (the importer treats it as the root).
 */
export function pageUrls(pages: PageNode[]): Set<string> {
  const urls = new Set<string>(["/"]);
  const walk = (nodes: PageNode[], prefix: string, depth: number) => {
    for (const node of nodes) {
      if (node.dynamic) continue;
      const isHome = depth === 1 && !node.slug;
      const url = isHome ? "/" : `${prefix}/${node.slug}`;
      urls.add(url);
      if (node.children?.length) walk(node.children, isHome ? "" : url, depth + 1);
    }
  };
  walk(pages, "", 1);
  return urls;
}

/**
 * The importer only maps a standard slug to its ready-made template at the top level (a listed home
 * entry's children count as top level). Nested, the page silently becomes a custom page.
 */
const checkStandardSlugs = (
  nodes: PageNode[],
  path: Path,
  topLevel: boolean,
  ctx: z.RefinementCtx,
) => {
  nodes.forEach((node, index) => {
    const nodePath = [...path, index];
    if (node.dynamic) return;
    if (!topLevel && node.slug && KNOWN_SLUGS.includes(node.slug)) {
      ctx.addIssue({
        code: "custom",
        path: [...nodePath, "slug"],
        message: `"${node.slug}" is a standard page and must be a top-level page, or it loses its ready-made template. Move it to the top level, or give a custom page a different slug`,
      });
    }
    if (node.children?.length) {
      checkStandardSlugs(node.children, [...nodePath, "children"], topLevel && !node.slug, ctx);
    }
  });
};

/**
 * The importer reads a listed home entry's children as top-level pages and then checks that level
 * again (`parseSitemapImport`): no dynamic page there and no slug twice. The sibling rules above
 * can't see across a home entry's children and the pages next to it, so the same checks run here.
 */
const checkImportedTopLevel = (pages: PageNode[], ctx: z.RefinementCtx) => {
  const isHome = (node: PageNode) => !node.dynamic && !node.slug;
  if (!pages.some((node) => isHome(node) && node.children?.length)) return;
  const top = pages.flatMap((node) => (isHome(node) ? (node.children ?? []) : [node]));
  if (top.some((node) => node.dynamic)) {
    ctx.addIssue({
      code: "custom",
      path: ["pages"],
      message: "A dynamic page must sit under a page, not at the top level.",
    });
  }
  const slugs = top.map((node) => node.slug);
  const duplicate = slugs.find((slug, index) => slugs.indexOf(slug) !== index);
  if (duplicate !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["pages"],
      message: `Duplicate slug "${duplicate}" at the top level.`,
    });
  }
};

/** Catalog slug of each listing -> the name of the dynamic detail page it takes (`news` -> News Detail). */
const DETAIL_OF = new Map(
  PAGE_DETAILS.flatMap((detail) => {
    const listing = PAGE_OPTIONS.find((p) => p.id === detail.parentId);
    return listing?.slug ? [[listing.slug, detail.label] as const] : [];
  }),
);

/**
 * Ours, not the importer's: a standard listing at the top level has its dynamic detail page, or
 * every article, player or match it lists has no page to open.
 */
const checkListingDetails = (pages: PageNode[], ctx: z.RefinementCtx) => {
  const check = (nodes: PageNode[], path: Path) =>
    nodes.forEach((node, index) => {
      const nodePath = [...path, index];
      if (node.dynamic) return;
      if (!node.slug) {
        // a listed home entry: its children are the top level
        if (node.children?.length) check(node.children, [...nodePath, "children"]);
        return;
      }
      const detail = DETAIL_OF.get(node.slug);
      if (detail && !node.children?.some((child) => child.dynamic)) {
        ctx.addIssue({
          code: "custom",
          path: [...nodePath, "children"],
          message: `"${node.slug}" lists items, so it needs its detail page under it: { "name": "${detail}", "dynamic": true }`,
        });
      }
    });
  check(pages, ["pages"]);
};

/** The whole agent result: the pages to import and the header menu that links to them. */
export const SitemapSchema = SitemapShape.superRefine(({ pages, navigation }, ctx) => {
  const imported = SitemapImportSchema.safeParse({ pages });
  if (!imported.success) {
    for (const issue of imported.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  }
  checkImportedTopLevel(pages, ctx);
  checkStandardSlugs(pages, ["pages"], true, ctx);
  checkListingDetails(pages, ctx);

  const urls = pageUrls(pages);
  const seen = new Set<string>();
  const walk = (items: NavItem[], path: Path, depth: number) => {
    if (depth === 1 && items.length > MAX_NAV_ITEMS) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `The menu can have at most ${MAX_NAV_ITEMS} top-level items (found ${items.length})`,
      });
    }
    items.forEach((item, index) => {
      const itemPath = [...path, index];
      if (!urls.has(item.url)) {
        ctx.addIssue({
          code: "custom",
          path: [...itemPath, "url"],
          message: `Menu url "${item.url}" is not a page in this sitemap`,
        });
      } else if (seen.has(item.url)) {
        ctx.addIssue({
          code: "custom",
          path: [...itemPath, "url"],
          message: `Menu url "${item.url}" appears more than once`,
        });
      }
      seen.add(item.url);
      if (!item.children?.length) return;
      if (depth >= MAX_NAV_DEPTH) {
        ctx.addIssue({
          code: "custom",
          path: [...itemPath, "children"],
          message: `The menu can be nested at most ${MAX_NAV_DEPTH} levels deep`,
        });
        return;
      }
      walk(item.children, [...itemPath, "children"], depth + 1);
    });
  };
  walk(navigation, ["navigation"], 1);
});
export type Sitemap = z.infer<typeof SitemapSchema>;

/** Plain-text issues, one per line, as the validate tool and the loop report them. */
export function sitemapIssues(input: z.infer<typeof SitemapShape>): string[] {
  const result = SitemapSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) => {
    const path = i.path.reduce<string>(
      (text, part) =>
        typeof part === "number" ? `${text}[${part}]` : `${text}${text ? "." : ""}${String(part)}`,
      "",
    );
    return path ? `${path}: ${i.message}` : i.message;
  });
}
