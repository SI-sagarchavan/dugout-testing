import { join } from "node:path";
import {
  agent as bind,
  type Result as DataOutput,
  type Dsl,
  loadDsl,
} from "@dugout/agent-data-bind";
import {
  type ControlPlane,
  createControlPlane,
  type Result as FrameOutput,
  agent as frameMatch,
  RunInput,
} from "@dugout/agent-frame-match";
import {
  type AgentSpec,
  type AskedQuestion,
  AwaitingAnswers,
  type Message,
  NeedsSetup,
} from "@dugout/contracts";
import { defineAgent, type Pipeline, type PipelineContext } from "@dugout/sdk";
import { z } from "zod";
import { mergeBindings, type PlanParts } from "./merge.ts";

/** The one tool: it runs the whole pass, in a fixed order, and answers with the whole result. */
const BUILD = "page.build";

export const spec: AgentSpec = {
  id: "section-builder",
  version: 1,
  owner: "fanos-content",
  description:
    "Turns a designer's Handoff into one page preview with its data bound: the frame matched to its screenshot and published (frame-match), then the data found, or built, in Cast and bound to it (bind). A section with no data on it (a heading, tabs, a button) is handed over as frame-match published it, with nothing bound. One run, one result, one preview.",
  instructions: [
    "A designer pressed Handoff in the Figma plugin. The whole job is one tool: page.build. It runs in a fixed order, so you do not choose the steps: the frame is matched to its screenshot and published, then the data it shows is found in Cast, or built there, and bound to it. A section that shows no data skips the second stage. It takes no arguments.",
    "",
    `1. Call ${BUILD} once. It starts without asking anyone; people are asked only the questions a stage raises.`,
    "2. Call final with a one-sentence summary of what page.build did. The result itself is page.build's, filled in by code: do not write a link or a number of your own.",
    "",
    "If page.build fails, read why. It names the stage that failed and what it said. A stage that finished is not done again, so you may call page.build again. After three failures of one stage it is not tried again: say so in your answer, with the reason, and stop. A failure that needs setup (a sign-in, a key) ends the run by itself: nothing you call changes it. Never invent a preview link or a result.",
  ].join("\n"),
  tools: [],
  skills: [],
  onDemandSkills: [],
  // the work is in the two agents it runs; this one only starts the pass and reports it
  model: "haiku",
  memory: { read: [], write: [] },
  // frame-match and bind each have their own limit; this covers both, and bind's researcher and builder
  // each failed try of a stage (three at most per stage, per slot) is one more call of page.build
  budget: { usdPerRun: 3, maxSteps: 12, maxDepth: 1 },
  // starting the build asks nobody; a stage still stops for a person when it has a question
  approvals: [],
};

const Choice = z.object({
  key: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })),
  initial: z.string(),
  owner: z.string().optional().describe("The slot that draws it"),
});

/** What became of one slot of the frame. */
export const SlotOutput = z.object({
  name: z.string().describe("The slot's heading, slugged"),
  data: z
    .enum(["bound", "none", "failed", "skipped"])
    .describe(
      "none: nothing in it is data; failed: it could not be bound; skipped: a person chose not to bind it in this pass, for Cast's live-run budget",
    ),
  hookId: z.string().optional().describe("The Cast hook its data comes from"),
  bound: z.number(),
  collapsed: z.number(),
  remaining: z.array(z.string()),
});
export type SlotOutput = z.infer<typeof SlotOutput>;

