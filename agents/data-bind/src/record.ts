import type { BuildPattern, BuildReport, RunEvent, Situation } from "@dugout/contracts";

interface FieldShape {
  src: string;
  prop: string;
  path?: string;
  template?: string;
}
interface PlanShape {
  note?: string;
  collapse?: Array<{
    over: string;
    as: string;
    members: string[];
    slice?: [number, number] | [number];
    when?: unknown;
    variants?: Array<{ src: string; when: unknown; fields?: FieldShape[] }>;
    fields?: FieldShape[];
  }>;
  bind?: FieldShape[];
  set?: Array<{ src: string; prop: string; value: unknown }>;
  keep?: Array<{ src: string; why: string }>;
}
/** The parts of the run's result this reads (`Result` in agent.ts). */
interface Ending {
  previewUrl?: string;
  planArtifactId?: string;
  bound?: number;
  collapsed?: number;
  remaining?: string[];
  data?: "bound" | "stand-in" | "none";
  dataWhy?: string;
  static?: boolean;
  despite?: string;
  sources?: Array<Record<string, unknown>>;
}

/** The last plan `bind.try` applied without an error: the one `bind.publish` stores. */
export function triedPlan(events: RunEvent[]): PlanShape | undefined {
  const inputs = new Map<string, unknown>();
  let plan: PlanShape | undefined;
  for (const event of events) {
    if (event.type === "tool.started" && event.data.tool === "bind.try") {
      inputs.set(event.data.callId, event.data.input);
    }
    if (event.type === "tool.completed" && event.data.ok && inputs.has(event.data.callId)) {
      try {
        plan = JSON.parse((inputs.get(event.data.callId) as { plan: string }).plan);
      } catch {
        // not a plan: bind.try refused it
      }
    }
  }
  return plan;
}

/** What a field reads, without the node it is put on. */
const reads = (f: FieldShape) => ({
  prop: f.prop,
  ...(f.path ? { path: f.path } : {}),
  ...(f.template ? { template: f.template } : {}),
});

