import type { ModelRequest } from "@dugout/contracts";
import type { ScriptedTurn } from "@dugout/core";

/**
 * A stand-in writer that decides from the transcript, as a real model does, so a run resumed in a
 * new invocation (with a new model client) carries on where it was.
 */
export function writer(): Array<(req: ModelRequest) => ScriptedTurn> {
  const save = (body: string): ScriptedTurn => ({
    toolCalls: [
      {
        name: "draft.save",
        arguments: { topicId: "t-101", title: "Season opener", body },
      },
    ],
  });
  const turn = (req: ModelRequest): ScriptedTurn => {
    const taken = req.messages.filter((m) => m.role === "assistant").length;
    const last = req.messages.at(-1);
    if (taken === 0) {
      return {
        content: "Looking up the topic.",
        toolCalls: [{ name: "topics.get", arguments: { topicId: "t-101" } }],
      };
    }
    if (taken === 1) {
      const t = JSON.parse(last?.content ?? "{}") as { topicId: string };
      return { toolCalls: [{ name: "topics.history", arguments: { topicId: t.topicId } }] };
    }
    if (taken === 2) return save("A measured draft about the whole topic.");
    // when the reviewer asks for changes (a user message), save again with them
    if (last?.role === "user")
      return save("A measured draft about the whole topic, naming the captains.");
    return { content: "Saved." };
  };
  return Array.from({ length: 10 }, () => turn);
}

/** What the asking drafter asks before it writes: a choice and a text question. */
export const DRAFT_QUESTIONS = [
  {
    id: "tone",
    question: "Which tone should the draft take?",
    why: "The brief does not say",
    kind: "choice",
    options: [
      { value: "measured", label: "Measured", description: "" },
      { value: "excited", label: "Excited", description: "Opening-day energy" },
    ],
    allowOther: false,
    proposed: ["measured"],
  },
  {
    id: "title",
    question: "What should the draft be called?",
    why: "No title was given",
    kind: "text",
    options: [],
    allowOther: false,
    proposed: ["Season opener"],
  },
];

/** The writer, asking a person two questions first (ADR 0029); then as `writer` does. */
export function askingWriter(): Array<(req: ModelRequest) => ScriptedTurn> {
  const [base] = writer() as [(req: ModelRequest) => ScriptedTurn];
  const turn = (req: ModelRequest): ScriptedTurn => {
    const at = req.messages.findIndex((m) => m.role === "assistant");
    if (at === -1)
      return { toolCalls: [{ name: "ask", arguments: { questions: DRAFT_QUESTIONS } }] };
    // the answers are the ask's tool result; from there on it is the writer's run
    return base({ ...req, messages: req.messages.filter((_, i) => i !== at && i !== at + 1) });
  };
  return Array.from({ length: 10 }, () => turn);
}