export const Output = z.object({
  previewUrl: z.string().describe("The preview with its data bound: the one thing handed over"),
  treeArtifactId: z.string(),
  planArtifactId: z.string().describe("Empty when nothing was bound"),
  dataArtifactId: z.string().describe("Empty when nothing was bound"),
  data: z
    .enum(["bound", "none"])
    .default("bound")
    .describe("none: nothing on the section is data, so it was handed over with nothing bound"),
  dataWhy: z.array(z.string()).default([]).describe("Why the section was read as showing no data"),
  choices: z
    .array(Choice)
    .default([])
    .describe(
      "What the section's tabs write to its page (_page.<key>), for other sections to read",
    ),
  slots: z
    .array(SlotOutput)
    .default([])
    .describe("Each part of the frame that shows one kind of data, and what became of it"),
  measured: z.boolean().describe("False when too little of the frame has a screenshot to compare"),
  coverage: z.number().describe("Share of the frame a compared screenshot covers, 0 to 100"),
  before: z.number().optional().describe("Match before the frame was fixed, 0 to 100"),
  match: z.number().optional().describe("Match of the published frame, 0 to 100"),
  bound: z.number().describe("Props bound to data"),
  collapsed: z.number().describe("Lists the binding made"),
  remaining: z
    .array(z.string())
    .describe("Everything still off, each starting with the part it is about: frame or data"),
  kept: z
    .array(z.string())
    .default([])
    .describe(
      "What the binding left as designed on purpose, with why: the section's static parts, a look the data does not decide",
    ),
  compilerFindings: z.array(z.string()).describe("What the compiler should have done"),
  notes: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(["addressed", "not-addressed"]),
        detail: z.string(),
      }),
    )
    .default([])
    .describe("Each note the designer left: addressed by one of the stages, or why not"),
});
export type Output = z.infer<typeof Output>;

/**
 * What the model writes in `final`: one sentence. Everything else in the result is page.build's,
 * filled in by code (`completeFinal`), so none of it is in `final`'s grammar.
 */
export const Final = z.object({
  summary: z.string().describe("One sentence: what page.build did, or why it could not"),
});

type StageNote = { id: string; status: "addressed" | "not-addressed" | "not-mine"; detail: string };

/**
 * One answer for each note: addressed if either stage did it, else the reason the stage that owned
 * it gave. A note both stages left to the other (`not-mine`) is reported as not addressed, so the
 * reviewer sees it rather than a silence.
 */
export function mergeNotes(frame: StageNote[] = [], data: StageNote[] = []): Output["notes"] {
  const ids = [...new Set([...frame, ...data].map((n) => n.id))];
  return ids.map((id) => {
    const reports = [...frame, ...data].filter((n) => n.id === id);
    const done = reports.find((n) => n.status === "addressed");
    if (done) return { id, status: "addressed" as const, detail: done.detail };
    const refused = reports.find((n) => n.status === "not-addressed");
    return {
      id,
      status: "not-addressed" as const,
      detail: refused?.detail ?? "neither stage took this note",
    };
  });
}

/** A frame of one slot: what became of it, from the two stages' answers. */
function oneSlot(frame: FrameOutput, data: DataOutput): SlotOutput[] {
  const only = frame.slots?.[0];
  const hook = data.sources?.find((s) => typeof s.hookId === "string");
  return [
    {
      name: only?.name ?? "section",
      data: data.static ? "none" : "bound",
      ...(typeof hook?.hookId === "string" ? { hookId: hook.hookId } : {}),
      bound: data.bound,
      collapsed: data.collapsed,
      remaining: data.remaining,
    },
  ];
}

