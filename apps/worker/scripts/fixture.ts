// pnpm fixture waiting-run --tenant sb [--open ask|review] [--stream-only]
//
// A run that has stopped for a person (ADR 0029), written as a worker leaves one, without running a
// model: a `runs` row (status waiting), its checkpoint with the open questions, its events in
// `run_events` and in the Valkey stream, an earlier round already answered, and a child run's
// question passed up. For building and testing a host (the FanXP backend's run routes, the admin
// app's queue) against real data: list it, stream it, answer it through `POST …/answers`.
//
// The run's agent is `fixture`, which no worker serves, so an answer queues the run and nothing
// resumes it: the row shows what the host wrote. Use `--open review` for a write waiting for a yes.
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { AskedQuestion, RunCheckpoint, RunEvent } from "@dugout/contracts";
import { reviewQuestion } from "@dugout/contracts";
import { loadEnv } from "@dugout/core";
import { createPool, withTenant } from "@dugout/db";
import { Valkey } from "iovalkey";
import { LOCAL_VALKEY_URL } from "../src/index.ts";

loadEnv();
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tenant: { type: "string" },
    open: { type: "string", default: "ask" },
  },
});
if (positionals[0] !== "waiting-run" || !values.tenant) {
  console.error("usage: pnpm fixture waiting-run --tenant <client code> [--open ask|review]");
  process.exit(2);
}
const tenant = values.tenant;
const openReview = values.open === "review";

const runId = randomUUID();
const childId = randomUUID();
const handoffId = randomUUID();
const now = Date.now();
let seq = 0;
const events: RunEvent[] = [];
const at = (offsetMs: number) => new Date(now - 60_000 + offsetMs).toISOString();
const emit = (type: RunEvent["type"], data: unknown, offsetMs: number, id = runId) => {
  seq += 1;
  events.push({ runId: id, seq, at: at(offsetMs), type, data } as RunEvent);
};

const usage = {
  inputTokens: 1200,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 90,
  reasoningTokens: 0,
  costUsd: 0.0123,
  budgetCostUsd: 0.0123,
  steps: 2,
};

const SB = "https://www.southernbrave.co.uk";
const asked: AskedQuestion[] = [
  {
    id: "content",
    question:
      "The design shows video cards, but the only hook returns articles. What should the cards show?",
    why: "dugout_cricket_south_coast_stories has an image and a date for each item: no video URL, no duration. A connector for videos exists (fanxp-seed-api-cms-video-detail).",
    kind: "choice",
    options: [
      {
        value: "build",
        label: "Build a video hook",
        description: "A new dugout_ hook from the video connector, then bind it",
      },
      {
        value: "articles",
        label: "Use the articles",
        description: "Bind what exists; duration and video stay as designed",
      },
    ],
    allowOther: false,
    proposed: ["build"],
  },
  {
    id: "image_domain",
    question: "Which domain serves the CMS images?",
    why: "The image paths are relative (/static-assets/a.png), so the page needs a domain in front.",
    kind: "choice",
    options: [{ value: SB, label: "southernbrave.co.uk", description: "Used in 3 earlier runs" }],
    allowOther: true,
    proposed: [SB],
    learned: { times: 3, lastAt: at(-86_400_000) },
  },
  {
    id: "cards",
    question: "How many cards should the strip show?",
    why: "The design draws 4 cards and the hook returns 6 items.",
    kind: "number",
    options: [],
    allowOther: false,
    proposed: ["4"],
  },
];

emit(
  "run.started",
  { agentId: "fixture", agentVersion: 1, tenantId: tenant, input: { handoffId } },
  0,
);
for (const [i, text] of ["Reading ", "the handoff, ", "then binding."].entries()) {
  emit("token", { step: 1, text }, 100 + i * 50);
}
emit(
  "step.completed",
  {
    step: 1,
    message: {
      role: "assistant",
      content: "Reading the handoff, then binding.",
      toolCalls: [{ id: "call_1", name: "agent.hookMaker", arguments: "{}" }],
    },
    usage: { ...usage, costUsd: 0.004, budgetCostUsd: 0.004 },
    servedModel: "fixture",
    finishReason: "tool_use",
  },
  400,
);
emit("tool.started", { step: 1, callId: "call_1", tool: "agent.hookMaker", input: {} }, 500);
// a question from a child run, passed up: answered earlier, by a person
emit(
  "question.asked",
  { step: 1, callId: "call_1", tool: "agent.hookMaker", questions: asked, from: [childId] },
  600,
);
emit(
  "question.answered",
  {
    step: 1,
    callId: "call_1",
    tool: "agent.hookMaker",
    by: "sagar",
    answers: { content: "build", image_domain: SB, cards: 4 },
    source: "person",
  },
  9_000,
);
emit(
  "tool.completed",
  {
    step: 1,
    callId: "call_1",
    tool: "agent.hookMaker",
    ok: true,
    content: '{"hookId":"dugout_cms_videos"}',
    durationMs: 8000,
  },
  12_000,
);

