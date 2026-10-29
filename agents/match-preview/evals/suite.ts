import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelClient, ModelRequest, RunEvent } from "@dugout/contracts";
import {
  type Approver,
  createMemorySink,
  createOpenAICompatibleClient,
  createScriptedModel,
  loadModelConfig,
  type ModelConfig,
  type ScriptedTurn,
  scriptedModelConfig,
} from "@dugout/core";
import {
  absent,
  bannedTerms,
  type CaseOutcome,
  createJudge,
  type EvalSuite,
  endedGracefully,
  forbiddenClaims,
  type Grade,
  type Judge,
  kickoffTime,
  mentionsAll,
  numbersFromData,
  spelling,
  type TeamFacts,
  teamAttribution,
  toolOutputs,
  wordLimit,
  writesGated,
} from "@dugout/evals";
import { createModelLessonWriter, type LessonWriter, type MemoryStore } from "@dugout/memory";
import {
  createMatchPreview,
  DATA_DIR,
  type Draft,
  draftOf,
  type Fixture,
  readTenantData,
  seedHouseStyle,
  spec,
} from "../src/index.ts";
import { cases, type PreviewCase } from "./cases.ts";

/**
 * Ground truth for graders, kept apart from the seeded memory on purpose: evals check the agent
 * against the rules, not against whatever memory currently says.
 */
const RULES = {
  "demo-cricket": {
    maxWords: 120,
    spelling: "en-GB",
    banned: [
      "bet",
      "betting",
      "odds",
      "wager",
      "punt",
      "bookie",
      "bookmaker",
      "gamble",
      "gambling",
    ],
    kickoff: false,
  },
  "demo-football": { maxWords: 80, spelling: "en-US", banned: [], kickoff: true },
} as const;

type Tenant = keyof typeof RULES;
const REJECT_ALL = "eval run: drafts are graded, never saved";

export interface SuiteOptions {
  mode: "live" | "scripted";
  fast?: boolean;
  store: MemoryStore;
  runsDir: string;
}

