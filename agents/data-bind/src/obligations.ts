/**
 * What a section's settled intent obliges each stage to build (ADR 0039). A model settles an intent
 * once (the design pages this list: data-bind's `need.paged`), and it travels in what it shaped (the
 * paged hook answers `next`). Each later stage's check reads it there and refuses an answer that
 * leaves it unbuilt, whatever the data holds today: a list on its last page is still a paged list.
 * The model still decides how to build it; code only holds it to what was settled.
 *
 * Each kind is one entry with a check per stage: paging (the intent read from the paged hook's
 * `next`), a fixed count (`need.count`) and links (a need's field of kind `link`), both read from
 * what the run asked hook-maker; a carousel (a `Carousel` frame-match settled, in the tree); and a
 * list that shrinks, which is what a list is.
 */

/** An obligation a stage has not met: the source it is about, and what to build, as the model reads it. */
export interface Unmet {
  source: string;
  problem: string;
}

/** A list a paged source holds, by the path the plan reads it at (`galleries.galleries`). */
export interface PagedList {
  /** The source's name in the bag (bind.source's `as`). */
  source: string;
  /** The list's path from the bag. */
  list: string;
}

/**
 * The lists of each source whose top answers `next`: a paged hook's contract (ADR 0030, hook-maker
 * builds one only for a `need.paged`), so its answer is where the intent is read.
 */
export function pagedLists(bag: unknown): PagedList[] {
  const lists: PagedList[] = [];
  for (const [source, value] of Object.entries((bag ?? {}) as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("next" in value)) continue;
    for (const [key, held] of Object.entries(value)) {
      if (Array.isArray(held)) lists.push({ source, list: `${source}.${key}` });
    }
  }
  return lists;
}

interface PlanShape {
  collapse?:
    | Array<{
        over: string;
        as?: string | undefined;
        slice?: readonly number[] | undefined;
        members?: unknown;
        fields?: unknown;
      }>
    | undefined;
  bind?: unknown;
  set?: unknown;
}

/** Whether the plan reads the list at all: a collapse over it, or a path into it. */
function reads(plan: PlanShape, list: string): boolean {
  return JSON.stringify(plan).includes(`"${list}`);
}

/** Paged sources whose lists the plan reads, one entry per source. */
function pagedRead(plan: PlanShape, bag: unknown) {
  const bySource = new Map<string, string[]>();
  for (const p of pagedLists(bag)) {
    if (!reads(plan, p.list)) continue;
    bySource.set(p.source, [...(bySource.get(p.source) ?? []), p.list]);
  }
  return bySource;
}

/** A source whose list the design draws a fixed number of: `need.count`, not paged and not grouped. */
export interface Counted {
  source: string;
  count: number;
}

/** What one call asked hook-maker and what it answered, as the SDK keeps it (`askedOf`). */
interface AskedHook {
  input?: unknown;
  output?: unknown;
}

/**
 * The sources whose list the design draws a fixed number of, from what the run asked hook-maker
 * (the need its model settled) and the hook each answer gave, matched to the sources bound by hook.
 * A need that pages or gathers items into groups draws no fixed number of the list.
 */
export function countedSources(
  asked: readonly AskedHook[],
  sources: ReadonlyArray<{ as: string; hookId?: string | undefined }>,
): Counted[] {
  const byHook = new Map<string, number>();
  for (const a of asked) {
    const need = (a.input as { need?: { count?: unknown; paged?: unknown; groupBy?: unknown } })
      ?.need;
    const hookId = (a.output as { hookId?: unknown } | undefined)?.hookId;
    if (typeof hookId !== "string" || !need) continue;
    if (typeof need.count === "number" && !need.paged && !need.groupBy)
      byHook.set(hookId, need.count);
    else byHook.delete(hookId);
  }
  return sources.flatMap((s) => {
    const count = s.hookId ? byHook.get(s.hookId) : undefined;
    return count === undefined ? [] : [{ source: s.as, count }];
  });
}

/** The lists a source holds: the source itself when it is a list, else the lists at its top. */
function listsOf(bag: unknown, source: string): string[] {
  const value = (bag as Record<string, unknown> | undefined)?.[source];
  if (Array.isArray(value)) return [source];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .filter(([, held]) => Array.isArray(held))
    .map(([key]) => `${source}.${key}`);
}