/** Every path with a pipe and every template: the forms the plan had to name (the `date` pipe). */
function formsOf(plan: PlanShape): string[] {
  const fields = [
    ...(plan.bind ?? []),
    ...(plan.collapse ?? []).flatMap((c) => [
      ...(c.fields ?? []),
      ...(c.variants ?? []).flatMap((v) => v.fields ?? []),
    ]),
  ];
  const forms = fields.flatMap((f) => [
    ...(f.path?.includes("|") ? [f.path] : []),
    ...(f.template ? [f.template] : []),
  ]);
  return [...new Set(forms)];
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
/** A path's last field, without an index: `item.published_date` → `published_date`. */
const lastField = (path: string) =>
  path
    .split(".")
    .at(-1)
    ?.replace(/\[\d*\]$/, "") ?? path;

/**
 * The form each kind of date is written in, from the `date` pipes the plan named
 * (`published_date | date:"DD MMM, YYYY"`): `form.date.<field>` once sections agree on it.
 */
export function datePatterns(forms: string[]): BuildPattern[] {
  return forms.flatMap((form) => {
    const m = /^\s*([^|]+?)\s*\|\s*(date:.+?)\s*$/.exec(form);
    if (!m?.[1] || !m[2]) return [];
    const field = slug(lastField(m[1]));
    if (!field) return [];
    return [
      {
        key: `form.date.${field}`,
        value: { pipe: m[2], field },
        sentence: `A ${field.replace(/-/g, " ")} is written with the pipe ${m[2]}`,
      },
    ];
  });
}

/**
 * Whether a person settled `data_source` as `none`: answered so when the model asked in this run,
 * or decided so on this section before (bind.load's `settled`). Code only reads what happened; the
 * model decides whether to ask.
 */
function personLeftNone(events: RunEvent[]): boolean {
  for (const e of events) {
    if (
      e.type === "question.answered" &&
      (e.data.source === "person" || e.data.source === "memory")
    ) {
      if (e.data.answers[DATA_SOURCE] === NONE) return true;
    }
    if (e.type === "tool.completed" && e.data.tool === "bind.load" && e.data.ok) {
      try {
        const loaded = JSON.parse(String(e.data.content)) as { settled?: Record<string, unknown> };
        if (loaded.settled?.[DATA_SOURCE] === NONE) return true;
      } catch {
        // a long result is a reference: nothing to read here
      }
    }
  }
  return false;
}
const DATA_SOURCE = "data_source";
const NONE = "none";

/**
 * What a run bound (ADR 0034): the hook and the input it ran with, the plan as stored and a
 * reduced copy of it (which field feeds which prop, what repeats, the variants, what is kept and
 * why), how the data ended and each text form the plan named. Read from the run's result and its
 * last `bind.try`, by code. Good when it was publishable without `despite` and ended bound, or
 * none when nothing on the section is data or a person settled `data_source` as none. A `none`
 * nobody decided (no source found, Cast out of reach) is not good: it is read as `failed`, never
 * as a precedent that settles where the data comes from.
 */
export function record(run: {
  output: unknown;
  events: RunEvent[];
  section: Situation;
}): BuildReport | undefined {
  const out = run.output as Ending | undefined;
  const plan = triedPlan(run.events);
  // a run that neither tried a plan nor ended has nothing to say about the section
  if (!out && !plan) return undefined;
  const on = run.section.name ? `"${run.section.name}"` : "the section";
  const ending = out?.data ?? (out?.static ? "none" : out ? "bound" : undefined);
  const sources = (out?.sources ?? []).map((s) => ({
    ...(typeof s.as === "string" ? { as: s.as } : {}),
    ...(typeof s.hookId === "string" ? { hookId: s.hookId } : {}),
    ...(s.input && typeof s.input === "object" ? { input: s.input } : {}),
  }));
  const lists = (plan?.collapse ?? []).map((c) => ({
    over: c.over,
    as: c.as,
    members: c.members,
    ...(c.slice ? { slice: c.slice } : {}),
    ...(c.when ? { when: c.when } : {}),
    fields: (c.fields ?? []).map((f) => ({ src: f.src, ...reads(f) })),
    variants: (c.variants ?? []).map((v) => ({
      src: v.src,
      when: v.when,
      fields: (v.fields ?? []).map((f) => ({ src: f.src, ...reads(f) })),
    })),
  }));
  const forms = plan ? formsOf(plan) : [];
  const dates = datePatterns(forms);
  const hooks = sources.flatMap((s) => (s.hookId ? [s.hookId] : []));
  const to = hooks.length ? hooks.join(", ") : "the data it was given";
  const line =
    ending === "none"
      ? `left ${on} unbound${out?.dataWhy ? ` (${out.dataWhy})` : ""}`
      : ending === "stand-in"
        ? `bound ${on} to stand-in data from ${to}: ${out?.bound ?? 0} props, ${out?.collapsed ?? 0} lists`
        : ending === "bound"
          ? `bound ${on} to ${to}: ${out?.bound ?? 0} props, ${out?.collapsed ?? 0} lists`
          : `tried to bind ${on} and did not publish`;
  return {
    did: {
      ending: ending ?? "unpublished",
      ...(out?.dataWhy ? { why: out.dataWhy } : {}),
      sources,
      ...(out?.planArtifactId ? { planArtifactId: out.planArtifactId } : {}),
      ...(plan
        ? {
            plan: {
              ...(plan.note ? { note: plan.note } : {}),
              lists,
              bind: (plan.bind ?? []).map((f) => ({ src: f.src, ...reads(f) })),
              set: plan.set ?? [],
              keep: plan.keep ?? [],
            },
          }
        : {}),
      forms,
      ...(out?.despite ? { despite: out.despite } : {}),
    },
    // what repeats and what each prop reads by form: no node id, hook id, input or path of the club's
    portable: {
      ending: ending ?? "unpublished",
      lists: lists.map((l) => ({
        members: l.members.length,
        props: l.fields.map((f) => f.prop),
        variants: l.variants.length,
      })),
      props: (plan?.bind ?? []).map((f) => f.prop),
      kept: (plan?.keep ?? []).map((k) => k.why),
    },
    good:
      !!out &&
      !out.despite &&
      (ending === "bound" || (ending === "none" && (!!out.static || personLeftNone(run.events)))),
    remaining: out?.remaining ?? [],
    line,
    ...(dates.length ? { patterns: dates } : {}),
    ...(out?.previewUrl ? { previewUrl: out.previewUrl } : {}),
  };
}
