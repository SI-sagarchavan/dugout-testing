import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ModelClient, RunEvent } from "@dugout/contracts";
import {
  type Approver,
  createBedrockClient,
  createMemorySink,
  createScriptedModel,
  loadModelConfig,
  type ModelConfig,
  scriptedModelConfig,
} from "@dugout/core";
import {
  type CaseOutcome,
  type EvalSuite,
  endedGracefully,
  type Grade,
  writesGated,
} from "@dugout/evals";
import type { MemoryStore } from "@dugout/memory";
import { houseFactsFor, seedHouseFacts } from "@dugout/sdk";
import { agent, type NavItem, type PageNode, type Sitemap, sitemapOf, spec } from "../src/index.ts";
import { cases, type SitemapCase } from "./cases.ts";
import {
  hasPages,
  keepsRest,
  lacksPages,
  listingsHaveDetail,
  menuAfterChange,
  menuOrder,
  menuStartsWithHome,
  noHomeEntry,
  noInjectedContent,
  passesRules,
  savedMatchesFinal,
  validatedBeforeSave,
} from "./graders.ts";
import { createFitJudge, type FitJudge } from "./judge.ts";

/**
 * Ground truth for graders, kept apart from the seeded memory on purpose: evals check the agent
 * against the rules, not against whatever memory currently says.
 */
const RULES = {
  "demo-cricket": {
    menuOrder: ["/", "/news", "/fixtures", "/squad", "/standings", "/videos", "/photos"],
  },
  "demo-football": {
    menuOrder: ["/", "/news", "/fixtures", "/standings", "/squad", "/videos"],
  },
} as const;

type Tenant = keyof typeof RULES;

export interface SuiteOptions {
  mode: "live" | "scripted";
  fast?: boolean;
  store: MemoryStore;
  runsDir: string;
}

export async function createSuite(opts: SuiteOptions): Promise<EvalSuite<SitemapCase>> {
  await seedHouseFacts(opts.store, Object.keys(RULES), [spec.id]);
  const live = opts.mode === "live";

  let models: ModelConfig;
  let client: ModelClient | undefined;
  let judge: FitJudge | undefined;
  if (live) {
    models = loadModelConfig();
    if (opts.fast) models.tiers.smart = models.tiers.fast;
    client = createBedrockClient();
    // the judge always uses the smart tier's model, so --fast doesn't change how sitemaps are scored
    judge = createFitJudge(client, loadModelConfig().tiers.smart.model);
  } else {
    models = scriptedModelConfig();
  }

  const factLines = async (tenant: string) =>
    (await houseFactsFor(tenant, spec.id)).map((f) => `- ${f.content}`).join("\n");

  const runCase = async (c: SitemapCase, _attempt: number): Promise<CaseOutcome> => {
    const tenant = c.tenant as Tenant;
    // every sitemap shown for approval; with `revise`, the first is sent back for the change
    const shown: Sitemap[] = [];
    // the editor approves into a throwaway folder, so `final` and the save both get exercised
    const approver: Approver = async (req) => {
      shown.push(sitemapOf(req));
      if (c.revise && shown.length === 1) {
        return { approved: false, by: "eval", changes: c.revise.request };
      }
      return { approved: true, by: "eval" };
    };
    const sink = createMemorySink();
    const run = agent.create({
      store: opts.store,
      client: client ?? scriptedWriter(tenant, c),
      models,
      runsDir: opts.runsDir,
      // cases run in parallel, so each gets its own folder rather than sharing the tenant's
      sitemapsDir: join(opts.runsDir, "sitemaps", randomUUID()),
      consolidate: false,
    });
    const result = await run({
      tenantId: tenant,
      input: { brief: c.brief, ...(c.sports ? { sports: c.sports } : {}) },
      approver,
      sinks: [sink],
    });
    const events = sink.events;
    const final = result.status === "completed" ? (result.output as Sitemap) : undefined;
    const base = c.revise ? shown[0] : undefined;
    const saved = c.revise && shown.length < 2 ? undefined : shown.at(-1);

    const grades: Grade[] = [
      writesGated(events, ["sitemap.save"]),
      endedGracefully(events),
      validatedBeforeSave(events),
      savedMatchesFinal(saved, final),
    ];
    if (final) {
      grades.push(
        passesRules(final),
        noHomeEntry(final),
        hasPages(final, c.include ?? [], c.includeMatching),
        listingsHaveDetail(final),
        menuStartsWithHome(final),
        menuOrder(final, RULES[tenant].menuOrder),
      );
      if (c.exclude?.length) grades.push(lacksPages(final, c.exclude));
      if (c.injected?.length) grades.push(noInjectedContent(final, c.injected));
      if (base && c.revise) {
        const { present = [], absent = [], menu = [] } = c.revise;
        grades.push(
          hasPages(final, present),
          keepsRest(base, final, absent),
          menuAfterChange(final, menu, absent),
        );
        if (absent.length) grades.push(lacksPages(final, absent));
      }
    }

    const outcome: CaseOutcome = {
      grades,
      runIds: [result.runId],
      costUsd: result.usage.costUsd,
      servedModels: servedModels(events),
    };
    if (judge && final && c.kind === "standard" && !c.revise) {
      outcome.judge = await judge({
        brief: c.brief,
        houseFacts: await factLines(tenant),
        outline: outline(final),
      });
    }
    return outcome;
  };

  return { agentId: spec.id, cases, runCase };
}

