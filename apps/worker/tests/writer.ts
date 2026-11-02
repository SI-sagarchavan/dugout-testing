import type { ModelRequest } from "@dugout/contracts";
import type { ScriptedTurn } from "@dugout/core";

/**
 * A stand-in drafter that decides from the transcript, as a real model does, so a run
 * resumed in a new invocation (with a new model client) carries on where it was.
 */
export function writer(): Array<(req: ModelRequest) => ScriptedTurn> {
  const turn = (req: ModelRequest): ScriptedTurn => {
    const taken = req.messages.filter((m) => m.role === "assistant").length;
    if (taken === 0) {
      return {
        content: "Looking up the topic.",
        toolCalls: [{ name: "topics.get", arguments: { topicId: "t-101" } }],
      };
    }
    if (taken === 1) {
      const t = JSON.parse(req.messages.at(-1)?.content ?? "{}") as { topicId: string };
      return { toolCalls: [{ name: "topics.history", arguments: { topicId: t.topicId } }] };
    }
    if (taken === 2) {
      const body = "A measured draft about the whole topic.";
      const args = { topicId: "t-101", title: "Season opener", body };
      return { toolCalls: [{ name: "draft.save", arguments: args }] };
    }
    return { content: "Saved." };
  };
  return Array.from({ length: 10 }, () => turn);
}
