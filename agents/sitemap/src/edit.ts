import { type NavItem, type PageNode, type Sitemap, sitemapIssues } from "./validation.ts";

export type EditResult = { ok: true; sitemap: Sitemap } | { ok: false; issues: string[] };

const cleanPath = (path: string) => {
  const trimmed = path.trim().replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** The static page at `url`, found the way the importer reads the tree (home's children are top level). */
function findPage(pages: PageNode[], url: string): PageNode | undefined {
  const walk = (nodes: PageNode[], prefix: string, depth: number): PageNode | undefined => {
    for (const node of nodes) {
      if (node.dynamic) continue;
      const isHome = depth === 1 && !node.slug;
      const nodeUrl = isHome ? "/" : `${prefix}/${node.slug}`;
      if (nodeUrl === url) return node;
      const found = node.children?.length
        ? walk(node.children, isHome ? "" : nodeUrl, depth + 1)
        : undefined;
      if (found) return found;
    }
    return undefined;
  };
  return walk(pages, "", 1);
}

const moveMenuUrls = (items: NavItem[], from: string, to: string): NavItem[] =>
  items.map((item) => ({
    ...item,
    url:
      item.url === from
        ? to
        : item.url.startsWith(`${from}/`)
          ? `${to}${item.url.slice(from.length)}`
          : item.url,
    ...(item.children ? { children: moveMenuUrls(item.children, from, to) } : {}),
  }));

/**
 * Changes the url of one page, keeping it under the same parent, and moves every menu link to it
 * (and to the pages under it). The result is checked with the same rules as the agent's output, so
 * a rename that breaks one is refused with the reasons.
 */
export function renamePath(sitemap: Sitemap, fromPath: string, toPath: string): EditResult {
  const from = cleanPath(fromPath);
  const to = cleanPath(toPath).toLowerCase();
  if (from === "/") return { ok: false, issues: ["The home page has no path to change"] };
  if (parentOf(from) !== parentOf(to)) {
    return {
      ok: false,
      issues: [
        `A path change keeps the page under ${parentOf(from)}. To move a page, ask for it with "change: ..."`,
      ],
    };
  }

  const next = structuredClone(sitemap);
  const page = findPage(next.pages, from);
  if (!page) return { ok: false, issues: [`No page at ${from}`] };
  page.slug = to.slice(to.lastIndexOf("/") + 1);
  next.navigation = moveMenuUrls(next.navigation, from, to);

  const issues = sitemapIssues(next);
  return issues.length ? { ok: false, issues } : { ok: true, sitemap: next };
}

export type Reply =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "path"; from: string; to: string }
  | { kind: "change"; request: string }
  | { kind: "unknown" };

/** What the editor typed at the approval prompt. An empty line is a no, as in `[y/N]`. */
export function parseReply(line: string): Reply {
  const text = line.trim();
  if (/^(y|yes)$/i.test(text)) return { kind: "approve" };
  if (/^(n|no)?$/i.test(text)) return { kind: "reject" };
  const path = /^path\s+(\S+)\s+(?:to\s+)?(\S+)$/i.exec(text);
  if (path?.[1] && path[2]) return { kind: "path", from: path[1], to: path[2] };
  const change = /^change:?\s+(.+)$/i.exec(text);
  if (change?.[1]) return { kind: "change", request: change[1].trim() };
  return { kind: "unknown" };
}

/** Marks a rejection that only asks for a change, so it is not remembered as a rejected draft. */
export const EDIT_REQUEST_PREFIX = "edit requested: ";
