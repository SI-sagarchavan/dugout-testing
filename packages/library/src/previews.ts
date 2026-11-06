import { type Pool, withTenant } from "@dugout/db";
import type { IndexReport } from "./indexer.ts";
import type { SectionLibrary } from "./store.ts";

/** The agents whose finished runs are a preview of a Handoff: frame-match publishes the frame. */
export const PREVIEW_AGENTS = ["frame-match", "section-builder"] as const;

export interface PreviewRun {
  runId: string;
  agentId: string;
  /** A FanXP Handoff (`handoffId`) or a control-plane export (`exportId`). */
  handoff: { kind: "handoff" | "export"; id: string; project: string };
  previewUrl: string;
  at: string;
}

/** The tenant's finished runs that built a preview of a Handoff, oldest first. */
export async function previewRuns(pool: Pool, tenantId: string): Promise<PreviewRun[]> {
  return withTenant(pool, tenantId, async (db) => {
    const { rows } = await db.query(
      `select id, agent_id, input, result->'output'->>'previewUrl' as preview_url, updated_at
       from runs
       where tenant_id = $1 and status = 'completed' and agent_id = any($2)
         and result->'output' ? 'previewUrl'
       order by updated_at`,
      [tenantId, [...PREVIEW_AGENTS]],
    );
    return rows.flatMap((r) => {
      const input = (r.input ?? {}) as { handoffId?: string; exportId?: string; project?: string };
      const handoff = input.handoffId
        ? { kind: "handoff" as const, id: input.handoffId }
        : input.exportId
          ? { kind: "export" as const, id: input.exportId }
          : undefined;
      if (!handoff || !r.preview_url) return [];
      return [
        {
          runId: String(r.id),
          agentId: String(r.agent_id),
          handoff: { ...handoff, project: input.project ?? "default" },
          previewUrl: String(r.preview_url),
          at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
        },
      ];
    });
  });
}

export interface PreviewSync {
  runs: number;
  /** Handoffs indexed because a preview was built from one not yet in the library. */
  indexed: IndexReport[];
  /** Sections marked previewed, by run. */
  marked: Array<{ runId: string; handoffId: string; sections: number }>;
  failed: Array<{ runId: string; handoffId: string; error: string }>;
}

/**
 * Every preview the tenant's runs built puts the sections of its Handoff in the shared pool:
 * the Handoff is indexed first when the library has not seen it, then its sections are marked.
 * Safe to run again: a run already counted changes nothing.
 */
export async function syncPreviews(opts: {
  pool: Pool;
  tenantId: string;
  library: SectionLibrary;
  /** Indexes one Handoff, read from where the run read it. */
  index: (run: PreviewRun) => Promise<IndexReport>;
  /** Index every previewed Handoff again, even one the library has seen. */
  reindex?: boolean;
}): Promise<PreviewSync> {
  const { tenantId, library } = opts;
  const runs = await previewRuns(opts.pool, tenantId);
  const out: PreviewSync = { runs: runs.length, indexed: [], marked: [], failed: [] };
  const known = new Map<string, boolean>();
  for (const run of runs) {
    const handoffId = run.handoff.id;
    try {
      if (!known.has(handoffId)) {
        if (opts.reindex || !(await library.hasHandoff(tenantId, handoffId))) {
          out.indexed.push(await opts.index(run));
        }
        known.set(handoffId, true);
      }
      const sections = await library.markPreviewed(tenantId, {
        runId: run.runId,
        agentId: run.agentId,
        handoffId,
        previewUrl: run.previewUrl,
        at: run.at,
      });
      out.marked.push({ runId: run.runId, handoffId, sections });
    } catch (err) {
      known.set(handoffId, true);
      out.failed.push({
        runId: run.runId,
        handoffId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
