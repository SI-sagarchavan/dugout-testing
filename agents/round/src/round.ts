import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineProgram, TENANTS_DIR } from "@dugout/core";

export const CHANNELS = ["social", "push", "headline"] as const;
export type Channel = (typeof CHANNELS)[number];

/** One fixture's matchday run, merged into the slate by fixture id. */
export interface SlatePack {
  fixtureId: string;
  status: string;
  output: unknown;
}

export interface RoundState extends Record<string, unknown> {
  fixtureIds: string[];
  packs: SlatePack[];
}

export interface RoundRequest {
  /** Fixture ids, in the order the slate should keep. */
  fixtures: string[];
  brief?: string;
  channels?: Channel[];
  /** How many matchday tasks run at once. Defaults to 2. */
  concurrency?: number;
}

const finished = (output: unknown) => {
  const status = (output as { status?: string } | null)?.status;
  return status === "completed" || status === "rejected" || status === "failed";
};

/**
 * One round: list the fixtures, run matchday for each (a task, so each has its own transcript),
 * then merge their results into one slate. Code ends every task; a rejected or failed fixture
 * stays in the slate and the others still run.
 */
export function defineRoundProgram(request: RoundRequest) {
  const concurrency = request.concurrency ?? 2;
  return defineProgram<RoundState>({
    id: "round",
    initial: { fixtureIds: [], packs: [] },
    fields: {
      fixtureIds: { reduce: "replace" },
      packs: { reduce: "merge", id: "fixtureId" },
    },
    run: async (ctx) => {
      await ctx.step("list", async () => ({ fixtureIds: request.fixtures }));
      await ctx.all(
        concurrency,
        ctx.state.fixtureIds.map(
          (fixtureId) => () =>
            ctx.task(fixtureId, {
              agentId: "matchday",
              input: {
                fixtureId,
                ...(request.brief ? { brief: request.brief } : {}),
                ...(request.channels ? { channels: request.channels } : {}),
              },
              until: finished,
              maxAttempts: 1,
            }),
        ),
      );
      await ctx.step("slate", async (state) => ({
        packs: state.fixtureIds.map((fixtureId) => {
          const output = ctx.result(fixtureId) as { status?: string } | undefined;
          return { fixtureId, status: output?.status ?? "missing", output };
        }),
      }));
    },
  });
}

/** The tenant's published fixtures, in file order. */
export async function listFixtures(tenantId: string, dataDir = TENANTS_DIR): Promise<string[]> {
  const raw = await readFile(join(dataDir, tenantId, "fixtures.json"), "utf8");
  const { fixtures } = JSON.parse(raw) as { fixtures: Array<{ fixtureId: string }> };
  return fixtures.map((fixture) => fixture.fixtureId);
}