/** One answer from the two stages, as the pass hands it over. No data stage: nothing was data. */
export function assemble(frame: FrameOutput, given?: DataOutput, slots?: SlotOutput[]): Output {
  const data: DataOutput = given ?? {
    static: true,
    previewUrl: frame.previewUrl,
    planArtifactId: "",
    dataArtifactId: "",
    bound: 0,
    collapsed: 0,
    remaining: [],
    notes: [],
  };
  const notes = mergeNotes(frame.notes, data.notes);
  return {
    previewUrl: data.previewUrl || frame.previewUrl,
    treeArtifactId: frame.treeArtifactId,
    planArtifactId: data.planArtifactId,
    dataArtifactId: data.dataArtifactId,
    data: data.static ? "none" : "bound",
    dataWhy: data.static
      ? given
        ? ["the binding stage found nothing on it to bind"]
        : (frame.content?.evidence ?? [])
      : [],
    choices: frame.choices ?? [],
    slots: slots ?? oneSlot(frame, data),
    measured: frame.measured,
    coverage: frame.coverage,
    ...(frame.before !== undefined ? { before: frame.before } : {}),
    ...(frame.match !== undefined ? { match: frame.match } : {}),
    bound: data.bound,
    collapsed: data.collapsed,
    remaining: [
      ...notes
        .filter((n) => n.status === "not-addressed")
        .map((n) => `note ${n.id}: not addressed: ${n.detail}`),
      ...(frame.unmeasuredBecause
        ? [`frame: nothing was compared: ${frame.unmeasuredBecause}`]
        : []),
      ...frame.remaining.map((item) => `frame: ${item}`),
      ...data.remaining.map((item) => `data: ${item}`),
    ],
    kept: data.kept ?? [],
    compilerFindings: frame.compilerFindings,
    notes,
  };
}

/** What `page.build` returned in this run, or undefined. */
export function builtIn(messages: Message[]): Output | undefined {
  const calls = new Set<string>();
  let found: Output | undefined;
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) if (call.name === BUILD) calls.add(call.id);
    } else if (message.role === "tool" && calls.has(message.toolCallId) && !message.isError) {
      try {
        found = Output.parse(JSON.parse(message.content));
      } catch {
        // not a result of the pass
      }
    }
  }
  return found;
}

/** Every field is the pass's: the host writes it over whatever the model sent. */
/** What a run did, for its thread's note (ADR 0031): the next run on the section starts from it. */
export function threadNote(_input: unknown, output: unknown): string | undefined {
  const parsed = Output.safeParse(output);
  if (!parsed.success) return undefined;
  const o = parsed.data;
  const match =
    o.measured && o.match !== undefined
      ? `the frame matches its screenshot ${o.match}%${o.before !== undefined ? ` (from ${o.before}%)` : ""}`
      : "the frame was not measured against a screenshot";
  const missed = o.notes.filter((n) => n.status === "not-addressed");
  const writes = o.choices.length
    ? ` Its tabs write ${o.choices.map((c) => `_page.${c.key} (${c.options.map((x) => x.value).join(", ")})`).join(", ")} for the page's other sections to read.`
    : "";
  const parts =
    o.slots.length > 1
      ? ` Slots: ${o.slots.map((s) => `${s.name} ${s.data === "bound" ? `bound (${s.bound} props${s.hookId ? `, from ${s.hookId}` : ""})` : s.data === "none" ? "has no data" : s.data === "skipped" ? "not bound in this pass (Cast budget)" : "failed"}`).join("; ")}.`
      : "";
  return [
    o.data === "none"
      ? `Built the section from the Handoff and published its preview: ${match}; nothing on it is data, so nothing was bound.${writes}${parts}`
      : `Built the section from the Handoff and published its preview with data bound: ${match}; ${o.bound} props bound to data, ${o.collapsed} lists.${writes}${parts}`,
    missed.length
      ? `Designer notes not met: ${missed.map((n) => `${n.id} (${n.detail})`).join("; ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function completeFinal(_output: unknown, run: { messages: Message[] }): unknown {
  return builtIn(run.messages);
}

export function verifyFinal(output: unknown, run: { messages: Message[] }): string | undefined {
  return builtIn(run.messages) || output === undefined
    ? undefined
    : `${BUILD} has not completed in this run. Call it first, and answer with what it returns.`;
}

/**
 * Cast allows 25 live runs an hour to a person, shared by every agent. A slot looks its hook up (a
 * few runs) and may build one (more). When the slots of a pass could spend more than an hour
 * holds, a person is asked once before any is bound (`cast_budget`): bind them all, the first few,
 * or none. It is an estimate, not a count: Cast does not say what is left of the hour.
 */
export const CAST_RUNS_PER_HOUR = 25;
export const CAST_RUNS_PER_SLOT = 6;
export const CAST_BUDGET_QUESTION = "cast_budget";

/** How many slots an hour's live runs cover, at the estimate. */
const slotsAnHourCovers = () => Math.max(1, Math.floor(CAST_RUNS_PER_HOUR / CAST_RUNS_PER_SLOT));

export function castBudgetQuestion(slots: string[]): AskedQuestion {
  const first = slotsAnHourCovers();
  return {
    id: CAST_BUDGET_QUESTION,
    kind: "choice",
    question: `Bind all ${slots.length} parts of this frame to Cast data now?`,
    why: `${slots.length} parts show data (${slots.join(", ")}). Finding or building each one's hook may use about ${CAST_RUNS_PER_SLOT} of Cast's live runs, ${slots.length * CAST_RUNS_PER_SLOT} in all, and Cast allows ${CAST_RUNS_PER_HOUR} an hour to a person, shared with every agent.`,
    options: [
      {
        value: "first",
        label: `Bind the first ${first}`,
        description: `The others are published with the designer's copy and listed as not bound.`,
      },
      {
        value: "all",
        label: "Bind them all",
        description: "Some may fail if Cast's hour runs out; they are listed with why.",
      },
      {
        value: "none",
        label: "Bind none now",
        description: "The frame is published as matched, with nothing bound.",
      },
    ],
    allowOther: false,
    proposed: ["first"],
  };
}