const writeCall = { step: 2, callId: "call_2", tool: "bind.publish" };
let waiting: NonNullable<RunCheckpoint["waiting"]>;
if (openReview) {
  // as the loop leaves it: the write is asked about before it starts
  const subject = { input: { bound: 10, collapsed: 2, problems: ["a placeholder stays: 09:11"] } };
  waiting = {
    ...writeCall,
    input: subject.input,
    questions: [reviewQuestion("bind.publish")],
    from: [],
    subject,
  };
  emit("question.asked", { ...writeCall, questions: waiting.questions, from: [], subject }, 13_500);
} else {
  const second: AskedQuestion[] = [
    {
      id: "countdown",
      question:
        "The design counts down to a kick-off and the data has no start timestamp. What should the digits do?",
      why: "dugout_cms_videos gives a date but no instant to count to.",
      kind: "choice",
      options: [
        { value: "keep", label: "Leave them as designed", description: "02 : 24 : 12 : 33 stays" },
        { value: "hide", label: "Hide the clock", description: "The block is not shown" },
      ],
      allowOther: false,
      proposed: ["keep"],
    },
    {
      id: "featured",
      question: "Feature the first card?",
      why: "The design draws the first card larger than the rest.",
      kind: "confirm",
      options: [],
      allowOther: false,
      proposed: ["yes"],
    },
  ];
  waiting = {
    step: 2,
    callId: "call_2",
    tool: "ask",
    input: { questions: second },
    questions: second,
    from: [],
  };
  emit(
    "question.asked",
    { step: 2, callId: "call_2", tool: "ask", questions: second, from: [] },
    13_500,
  );
}

const checkpoint: RunCheckpoint = {
  version: 1,
  agentId: "fixture",
  agentVersion: 1,
  step: 2,
  usage,
  messages: 0,
  lastSeq: seq,
  invalidOutputs: 0,
  blockedFinishes: 0,
  wrote: false,
  pendingChanges: {},
  waiting,
  savedAfter: "waiting",
};

const pool = createPool();
await withTenant(pool, tenant, async (db) => {
  await db.query(
    `insert into runs (id, tenant_id, agent_id, status, input, created_at, updated_at)
     values ($1, $2, 'fixture', 'waiting', $3, $4, now())`,
    [runId, tenant, { handoffId }, at(0)],
  );
  for (const e of events) {
    if (e.type === "token") continue; // streamed text lives in Valkey only
    await db.query(
      `insert into run_events (run_id, seq, tenant_id, type, data, at) values ($1, $2, $3, $4, $5, $6)`,
      [runId, e.seq, tenant, e.type, e.data, e.at],
    );
  }
  await db.query(
    `insert into run_checkpoints (run_id, tenant_id, checkpoint) values ($1, $2, $3)`,
    [runId, tenant, checkpoint],
  );
});
await pool.end();

const valkey = new Valkey(process.env.VALKEY_URL || LOCAL_VALKEY_URL);
const key = `${process.env.VALKEY_KEY_PREFIX ?? ""}run:${runId}:events`;
for (const e of events) await valkey.xadd(key, `0-${e.seq}`, "e", JSON.stringify(e));
await valkey.expire(key, 7 * 24 * 3600);
valkey.disconnect();

console.log(
  `waiting run ${runId} for ${tenant}, open: ${openReview ? "a write review" : "a 2-question ask"}`,
);
console.log(
  `  ${events.length} events (seq 1-${seq}), an earlier round answered, a child run's question passed up`,
);
console.log(
  `  waiting.callId = ${waiting.callId}; answer with { callId, answers } at POST …/runs/${runId}/answers`,
);
console.log(`  stream:  redis-cli -p 56379 xrange ${key} - +`);
