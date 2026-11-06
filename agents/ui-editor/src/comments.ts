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
    draft?: { changed?: string[]; was?: Record<string, unknown> };
    parent?: string | null;
    children?: Array<{ id: string; type: string }>;
  };
}

export interface CommentSource {
  /** The comments still to do on this preview, oldest first. */
  open(): Promise<UiComment[]>;
  /** Marks comments as handed to this run: shown as sent in the preview until a person resolves them. */
  sent(ids: string[], runId: string): Promise<void>;
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

/**
 * The comments in the harness database (`ui_comments`), for the tenant of the run. The host that
 * saved them is Studio's backend (`POST /surface/runs/:id/comments`); this is the other side of the
 * same table. Every statement runs with the tenant named, so row-level security shows no other's.
 */
export function dbComments(
  pool: Pool,
): (tenant: string, project: string, ref: string) => CommentSource {
  return (tenant, project, ref) => ({
    open: () =>
      withTenant(pool, tenant, async (db) => {
        const { rows } = await db.query<Row>(
          `select ${COLUMNS} from ui_comments
           where project = $1 and ref = $2 and status = 'open' order by created_at`,
          [project, ref],
        );
        return rows.map((r) => ({
          id: r.id,
          nodeId: r.node_id,
          src: r.src,
          nodeType: r.node_type,
          path: r.path,
          body: r.body,
          status: r.status,
          context: r.context ?? {},
        }));
      }),
    sent: (ids, runId) =>
      withTenant(pool, tenant, async (db) => {
        await db.query(
          `update ui_comments set status = 'sent', run_id = $3, updated_at = now()
           where project = $1 and ref = $2 and id = any($4::uuid[])`,
          [project, ref, runId, ids],
        );
      }),
  });
}