/** Every path a plan reads, wherever it is (bind, collapse fields, set values). */
function pathsIn(plan: PlanShape): string[] {
  const paths: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (k === "path" && typeof x === "string") paths.push(x);
        else walk(x);
      }
  };
  walk(plan);
  return paths;
}

/**
 * data-bind's part of paging: a list of a paged source the plan reads is drawn, past the cards
 * bound by position, by a collapse with an open slice (`[n]`), so the items a later page adds have
 * somewhere to draw.
 */
function pagingBinding(plan: PlanShape, bag: unknown): Unmet[] {
  const problems: Unmet[] = [];
  for (const [source, lists] of pagedRead(plan, bag)) {
    const open = (plan.collapse ?? []).some(
      (c) => c.slice?.length === 1 && lists.some((l) => c.over === l),
    );
    if (open) continue;
    problems.push({
      source,
      problem: `${source} pages (it answers next: the page adds the next page's items to ${lists.join(", ")}), and no collapse in the plan draws ${lists[0]} from an index on, so the items a later page adds have nowhere to draw. Keep the cards the design draws in their own looks bound by position, and add a collapse over ${lists[0]} with an open slice [n] (n: how many are bound before it) on the shape the design repeats last. Build it whatever the data holds today: on its last page (next: null) it draws nothing`,
    });
  }
  return problems;
}

/**
 * data-bind's part of a fixed count: a list the design draws N of is drawn N at most, however long
 * the data grows. Every collapse over it cuts it (a closed slice within N), and no card is bound by
 * position past the N-th.
 */
function countBinding(plan: PlanShape, bag: unknown, counted: readonly Counted[]): Unmet[] {
  const problems: Unmet[] = [];
  const paths = pathsIn(plan);
  for (const { source, count } of counted) {
    for (const list of listsOf(bag, source)) {
      const over = (plan.collapse ?? []).filter((c) => c.over === list);
      const uncut = over.filter((c) => c.slice?.length !== 2);
      const past = over.filter((c) => c.slice?.length === 2 && (c.slice[1] ?? 0) > count);
      const prefix = `${list}.`;
      const placed = paths.flatMap((p) => {
        if (!p.startsWith(prefix)) return [];
        const at = Number(p.slice(prefix.length).split(".")[0]);
        return Number.isInteger(at) && at >= count ? [at] : [];
      });
      if (uncut.length === 0 && past.length === 0 && placed.length === 0) continue;
      const what = [
        ...(uncut.length
          ? [
              `a collapse over it draws ${uncut.some((c) => c.slice?.length === 1) ? "from an index to the end" : "every item"}`,
            ]
          : []),
        ...(past.length
          ? [`a collapse runs to item ${Math.max(...past.map((c) => c.slice?.[1] ?? 0))}`]
          : []),
        ...(placed.length ? [`a card is bound to item ${Math.min(...placed)} by position`] : []),
      ].join(", and ");
      problems.push({
        source,
        problem: `the design draws ${count} of ${list} (need.count ${count}), and ${what}: a longer feed would draw past the design. Cut it to ${count}: a closed slice [start, end] with end at most ${count} on each collapse over it, and positions below ${count}. Build it whatever the data holds today: a feed with fewer items still draws them all`,
      });
    }
  }
  return problems;
}

/** A node of the frame, as much of it as the checks read. */
interface NodeShape {
  id: string;
  parent: string | null;
  type?: string;
  src: string;
  props: Record<string, unknown>;
}

/** Where a path reads an item by position: the list and the index (`news.items.3.title`). */
function itemAt(path: string): { list: string; at: number } | undefined {
  const parts = path.split(".");
  const i = parts.findIndex((p) => /^\d+$/.test(p));
  return i > 0 ? { list: parts.slice(0, i).join("."), at: Number(parts[i]) } : undefined;
}

/**
 * data-bind's part of a list that shrinks: a card bound to an item by position is drawn only while
 * the data holds that item, so a feed with fewer items tomorrow hides the card instead of drawing
 * it empty. A `when` on the card's node or one around it reads that very item.
 */
