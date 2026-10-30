import type { RunMemoryContext } from "@dugout/contracts";
import { groupLabel } from "./shared.ts";
import { loadSkill } from "./skills.ts";
import type { MemoryItem, MemoryReader } from "./store.ts";
import { SKILL_TOOL } from "./tools.ts";

/** Share of the model's context window that retrieved memory may use. */
export const MEMORY_SHARE = 0.12;

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface BuildContextOptions {
  reader: MemoryReader;
  skillsDir: string;
  /** Put in the instructions in full. */
  skills: string[];
  /** Listed by name and description, for the agent to load with `skill.load`. */
  onDemandSkills: string[];
  tenantId: string;
  /** The shared scopes the tenant reads too, most general first (`memoryGroups`). */
  groups?: string[];
  agentId: string;
  /** Text to find similar episodes with, usually the run input. */
  query: string;
  budgetTokens: number;
  readSemantic: boolean;
  readEpisodic: boolean;
  episodes?: number;
}

/**
 * Assembles skills, the skills there are to load, active facts and similar past episodes, in that
 * priority. Skills and the list must fit the budget; facts and episodes stop being added once the
 * next one would pass it. Items are dropped whole, never cut.
 */
export async function buildContext(opts: BuildContextOptions): Promise<RunMemoryContext> {
  const sections: string[] = [];
  const sources: RunMemoryContext["sources"] = [];
  let used = 0;
  const fits = (tokens: number) => used + tokens <= opts.budgetTokens;

  for (const name of opts.skills) {
    const skill = await loadSkill(opts.skillsDir, name);
    const text = `## Skill: ${name}\n\n${skill.content}`;
    const tokens = estimateTokens(text);
    if (!fits(tokens)) throw new Error(`skill ${name} alone exceeds the memory budget`);
    sections.push(text);
    sources.push({
      id: `skill:${name}`,
      kind: "procedural",
      tokens,
      text: `skill ${name} (loaded in full): ${opening(skill.content)}`,
    });
    used += tokens;
  }

  if (opts.onDemandSkills.length > 0) {
    const lines = await Promise.all(
      opts.onDemandSkills.map(async (name) => {
        const { description } = await loadSkill(opts.skillsDir, name);
        if (!description) throw new Error(`skill ${name} is loaded on demand: add a description`);
        return `- ${name}: ${description}`;
      }),
    );
    const text = [
      "## Skills you can load",
      `Only their descriptions are here. When the task needs one, call ${SKILL_TOOL} with its name to get its instructions.`,
      lines.join("\n"),
    ].join("\n\n");
    const tokens = estimateTokens(text);
    if (!fits(tokens)) throw new Error("the skills to load don't fit the memory budget");
    sections.push(text);
    for (const [i, name] of opts.onDemandSkills.entries()) {
      const line = lines[i] ?? name;
      sources.push({
        id: `skill:${name}`,
        kind: "procedural",
        tokens: estimateTokens(line),
        text: line.replace(/^- /, ""),
      });
    }
    used += tokens;
  }

  const addList = (
    title: string,
    lines: Array<{ id: string; kind: string; line: string; text: string }>,
  ) => {
    const kept: string[] = [];
    for (const item of lines) {
      const tokens = estimateTokens(item.line) + 1;
      if (!fits(tokens + estimateTokens(title))) break;
      kept.push(item.line);
      sources.push({ id: item.id, kind: item.kind, tokens, text: item.text });
      used += tokens;
    }
    if (kept.length > 0) {
      sections.push(`${title}\n\n${kept.join("\n")}`);
      used += estimateTokens(title);
    }
  };

  const groups = opts.groups ?? [];
  if (opts.readSemantic) {
    const facts = await opts.reader.activeFacts(opts.tenantId, groups);
    const own = facts.filter((f) => f.tenantId !== null);
    addList(
      "## House facts\n\nThese are reviewed facts for this tenant. Follow them.",
      own.map((f) => ({ id: f.id, kind: "semantic", line: `- ${f.content}`, text: f.content })),
    );
    // a key the tenant has is its own; a sport's rule wins over the rule for every tenant
    const taken = new Set(own.map((f) => f.key));
    for (const scope of [...groups].reverse()) {
      const shared = facts.filter((f) => f.sharedScope === scope && !taken.has(f.key));
      for (const f of shared) taken.add(f.key);
      addList(
        `## Shared with ${groupLabel(scope)}\n\nReviewed rules learned across clients. Where a house fact above disagrees, follow the house fact.`,
        shared.map((f) => ({
          id: f.id,
          kind: "semantic",
          line: `- ${f.content}`,
          text: `${f.content} — ${groupLabel(scope)}`,
        })),
      );
    }
  }

  if (opts.readEpisodic) {
    const recall = { tenantId: opts.tenantId, agentId: opts.agentId, query: opts.query };
    const lessons = await opts.reader.recallEpisodes({
      ...recall,
      groups,
      episodeType: "lesson",
      limit: opts.episodes ?? 5,
    });
    addList(
      "## Lessons from past runs\n\nReviewer feedback on earlier drafts, this tenant's and some learned across clients. Don't repeat these mistakes.",
      lessons.map((e) => ({
        id: e.id,
        kind: "episodic",
        line: lessonLine(e),
        text: lessonLine(e).replace(/^- /, ""),
      })),
    );
    const runs = await opts.reader.recallEpisodes({ ...recall, episodeType: "run", limit: 3 });
    addList(
      "## Similar past runs\n\nHow earlier runs like this one for this tenant ended.",
      runs.map((e) => ({
        id: e.id,
        kind: "episodic",
        line: `- (${e.createdAt.slice(0, 10)}) ${e.content}`,
        text: `(${e.createdAt.slice(0, 10)}) ${e.content}`,
      })),
    );
  }

  return { text: sections.join("\n\n"), tokens: used, sources };
}

/** The first paragraph, on one line: enough to recognise a skill without printing the whole file. */
function opening(text: string): string {
  const paragraph = text.split(/\n\s*\n/)[0] ?? text;
  return paragraph.replace(/\s+/g, " ").trim();
}

function lessonLine(e: MemoryItem): string {
  if (e.sharedScope) return `- (from ${e.strength} clients) ${e.content}`;
  const times = e.strength > 1 ? `, ${e.strength} times` : "";
  return `- (${e.lastSeenAt.slice(0, 10)}${times}) ${e.content}`;
}
