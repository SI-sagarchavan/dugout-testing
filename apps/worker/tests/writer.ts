import type { ModelRequest } from "@dugout/contracts";
import type { ScriptedTurn } from "@dugout/core";

/**
 * A stand-in match-preview writer that decides from the transcript, as a real model does, so a run
 * resumed in a new invocation (with a new model client) carries on where it was.
 */
export function writer(): Array<(req: ModelRequest) => ScriptedTurn> {
  const turn = (req: ModelRequest): ScriptedTurn => {
    const taken = req.messages.filter((m) => m.role === "assistant").length;
    if (taken === 0) {
      return {
        content: "Looking up the fixture.",
        toolCalls: [{ name: "fixtures.get", arguments: { fixtureId: "c-101" } }],
      };
    }
    if (taken === 1) {
      const f = JSON.parse(req.messages.at(-1)?.content ?? "{}") as { home: string };
      return { toolCalls: [{ name: "team.stats", arguments: { teamId: f.home } }] };
    }
    if (taken === 2) {
      const body = "A measured preview of both sides.";
      const args = { fixtureId: "c-101", title: "Mariners v Chargers", body };
      return { toolCalls: [{ name: "draft.save", arguments: args }] };
    }
    return { content: "Saved." };
  };
  return Array.from({ length: 10 }, () => turn);
}
