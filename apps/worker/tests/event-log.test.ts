import { randomUUID } from "node:crypto";
import type { RunEvent } from "@dugout/contracts";
import { Valkey } from "iovalkey";
import { afterAll, describe, expect, it } from "vitest";
import { createValkeyEventLog } from "../src/index.ts";

const valkey = new Valkey(process.env.VALKEY_TEST_URL || "redis://localhost:56379/1");
const events = createValkeyEventLog(valkey, { keyPrefix: `test:${randomUUID()}:` });
const made: string[] = [];

afterAll(async () => {
  if (made.length > 0) await valkey.del(...made);
  valkey.disconnect();
});

const event = (runId: string, seq: number, type: string, data: unknown) =>
  ({ runId, seq, at: new Date(seq * 1000).toISOString(), type, data }) as RunEvent;

describe("the tenant's feed", () => {
  it("carries a run's events but not its streamed fragments, which stay on the run's own stream", async () => {
    const tenant = `t-${randomUUID()}`;
    const runId = randomUUID();
    made.push(
      events.feedKey(tenant),
      `${events.feedKey(tenant).split("tenant:")[0]}run:${runId}:events`,
    );
    const written = [
      event(runId, 1, "run.started", { agentId: "drafter" }),
      event(runId, 2, "token", { step: 1, text: "Hel" }),
      event(runId, 3, "tool.input.delta", { step: 1, callId: "c1", delta: '{"a"' }),
      event(runId, 4, "step.completed", { step: 1 }),
    ];
    for (const e of written) {
      await events.sink().write(e);
      await events.feedSink(tenant).write(e);
    }

    const feed = await valkey.xrange(events.feedKey(tenant), "-", "+");
    const onFeed = feed.map(([, fields]) => {
      const at = fields.indexOf("data");
      return {
        kind: fields[fields.indexOf("type") + 1],
        event: JSON.parse(fields[at + 1] ?? "null"),
      };
    });
    // every entry is a run's event, as the host reads the feed
    expect(onFeed.map((f) => f.kind)).toEqual(["run.event", "run.event"]);
    expect(onFeed.map((f) => f.event.type)).toEqual(["run.started", "step.completed"]);
    // a client that follows the run reads the fragments from the run's stream, gapless by seq
    expect((await events.read(runId, 0)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});