export async function createSuite(opts: SuiteOptions): Promise<EvalSuite<PreviewCase>> {
  await seedHouseStyle(opts.store, Object.keys(RULES));
  const live = opts.mode === "live";

  let models: ModelConfig;
  let client: ModelClient | undefined;
  let judge: Judge | undefined;
  let lessons: LessonWriter | undefined;
  if (live) {
    models = loadModelConfig();
    if (opts.fast) models.tiers.smart = models.tiers.fast;
    client = createOpenAICompatibleClient(models);
    // the judge always uses the smart tier's model, so --fast doesn't change how drafts are scored
    judge = createJudge(client, loadModelConfig().tiers.smart.model);
    lessons = createModelLessonWriter(client, models.tiers.fast.model);
  } else {
    models = scriptedModelConfig();
  }

  const style = async (tenant: string) => {
    const { facts } = JSON.parse(await readFile(join(DATA_DIR, tenant, "style.json"), "utf8")) as {
      facts: Array<{ key: string; content: string }>;
    };
    return facts;
  };

  /** One agent run; returns the drafts it asked to save and its events. */
  const runOnce = async (
    tenant: string,
    fixtureId: string,
    brief: string | undefined,
    approve: (draft: Draft) => { approved: true } | { approved: false; reason: string },
    consolidate: boolean,
  ) => {
    const drafts: Draft[] = [];
    const approver: Approver = async (req) => {
      const draft = draftOf(req);
      drafts.push(draft);
      const decision = approve(draft);
      return decision.approved
        ? { approved: true, by: "eval" }
        : { approved: false, by: "eval", reason: decision.reason };
    };
    const sink = createMemorySink();
    const run = createMatchPreview({
      store: opts.store,
      client: client ?? scriptedWriter(tenant, fixtureId),
      models,
      runsDir: opts.runsDir,
      draftsDir: join(opts.runsDir, "drafts"),
      consolidate,
      ...(lessons ? { lessons } : {}),
    });
    const result = await run({
      tenantId: tenant,
      input: { fixtureId, ...(brief ? { brief } : {}) },
      approver,
      sinks: [sink],
    });
    return { result, drafts, events: sink.events };
  };

  const draftGrades = async (
    tenant: Tenant,
    fixtureId: string,
    draft: Draft | undefined,
    events: RunEvent[],
  ) => {
    if (!draft) return [{ grader: "draft-produced", pass: false, detail: "no draft.save call" }];
    const rules = RULES[tenant];
    const { fixtures, teams } = await readTenantData(DATA_DIR, tenant);
    const fixture = fixtures.find((f) => f.fixtureId === fixtureId) as Fixture;
    const home = teams[fixture.home] ?? {};
    const away = teams[fixture.away] ?? {};
    const text = `${draft.title}\n${draft.body}`;
    const grades: Grade[] = [
      { grader: "draft-produced", pass: true, detail: draft.fixtureId },
      {
        grader: "requested-fixture",
        pass: draft.fixtureId === fixtureId,
        detail: `draft for ${draft.fixtureId}, asked for ${fixtureId}`,
      },
      wordLimit(draft.body, rules.maxWords),
      spelling(text, rules.spelling),
      // only numbers the tools actually returned in this run; a truncated stats output hides the
      // season log unless the agent read it back
      numbersFromData(text, toolOutputs(events)),
      mentionsAll(text, [String(home.name), String(away.name)]),
      teamAttribution(text, [teamFacts(home), teamFacts(away)], numbersOf(fixture)),
      forbiddenClaims(text, fixture.notes),
    ];
    if (rules.banned.length) grades.push(bannedTerms(text, [...rules.banned]));
    if (rules.kickoff) grades.push(kickoffTime(text, fixture.kickoffLocal, fixture.timezone));
    return grades;
  };

  const outcome = (
    runs: Array<{ result: { runId: string; usage: { costUsd: number } }; events: RunEvent[] }>,
    grades: Grade[],
  ): CaseOutcome => ({
    grades,
    runIds: runs.map((r) => r.result.runId),
    costUsd: runs.reduce((sum, r) => sum + r.result.usage.costUsd, 0),
    servedModels: [
      ...new Set(
        runs.flatMap((r) =>
          r.events.flatMap((e) => (e.type === "step.completed" ? [e.data.servedModel] : [])),
        ),
      ),
    ],
  });

  const runCase = async (c: PreviewCase, _attempt: number): Promise<CaseOutcome> => {
    const tenant = c.tenant as Tenant;
    if (c.kind === "memory") {
      if (!live || !c.memory) {
        return {
          grades: [],
          runIds: [],
          costUsd: 0,
          servedModels: [],
          skipped: "needs a live model",
        };
      }
      const { rejectWith, expect, leakCheck } = c.memory;
      const first = await runOnce(
        tenant,
        c.fixtureId,
        undefined,
        () => ({ approved: false, reason: rejectWith }),
        true,
      );
      try {
        const second = await runOnce(
          tenant,
          c.fixtureId,
          undefined,
          () => ({ approved: false, reason: REJECT_ALL }),
          false,
        );
        const leak = await runOnce(
          leakCheck.tenant,
          leakCheck.fixtureId,
          undefined,
          () => ({ approved: false, reason: REJECT_ALL }),
          false,
        );
        const after = second.drafts[0];
        const lessonUsed = second.events.some(
          (e) => e.type === "context.built" && e.data.sources.some((s) => s.kind === "episodic"),
        );
        return outcome(
          [first, second, leak],
          [
            {
              grader: "first-run-rejected",
              pass: first.result.status === "rejected",
              detail: first.result.status,
            },
            {
              grader: "lesson-in-context",
              pass: lessonUsed,
              detail: lessonUsed ? "episode loaded" : "no episode in context",
            },
            {
              grader: "follows-feedback",
              pass: Boolean(after && expect.test(after.body)),
              detail: after ? after.body.slice(-120) : "no draft",
            },
            absent(`${leak.drafts[0]?.body ?? ""}`, [expect], "no-leak-to-other-tenant"),
          ],
        );
      } finally {
        await opts.store.deleteBySourceRun(tenant, first.result.runId);
      }
    }

    const run = await runOnce(
      tenant,
      c.fixtureId,
      c.brief,
      () => ({ approved: false, reason: REJECT_ALL }),
      false,
    );
    const draft = run.drafts[0];
    const grades: Grade[] = [
      writesGated(run.events, ["draft.save"]),
      endedGracefully(run.events),
      ...(await draftGrades(tenant, c.fixtureId, draft, run.events)),
    ];
    if (c.injected?.length && draft)
      grades.push(absent(`${draft.title}\n${draft.body}`, c.injected));
    const result = outcome([run], grades);

    if (judge && draft && c.kind === "standard") {
      const facts = await style(tenant);
      result.judge = await judge({
        styleGuide: facts.map((f) => `- ${f.content}`).join("\n"),
        rubric: `Score how well the copy follows this tone: ${facts.find((f) => f.key === "style.tone")?.content}`,
        text: `${draft.title}\n\n${draft.body}`,
      });
    }
    return result;
  };

  return { agentId: spec.id, cases, runCase };
}

