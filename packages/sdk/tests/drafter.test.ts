// What these tests ran against a product agent before: behaviour of the harness around an agent
// (tenant-scoped tools, long outputs by reference, an idempotent write, a stable prompt, a
// rejection that becomes a lesson), now on the test agent so no product agent is needed for it.
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest } from "@dugout/contracts";
import { approve, reject } from "@dugout/contracts";
import { createScriptedModel, type ScriptedTurn, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { seedHouseFacts } from "../src/index.ts";
import { drafter } from "../src/testing.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
beforeAll(() => seedHouseFacts(store, ["demo-cricket", "demo-football"]));

const lastTool = (req: ModelRequest) => JSON.parse(req.messages.at(-1)?.content ?? "{}");
const approves = async () => approve("x");

/** Follows the agent's workflow using whatever the tools return. */
function script(
  topicId: string,
  body = "A measured draft about this topic and how it came about.",
): Array<(req: ModelRequest) => ScriptedTurn> {
  let topic: { name: string };
  return [
    () => ({ toolCalls: [{ name: "topics.get", arguments: { topicId } }] }),
    (req) => {
      topic = lastTool(req);
      return { toolCalls: [{ name: "topics.history", arguments: { topicId } }] };
    },
    () => ({
      toolCalls: [{ name: "draft.save", arguments: { topicId, title: topic.name, body } }],
    }),
    () => ({ content: "Saved the draft." }),
  ];
}

let draftsDir: string;
let runsDir: string;
let suffix: string;
beforeEach(async () => {
  draftsDir = await mkdtemp(join(tmpdir(), "drafts-"));
  runsDir = await mkdtemp(join(tmpdir(), "runs-"));
  suffix = randomUUID().slice(0, 6);
});

const draft = (
  turns: Parameters<typeof createScriptedModel>[0],
  lessons?: () => Promise<string>,
) => {
  const client = createScriptedModel(turns);
  const run = drafter.create({
    store,
    client,
    models: scriptedModelConfig(),
    draftsDir,
    runsDir,
    // only the lesson test writes memory; anything else would pile up in the shared test database
    consolidate: lessons !== undefined,
    ...(lessons ? { lessons } : {}),
  });
  return { run, client };
};

describe("the test agent on the harness", () => {
  it("cannot read another tenant's topics", async () => {
    const { run, client } = draft([
      () => ({ toolCalls: [{ name: "topics.get", arguments: { topicId: "t-201" } }] }),
      () => ({ content: "Could not find it." }),
    ]);
    await run({ tenantId: "demo-cricket", input: { topicId: "t-201" }, responder: approves });
    expect(client.requests[1]?.messages.at(-1)?.content).toBe("Error: no topic t-201");
  });

  it("stores a long tool output and sends a reference to it", async () => {
    const { run, client } = draft(script("t-101"));
    await run({ tenantId: "demo-cricket", input: { topicId: "t-101" }, responder: approves });
    const history = lastTool(client.requests[2] as ModelRequest);
    expect(history.ref).toMatch(/^out-\d+$/);
    expect(history.preview).toContain('"name":"Season opener"');
  });

  it("saving the same draft twice changes nothing", async () => {
    for (let i = 0; i < 2; i++) {
      const { run, client } = draft(script("t-102"));
      await run({ tenantId: "demo-cricket", input: { topicId: "t-102" }, responder: approves });
      expect(JSON.parse(client.requests[3]?.messages.at(-1)?.content ?? "{}").unchanged).toBe(
        i === 1,
      );
    }
  });

  it("sends one system prompt for a tenant whatever the input, and the input after the recalled memory", async () => {
    const requests = [];
    for (const topicId of ["t-101", "t-102"]) {
      const { run, client } = draft(script(topicId));
      await run({ tenantId: "demo-cricket", input: { topicId }, responder: approves });
      requests.push(client.requests[0]);
    }
    // recalled memory depends on the input, so it can't be in the cached prefix
    expect(requests[0]?.messages[0]).toEqual(requests[1]?.messages[0]);
    for (const [i, topicId] of ["t-101", "t-102"].entries()) {
      const first = requests[i]?.messages[1]?.content ?? "";
      expect(first).toMatch(/^<recalled_memory>\nToday is \d{4}-\d{2}-\d{2}\./);
      expect(first.endsWith(`</recalled_memory>\n\n{"topicId":"${topicId}"}`)).toBe(true);
    }
  });

  it("remembers a rejection as a lesson in that tenant's next run only", async () => {
    const tenantId = "demo-cricket";
    const reason = `Don't call the topic a saga ${suffix}`;
    const lesson = `Never call a topic a saga ${suffix}.`;
    const first = draft(script("t-103", "An epic saga awaits."), async () => lesson);
    const rejected = await first.run({
      tenantId,
      input: { topicId: "t-103" },
      responder: async () => reject("editor", reason),
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.afterRunError).toBeUndefined();

    const second = draft(script("t-103"));
    await second.run({ tenantId, input: { topicId: "t-103" }, responder: approves });
    // a lesson is recalled memory: in the first user message with the input, never in the system prompt
    expect(second.client.requests[0]?.messages[0]?.content).not.toContain(lesson);
    expect(second.client.requests[0]?.messages[1]?.content).toContain(lesson);
    expect(second.client.requests[0]?.messages[1]?.content).toContain('{"topicId":"t-103"}');

    const other = draft(script("t-203"));
    await other.run({
      tenantId: "demo-football",
      input: { topicId: "t-203" },
      responder: approves,
    });
    expect(other.client.requests[0]?.messages[0]?.content).not.toContain(suffix);
    expect(other.client.requests[0]?.messages[1]?.content).not.toContain(suffix);

    await store.deleteBySourceRun(tenantId, rejected.runId);
  });
});
