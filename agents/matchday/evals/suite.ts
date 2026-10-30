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
  TENANTS_DIR,
} from "@dugout/core";
import {
  bannedTerms,
  type CaseOutcome,
  type EvalSuite,
  endedGracefully,
  type Grade,
  wordLimit,
  writesGated,
} from "@dugout/evals";
import type { MemoryStore } from "@dugout/memory";
import { seedHouseFacts } from "@dugout/sdk";
import {
  agent,
  CHANNELS,
  type Channel,
  countWords,
  HEADLINE_MAX_CHARS,
  type Pack,
  PREVIEW_MAX_WORDS,
  PUSH_MAX_CHARS,
  packOf,
  SOCIAL_MAX_CHARS,
  spec,
} from "../src/index.ts";
import { readTenantData } from "../src/tools.ts";
import { cases, type MatchdayCase } from "./cases.ts";

const BANNED = [
  "bet",
  "betting",
  "odds",
  "wager",
  "punt",
  "bookie",
  "bookmaker",
  "gamble",
  "gambling",
];

export interface SuiteOptions {
  mode: "live" | "scripted";
  /** Runs the agent on this model instead of its spec's. */
  model?: string;
  store: MemoryStore;
  runsDir: string;
}

export async function createSuite(opts: SuiteOptions): Promise<EvalSuite<MatchdayCase>> {
  await seedHouseFacts(opts.store, ["demo-cricket", "demo-football"]);
  const live = opts.mode === "live";
  let models: ModelConfig;
  let client: ModelClient | undefined;
  if (live) {
    models = loadModelConfig();
    client = createBedrockClient({ models });
  } else {
    models = scriptedModelConfig();
  }

  const runCase = async (c: MatchdayCase): Promise<CaseOutcome> => {
    const { fixtures, teams } = await readTenantData(TENANTS_DIR, c.tenant);
    const fixture = fixtures.find((item) => item.fixtureId === c.fixtureId);
    if (!fixture) throw new Error(`no fixture ${c.fixtureId}`);
    const home = String(teams[fixture.home]?.name ?? "");
    const away = String(teams[fixture.away]?.name ?? "");
    const channels = c.channels ?? [];
    const full = body(home, away, fixture.venue, fixture.date, fixture.kickoffLocal);
    const first = c.revise ? body(home, away, undefined, fixture.date, fixture.kickoffLocal) : full;
    const packs = {
      first: makePack(fixture.fixtureId, channels, home, away, first, fixture.kickoffLocal),
      final: makePack(fixture.fixtureId, channels, home, away, full, fixture.kickoffLocal),
    };
    const shown: Pack[] = [];
    const approver: Approver = async (req) => {
      shown.push(packOf(req));
      if (c.revise && shown.length === 1) {
        return { approved: false, by: "eval", changes: c.revise.request };
      }
      return { approved: true, by: "eval" };
    };
    const sink = createMemorySink();
    const run = agent.create({
      store: opts.store,
      client: client ?? scriptedWriter(fixture, packs, channels, c.revise !== undefined),
      models,
      ...(opts.model ? { model: opts.model } : {}),
      runsDir: opts.runsDir,
      packsDir: join(opts.runsDir, "packs", randomUUID()),
      consolidate: false,
    });
    const result = await run({
      tenantId: c.tenant,
      input: {
        fixtureId: c.fixtureId,
        ...(c.brief ? { brief: c.brief } : {}),
        ...(channels.length ? { channels } : {}),
      },
      approver,
      sinks: [sink],
    });
    const events = sink.events;
    const final = result.status === "completed" ? (result.output as Pack) : undefined;
    const grades: Grade[] = [
      writesGated(events, ["pack.save"]),
      endedGracefully(events),
      loadedChannels(events, channels),
      {
        grader: "approvals",
        pass: shown.length === (c.revise ? 2 : 1),
        detail: `${shown.length} pack(s) shown`,
      },
    ];
    if (final) {
      grades.push(
        wordLimit(final.preview.body, PREVIEW_MAX_WORDS),
        bannedTerms(packText(final), BANNED),
        mentions(final.preview.body, [home, away], "both-teams"),
        channelsPresent(final, channels),
      );
      if (channels.includes("push") && final.push) {
        grades.push(mentions(final.push, [fixture.kickoffLocal], "kickoff"));
      }
      if (channels.includes("headline") && final.headline) {
        grades.push(mentions(final.headline, [home], "home-team"));
      }
      if (c.revise && shown[0] && shown[1]) {
        grades.push({
          grader: "revise-venue",
          pass:
            !shown[0].preview.body.includes(fixture.venue) &&
            shown[1].preview.body.includes(fixture.venue) &&
            final.preview.body.includes(fixture.venue),
          detail: fixture.venue,
        });
      }
      grades.push({
        grader: "saved-matches-final",
        pass: JSON.stringify(shown.at(-1)) === JSON.stringify(final),
        detail: shown.at(-1) ? "matches" : "nothing saved",
      });
    }
    return {
      grades,
      runIds: [result.runId],
      costUsd: result.usage.costUsd,
      servedModels: servedModels(events),
    };
  };

  return { agentId: spec.id, cases, runCase };
}

