import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repo root. */
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Tools that live in their own script files but are started through one entry point, so the root
 * package.json lists a handful of commands and not one per script. A key is one word (`watch`) or
 * two (`memory review`); the value is the script, relative to the repo root.
 */
export type ToolTable = Record<string, string>;

export interface ToolHit {
  file: string;
  /** What is left of the command line for the script. */
  args: string[];
}

export function resolveTool(table: ToolTable, argv: string[]): ToolHit | undefined {
  const [first, second] = argv;
  if (first && second && table[`${first} ${second}`]) {
    return { file: join(REPO, table[`${first} ${second}`] as string), args: argv.slice(2) };
  }
  if (first && table[first])
    return { file: join(REPO, table[first] as string), args: argv.slice(1) };
  return undefined;
}

/** The second words under a first word that has some (`memory` -> review, promote), or none. */
export function subcommandsOf(table: ToolTable, first: string | undefined): string[] {
  if (!first) return [];
  return Object.keys(table)
    .filter((key) => key.startsWith(`${first} `))
    .map((key) => key.slice(first.length + 1));
}

/** Runs a script (relative to the repo root) in this process, as if it had been started alone. */
export async function runScript(script: string, args: string[]): Promise<void> {
  const file = join(REPO, script);
  process.argv = [process.argv[0] as string, file, ...args];
  await import(pathToFileURL(file).href);
}

/**
 * Runs the script a command line names, or `fallback` (relative to the repo root) when it names
 * none. `label` is how the entry point is typed, for the usage line.
 */
export async function dispatch(
  table: ToolTable,
  argv: string[],
  fallback: string,
  label: string,
): Promise<void> {
  const hit = resolveTool(table, argv);
  if (!hit) {
    const options = subcommandsOf(table, argv[0]);
    if (options.length > 0) {
      console.error(`usage: ${label} ${argv[0]} <${options.join("|")}> [options]`);
      process.exitCode = 2;
      return;
    }
  }
  const file = hit?.file ?? join(REPO, fallback);
  process.argv = [process.argv[0] as string, file, ...(hit ? hit.args : argv)];
  await import(pathToFileURL(file).href);
}