/** Which of the slots with data to bind now: all, unless a person chose fewer for Cast's budget. */
export function slotsToBind<T>(binding: T[], own: PipelineContext = {}): T[] {
  if (binding.length * CAST_RUNS_PER_SLOT <= CAST_RUNS_PER_HOUR) return binding;
  const answer = own.answered?.answers[CAST_BUDGET_QUESTION];
  if (answer === undefined) {
    throw new AwaitingAnswers([
      castBudgetQuestion(binding.map((s) => (s as { name?: string }).name ?? "a part")),
    ]);
  }
  if (answer === "all") return binding;
  if (answer === "none") return [];
  return binding.slice(0, slotsAnHourCovers());
}

/** The pass: the two agents, in this order, and nothing for the model to decide. */
export function makePipeline(
  deps: { plane?: (project: string) => ControlPlane; dsl?: () => Promise<Dsl> } = {},
): Pipeline {
  const planeOf = deps.plane ?? ((project: string) => createControlPlane(project));
  const dslOf = deps.dsl ?? loadDsl;
  return {
    name: BUILD,
    noApproval: true,
    // one slot's hook is looked up, or built, at a time: Cast's live runs are few and shared
    concurrency: 1,
    description:
      "Runs the whole pass for this Handoff, in order: matches the frame to its screenshot and publishes it, then finds (or builds) the data in Cast and binds it, unless nothing on the section is data. A frame of several parts that each show data (a strip of fixtures over a squad) binds each part on its own and publishes once. Takes no arguments. Answers with the one preview and everything still off.",
    async run(call, input, own) {
      const { exportId, handoffId, project } = RunInput.parse(input);
      const frame = (await call(
        frameMatch,
        handoffId ? { handoffId, project } : { exportId, project },
      )) as FrameOutput;
      const slots = frame.slots ?? [];
      if (slots.length < 2) {
        // a heading, tabs and a button: nothing to find in Cast, nothing to bind
        if (frame.content?.data === "none") return assemble(frame);
        const data = (await call(bind, { preview: frame.previewUrl })) as DataOutput;
        return assemble(frame, data);
      }
      return fanOut(frame, call, planeOf(project), dslOf, own);
    },
  };
}

/** Whether a call's failure is final: its child has been tried as often as it is tried. */
const exhausted = (err: unknown) => /not tried again/.test((err as Error)?.message ?? "");

