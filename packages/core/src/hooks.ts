import {
  type AfterModel,
  type AfterTool,
  type AgentDefinition,
  type BeforeFinal,
  type BeforeModel,
  defineHook,
  type Message,
  type RunCheckpoint,
  type RunHook,
} from "@dugout/contracts";
import { SpecError } from "./errors.ts";

/** The same call failing this many times in a row ends the run. */
export const MAX_SAME_FAILURES = 3;
/** Asks for the result; the turn after it must be `final`. */
export const FINAL_NUDGE = "Call the final tool with your result.";

/** Two turns left: one to spare for a mistake, then the last. */
const stepsLeft = defineHook<{ warned: boolean }>({
  id: "stepsLeft",
  initial: { warned: false },
  beforeModel({ step, maxSteps, hasOutput }, state) {
    if (maxSteps - (step - 1) !== 2 || state.warned) return undefined;
    return {
      state: { warned: true },
      append: [
        {
          role: "user",
          content: `2 model turns left. Finish now.${hasOutput ? "\nCall final with your result." : ""}`,
        },
      ],
    };
  },
});

/** What to say when a turn made no tool call and the run goes on. */
const nudges = defineHook<undefined>({
  id: "nudges",
  afterModel(turn: AfterModel) {
    if (turn.toolCalls > 0) return undefined;
    if (turn.cutOff) {
      return { nudge: `Your reply was cut off (${turn.finishReason}). Send it again, shorter.` };
    }
    const pending = Object.entries(turn.pendingChanges);
    if (pending.length > 0) {
      return {
        nudge: pending.map(([tool, changes]) => changesMessage(tool, changes)).join("\n\n"),
      };
    }
    return turn.hasOutput ? { nudge: FINAL_NUDGE } : undefined;
  },
});

interface Repeats {
  refused?: { tool: string; args: string } | undefined;
  failed?: { tool: string; args: string; count: number } | undefined;
}

/** One refusal is feedback. The same call again is the model stuck, so the run stops. */
const repeatedCalls = defineHook<Repeats>({
  id: "repeatedCalls",
  initial: {},
  afterTool(event: AfterTool, state) {
    const { call, args } = event;
    if (event.stage === "denied") {
      if (state.refused?.tool === call.name && state.refused.args === args) {
        return { stop: `${call.name} was refused, and the same call was sent again unchanged` };
      }
      return { state: { ...state, refused: { tool: call.name, args } } };
    }
    if (event.stage === "cleared") {
      return state.refused ? { state: { ...state, refused: undefined } } : undefined;
    }
    if (event.ok) return state.failed ? { state: { ...state, failed: undefined } } : undefined;
    const count =
      state.failed?.tool === call.name && state.failed.args === args ? state.failed.count + 1 : 1;
    const next = { ...state, failed: { tool: call.name, args, count } };
    return count >= MAX_SAME_FAILURES
      ? { state: next, stop: `${call.name} failed ${MAX_SAME_FAILURES} times with the same input` }
      : { state: next };
  },
});

/** The agent's own check of its result. */
const verifyFinal = (agent: AgentDefinition) =>
  defineHook<undefined>({
    id: "verifyFinal",
    beforeFinal({ value, ctx, messages }: BeforeFinal) {
      const refuse = agent.verifyFinal?.(value, { ctx, messages: messages as Message[] });
      return refuse === undefined ? undefined : { refuse };
    },
  });

/** What the reviewer says, as the user, when they send a call back for changes. */
export function changesMessage(tool: string, changes: string): string {
  return [
    `I reviewed your ${tool} call and did not approve it yet. Please change this: ${JSON.stringify(changes)}`,
    `Make only that change and keep everything else exactly as it was, then call ${tool} again with the full updated input.`,
    "This request takes priority over the brief and your earlier choices.",
    `Only if ${tool} itself would refuse the change (it fails validation), call ${tool} again with the closest input it accepts; I will decide.`,
  ].join("\n");
}

/** The harness's own hooks, which run first. */
export const harnessHooks = (agent: AgentDefinition): RunHook[] => [
  stepsLeft,
  nudges,
  repeatedCalls,
  verifyFinal(agent),
];

