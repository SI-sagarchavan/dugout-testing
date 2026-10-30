import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolContext } from "@dugout/contracts";
import { TENANTS_DIR } from "@dugout/core";
import { z } from "zod";
import { type Pack, PackSchema, packFixtureProblems, packRecord } from "./pack.ts";

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

/**
 * Reads one tenant's sample sports data, the stand-in for its feed. The tenant always comes from
 * the verified tool context.
 */
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

export function createMatchdayTools(opts: { dataDir?: string; packsDir: string }) {
  const dataDir = opts.dataDir ?? TENANTS_DIR;
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

  const packSave = defineTool({
    name: "pack.save",
    description:
      "Save the matchday pack for an editor. social, push and headline are required: the text when that channel was requested, or null when it was not. The preview body is at most 120 words. No betting language. A push must include the kickoff time from fixtures.get, and a headline must name the home team. Saving the same pack twice changes nothing.",
    input: PackSchema,
    effect: "write",
    timeoutMs: 5_000,
    retries: 1, // idempotent by content hash
    async run(pack, ctx) {
      const { fixtures, teams } = await data(ctx);
      const fixture = fixtures.find((item) => item.fixtureId === pack.fixtureId);
      if (!fixture) throw new Error(`no fixture ${pack.fixtureId}`);
      const homeName = teams[fixture.home]?.name;
      if (typeof homeName !== "string" || !homeName) throw new Error(`no team ${fixture.home}`);
      // Kickoff and the home-team name need the fixture file, which preflight cannot read.
      // A pack that fails here is not written; the model has to fix it and ask again.
      const problems = packFixtureProblems(pack, { kickoffLocal: fixture.kickoffLocal, homeName });
      if (problems.length) throw new Error(problems.join("; "));
      const { unchanged } = await writePack(join(opts.packsDir, ctx.tenantId), pack, ctx.runId);
      return { saved: true, unchanged, fixtureId: pack.fixtureId };
    },
  });

  return [fixturesGet, teamStats, packSave] as [
    typeof fixturesGet,
    typeof teamStats,
    typeof packSave,
  ];
}

/** Writes one tenant's pack. The same content is left untouched. */
export async function writePack(
  dir: string,
  pack: Pack,
  runId: string,
): Promise<{ unchanged: boolean }> {
  const file = join(dir, `${pack.fixtureId}.json`);
  const body = packRecord(pack);
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12);
  const existing = await readFile(file, "utf8")
    .then((raw) => JSON.parse(raw) as { hash?: string })
    .catch(() => undefined);
  if (existing?.hash === hash) return { unchanged: true };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ ...body, hash, runId }, null, 2));
  return { unchanged: false };
}