async function fanOut(
  frame: FrameOutput,
  call: Parameters<Pipeline["run"]>[0],
  plane: ControlPlane,
  dslOf: () => Promise<Dsl>,
  own: PipelineContext = {},
): Promise<Output> {
  const slots = frame.slots ?? [];
  const withData = slots.filter((s) => s.content.data !== "none");
  if (withData.length === 0) return assemble(frame, undefined, slots.map(noData));
  // a person is asked once when the slots could spend more of Cast than an hour holds
  const binding = slotsToBind(withData, own);
  const chosen = new Set(binding.map((s) => s.id));
  const deferred = withData.filter((s) => !chosen.has(s.id));
  const settled = await Promise.allSettled(
    binding.map((s) =>
      call(
        bind,
        {
          preview: frame.previewUrl,
          slot: {
            id: s.id,
            name: s.name,
            nodes: s.nodes,
            signature: s.signature,
            content: s.content,
            readFrom: [],
          },
        },
        { key: s.id },
      ),
    ),
  );
  // a pause for a person, or a setup, is the pass's: the answers come back to the one that asked
  for (const r of settled) {
    if (
      r.status === "rejected" &&
      (r.reason instanceof AwaitingAnswers || r.reason instanceof NeedsSetup)
    ) {
      throw r.reason;
    }
  }
  // a slot with tries left is tried again by calling the pass again; the others are kept
  const open = settled.find((r) => r.status === "rejected" && !exhausted(r.reason));
  if (open?.status === "rejected") throw open.reason;

  const reports = new Map<string, SlotOutput>([
    ...slots.filter((s) => s.content.data === "none").map((s) => [s.name, noData(s)] as const),
    ...deferred.map((s) => [s.name, skipped(s)] as const),
  ]);
  const parts: Array<{ name: string; data: DataOutput; report: SlotOutput }> = [];
  settled.forEach((r, i) => {
    const slot = binding[i];
    if (!slot) return;
    if (r.status === "rejected") {
      reports.set(slot.name, {
        name: slot.name,
        data: "failed",
        bound: 0,
        collapsed: 0,
        remaining: [(r.reason as Error).message],
      });
      return;
    }
    const data = r.value as DataOutput;
    const hook = data.sources?.find((x) => typeof x.hookId === "string");
    const report: SlotOutput = {
      name: slot.name,
      data: data.static ? "none" : "bound",
      ...(typeof hook?.hookId === "string" ? { hookId: hook.hookId } : {}),
      bound: data.bound,
      collapsed: data.collapsed,
      remaining: data.remaining,
    };
    reports.set(slot.name, report);
    if (!data.static) parts.push({ name: slot.name, data, report });
  });

  const out = (given: DataOutput | undefined) =>
    assemble(
      frame,
      given,
      slots.map((s) => reports.get(s.name) as SlotOutput),
    );
  const failedLines = [...reports.values()]
    .filter((r) => r.data === "failed" || r.data === "skipped")
    .map((r) => `${r.name}: not bound: ${r.remaining[0] ?? "it failed"}`);
  const notes = parts.flatMap((p) => p.data.notes);
  if (parts.length === 0) {
    const none = out(undefined);
    return { ...none, remaining: [...none.remaining, ...failedLines.map((l) => `data: ${l}`)] };
  }

  // the slots' plans, side by side, over every slot's data: published once
  const loaded = await Promise.all(
    parts.map(async (p) => ({
      name: p.name,
      plan: (await plane.json(p.data.planArtifactId)) as PlanParts,
      bag: (await plane.json(p.data.dataArtifactId)) as Record<string, unknown>,
    })),
  );
  const merged = mergeBindings(loaded);
  const kept = new Set(merged.merged);
  for (const refused of merged.refused) {
    const report = reports.get(refused.name);
    if (report) {
      report.data = "failed";
      report.remaining = [`left out of the page: ${refused.why}`];
    }
  }
  const problems = await checkMerged(plane, dslOf, frame.treeArtifactId, merged.plan);
  const used = parts.filter((p) => kept.has(p.name));
  const sources = used.flatMap((p) => p.data.sources ?? []);
  const meta = {
    source: "dugout:section-builder",
    preview: frame.previewUrl,
    slots: used.map((p) => p.name),
    data: sources,
  };
  const dataArtifactId = await plane.upload("sample_data", merged.bag, meta);
  const planArtifactId = await plane.upload("binding_plan", merged.plan, meta);
  const link = new URL(frame.previewUrl);
  link.searchParams.set("data", dataArtifactId);
  link.searchParams.set("plan", planArtifactId);
  const given: DataOutput = {
    previewUrl: link.toString(),
    planArtifactId,
    dataArtifactId,
    bound: used.reduce((n, p) => n + p.data.bound, 0),
    collapsed: used.reduce((n, p) => n + p.data.collapsed, 0),
    kept: used.flatMap((p) => p.data.kept ?? []),
    remaining: [
      ...used.flatMap((p) => p.data.remaining.map((item) => `${p.name}: ${item}`)),
      ...[...reports.values()]
        .filter((r) => r.data === "failed" || r.data === "skipped")
        .map((r) => `${r.name}: not bound: ${r.remaining[0] ?? "it failed"}`),
      ...problems.map((item) => `the merged plan: ${item}`),
    ],
    notes,
  };
  return out(given);
}

