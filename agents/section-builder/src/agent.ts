import { join } from "node:path";
import { agent as bind, type Result as DataOutput } from "@dugout/agent-data-bind";
import {
  type Result as FrameOutput,
  agent as frameMatch,
  RunInput,
} from "@dugout/agent-frame-match";
import type { AgentSpec, Message } from "@dugout/contracts";
import { defineAgent, type Pipeline } from "@dugout/sdk";
import { z } from "zod";

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
    `1. Call ${BUILD} once. A person approves it once; that covers everything it does.`,
    "2. Call final with a one-sentence summary of what page.build did. The result itself is page.build's, filled in by code: do not write a link or a number of your own.",
    "",
    "If page.build fails, read why. It names the stage that failed and what it said. A stage that finished is not done again, so you may call page.build again, and a person approves that. After three failures of one stage it is not tried again: say so in your answer, with the reason, and stop. A failure that needs setup (a sign-in, a key) ends the run by itself: nothing you call changes it. Never invent a preview link or a result.",
  ].join("\n"),
  tools: [],
  skills: [],
  onDemandSkills: [],
  // the work is in the two agents it runs; this one only starts the pass and reports it
  model: "haiku",
  memory: { read: [], write: [] },
  // frame-match and bind each have their own limit; this covers both, and bind's researcher and builder
  budget: { usdPerRun: 3, maxSteps: 8, maxDepth: 1 },
  approvals: ["effect:write"],
};

const Choice = z.object({
  key: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })),
  initial: z.string(),
});

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
  measured: z.boolean().describe("False when too little of the frame has a screenshot to compare"),
  coverage: z.number().describe("Share of the frame a compared screenshot covers, 0 to 100"),
  before: z.number().optional().describe("Match before the frame was fixed, 0 to 100"),
  match: z.number().optional().describe("Match of the published frame, 0 to 100"),
  bound: z.number().describe("Props bound to data"),
  collapsed: z.number().describe("Lists the binding made"),
  remaining: z
    .array(z.string())
    .describe("Everything still off, each starting with the part it is about: frame or data"),
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

/** One answer from the two stages, as the pass hands it over. No data stage: nothing was data. */
export function assemble(frame: FrameOutput, given?: DataOutput): Output {
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
  return [
    o.data === "none"
      ? `Built the section from the Handoff and published its preview: ${match}; nothing on it is data, so nothing was bound.${writes}`
      : `Built the section from the Handoff and published its preview with data bound: ${match}; ${o.bound} props bound to data, ${o.collapsed} lists.${writes}`,
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

/** The pass: the two agents, in this order, and nothing for the model to decide. */
export const pipeline: Pipeline = {
  name: BUILD,
  description:
    "Runs the whole pass for this Handoff, in order: matches the frame to its screenshot and publishes it, then finds (or builds) the data in Cast and binds it, unless nothing on the section is data. Takes no arguments. Answers with the one preview and everything still off.",
  async run(call, input) {
    const { exportId, handoffId, project } = RunInput.parse(input);
    const frame = (await call(
      frameMatch,
      handoffId ? { handoffId, project } : { exportId, project },
    )) as FrameOutput;
    // a heading, tabs and a button: nothing to find in Cast, nothing to bind
    if (frame.content?.data === "none") return assemble(frame);
    const data = (await call(bind, { preview: frame.previewUrl })) as DataOutput;
    return assemble(frame, data);
  },
};

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
