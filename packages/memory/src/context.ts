import type { RunMemoryContext } from "@dugout/contracts";
import { groupLabel } from "./shared.ts";
import { loadSkill } from "./skills.ts";
import type { MemoryItem, MemoryReader } from "./store.ts";
import { SEARCH_TOOL, SKILL_TOOL } from "./tools.ts";

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
  /**
   * Key prefixes of the facts that go in the prompt (`memory.pin`, ADR 0034). Left out, every
   * fact does; given, the rest are one line and are searched.
   */
  pin?: string[];
  readEpisodic: boolean;
  episodes?: number;
  /**
   * The agent's own lessons a person approved as rules (`lesson.<hash>` facts, proposed the third
   * time a reviewer says the same): how it works, like a skill, so they go in its instructions
   * whether or not it reads house facts, and whatever its `pin`.
   */
  readLessons?: boolean;
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
  ): number => {
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
    // what did not fit is said, never dropped in silence
    return lines.length - kept.length;
  };

  const groups = opts.groups ?? [];
  // read once, for the house facts and for the agent's approved lessons
  const everything =
    opts.readSemantic || opts.readLessons
      ? await opts.reader.activeFacts(opts.tenantId, groups)
      : [];
  const shown = new Set<string>();
  if (opts.readSemantic) {
    const pinned = (f: MemoryItem) =>
      !opts.pin || opts.pin.some((prefix) => (f.key ?? "").startsWith(prefix));
    const active = everything.filter(pinned);
    for (const f of active) shown.add(f.id);
    const own = active.filter((f) => f.tenantId !== null);
    let cut = addList(
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
      cut += addList(
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
    // the facts the prompt does not hold: how many, and where to look (ADR 0034)
    const rest = everything.filter((f) => !pinned(f));
    const note = factsNote(rest, cut);
    if (note) {
      sections.push(note);
      used += estimateTokens(note);
    }
  }

  if (opts.readLessons) {
    const lessons = everything.filter(
      (f) =>
        (f.key ?? "").startsWith(LESSON_FACT) && f.agentId === opts.agentId && !shown.has(f.id),
    );
    addList(
      sections,
      facts,
      "## Rules reviewers taught you\n\nWhat reviewers said about your earlier work often enough that a person approved it as a rule. Follow them.",
      lessons.map((f) => ({ id: f.id, kind: "semantic", line: `- ${f.content}`, text: f.content })),
    );
  }

  if (opts.readEpisodic) {
    for (const list of await recallLists(opts, groups)) {
      addList(recalledSections, recalled, list.title, list.items);
    }
  }

  return {
    text: sections.join("\n\n"),
    // every run is told the date, in the first user message so the instructions stay the same
    // from day to day; an agent that reads episodic memory gets what was recalled with it
    recalled: opts.readEpisodic
      ? recalledBlock(opts.now ?? new Date(), recalledSections)
      : today(opts.now ?? new Date()),
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

/** The key prefix of a lesson a person approved as a fact (`proposeLesson` in consolidation). */
export const LESSON_FACT = "lesson.";

/** The date as the run is told it: UTC, and said to be, so a club in another zone is not misled. */
const today = (now: Date) => `Today is ${now.toISOString().slice(0, 10)} (UTC).`;

/** The recalled memory as one message-sized block, marked so the model reads it as data. */
function recalledBlock(now: Date, sections: string[]): string {
  return `<recalled_memory>\n${[today(now), ...sections].join("\n\n")}\n</recalled_memory>`;
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

/**
 * One line on the facts the prompt does not hold: those a pin left out, under which prefixes, and
 * those that did not fit. `memory.search` finds them. Nothing when every fact is there.
 */
export function factsNote(unpinned: MemoryItem[], cut: number): string {
  const parts: string[] = [];
  if (unpinned.length > 0) {
    const prefixes = [
      ...new Set(unpinned.map((f) => (f.key ?? "").split(/(?<=\.)/)[0]).filter(Boolean)),
    ].sort();
    parts.push(
      `${unpinned.length} more fact${unpinned.length === 1 ? " is" : "s are"} not shown${prefixes.length ? `, under ${prefixes.join(" ")}` : ""}.`,
    );
  }
  if (cut > 0) parts.push(`${cut} did not fit here.`);
  return parts.length ? `${parts.join(" ")} Find one with ${SEARCH_TOOL}.` : "";
}
