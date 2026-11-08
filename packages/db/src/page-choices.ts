/**
 * The choices published sections write to their page (ADR 0032; `_page` in `@fanos/dsl`): what a
 * section built later can read. Recorded by frame-match when it publishes, read by data-bind.
 */

import { type Pool, withTenant } from "./index.ts";

export interface PageChoiceOption {
  value: string;
  label?: string;
}

export interface RecordedChoice {
  key: string;
  options: PageChoiceOption[];
  initial: string;
}

export interface PageChoiceRow extends RecordedChoice {
  project: string;
  /** The Handoff (or export) the section was built from. */
  section: string;
  sectionName: string | null;
  treeArtifactId: string;
  updatedAt: Date;
}

/** A section's choices, as published now: what it no longer writes goes. */
export async function recordPageChoices(
  pool: Pool,
  tenantId: string,
  section: {
    project: string;
    section: string;
    name?: string;
    treeArtifactId: string;
    runId?: string;
    choices: RecordedChoice[];
  },
): Promise<void> {
  await withTenant(pool, tenantId, async (db) => {
    await db.query("delete from page_choices where project = $1 and section = $2", [
      section.project,
      section.section,
    ]);
    for (const c of section.choices) {
      await db.query(
        `insert into page_choices
           (tenant_id, project, section, section_name, key, options, initial, tree_artifact_id, run_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          section.project,
          section.section,
          section.name ?? null,
          c.key,
          JSON.stringify(c.options),
          c.initial,
          section.treeArtifactId,
          section.runId ?? null,
        ],
      );
    }
  });
}

/** The tenant's page choices in a project, newest first; one section's left out when named. */
export async function pageChoicesOf(
  pool: Pool,
  tenantId: string,
  project: string,
  opts: { except?: string } = {},
): Promise<PageChoiceRow[]> {
  return withTenant(pool, tenantId, async (db) => {
    const { rows } = await db.query<{
      project: string;
      section: string;
      section_name: string | null;
      key: string;
      options: PageChoiceOption[];
      initial: string;
      tree_artifact_id: string;
      updated_at: Date;
    }>(
      `select project, section, section_name, key, options, initial, tree_artifact_id, updated_at
         from page_choices where project = $1 and ($2::text is null or section <> $2)
        order by updated_at desc`,
      [project, opts.except ?? null],
    );
    return rows.map((r) => ({
      project: r.project,
      section: r.section,
      sectionName: r.section_name,
      key: r.key,
      options: r.options,
      initial: r.initial,
      treeArtifactId: r.tree_artifact_id,
      updatedAt: r.updated_at,
    }));
  });
}