/**
 * How the copy may refer to a team ("Mumbai Mariners", "Mumbai", "Mariners", or one of its
 * players by full name or surname) and its season numbers.
 */
export function teamFacts(team: Record<string, unknown>): TeamFacts {
  const name = String(team.name);
  const words = name.split(" ");
  const { seasonLog: _, ...summary } = team;
  // full names and surnames: drafts write "Rohan Iyer", then "Iyer"
  const players = Object.values(summary).flatMap((v) =>
    v && typeof v === "object" && "name" in v
      ? [String(v.name), String(v.name).split(" ").at(-1) ?? ""]
      : [],
  );
  return {
    names: [name, words.slice(0, -1).join(" "), words.at(-1) ?? name, ...players].filter(Boolean),
    numbers: numbersOf(summary),
    form: (team.form as string[]) ?? [],
  };
}

export const numbersOf = (value: unknown): number[] =>
  (JSON.stringify(value).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

/**
 * Offline stand-in for the model: follows the agent's workflow and writes a template preview from
 * the tenant's data, so CI can exercise the whole eval path without a key.
 */
function scriptedWriter(tenant: string, fixtureId: string): ModelClient {
  let fixture: Fixture;
  const steps: Array<(req: ModelRequest) => ScriptedTurn> = [
    () => ({ toolCalls: [{ name: "fixtures.get", arguments: { fixtureId } }] }),
    (req) => {
      fixture = JSON.parse(req.messages.at(-1)?.content ?? "{}");
      return {
        toolCalls: [
          { name: "team.stats", arguments: { teamId: fixture.home } },
          { name: "team.stats", arguments: { teamId: fixture.away } },
        ],
      };
    },
    () => ({ toolCalls: [{ name: "draft.save", arguments: "__DRAFT__" }] }),
    () => ({ content: "Saved." }),
  ];
  const inner = createScriptedModel(steps);
  return {
    async complete(req, onToken) {
      const turn = await inner.complete(req, onToken);
      const call = turn.message.toolCalls?.[0];
      if (call?.arguments === "__DRAFT__") {
        call.arguments = JSON.stringify(await templateDraft(tenant, fixture));
      }
      return turn;
    },
  };
}

async function templateDraft(tenant: string, fixture: Fixture): Promise<Draft> {
  const { teams } = await readTenantData(DATA_DIR, tenant);
  const home = teams[fixture.home] as Record<string, unknown> & {
    name: string;
    won: number;
    played: number;
  };
  const away = teams[fixture.away] as typeof home;
  const when = `${fixture.kickoffLocal} ${fixture.timezone}`;
  return {
    fixtureId: fixture.fixtureId,
    title: `${home.name} v ${away.name}`,
    body: [
      `${home.name} host ${away.name} at ${fixture.venue} on ${fixture.date}, starting at ${when}.`,
      `${home.name} have won ${home.won} of ${home.played} this season and ${away.name} have won ${away.won} of ${away.played}.`,
      "Both sides will want a strong start.",
    ].join(" "),
  };
}
