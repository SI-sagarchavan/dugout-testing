import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent as matchday, type Pack } from "@dugout/agent-matchday";
import type { ModelRequest } from "@dugout/contracts";
import {
  createScriptedModel,
  type ProgramCheckpoint,
  runProgram,
  scriptedModelConfig,
  type TaskRunner,
} from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup";
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { agentIds, seedHouseFacts } from "@dugout/sdk";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { defineRoundProgram, listFixtures, type RoundState } from "../src/round.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
beforeAll(() => seedHouseFacts(store, ["demo-cricket"]));

describe("round program", () => {
  it("lists the tenant's fixtures and leaves the agent registry to defineAgent folders", async () => {
    expect(await listFixtures("demo-cricket")).toEqual([
      "c-101",
      "c-102",
      "c-103",
      "c-104",
      "c-105",
    ]);
    expect(await agentIds()).not.toContain("round");
    expect(await agentIds()).toEqual(
      expect.arrayContaining(["matchday", "match-preview", "sitemap"]),
    );
  });

  it("runs matchday tasks two at a time and keeps a failed fixture in the slate", async () => {
    const program = defineRoundProgram({ fixtures: ["c-101", "c-102", "c-103"], concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    const release: Record<string, (output: { status: string }) => void> = {};
    const tasks: TaskRunner = (req) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        release[req.id] = (output) => {
          active -= 1;
          resolve({ status: "completed", output });
        };
      });
    };
    const running = runProgram(program, { tasks });
    await waitFor(() => Object.keys(release).length >= 2);
    expect(maxActive).toBe(2);
    release["c-101"]?.({ status: "completed" });
    release["c-102"]?.({ status: "failed" });
    await waitFor(() => release["c-103"] !== undefined);
    release["c-103"]?.({ status: "completed" });
    const { state } = await running;
    expect(state.packs.map((pack) => [pack.fixtureId, pack.status])).toEqual([
      ["c-101", "completed"],
      ["c-102", "failed"],
      ["c-103", "completed"],
    ]);
  });

  it("resumes finished matchday tasks and then writes the slate", async () => {
    const program = defineRoundProgram({ fixtures: ["c-101", "c-102"], concurrency: 1 });
    let crash = true;
    const calls: string[] = [];
    const tasks: TaskRunner = async (req) => {
      calls.push(req.id);
      if (crash && req.id === "c-102") throw new Error("worker died");
      return { status: "completed", output: { status: "completed", fixtureId: req.id } };
    };
    let saved: ProgramCheckpoint<RoundState> | undefined;
    await expect(
      runProgram(program, {
        tasks,
        save: (checkpoint) => {
          saved = checkpoint;
        },
      }),
    ).rejects.toThrow("worker died");
    expect(calls).toEqual(["c-101", "c-102"]);
    if (!saved) throw new Error("no checkpoint");

    calls.length = 0;
    crash = false;
    const { state } = await runProgram(program, { tasks, resume: saved });
    expect(calls).toEqual(["c-102"]);
    expect(state.packs.map((pack) => pack.fixtureId)).toEqual(["c-101", "c-102"]);
    expect(state.packs.every((pack) => pack.status === "completed")).toBe(true);
  });
});

describe("round running matchday", () => {
  it("runs a scripted matchday for each fixture and saves both packs", async () => {
    const packsDir = await mkdtemp(join(tmpdir(), "round-packs-"));
    const runsDir = await mkdtemp(join(tmpdir(), "round-runs-"));
    const program = defineRoundProgram({ fixtures: ["c-101", "c-104"], concurrency: 2 });
    const { state } = await runProgram(program, {
      tasks: async (req) => {
        const input = req.input as { fixtureId: string };
        const result = await matchday.create({
          store,
          client: createScriptedModel(writerScript()),
          models: scriptedModelConfig(),
          packsDir,
          runsDir,
          consolidate: false,
        })({
          tenantId: "demo-cricket",
          input,
          approver: async () => ({ approved: true, by: "editor" }),
          runId: randomUUID(),
        });
        return { status: "completed", output: result };
      },
    });
    expect(state.packs.map((pack) => pack.status)).toEqual(["completed", "completed"]);
    const outputs = state.packs.map((pack) => (pack.output as { output: Pack }).output);
    expect(outputs.map((pack) => pack.fixtureId)).toEqual(["c-101", "c-104"]);
    expect(outputs[0]?.preview.title).toContain("Mumbai");
    expect(outputs[1]?.preview.title).toContain("Chennai");
  });
});

function writerScript() {
  let fixture: {
    fixtureId: string;
    venue: string;
    date: string;
    kickoffLocal: string;
    homeTeam: { name: string };
    awayTeam: { name: string };
  };
  return [
    (req: ModelRequest) => ({
      toolCalls: [
        {
          name: "fixtures.get",
          arguments: {
            fixtureId: JSON.parse(
              req.messages.find((message) => message.role === "user")?.content ?? "{}",
            ).fixtureId,
          },
        },
      ],
    }),
    (req: ModelRequest) => {
      fixture = JSON.parse(req.messages.at(-1)?.content ?? "{}");
      return {
        toolCalls: [
          { name: "team.stats", arguments: { teamId: "mum" } },
          { name: "team.stats", arguments: { teamId: "che" } },
        ],
      };
    },
    () => {
      const pack = packFor(fixture);
      return { toolCalls: [{ name: "pack.save", arguments: pack }] };
    },
    () => ({ toolCalls: [{ name: "final", arguments: packFor(fixture) }] }),
  ];
}

function packFor(fixture: {
  fixtureId: string;
  venue: string;
  date: string;
  kickoffLocal: string;
  homeTeam: { name: string };
  awayTeam: { name: string };
}): Pack {
  const { homeTeam, awayTeam } = fixture;
  return {
    fixtureId: fixture.fixtureId,
    channels: [],
    preview: {
      title: `${homeTeam.name} v ${awayTeam.name}`,
      body: `${homeTeam.name} host ${awayTeam.name} at ${fixture.venue} on ${fixture.date}, starting at ${fixture.kickoffLocal}.`,
    },
    social: null,
    push: null,
    headline: null,
  };
}

async function waitFor(ready: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}
