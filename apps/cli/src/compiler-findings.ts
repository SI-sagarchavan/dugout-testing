import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `.scratch/compiler-findings/issues/NN-<slug>.md`, one ticket per kind of gap (docs/agents/issue-tracker.md). */
export const FINDINGS_DIR = join(".scratch", "compiler-findings", "issues");

const NODE_ID = /^I?\d+:\d+(?:;I?\d+:\d+)*:\s+/;

/** The finding without the node it was seen on, so the same gap on two frames is one ticket. */
export function findingKey(finding: string): string {
  return finding.replace(NODE_ID, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function slugOf(key: string): string {
  return (
    key
      .replace(/[^a-z0-9]+/g, "-")
      .split("-")
      .filter(Boolean)
      .slice(0, 6)
      .join("-") || "finding"
  );
}

export interface FindingSource {
  runId: string;
  /** The frame the run was for, as the designer named it. */
  frame?: string;
}

/**
 * Files what a run says the compiler should have done. A gap already on file gets one more line
 * under `## Comments` instead of a second ticket. Nothing here edits the pipeline (ADR 0019).
 */
export function recordCompilerFindings(
  repoRoot: string,
  findings: readonly string[],
  source: FindingSource,
): { created: string[]; repeated: string[] } {
  const dir = join(repoRoot, FINDINGS_DIR);
  mkdirSync(dir, { recursive: true });
  const result = { created: [] as string[], repeated: [] as string[] };
  const seen = new Set<string>();
  for (const finding of findings) {
    const key = findingKey(finding);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    const line = `- run ${source.runId}${source.frame ? ` · ${source.frame}` : ""}: ${finding}`;
    const existing = files.find((f) =>
      readFileSync(join(dir, f), "utf8").includes(`Key: ${key}\n`),
    );
    if (existing) {
      const path = join(dir, existing);
      writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n${line}\n`);
      result.repeated.push(existing);
      continue;
    }
    const next = files.reduce((n, f) => Math.max(n, Number.parseInt(f, 10) || 0), 0) + 1;
    const name = `${String(next).padStart(2, "0")}-${slugOf(key)}.md`;
    writeFileSync(
      join(dir, name),
      [
        `# ${key.charAt(0).toUpperCase()}${key.slice(1)}`,
        "",
        "Status: needs-triage",
        `Key: ${key}`,
        "",
        "Reported by the frame-match agent: what the compiler should have done. Fix it in the pipeline.",
        "",
        "## Comments",
        "",
        line,
        "",
      ].join("\n"),
    );
    result.created.push(name);
  }
  return result;
}
