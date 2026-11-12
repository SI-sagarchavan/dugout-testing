/**
 * A section's versions (migration 026): each preview the section had after it was built. ui-editor
 * adds one each time it publishes edits; Studio's backend lists them, adds a person's hand edits and
 * goes back to one. The section is the run Studio opens for it, which the host names in the input.
 */
import { type Pool, withTenant } from "@dugout/db";

export interface Version {
  section: string;
  project: string;
  tree: string;
  plan?: string;
  data?: string;
  surfaces?: string;
  preview: string;
  fromTree: string;
  runId: string;
  what: string;
}

export interface VersionStore {
  add(tenantId: string, version: Version): Promise<void>;
}

export function dbVersions(pool: Pool): VersionStore {
  return {
    add: (tenantId, v) =>
      withTenant(pool, tenantId, async (db) => {
        await db.query(
          `insert into section_versions (tenant_id, section_run_id, thread_id, project, tree, plan,
             data, surfaces, preview, from_tree, by, run_id, what)
           values ($1, $2, (select thread_id from runs where id::text = $2), $3, $4, $5, $6, $7, $8,
             $9, 'agent:ui-editor', $10, $11)`,
          [
            tenantId,
            v.section,
            v.project,
            v.tree,
            v.plan ?? null,
            v.data ?? null,
            v.surfaces ?? null,
            v.preview,
            v.fromTree,
            v.runId,
            v.what.slice(0, 500),
          ],
        );
      }),
  };
}