/** A run saved before hooks kept these in checkpoint fields of their own. */
export function carryOverLegacyState(state: RunCheckpoint): void {
  const hooks = state.hooks ?? {};
  if (state.stepsWarned && !("stepsLeft" in hooks)) hooks.stepsLeft = { warned: true };
  if ((state.refused || state.failedCall) && !("repeatedCalls" in hooks)) {
    hooks.repeatedCalls = {
      ...(state.refused ? { refused: state.refused } : {}),
      ...(state.failedCall ? { failed: state.failedCall } : {}),
    };
  }
  state.stepsWarned = undefined;
  state.refused = undefined;
  state.failedCall = undefined;
  if (Object.keys(hooks).length > 0) state.hooks = hooks;
}

export interface Hooks {
  beforeModel(event: Omit<BeforeModel, "messages">, messages: Message[]): HookedView;
  afterModel(event: AfterModel): string | undefined;
  /** A message when a hook ends the run. */
  afterTool(event: AfterTool): string | undefined;
  /** The reason when a hook refuses the `final`. */
  beforeFinal(event: BeforeFinal): string | undefined;
}
export interface HookedView {
  /** Added to the transcript by hooks, in order. */
  append: Message[];
  /** What to send: the transcript with the hooks' views applied. */
  view: Message[];
}

/**
 * Runs the hooks of a run in order, the harness's first. Their state lives in `state.hooks`, so a
 * resumed run starts from where the saved one was. A hook that throws ends the run with an error
 * that names it.
 */
export function createHooks(all: RunHook[], state: RunCheckpoint): Hooks {
  const seen = new Set<string>();
  for (const hook of all) {
    if (!hook.id) throw new SpecError("a hook has no id");
    if (seen.has(hook.id)) throw new SpecError(`two hooks are called ${hook.id}`);
    seen.add(hook.id);
  }

  const read = (hook: RunHook): unknown =>
    state.hooks && hook.id in state.hooks
      ? state.hooks[hook.id]
      : hook.initial === undefined
        ? undefined
        : structuredClone(hook.initial);
  const write = (hook: RunHook, next: unknown) => {
    state.hooks = { ...state.hooks, [hook.id]: next };
  };
  const run = <T extends { state?: unknown }>(
    hook: RunHook,
    phase: string,
    call: () => T | undefined,
  ): T | undefined => {
    let outcome: T | undefined;
    try {
      outcome = call();
    } catch (err) {
      throw new Error(
        `hook ${hook.id} threw in ${phase}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (outcome && "state" in outcome) write(hook, outcome.state);
    return outcome;
  };

  return {
    beforeModel(event, messages) {
      const append: Message[] = [];
      let view: Message[] = messages;
      for (const hook of all) {
        const out = hook.beforeModel
          ? run(hook, "beforeModel", () =>
              hook.beforeModel?.({ ...event, messages: view }, read(hook)),
            )
          : undefined;
        if (out?.append?.length) {
          append.push(...out.append);
          view = [...view, ...out.append];
        }
        if (out?.view) view = out.view;
      }
      return { append, view };
    },
    afterModel(event) {
      const nudges: string[] = [];
      for (const hook of all) {
        const out = hook.afterModel
          ? run(hook, "afterModel", () => hook.afterModel?.(event, read(hook)))
          : undefined;
        if (out?.nudge) nudges.push(out.nudge);
      }
      return nudges.length > 0 ? nudges.join("\n\n") : undefined;
    },
    afterTool(event) {
      let stop: string | undefined;
      for (const hook of all) {
        const out = hook.afterTool
          ? run(hook, "afterTool", () => hook.afterTool?.(event, read(hook)))
          : undefined;
        stop ??= out?.stop;
      }
      return stop;
    },
    beforeFinal(event) {
      for (const hook of all) {
        const out = hook.beforeFinal
          ? run(hook, "beforeFinal", () => hook.beforeFinal?.(event, read(hook)))
          : undefined;
        if (out?.refuse !== undefined) return out.refuse;
      }
      return undefined;
    },
  };
}
