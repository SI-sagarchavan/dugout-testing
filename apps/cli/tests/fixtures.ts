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

/** The sitemap agent's workflow, decided from the transcript; a change request moves the Fan Zone. */
export function sitemapWriter(): Array<(req: ModelRequest) => ScriptedTurn> {
  const sitemap = (fanZone: string) => ({
    pages: [
      { name: "News", slug: "news", children: [{ name: "News Detail", dynamic: true }] },
      { name: "Fan Zone", slug: fanZone },
      { name: "404", slug: "404" },
    ],
    navigation: [
      { name: "Home", url: "/" },
      { name: "News", url: "/news" },
      { name: "Fan Zone", url: `/${fanZone}` },
    ],
  });
  const turn = (req: ModelRequest): ScriptedTurn => {
    const taken = req.messages.filter((m) => m.role === "assistant").length;
    if (taken === 0) return { toolCalls: [{ name: "pages.catalog", arguments: {} }] };
    if (taken === 1)
      return { toolCalls: [{ name: "sitemap.validate", arguments: sitemap("fan-zone") }] };
    if (taken === 2)
      return { toolCalls: [{ name: "sitemap.save", arguments: sitemap("fan-zone") }] };
    // the reviewer's change request arrives as a user message
    if (req.messages.at(-1)?.role === "user")
      return { toolCalls: [{ name: "sitemap.save", arguments: sitemap("fanzone") }] };
    // ends with what was saved last
    const saved = req.messages
      .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
      .findLast((c) => c.name === "sitemap.save");
    return { toolCalls: [{ name: "final", arguments: JSON.parse(saved?.arguments ?? "{}") }] };
  };
  return Array.from({ length: 10 }, () => turn);
}