const servedModels = (events: RunEvent[]) => [
  ...new Set(events.flatMap((e) => (e.type === "step.completed" ? [e.data.servedModel] : []))),
];

/** The sitemap as indented lines, for the judge. */
export function outline(sitemap: Sitemap): string {
  const pages = (nodes: PageNode[], indent: string): string[] =>
    nodes.flatMap((n) => [
      `${indent}${n.name} ${n.dynamic ? "(dynamic)" : `/${n.slug ?? ""}`}`,
      ...pages(n.children ?? [], `${indent}  `),
    ]);
  const menu = (items: NavItem[], indent: string): string[] =>
    items.flatMap((i) => [`${indent}${i.name} ${i.url}`, ...menu(i.children ?? [], `${indent}  `)]);
  return ["Pages:", ...pages(sitemap.pages, "  "), "Menu:", ...menu(sitemap.navigation, "  ")].join(
    "\n",
  );
}

const LISTINGS = [
  { name: "News", slug: "news", detail: "News Detail" },
  { name: "Photos", slug: "photos", detail: "Photo Details" },
  { name: "Videos", slug: "videos", detail: "Videos Detail" },
];
const SPORTS = [
  { name: "Squad", slug: "squad", detail: "Squad Detail" },
  { name: "Fixtures", slug: "fixtures", detail: "Matchcenter" },
  { name: "Standings", slug: "standings" },
  { name: "Statistics", slug: "statistics" },
];

/** A sitemap built from a template, in the order the publisher's menu rules ask for. */
export function templateSitemap(tenant: Tenant, c: SitemapCase): Sitemap {
  const wanted = [
    ...LISTINGS,
    ...(c.sports?.length ? SPORTS : []),
    { name: "About", slug: "about" },
    { name: "Privacy Policy", slug: "privacy-policy" },
    { name: "Terms and Conditions", slug: "terms-and-conditions" },
    { name: "404", slug: "404" },
  ].filter((p) => !c.exclude?.includes(p.slug));
  const pages: PageNode[] = [
    ...wanted.map((p): PageNode => {
      const detail = "detail" in p ? p.detail : undefined;
      return {
        name: p.name,
        slug: p.slug,
        ...(detail ? { children: [{ name: detail, dynamic: true }] } : {}),
      };
    }),
    ...(c.extra ?? []),
  ];
  const urls = new Set(wanted.map((p) => `/${p.slug}`));
  const navigation: NavItem[] = RULES[tenant].menuOrder
    .filter((url) => url === "/" || urls.has(url))
    .map((url) => ({
      name: url === "/" ? "Home" : (wanted.find((p) => `/${p.slug}` === url)?.name ?? url),
      url,
    }));
  return { pages, navigation };
}

/**
 * Offline stand-in for the model: follows the agent's workflow and ends with a template sitemap, so
 * CI can exercise the whole eval path without a key.
 */
function scriptedWriter(tenant: Tenant, c: SitemapCase): ModelClient {
  const base = templateSitemap(tenant, c);
  const save = (sitemap: Sitemap) => [
    { toolCalls: [{ name: "sitemap.validate", arguments: sitemap }] },
    { toolCalls: [{ name: "sitemap.save", arguments: sitemap }] },
  ];
  const sitemap = c.revise ? c.revise.apply(base) : base;
  return createScriptedModel([
    { toolCalls: [{ name: "pages.catalog", arguments: {} }] },
    // with `revise`, the first save is sent back and the second carries the change
    ...(c.revise ? save(base) : []),
    ...save(sitemap),
    { toolCalls: [{ name: "final", arguments: sitemap }] },
  ]);
}