function shrinkBinding(plan: PlanShape, nodes: readonly NodeShape[] | undefined): Unmet[] {
  if (!nodes?.length) return [];
  const bySrc = new Map(nodes.map((n) => [n.src, n]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // what each node is drawn under, the plan's when over the design's
  const whens = new Map<string, unknown>(nodes.map((n) => [n.src, n.props.when]));
  for (const set of (plan.set ?? []) as Array<{ src?: string; prop?: string; value?: unknown }>)
    if (set.prop === "when" && set.src) whens.set(set.src, set.value);
  const guards = (src: string, item: string): boolean => {
    for (let at = bySrc.get(src); at; at = at.parent === null ? undefined : byId.get(at.parent)) {
      const when = whens.get(at.src);
      if (
        when !== undefined &&
        pathsIn({ when } as never).some((p) => p === item || p.startsWith(`${item}.`))
      )
        return true;
    }
    return false;
  };
  const unguarded = new Map<string, number[]>();
  for (const bind of (plan.bind ?? []) as Array<{ src?: string; path?: string }>) {
    if (!bind.src || !bind.path) continue;
    const item = itemAt(bind.path);
    if (!item) continue;
    if (guards(bind.src, `${item.list}.${item.at}`)) continue;
    unguarded.set(item.list, [...new Set([...(unguarded.get(item.list) ?? []), item.at])]);
  }
  return [...unguarded].map(([list, at]) => ({
    source: list.split(".")[0] ?? list,
    problem: `cards are bound to ${list} by position (item${at.length > 1 ? "s" : ""} ${at.sort((a, b) => a - b).join(", ")}) with nothing hiding them when the data holds fewer items, so a shorter feed draws them empty. Put a set of when on each such card (the node that is one card), { "path": "${list}.<n>", "exists": true }, whatever the data holds today`,
  }));
}

/**
 * The sources whose items each open their own page: the run asked hook-maker for a field of kind
 * `link` (the need its model settled), and the source is bound by the hook that answered.
 */
export function linkedSources(
  asked: readonly AskedHook[],
  sources: ReadonlyArray<{ as: string; hookId?: string | undefined }>,
): string[] {
  const hooks = new Set<string>();
  for (const a of asked) {
    const need = (a.input as { need?: { item?: Array<{ kind?: unknown }> } })?.need;
    const hookId = (a.output as { hookId?: unknown } | undefined)?.hookId;
    if (typeof hookId === "string" && need?.item?.some((f) => f.kind === "link")) hooks.add(hookId);
  }
  return sources.filter((s) => s.hookId && hooks.has(s.hookId)).map((s) => s.as);
}

/**
 * data-bind's part of a link: when the design's items each open their own page, the plan links
 * them: an `href` (or a Button's navigate action) that reads the source, by its path or through a
 * collapse's item over it.
 */
function linkBinding(plan: PlanShape, linked: readonly string[]): Unmet[] {
  if (linked.length === 0) return [];
  const links: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") {
      const o = v as { prop?: unknown; value?: { kind?: unknown } };
      if (o.prop === "href" || (o.prop === "action" && o.value?.kind === "navigate"))
        links.push(JSON.stringify(v));
      else for (const x of Object.values(v)) walk(x);
    }
  };
  walk(plan);
  const collapses = plan.collapse ?? [];
  return linked.flatMap((source) => {
    const aliases = collapses
      .filter((c) => c.over === source || c.over.startsWith(`${source}.`))
      .flatMap((c) => (c.as ? [c.as] : []));
    const reads = (json: string) =>
      json.includes(`"${source}.`) ||
      json.includes(`{${source}.`) ||
      aliases.some((a) => json.includes(`"${a}.`) || json.includes(`{${a}.`));
    if (links.some(reads)) return [];
    return [
      {
        source,
        problem: `${source}'s items each open their own page (the run asked agent.hookMaker for a link field), and nothing in the plan links them. Bind href on each card's node (the template's root): a path to the field that holds the URL, or a template from a route.* house fact over the item's slug or id (/news/{n.slug}). A Button links by its action (navigate), never by href`,
      },
    ];
  });
}

/**
 * data-bind's part of a carousel: frame-match's model settled that a container is a carousel (a
 * `Carousel` in the tree), whose slides are as many as the data holds. A list drawn in it is a
 * collapse that cuts nothing (no closed slice), and no slide is bound to an item by position. A
 * list the design draws a fixed number of (`need.count`) is cut by that obligation instead.
 */
