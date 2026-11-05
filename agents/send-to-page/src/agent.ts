import { join } from "node:path";
import { agent as bind, type Output as DataOutput } from "@dugout/agent-bind";
import { agent as cardMatch, type Output as FrameOutput, RunInput } from "@dugout/agent-card-match";
import type { AgentSpec, Message } from "@dugout/contracts";
import { defineAgent, type Pipeline } from "@dugout/sdk";
import { z } from "zod";

/** The one tool: it runs the whole pass, in a fixed order, and answers with the whole result. */
const BUILD = "page.build";

export const spec: AgentSpec = {
  id: "send-to-page",
  version: 1,
  owner: "fanos-content",
  description:
    "Turns a designer's Send into one page preview with its data bound: the frame matched to its screenshot and published (card-match), then the data found, or built, in Cast and bound to it (bind). One run, one result, one preview.",
  instructions: [
    "A designer pressed Send in the Figma plugin. The whole job is one tool: page.build. It runs in a fixed order, so you do not choose the steps: the frame is matched to its screenshot and published, then the data it shows is found in Cast, or built there, and bound to it. It takes no arguments.",
    "",
    `1. Call ${BUILD} once. A person approves it once; that covers everything it does.`,
    "2. Call final. Every field is copied from what page.build returned: do not write a link or a number of your own.",
    "",
    "If page.build fails, read why. It names the stage that failed and what it said. A stage that finished is not done again, so you may call page.build again, and a person approves that. After three failures of one stage it is not tried again: say so in your answer, with the reason, and stop. Never invent a preview link or a result.",
  ].join("\n"),
  tools: [],
  skills: [],
  onDemandSkills: [],
  // the work is in the two agents it runs; this one only starts the pass and reports it
  model: "haiku",
  memory: { read: [], write: [] },
  // card-match and bind each have their own limit; this covers both, and bind's researcher and builder
  budget: { usdPerRun: 3, maxSteps: 8, maxDepth: 1 },
  approvals: ["effect:write"],
};

export const Output = z.object({
  previewUrl: z.string().describe("The preview with its data bound: the one thing handed over"),
  treeArtifactId: z.string(),
  planArtifactId: z.string(),
  dataArtifactId: z.string(),
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
});
export type Output = z.infer<typeof Output>;

/** One answer from the two stages, as the pass hands it over. */
export function assemble(frame: FrameOutput, data: DataOutput): Output {
  return {
    previewUrl: data.previewUrl,
    treeArtifactId: frame.treeArtifactId,
    planArtifactId: data.planArtifactId,
    dataArtifactId: data.dataArtifactId,
    measured: frame.measured,
    coverage: frame.coverage,
    ...(frame.before !== undefined ? { before: frame.before } : {}),
    ...(frame.match !== undefined ? { match: frame.match } : {}),
    bound: data.bound,
    collapsed: data.collapsed,
    remaining: [
      ...(frame.unmeasuredBecause
        ? [`frame: nothing was compared: ${frame.unmeasuredBecause}`]
        : []),
      ...frame.remaining.map((item) => `frame: ${item}`),
      ...data.remaining.map((item) => `data: ${item}`),
    ],
    compilerFindings: frame.compilerFindings,
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
    "Runs the whole pass for this Send, in order: matches the frame to its screenshot and publishes it, then finds (or builds) the data in Cast and binds it. Takes no arguments. Answers with the one preview and everything still off.",
  async run(call, input) {
    const { exportId, project } = RunInput.parse(input);
    const frame = (await call(cardMatch, { exportId, project })) as FrameOutput;
    const data = (await call(bind, { preview: frame.previewUrl })) as DataOutput;
    return assemble(frame, data);
  },
};

export const agent = defineAgent({
  spec,
  input: RunInput,
  output: Output,
  completeFinal,
  verifyFinal,
  dir: join(import.meta.dirname, ".."),
  tools: () => [],
  agents: [cardMatch, bind],
  pipeline,
  cli: {
    flags: { export: "exportId" },
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
        "One pass for this Send: the frame is matched to its screenshot and published, then the data it shows is found in Cast (a new dugout_… hook is built there if none fits) and bound to it. No existing hook of Cast's is changed.",
      ].join("\n");
    },
  },
});
