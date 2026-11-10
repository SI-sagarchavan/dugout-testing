/**
 * The page's choices, as a binding reads them (ADR 0032): what other sections' tabs write
 * (`_page.<key>`), and which lists of this section's data follow one.
 *
 * A list under a toggle (`<option a> | <option b>`) is often one list of every item, each saying in
 * one field which option it is for. Code finds the field: a list whose items hold, in one field,
 * values that are the options of a choice ("Option A" for `option_a`). The plan then draws an item
 * only while its value is the chosen one: the template's `when` is
 * `{ path: "<as>.<field>", eqPath: "_page.<key>" }`.
 */

/** A choice another section writes, as recorded when it was published. */
export interface KnownChoice {
  key: string;
  options: Array<{ value: string; label?: string }>;
  initial: string;
  /** The section that writes it, as a person names it. */
  section?: string | null;
  /** The slot of its frame that draws it: only that slot follows it unless told to. */
  owner?: string;
}

/** As `choiceValue` in `@fanos/dsl`: what the page compares. */
export function choiceValue(value: unknown): string {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** One line a choice, for the model. */
export function describeChoice(c: KnownChoice): string {
  const options = c.options
    .map((o) => (o.label ? `${o.value} ("${o.label}")` : o.value))
    .join(" | ");
  return `_page.${c.key}: ${options}, starts at ${c.initial}${c.section ? `; written by "${c.section}"` : ""}`;
}

export interface ChoiceLink {
  /** The list, as the plan names it: `squad.items`. */
  list: string;
  /** The item field that holds the choice's values. */
  field: string;
  key: string;
  /** The choice's values the field holds, and how many items hold none of them. */
  covers: string[];
  others: number;
}

const MAX_ITEMS = 200;

/**
 * Every list in the data whose items hold a choice's values in one field: two of its options at
 * least, and most of the items one of them.
 */
export function linksOf(data: unknown, choices: KnownChoice[]): ChoiceLink[] {
  const links: ChoiceLink[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 6 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ITEMS)
        .filter(
          (i): i is Record<string, unknown> =>
            i !== null && typeof i === "object" && !Array.isArray(i),
        );
      if (items.length >= 2) {
        const fields = new Set(items.flatMap((i) => Object.keys(i)));
        for (const field of fields) {
          const held = items
            .map((i) => i[field])
            .filter((v) => typeof v === "string" || typeof v === "number");
          if (held.length < items.length / 2) continue;
          for (const c of choices) {
            const values = new Set(c.options.map((o) => choiceValue(o.value)));
            const hits = held.map((v) => choiceValue(v)).filter((v) => values.has(v));
            const covers = [...new Set(hits)];
            if (covers.length >= 2 && hits.length >= held.length * 0.8) {
              links.push({
                list: path,
                field,
                key: c.key,
                covers,
                others: items.length - hits.length,
              });
            }
          }
        }
        visit(items[0], `${path}.0`, depth + 1);
      }
      return;
    }
    for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k, depth + 1);
  };
  visit(data, "", 0);
  return links;
}

/** A link, as the model is told it. */
export function describeLink(l: ChoiceLink): string {
  return `${l.list}: each item's "${l.field}" is one of _page.${l.key} (${l.covers.join(", ")})${l.others ? `; ${l.others} hold none` : ""}. To draw only the chosen ones, give the template's collapse when { "path": "<as>.${l.field}", "eqPath": "_page.${l.key}" }`;
}

interface PlanCollapse {
  over: string;
  as: string;
  members?: string[];
  when?: unknown;
}

const whensOf = (when: unknown): Array<{ path?: string; eqPath?: string }> =>
  Array.isArray(when) ? when : when && typeof when === "object" ? [when] : [];

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>(
      (v, key) => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined),
      value,
    );

/** A choice problem, on the list's template so a plan can keep it with why. */
export interface ChoiceProblem {
  message: string;
  src?: string;
}

/**
 * What a plan gets wrong about the page's choices (ticket 13), from the plan and the data alone:
 * a list a choice governs that the plan draws whole, and a filter whose options some list has no
 * items for. A list that follows the choice by its `over` is filtered already.
 *
 * Only a choice placed with the list governs it: one the section (or the slot) draws itself
 * (`drawn`), when the list's items hold its values; or one another section writes that this one
 * was told to read (`placed`, a slot's `readFrom`), when its options cover every value the field
 * holds. Another section's choice whose values a field happens to share (a home/away toggle over
 * fixtures that each say where they are played) is not this list's. Each problem can be kept.
 */
export function choiceProblems(
  plan: { collapse?: PlanCollapse[] } | undefined,
  data: unknown,
  drawn: KnownChoice[],
  placed: KnownChoice[] = [],
  /** Every other choice the page has: a filter the plan writes on one is checked all the same. */
  others: KnownChoice[] = [],
): ChoiceProblem[] {
  const problems: ChoiceProblem[] = [];
  const collapses = plan?.collapse ?? [];
  const keepHint = (c: PlanCollapse) =>
    c.members?.[0] ? `; or keep ${c.members[0]} with why the list does not follow it` : "";
  const governing = [
    ...linksOf(data, drawn),
    ...linksOf(data, placed).filter((l) => l.others === 0),
  ];
  for (const link of governing) {
    const c = collapses.find((x) => x.over === link.list);
    if (!c) continue;
    const filtered = whensOf(c.when).some((w) => w.eqPath === `_page.${link.key}`);
    if (!filtered) {
      problems.push({
        message: `${link.list} is filtered by the page choice _page.${link.key}: each item's "${link.field}" is one of its options (${link.covers.join(", ")}), and the collapse over it draws every item. Give it when { "path": "${c.as}.${link.field}", "eqPath": "_page.${link.key}" }${keepHint(c)}`,
        ...(c.members?.[0] ? { src: c.members[0] } : {}),
      });
    }
  }
  const choices = [...drawn, ...placed, ...others];
  for (const c of collapses) {
    for (const w of whensOf(c.when)) {
      const key = /^_page\.(\w+)$/.exec(w.eqPath ?? "")?.[1];
      const field = w.path?.startsWith(`${c.as}.`) ? w.path.slice(c.as.length + 1) : undefined;
      const choice = choices.find((x) => x.key === key);
      if (!choice || !field) continue;
      const list = at(data, c.over);
      const held = (Array.isArray(list) ? list : []).map((i) => choiceValue(at(i, field)));
      // an option no item holds draws every item (an ALL option, `@fanos/dsl`'s rule), so only a
      // filter that holds none of the options is wrong: every option then draws the whole list
      const none = choice.options.filter((o) => !held.includes(choiceValue(o.value)));
      if (held.length > 0 && none.length === choice.options.length) {
        problems.push({
          message: `${c.over} filtered by _page.${key}: no item holds any of its options (${choice.options.map((o) => o.value).join(", ")}) in "${field}" (it holds ${[...new Set(held)].slice(0, 4).join(", ") || "nothing"}), so every option draws the whole list. Map the value in the data (the hook's transform) or filter on another field${keepHint(c)}`,
          ...(c.members?.[0] ? { src: c.members[0] } : {}),
        });
      }
    }
  }
  return problems;
}