function carouselBinding(
  plan: PlanShape,
  nodes: readonly NodeShape[] | undefined,
  counted: readonly Counted[],
): Unmet[] {
  const carousels = (nodes ?? []).filter((n) => n.type === "Carousel");
  if (carousels.length === 0) return [];
  const bySrc = new Map((nodes ?? []).map((n) => [n.src, n]));
  const byId = new Map((nodes ?? []).map((n) => [n.id, n]));
  const carouselOf = (src: string) => {
    for (let at = bySrc.get(src); at; at = at.parent === null ? undefined : byId.get(at.parent))
      if (at.type === "Carousel") return at;
    return undefined;
  };
  const fixed = new Set(counted.map((c) => c.source));
  const problems: Unmet[] = [];
  for (const c of plan.collapse ?? []) {
    const members = Array.isArray(c.members) ? (c.members as string[]) : [];
    const inside = members.map(carouselOf).find(Boolean);
    const source = c.over.split(".")[0] ?? c.over;
    if (!inside || fixed.has(source) || c.slice?.length !== 2) continue;
    problems.push({
      source,
      problem: `the carousel ${inside.src} draws ${c.over} cut to [${c.slice.join(", ")}]: a carousel's slides are as many as the data holds. Take the slice off (a fixed number is need.count's to say, and hook-maker's to give)`,
    });
  }
  const placed = new Map<string, Set<string>>();
  for (const bind of (plan.bind ?? []) as Array<{ src?: string; path?: string }>) {
    if (!bind.src || !bind.path || !itemAt(bind.path)) continue;
    const inside = carouselOf(bind.src);
    const source = bind.path.split(".")[0] ?? bind.path;
    if (!inside || fixed.has(source)) continue;
    placed.set(inside.src, new Set([...(placed.get(inside.src) ?? []), source]));
  }
  for (const [carousel, sources] of placed)
    for (const source of sources)
      problems.push({
        source,
        problem: `the carousel ${carousel}'s slides are bound to ${source}'s items by position, so it draws only the slides the design drew. Collapse the slides over the list (the first slide the template), so it draws as many as the data holds`,
      });
  return problems;
}

/** What settled intents oblige a binding plan to build, beside what its data says (paging). */
export interface Settled {
  counted?: readonly Counted[];
  /** Sources whose items each open their own page. */
  linked?: readonly string[];
}

/** data-bind's part of every kind: one problem per source and kind; fixed in the plan, never kept. */
export function bindingObligations(
  plan: PlanShape,
  bag: unknown,
  settled: Settled = {},
  nodes?: readonly NodeShape[],
): Unmet[] {
  return [
    ...pagingBinding(plan, bag),
    ...countBinding(plan, bag, settled.counted ?? []),
    ...shrinkBinding(plan, nodes),
    ...linkBinding(plan, settled.linked ?? []),
    ...carouselBinding(plan, nodes, settled.counted ?? []),
  ];
}

interface Built {
  /** The section's machine (the tree root's `props.machine`). */
  machine?: unknown;
  /** Everything the section's layers say (the tree and the plan), searched for what reads `next`. */
  layers: unknown;
}

/**
 * interaction's part: a paged source the plan reads has a request for its next page in the
 * section's machine (`requests.<n>.source`), and a layer drawn on the source's `next` (the button
 * that asks, hidden on the last page). One problem per source that lacks either.
 */
export function behaviourObligations(plan: PlanShape, bag: unknown, built: Built): Unmet[] {
  const problems: Unmet[] = [];
  const requests = Object.values(
    ((built.machine as { requests?: Record<string, { source?: unknown }> } | undefined)?.requests ??
      {}) as Record<string, { source?: unknown }>,
  );
  const layers = JSON.stringify(built.layers ?? null);
  for (const [source] of pagedRead(plan, bag)) {
    const asks = requests.some((r) => r?.source === source);
    const hides = layers.includes(`"${source}.next"`);
    if (asks && hides) continue;
    problems.push({
      source,
      problem: `${source} pages (it answers next) and the section ${asks ? "has a request for its next page" : "asks for no next page of it"}${hides ? "" : ", and nothing is drawn on its next"}: wire what asks for more (the design's LOAD MORE, a pager) as the machine skill shows, a request with source ${source} and the button's when on ${source}.next. Build it whatever next holds today: null hides the button, which is the design working on its last page`,
    });
  }
  return problems;
}
