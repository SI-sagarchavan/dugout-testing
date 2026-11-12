/**
 * The comments a person left on a section's elements, as the agent reads them. They live in the
 * harness database (`ui_comments`), saved there by the backend. The tenant is the run's, never
 * the model's.
 */
import { type Pool, withTenant } from "@dugout/db";

export interface UiComment {
  id: string;
  nodeId: string;
  src: string | null;
  nodeType: string | null;
  path: string | null;
  body: string;
  status: "open" | "sent" | "done" | "dismissed";
  /** What the person had on screen: the node's props, the edits they drafted, its place in the tree. */
  context: {
    type?: string;
    props?: Record<string, unknown>;
    draft?: {
      changed?: string[];
      was?: Record<string, unknown>;
      /** Elements the person deleted by hand (with what was under them), by the top of each cut. */
      removed?: Array<{ id: string; type: string; parent: string | null }>;
    };
    parent?: string | null;
    children?: Array<{ id: string; type: string }>;
  };
}

/** A comment made before this run on the same element: what was asked, and where it stands. */
export interface EarlierComment {
  nodeId: string;
  body: string;
  status: UiComment["status"];
  at: string;
}

export interface CommentSource {
  /**
   * The comments this run is to do, oldest first: the ones named (the host's Send passes the ids it
   * handed over), else the ones a host marked `sent` with this run's id, else the open ones on this
   * preview (the terminal hands none).
   */
  open(runId?: string, ids?: readonly string[]): Promise<UiComment[]>;
  /** Marks comments as handed to this run: shown as sent in the preview until a person resolves them. */
  sent(ids: string[], runId: string): Promise<void>;
  /** Comments made before on these elements, of this section (or this tree), newest first. */
  earlier?(nodeIds: readonly string[], except: readonly string[]): Promise<EarlierComment[]>;
}

const COLUMNS = "id, node_id, src, node_type, path, body, status, context";

interface Row {
  id: string;
  node_id: string;
  src: string | null;
  node_type: string | null;
  path: string | null;
  body: string;
  status: UiComment["status"];
  context: UiComment["context"] | null;
}

const toComment = (r: Row): UiComment => ({
  id: r.id,
  nodeId: r.node_id,
  src: r.src,
  nodeType: r.node_type,
  path: r.path,
  body: r.body,
  status: r.status,
  context: r.context ?? {},
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EARLIER_LIMIT = 12;

/**
 * The comments in the harness database (`ui_comments`), for the tenant of the run. The host that
 * saved them is Studio's backend (`POST /surface/runs/:id/comments`); this is the other side of the
 * same table. Every statement runs with the tenant named, so row-level security shows no other's.
 * `section` is the run Studio opens for the section, when the host named it: a section's comments
 * outlive each tree its edits make.
 */
export function dbComments(
  pool: Pool,
): (tenant: string, project: string, ref: string, section?: string) => CommentSource {
  return (tenant, project, ref, section) => ({
    open: (runId, ids) =>
      withTenant(pool, tenant, async (db) => {
        const named = (ids ?? []).filter((id) => UUID.test(id));
        if (named.length > 0) {
          const { rows } = await db.query<Row>(
            `select ${COLUMNS} from ui_comments
             where project = $1 and id = any($2::uuid[]) order by created_at`,
            [project, named],
          );
          if (rows.length > 0) return rows.map(toComment);
        }
        if (runId) {
          const { rows } = await db.query<Row>(
            `select ${COLUMNS} from ui_comments
             where project = $1 and run_id = $2 and status = 'sent' order by created_at`,
            [project, runId],
          );
          if (rows.length > 0) return rows.map(toComment);
        }
        const { rows } = await db.query<Row>(
          `select ${COLUMNS} from ui_comments
           where project = $1 and ref = $2 and status = 'open' order by created_at`,
          [project, ref],
        );
        return rows.map(toComment);
      }),
    sent: (ids, runId) =>
      withTenant(pool, tenant, async (db) => {
        await db.query(
          `update ui_comments set status = 'sent', run_id = $2, updated_at = now()
           where project = $1 and id = any($3::uuid[]) and status = 'open'`,
          [project, runId, ids.filter((id) => UUID.test(id))],
        );
      }),
    earlier: (nodeIds, except) =>
      withTenant(pool, tenant, async (db) => {
        if (nodeIds.length === 0) return [];
        const { rows } = await db.query<{
          node_id: string;
          body: string;
          status: UiComment["status"];
          created_at: Date;
        }>(
          `select node_id, body, status, created_at from ui_comments
           where project = $1 and node_id = any($2::text[])
             and not (id = any($3::uuid[]))
             and (${section ? "section_run_id = $4" : "ref = $4"})
           order by created_at desc limit ${EARLIER_LIMIT}`,
          [project, [...nodeIds], except.filter((id) => UUID.test(id)), section ?? ref],
        );
        return rows.map((r) => ({
          nodeId: r.node_id,
          body: r.body,
          status: r.status,
          at: new Date(r.created_at).toISOString(),
        }));
      }),
  });
}
