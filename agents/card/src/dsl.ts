import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@dugout/core";

// The DSL vocabulary and the renderer are the built @fanos packages: `pnpm build`.
interface DslIssue {
  code: string;
  severity: string;
  message: string;
  nodeId?: string;
  path?: string;
  suggestions?: string[];
}

interface Checker {
  parse(tree: unknown): unknown;
  validate(tree: unknown, data: unknown): { errors: DslIssue[]; warnings: DslIssue[] };
}

let checker: Checker | undefined;

async function loadChecker(): Promise<void> {
  const root = REPO_ROOT;
  const dsl = (await import(pathToFileURL(join(root, "packages/dsl/dist/index.js")).href)) as {
    flatTreeSchema: { parse(tree: unknown): unknown };
    validate(
      tree: unknown,
      options: { registry: unknown; data?: unknown },
    ): {
      errors: DslIssue[];
      warnings: DslIssue[];
    };
  };
  const tokens = (await import(
    pathToFileURL(join(root, "packages/tokens/dist/index.js")).href
  )) as {
    loadTheme(path: string): unknown;
    loadSurfaces(path: string): unknown;
    createRegistry(theme: unknown, options: { surfaces: unknown }): unknown;
  };
  const theme = tokens.loadTheme(join(root, "packages/tokens/fixtures/southern-brave.json"));
  const surfaces = tokens.loadSurfaces(join(root, "packages/tokens/surfaces/southern-brave.json"));
  const registry = tokens.createRegistry(theme, { surfaces });
  checker = {
    parse: (tree) => dsl.flatTreeSchema.parse(tree),
    validate: (tree, data) => dsl.validate(tree, { registry, data }),
  };
}

// Importers wait until the pipeline validator is ready.
await loadChecker();

export interface CardCheck {
  ok: boolean;
  issues: string[];
}

/** Zero errors and zero warnings. A warning would fail the pipeline fixture suite. */
export function checkCard(tree: unknown, data: unknown): CardCheck {
  if (!checker) return { ok: false, issues: ["the DSL checker is not loaded"] };
  try {
    const parsed = checker.parse(tree);
    const result = checker.validate(parsed, data);
    const issues = [...result.errors, ...result.warnings].map(formatIssue);
    return { ok: issues.length === 0, issues };
  } catch (err) {
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
}

function formatIssue(issue: DslIssue): string {
  const where = [issue.nodeId, issue.path].filter(Boolean).join(".");
  const suggest = issue.suggestions?.length ? ` Try: ${issue.suggestions.join(", ")}.` : "";
  return `${issue.code}${where ? ` ${where}` : ""}: ${issue.message}${suggest}`;
}

/** The hand-authored sample, used by the scripted tests as a known-good tree. */
export function sampleCard(): { tree: unknown; data: unknown } {
  const root = REPO_ROOT;
  return {
    tree: JSON.parse(readFileSync(join(root, "packages/dsl/fixtures/sample-card.json"), "utf8")),
    data: JSON.parse(
      readFileSync(join(root, "packages/renderer/fixtures/sample-card.data.json"), "utf8"),
    ),
  };
}
