import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolContext } from "@dugout/contracts";
import { z } from "zod";

export const DATA_DIR = join(import.meta.dirname, "..", "data");

export interface Fixture {
  fixtureId: string;
  home: string;
  away: string;
  venue: string;
  date: string;
  kickoffLocal: string;
  timezone: string;
  notes: string;
  [extra: string]: unknown;
}

export interface Draft {
  fixtureId: string;
  title: string;
  body: string;
}

/** Reads one tenant's sample data. The tenant always comes from the verified tool context. */
export async function readTenantData(dataDir: string, tenantId: string) {
  const dir = join(dataDir, tenantId);
  const [fixtures, teams] = await Promise.all([
    readFile(join(dir, "fixtures.json"), "utf8"),
    readFile(join(dir, "teams.json"), "utf8"),
  ]);
  return {
    fixtures: (JSON.parse(fixtures) as { fixtures: Fixture[] }).fixtures,
    teams: (JSON.parse(teams) as { teams: Record<string, Record<string, unknown>> }).teams,
  };
}

export function createMatchPreviewTools(opts: { dataDir?: string; draftsDir: string }) {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const data = (ctx: ToolContext) => readTenantData(dataDir, ctx.tenantId);

  const fixturesGet = defineTool({
    name: "fixtures.get",
    description: "Get one fixture: teams, venue, date, local kickoff time and notes.",
    input: z.object({ fixtureId: z.string().regex(/^[a-z]-\d{3}$/) }),
    effect: "read",
    timeoutMs: 5_000,
    async run({ fixtureId }, ctx) {
      const { fixtures, teams } = await data(ctx);
      const fixture = fixtures.find((f) => f.fixtureId === fixtureId);
      if (!fixture) throw new Error(`no fixture ${fixtureId}`);
      return {
        ...fixture,
        homeTeam: { teamId: fixture.home, name: teams[fixture.home]?.name },
        awayTeam: { teamId: fixture.away, name: teams[fixture.away]?.name },
      };
    },
  });

  const teamStats = defineTool({
    name: "team.stats",
    description:
      "Season stats for one team: record, recent form, key players, then the full match log.",
    input: z.object({ teamId: z.string().regex(/^[a-z]{3}$/) }),
    effect: "read",
    timeoutMs: 5_000,
    async run({ teamId }, ctx) {
      const { teams } = await data(ctx);
      const team = teams[teamId];
      if (!team) throw new Error(`no team ${teamId}`);
      return team;
    },
  });

  const draftSave = defineTool({
    name: "draft.save",
    description:
      "Save the preview as a draft for an editor. Saving the same draft twice changes nothing.",
    input: z.object({
      fixtureId: z.string().regex(/^[a-z]-\d{3}$/),
      title: z.string().min(3).max(120),
      body: z.string().min(20).max(2_000),
    }),
    effect: "write",
    timeoutMs: 5_000,
    retries: 1, // idempotent by fixture and content hash
    async run(draft, ctx) {
      const dir = join(opts.draftsDir, ctx.tenantId);
      const file = join(dir, `${draft.fixtureId}.json`);
      const hash = createHash("sha256").update(JSON.stringify(draft)).digest("hex").slice(0, 12);
      const existing = await readFile(file, "utf8")
        .then((s) => JSON.parse(s) as { hash: string })
        .catch(() => undefined);
      if (existing?.hash === hash)
        return { saved: true, unchanged: true, draftId: draft.fixtureId };
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify({ ...draft, hash, runId: ctx.runId }, null, 2));
      return { saved: true, unchanged: false, draftId: draft.fixtureId };
    },
  });

  return [fixturesGet, teamStats, draftSave];
}
