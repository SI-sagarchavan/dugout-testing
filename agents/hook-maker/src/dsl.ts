/**
 * The two readings hook-maker shares with the page, from the pipeline's DSL (its built `dist`, as
 * every agent loads the pipeline; run `pnpm build` after changing it): what value a page choice
 * compares (`pageValueOf`), and how a date is read (`formatDate`). Loaded once, when this module is
 * first imported, so the checks that use them stay synchronous.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@dugout/core";

interface DslReadings {
  pageValueOf(label: string): string;
  formatDate(
    input: string | number,
    pattern: string,
    timeZone: string,
    dateOrder?: "dmy" | "mdy",
  ): string | undefined;
}

const dsl = (await import(
  pathToFileURL(join(REPO_ROOT, "packages/dsl/dist/index.js")).href
)) as DslReadings;

/** The value a page choice writes and compares for an option or an item's field: "Men's" as the page reads it. */
export const pageValueOf = (value: unknown): string => dsl.pageValueOf(String(value));

/**
 * A date as a key that sorts as the instants do (`YYYYMMDDHHmmss`, UTC), read the way the page
 * reads dates; undefined when it does not read as one.
 */
export function dateKey(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const key = dsl.formatDate(value, "YYYYMMDDHHmmss", "UTC");
  return key && /^\d{14}$/.test(key) ? key : undefined;
}
