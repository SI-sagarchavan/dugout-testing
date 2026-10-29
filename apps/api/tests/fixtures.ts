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
        arguments: { fixtureId: "c-101", title: "Mariners v Chargers", body },
      },
    ],
  });
  const turn = (req: ModelRequest): ScriptedTurn => {
    const taken = req.messages.filter((m) => m.role === "assistant").length;
    const last = req.messages.at(-1);
    if (taken === 0) {
      return {
        content: "Looking up the fixture.",
        toolCalls: [{ name: "fixtures.get", arguments: { fixtureId: "c-101" } }],
      };
    }
    if (taken === 1) {
      const f = JSON.parse(last?.content ?? "{}") as { home: string };
      return { toolCalls: [{ name: "team.stats", arguments: { teamId: f.home } }] };
    }
    if (taken === 2) return save("A measured preview of both sides.");
    // when the reviewer asks for changes (a user message), save again with them
    if (last?.role === "user")
      return save("A measured preview of both sides, naming both captains.");
    return { content: "Saved." };
  };
  return Array.from({ length: 10 }, () => turn);
}