const noData = (s: NonNullable<FrameOutput["slots"]>[number]): SlotOutput => ({
  name: s.name,
  data: "none",
  bound: 0,
  collapsed: 0,
  remaining: [],
});

const skipped = (s: NonNullable<FrameOutput["slots"]>[number]): SlotOutput => ({
  name: s.name,
  data: "skipped",
  bound: 0,
  collapsed: 0,
  remaining: [
    "a person chose to spare Cast's live runs in this pass; it shows the designer's copy",
  ],
});

/** The merged plan applied to the published tree: what would be wrong on the page, in words. */
async function checkMerged(
  plane: ControlPlane,
  dslOf: () => Promise<Dsl>,
  treeArtifactId: string,
  plan: PlanParts,
): Promise<string[]> {
  try {
    const dsl = await dslOf();
    const tree = (await plane.json(treeArtifactId)) as Parameters<Dsl["applyBindingPlan"]>[0];
    const applied = dsl.applyBindingPlan(tree, plan);
    return [
      ...applied.drift.map((d) => `not applied: ${d.message}`),
      ...dsl.check(applied.tree).map((i) => `the tree is invalid: ${i.message}`),
    ];
  } catch (err) {
    return [`could not be checked: ${(err as Error).message}`];
  }
}

export const pipeline: Pipeline = makePipeline();

export const agent = defineAgent({
  spec,
  input: RunInput,
  output: Final,
  result: Output,
  completeFinal,
  verifyFinal,
  threadNote,
  dir: join(import.meta.dirname, ".."),
  tools: () => [],
  agents: [frameMatch, bind],
  pipeline,
  cli: {
    flags: { export: "exportId", handoff: "handoffId" },
    present: (req) => {
      const input = req.input as {
        retry?: { stage?: string; attempt: number; of: number; lastFailure: string };
      };
      return [
        `── ${req.tool} ──`,
        ...(input.retry
          ? [
              `TRY ${input.retry.attempt} OF ${input.retry.of} of ${input.retry.stage ?? "a stage"}: the last try failed. Approve only if another try is worth it.`,
              `Failure: ${input.retry.lastFailure}`,
            ]
          : []),
        "One pass for this Handoff: the frame is matched to its screenshot and published, then the data it shows is found in Cast (a new dugout_… hook is built there if none fits) and bound to it. No existing hook of Cast's is changed.",
      ].join("\n");
    },
  },
});
