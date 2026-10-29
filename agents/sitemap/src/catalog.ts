// The pages a new client can start with, ported from the admin app's onboarding catalog
// (wnm-fanxp-frontend: features/client-onboarding/lib/pageCatalog.ts). Slugs matching these map to
// ready-made templates, so the agent should use them exactly.

export type PageGroup = "general" | "content" | "sports" | "legal";

export interface PageOption {
  id: string;
  label: string;
  group: PageGroup;
  /** Static url segment. Empty for the home page and for detail pages. */
  slug: string;
  /** Only offered when at least one sport is known. */
  needsSport?: boolean;
  /** Always created by onboarding, so the agent leaves it out of the pages. */
  required?: boolean;
  /** The url is fixed. */
  slugLocked?: boolean;
}

export interface PageDetail {
  /** id of the page option the dynamic child is generated for. */
  id: string;
  label: string;
  /** Page option whose static node is the parent. */
  parentId: string;
}

export const PAGE_OPTIONS: readonly PageOption[] = [
  { id: "home", label: "Home page", group: "general", slug: "", required: true },
  { id: "not-found", label: "404 Page", group: "general", slug: "404", slugLocked: true },
  { id: "news-listing", label: "News Listing", group: "content", slug: "news" },
  { id: "photos-listing", label: "Photos Listing", group: "content", slug: "photos" },
  { id: "videos-listing", label: "Videos Listing", group: "content", slug: "videos" },
  { id: "news-detail", label: "News Detail", group: "content", slug: "" },
  { id: "videos-detail", label: "Videos Detail", group: "content", slug: "" },
  { id: "photo-details", label: "Photo Details", group: "content", slug: "" },
  { id: "squad", label: "Squad", group: "sports", slug: "squad", needsSport: true },
  {
    id: "squad-detail",
    label: "Squad Detail (player profile)",
    group: "sports",
    slug: "",
    needsSport: true,
  },
  { id: "fixtures", label: "Fixtures", group: "sports", slug: "fixtures", needsSport: true },
  { id: "matchcenter", label: "Matchcenter", group: "sports", slug: "", needsSport: true },
  { id: "standings", label: "Standings", group: "sports", slug: "standings", needsSport: true },
  { id: "statistics", label: "Statistics", group: "sports", slug: "statistics", needsSport: true },
  { id: "about", label: "About", group: "legal", slug: "about" },
  { id: "terms", label: "Terms and Conditions", group: "legal", slug: "terms-and-conditions" },
  { id: "privacy", label: "Privacy Policy", group: "legal", slug: "privacy-policy" },
  { id: "cookies", label: "Cookies Policy", group: "legal", slug: "cookies-policy" },
];

/** Detail pages that hang off a listing as a dynamic child (`/fixtures/$*` for a match). */
export const PAGE_DETAILS: readonly PageDetail[] = [
  { id: "news-detail", label: "News Detail", parentId: "news-listing" },
  { id: "videos-detail", label: "Videos Detail", parentId: "videos-listing" },
  { id: "photo-details", label: "Photo Details", parentId: "photos-listing" },
  { id: "squad-detail", label: "Squad Detail", parentId: "squad" },
  { id: "matchcenter", label: "Matchcenter", parentId: "fixtures" },
];

/** What `pages.catalog` returns: each standard page, with the dynamic child it takes, if any. */
export function describeCatalog() {
  return PAGE_OPTIONS.filter((p) => p.slug !== "" || p.required).map((p) => {
    const detail = PAGE_DETAILS.find((d) => d.parentId === p.id);
    return {
      name: p.label,
      slug: p.slug,
      group: p.group,
      needsSport: p.needsSport ?? false,
      ...(p.required ? { note: "created by onboarding; leave it out of pages" } : {}),
      ...(detail ? { dynamicChild: { name: detail.label } } : {}),
    };
  });
}

/** Slugs a brief may not know about; the importer maps them to ready-made templates. */
export const KNOWN_SLUGS = PAGE_OPTIONS.filter((p) => p.slug).map((p) => p.slug);
