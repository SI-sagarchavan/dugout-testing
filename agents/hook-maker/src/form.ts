/**
 * The form of a short text a design writes around a number: a date, a time, a score, a count with
 * its unit. Shared by hook-maker (does its output have the design's form?) and data-bind (does the
 * page?). Code only, so it holds for any data.
 */
const MONTHS = new Set(
  "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec".split(
    " ",
  ),
);
const WEEKDAYS = new Set(
  "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun".split(
    " ",
  ),
);
/** Units of time: "5 mins ago" and "2 hours ago" are one form. */
const TIME_UNITS = new Set(
  "second seconds sec secs minute minutes min mins hour hours hr hrs day days week weeks wk wks month months year years yr yrs".split(
    " ",
  ),
);

/** A word without its plural ending: "Goals" is "goal", "Matches" "match". Short words stay. */
const singular = (word: string) =>
  word.length <= 3 || !word.endsWith("s") || word.endsWith("ss")
    ? word
    : /(?:ch|sh|x|z)es$/.test(word)
      ? word.slice(0, -2)
      : word.slice(0, -1);

/**
 * The shape of a short text, so two values of one form compare equal. Digits are `9` (a sign
 * before them, thousands separators and decimals are not a form of their own: "+3", "-2", "1,234"
 * and "19.3" are each `9`); an ordinal is `9#` ("1st", "2nd"); a month is `month`, a weekday
 * `day`, a unit of time `<t>`; a one-letter word (a result's W or L) is `x`; any other word stays,
 * case-folded and without its plural ending, so the words around a value are compared too
 * ("(100 Balls)" is `(9 ball)`, "(20.0 Overs)" `(9 over)`, "1 Goal" and "2 Goals" both `9 goal`).
 * Letter case is not a form ("21 JULY" and "21 July" are one): a page sets it with `textCase`.
 * Punctuation and brackets stay.
 */
export function formOf(text: string): string {
  return text
    .trim()
    .replace(/(^|[^\p{L}\p{N}])[+\-−±](?=\d)/gu, "$1")
    .replace(/\d+(?:[.,  ]\d+)*(?:st|nd|rd|th)(?!\p{L})/giu, "9#")
    .replace(/\d+(?:[.,  ]\d+)*/g, "9")
    .replace(/\p{L}+/gu, (word) => {
      const lower = word.toLowerCase();
      if (MONTHS.has(lower)) return "month";
      if (WEEKDAYS.has(lower)) return "day";
      if (TIME_UNITS.has(lower)) return "<t>";
      if (lower.length === 1) return "x";
      return singular(lower);
    })
    .replace(/\s+/g, " ");
}

/** A placeholder whose form is the design's to keep: short and holding a number. */
export const hasForm = (placeholder: string) => placeholder.length <= 16 && /\d/.test(placeholder);
