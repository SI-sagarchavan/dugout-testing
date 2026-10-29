import type { RunMemoryContext } from "@dugout/contracts";
import { loadSkill } from "./skills.ts";
import type { MemoryReader } from "./store.ts";

/** Share of the model's context window that retrieved memory may use. */
export const MEMORY_SHARE = 0.12;

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface BuildContextOptions {
  reader: MemoryReader;
  skillsDir: string;
  skills: string[];
  tenantId: string;
  agentId: string;
  /** Text to find similar episodes with, usually the run input. */
  query: string;
  budgetTokens: number;
  readSemantic: boolean;
  readEpisodic: boolean;
  episodes?: number;
}

/**
 * Assembles skills, active facts and similar past episodes, in that priority, and stops adding
 * items once the next one would pass the budget. Items are dropped whole, never cut.
 */
export async function buildContext(opts: BuildContextOptions): Promise<RunMemoryContext> {
  const sections: string[] = [];
  const sources: RunMemoryContext["sources"] = [];
  let used = 0;
  const fits = (tokens: number) => used + tokens <= opts.budgetTokens;

  for (const name of opts.skills) {
    const skill = await loadSkill(opts.skillsDir, name, opts.tenantId);
    const text = `## Skill: ${name}\n\n${skill.content}`;
    const tokens = estimateTokens(text);
    if (!fits(tokens)) throw new Error(`skill ${name} alone exceeds the memory budget`);
    sections.push(text);
    sources.push({ id: `skill:${name}`, kind: "procedural", tokens });
    used += tokens;
  }

  const addList = (title: string, lines: Array<{ id: string; kind: string; line: string }>) => {
    const kept: string[] = [];
    for (const item of lines) {
      const tokens = estimateTokens(item.line) + 1;
      if (!fits(tokens + estimateTokens(title))) break;
      kept.push(item.line);
      sources.push({ id: item.id, kind: item.kind, tokens });
      used += tokens;
    }
    if (kept.length > 0) {
      sections.push(`${title}\n\n${kept.join("\n")}`);
      used += estimateTokens(title);
    }
  };

  if (opts.readSemantic) {
    const facts = await opts.reader.activeFacts(opts.tenantId, opts.agentId);
    addList(
      "## House facts\n\nThese are reviewed facts for this tenant. Follow them.",
      facts.map((f) => ({ id: f.id, kind: "semantic", line: `- ${f.content}` })),
    );
  }

  if (opts.readEpisodic) {
    const episodes = await opts.reader.search({
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      query: opts.query,
      kinds: ["episodic"],
      limit: opts.episodes ?? 5,
    });
    addList(
      "## Lessons from past runs\n\nReviewer feedback on earlier drafts for this tenant. Don't repeat these mistakes.",
      episodes.map((e) => ({
        id: e.id,
        kind: "episodic",
        line: `- (${e.createdAt.slice(0, 10)}) ${e.content}`,
      })),
    );
  }

  return { text: sections.join("\n\n"), tokens: used, sources };
}
