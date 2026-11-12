import type { BuildPattern, BuildReport, RunEvent, Situation } from "@dugout/contracts";
import { holdsWords } from "./entity.ts";

/** The parts of the run's input and output this reads; both are checked by their own schemas. */
interface NeedShape {
  list: string;
  count: number | "data";
  groupBy?: string;
  order?: string;
  item: Array<{ field: string; required?: boolean }>;
  must?: { team?: string; competition?: string };
}
interface Answer {
  hookId: string | null;
  name?: string;
  built: boolean;
  input: Record<string, string>;
  covers: string[];
  missing: string[];
  why: string;
  basis?: string;
  existing?: string;
  created?: string[];
  /** What the data is about, as the model judged it; absent from answers made before. */
  about?: { reading: "design" | "other" | "unknown"; why: string };
}

/**
 * What a run did to get a section's data (ADR 0034): the need, the hook it answered with and how
 * it came to it, what the hook gives and lacks. Read from the run's input and result, by code.
 * Good when it answered with a hook about what the design is about: the hook works and is the
 * section's. What the feed does not give is in `remaining`, never a reason to call the hook a
 * failure, so the next run on the section finds it and reuses it.
 */
export function record(run: {
  input: unknown;
  output: unknown;
  events: RunEvent[];
  section: Situation;
}): BuildReport | undefined {
  const need = (run.input as { need?: NeedShape } | undefined)?.need;
  if (!need) return undefined;
  const answer = run.output as Answer | undefined;
  const shape = {
    list: need.list,
    count: need.count,
    ...(need.groupBy ? { groupBy: need.groupBy } : {}),
    ...(need.order ? { order: need.order } : {}),
    fields: need.item.map((f) => ({ field: f.field, required: f.required === true })),
  };
  const on = run.section.name ? `"${run.section.name}"` : "the section";
  // the list the section shows: other agents' patterns on it are named for it (`layout.{list}`)
  const section = { labels: { list: need.list } };
  if (!answer || typeof answer !== "object") {
    return {
      did: { need: shape },
      portable: { need: shape },
      good: false,
      line: `got no data for ${on}`,
      section,
    };
  }
  const covers = answer.covers.map((c) => c.toLowerCase());
  const lacking = need.item
    .filter((f) => f.required && !covers.some((c) => c.includes(f.field.toLowerCase())))
    .map((f) => f.field);
  // what the data is about is the model's judgement (`about`); an answer made before it said so
  // is read as it was then: a missing line naming what the data must be about
  const must = [need.must?.team, need.must?.competition].filter((m): m is string => !!m);
  const other = answer.about
    ? answer.about.reading === "other"
    : answer.missing.some((line) => must.some((m) => holdsWords(line, m)));
  const good = answer.hookId !== null && !other;
  const how = answer.basis ?? (answer.built ? "built" : "found");
  return {
    did: {
      need: { ...shape, ...(need.must ? { must: need.must } : {}) },
      hookId: answer.hookId,
      ...(answer.name ? { name: answer.name } : {}),
      basis: how,
      input: answer.input,
      covers: answer.covers,
      missing: answer.missing,
      ...(answer.about ? { about: answer.about } : {}),
      why: answer.why,
      ...(answer.existing ? { existing: answer.existing } : {}),
      ...(answer.created?.length ? { created: answer.created } : {}),
    },
    // the need's shape and how it was met: no hook id, input, team or path of the club's data
    portable: { need: shape, basis: how, missing: answer.missing.length },
    good,
    remaining: [
      ...lacking.map((f) => `the hook does not give ${f}, which the design needs`),
      ...answer.missing,
    ],
    line: answer.hookId
      ? `${how === "built" || how === "sources" ? "built" : "found"} ${answer.hookId} for ${on} (${need.list})`
      : `found no hook for ${on} (${need.list})`,
    section,
    // sections that agree on the hook for a list make it the club's (ADR 0034, section 8)
    ...(answer.hookId ? { patterns: [hookPattern(answer.hookId)] } : {}),
  };
}

/** The hook that feeds the section's list: `data.hook.<list>` once sections agree. */
export const hookPattern = (hookId: string): BuildPattern => ({
  key: "data.hook.{list}",
  value: { hook: hookId, list: "{list}" },
  sentence: `The hook ${hookId} feeds the list "{list}"`,
});
