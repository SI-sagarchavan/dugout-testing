/**
 * The page's choices, as a binding reads them (ADR 0032): what other sections' tabs write
 * (`_page.<key>`), and which lists of this section's data follow one.
 *
 * A strip of players under a WOMEN | MEN toggle is one list of every player, each with a team. The
 * toggle is another section's; the strip shows the players of the team chosen there. Code finds
 * the field: a list whose items hold, in one field, values that are the options of a choice
 * ("Women", "Men" for `women`, `men`). The plan then draws an item only while its team is the
 * chosen one: the template's `when` is `{ path: "<as>.team", eqPath: "_page.<key>" }`.
 */

/** A choice another section writes, as recorded when it was published. */
export interface KnownChoice {
  key: string;
  options: Array<{ value: string; label?: string }>;
  initial: string;
  /** The section that writes it, as a person names it. */
  section?: string | null;
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