const servedModels = (events: RunEvent[]) => [
  ...new Set(
    events.flatMap((event) => (event.type === "step.completed" ? [event.data.servedModel] : [])),
  ),
];

function body(
  home: string,
  away: string,
  venue: string | undefined,
  date: string,
  kickoff: string,
) {
  const place = venue ? ` at ${venue}` : "";
  return `${home} host ${away}${place} on ${date}, starting at ${kickoff}.`;
}

function makePack(
  fixtureId: string,
  channels: Channel[],
  home: string,
  away: string,
  previewBody: string,
  kickoff: string,
): Pack {
  return {
    fixtureId,
    channels,
    preview: { title: `${home} v ${away}`, body: previewBody },
    social: channels.includes("social") ? `${home} face ${away}.` : null,
    push: channels.includes("push") ? `${home} v ${away}, ${kickoff}.` : null,
    headline: channels.includes("headline") ? `${home} host ${away}` : null,
  };
}

/**
 * Offline stand-in: reads the fixture, loads each requested channel skill, and saves a template
 * pack. With `revise`, the first save omits the venue and the second puts it back.
 */
function scriptedWriter(
  fixture: { fixtureId: string; home: string; away: string },
  packs: { first: Pack; final: Pack },
  channels: Channel[],
  revise: boolean,
): ModelClient {
  const save = (pack: Pack) => ({ toolCalls: [{ name: "pack.save", arguments: pack }] });
  return createScriptedModel([
    { toolCalls: [{ name: "fixtures.get", arguments: { fixtureId: fixture.fixtureId } }] },
    {
      toolCalls: [
        { name: "team.stats", arguments: { teamId: fixture.home } },
        { name: "team.stats", arguments: { teamId: fixture.away } },
      ],
    },
    ...(channels.length
      ? [
          {
            toolCalls: channels.map((name) => ({ name: "skill.load", arguments: { name } })),
          },
        ]
      : []),
    ...(revise ? [save(packs.first)] : []),
    save(packs.final),
    { toolCalls: [{ name: "final", arguments: packs.final }] },
  ]);
}

function loadedChannels(events: RunEvent[], channels: Channel[]): Grade {
  const loads = events.flatMap((event, index) =>
    event.type === "tool.started" && event.data.tool === "skill.load"
      ? [{ index, name: String((event.data.input as { name?: string }).name) }]
      : [],
  );
  const saveAt = events.findIndex(
    (event) => event.type === "tool.started" && event.data.tool === "pack.save",
  );
  const names = loads.map((load) => load.name);
  const beforeSave = saveAt === -1 || loads.every((load) => load.index < saveAt);
  const expected = [...channels];
  const pass =
    beforeSave &&
    names.length === expected.length &&
    expected.every((name) => names.includes(name));
  return {
    grader: "skills-loaded",
    pass,
    detail: pass ? expected.join(", ") || "none" : `loaded ${names.join(", ") || "none"}`,
  };
}

function channelsPresent(pack: Pack, channels: Channel[]): Grade {
  const problems: string[] = [];
  for (const channel of CHANNELS) {
    const text = pack[channel];
    const wanted = channels.includes(channel);
    if (wanted && !text) problems.push(`${channel} missing`);
    if (!wanted && text) problems.push(`${channel} extra`);
    const max =
      channel === "social"
        ? SOCIAL_MAX_CHARS
        : channel === "push"
          ? PUSH_MAX_CHARS
          : HEADLINE_MAX_CHARS;
    if (text && text.length > max) problems.push(`${channel} is ${text.length} chars`);
  }
  if (countWords(pack.preview.body) > PREVIEW_MAX_WORDS) problems.push("preview too long");
  return {
    grader: "channels",
    pass: problems.length === 0,
    detail: problems.join("; ") || channels.join(", ") || "preview only",
  };
}

function mentions(text: string, needles: string[], grader: string): Grade {
  const missing = needles.filter((needle) => needle && !text.includes(needle));
  return { grader, pass: missing.length === 0, detail: missing.join(", ") || "ok" };
}

function packText(pack: Pack): string {
  return [pack.preview.title, pack.preview.body, pack.social, pack.push, pack.headline]
    .filter(Boolean)
    .join("\n");
}
