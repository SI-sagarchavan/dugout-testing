import type { RunMemoryContext } from "@dugout/contracts";
import { groupLabel } from "./shared.ts";
import { loadSkill } from "./skills.ts";
import type { MemoryItem, MemoryReader } from "./store.ts";
import { SKILL_TOOL } from "./tools.ts";

/** Share of the model's context window that retrieved memory may use. */
export const MEMORY_SHARE = 0.12;

/** Default caps, in tokens, on recalled lessons and examples, and on house and shared facts. */
export const RECALLED_BUDGET_TOKENS = 6_000;
export const FACTS_BUDGET_TOKENS = 6_000;

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
  /** What skills and the rest may use together; skills must fit it, or the build fails. */
  budgetTokens: number;
  /** Cap on lessons and approved examples (the recalled memory). Skills don't count. */
  recalledBudgetTokens?: number;
  /** Cap on house and shared facts. Skills don't count. */
  factsBudgetTokens?: number;
  /** The date shown to the model; the real clock unless a test sets it. */
  now?: Date;
  readSemantic: boolean;
  readEpisodic: boolean;
  episodes?: number;
}

/**
 * Assembles skills, the skills there are to load, active facts, similar lessons and approved
 * examples, in that priority. Skills, the list and facts make `text`, the stable instructions;
 * lessons and examples make `recalled`, which depends on the input and goes in the first user
 * message, after the cached system prompt. Skills and the list must fit the budget; facts and
 * recalled items stop being added once the next one would pass their own cap (or the budget).
 * Items are dropped whole, never cut.
 */
export async function buildContext(opts: BuildContextOptions): Promise<RunMemoryContext> {
  const sections: string[] = [];
  const recalledSections: string[] = [];
  const sources: RunMemoryContext["sources"] = [];
  let used = 0;
  const fits = (tokens: number) => used + tokens <= opts.budgetTokens;
  const facts = { used: 0, cap: opts.factsBudgetTokens ?? FACTS_BUDGET_TOKENS };
  const recalled = { used: 0, cap: opts.recalledBudgetTokens ?? RECALLED_BUDGET_TOKENS };

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
    into: string[],
    bucket: { used: number; cap: number },
    title: string,
    lines: ListItem[],
  ) => {
    const kept: string[] = [];
    const titleTokens = estimateTokens(title);
    for (const item of lines) {
      const tokens = estimateTokens(item.line) + 1;
      if (bucket.used + tokens + titleTokens > bucket.cap || !fits(tokens + titleTokens)) break;
      kept.push(item.line);
      sources.push({ id: item.id, kind: item.kind, tokens, text: item.text });
      used += tokens;
      bucket.used += tokens;
    }
    if (kept.length > 0) {
      into.push(`${title}\n\n${kept.join("\n")}`);
      used += titleTokens;
      bucket.used += titleTokens;
    }
  };

  const groups = opts.groups ?? [];
  if (opts.readSemantic) {
    const active = await opts.reader.activeFacts(opts.tenantId, groups);
    const own = active.filter((f) => f.tenantId !== null);
    addList(
      sections,
      facts,
      "## House facts\n\nThese are reviewed facts for this tenant. Follow them.",
      own.map((f) => ({ id: f.id, kind: "semantic", line: `- ${f.content}`, text: f.content })),
    );
    // a key the tenant has is its own; a sport's rule wins over the rule for every tenant
    const taken = new Set(own.map((f) => f.key));
    for (const scope of [...groups].reverse()) {
      const shared = active.filter((f) => f.sharedScope === scope && !taken.has(f.key));
      for (const f of shared) taken.add(f.key);
      addList(
        sections,
        facts,
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
    for (const list of await recallLists(opts, groups)) {
      addList(recalledSections, recalled, list.title, list.items);
    }
  }

  return {
    text: sections.join("\n\n"),
    // only for an agent that reads episodic memory; the date is why it is there with nothing to recall
    recalled: opts.readEpisodic ? recalledBlock(opts.now ?? new Date(), recalledSections) : "",
    tokens: used,
    sources,
  };
}

/** Most examples a run is shown; each is a whole approved input. */
export const MAX_EXAMPLES = 2;

interface ListItem {
  id: string;
  kind: string;
  line: string;
  text: string;
}

/**
 * The memory recalled for this run's input: lessons, then approved examples. Kept apart from the
 * rest of `buildContext` because it is the part that depends on the input, not the tenant.
 */
async function recallLists(
  opts: BuildContextOptions,
  groups: string[],
): Promise<Array<{ title: string; items: ListItem[] }>> {
  const recall = { tenantId: opts.tenantId, agentId: opts.agentId, query: opts.query };
  const lessons = await opts.reader.recallEpisodes({
    ...recall,
    groups,
    episodeType: "lesson",
    limit: opts.episodes ?? 5,
  });
  const examples = await opts.reader.recallEpisodes({
    ...recall,
    episodeType: "example",
    limit: MAX_EXAMPLES,
  });
  return [
    {
      title:
        "## Lessons from past runs\n\nReviewer feedback on earlier drafts, this tenant's and some learned across clients. Don't repeat these mistakes.",
      items: lessons.map((e) => ({
        id: e.id,
        kind: "episodic",
        line: lessonLine(e),
        text: lessonLine(e).replace(/^- /, ""),
      })),
    },
    {
      title:
        "## Approved examples\n\nPast work an editor approved. Use it for style and structure only. Never copy its facts, names or numbers.",
      items: examples.map((e) => ({
        id: e.id,
        kind: "episodic",
        line: `- (${e.createdAt.slice(0, 10)}) ${e.content}`,
        text: e.content,
      })),
    },
  ];
}

/** The recalled memory as one message-sized block, marked so the model reads it as data. */
function recalledBlock(now: Date, sections: string[]): string {
  const date = `Today is ${now.toISOString().slice(0, 10)}.`;
  return `<recalled_memory>\n${[date, ...sections].join("\n\n")}\n</recalled_memory>`;
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
