/**
 * Where a preview's parts live (the control plane's artifacts) and where each version of a section
 * is kept (`section_versions`, migration 026), as ui-editor keeps them.
 */
import { type Pool, withTenant } from "@dugout/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The preview link, taken apart. */
export function previewOf(link: string) {
  const url = new URL(link);
  const match = /^\/preview\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match || !UUID.test(match[2] ?? ""))
    throw new Error(`not a preview link of a tree: ${link}`);
  return {
    url,
    project: decodeURIComponent(match[1] as string),
    tree: match[2] as string,
    plan: url.searchParams.get("plan") ?? undefined,
    data: url.searchParams.get("data") ?? undefined,
  };
}

export interface Plane {
  json(id: string): Promise<unknown>;
  meta(id: string): Promise<Record<string, unknown>>;
  upload(kind: string, json: unknown, meta: Record<string, unknown>): Promise<string>;
}

export function createPlane(project: string, env: NodeJS.ProcessEnv = process.env): Plane {
  const api = (env.FANOS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");
  const key = env.FANOS_API_KEY?.trim();
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  const base = `${api}/v1/projects/${encodeURIComponent(project)}`;
  return {
    async json(id) {
      const response = await fetch(`${base}/artifacts/${encodeURIComponent(id)}/content`, {
        headers,
      });
      if (!response.ok) throw new Error(`control plane artifact ${id}: ${response.status}`);
      return response.json();
    },
    async meta(id) {
      const response = await fetch(`${base}/artifacts/${encodeURIComponent(id)}`, { headers });
      if (!response.ok) throw new Error(`control plane artifact ${id}: ${response.status}`);
      return ((await response.json()) as { meta?: Record<string, unknown> }).meta ?? {};
    },
    async upload(kind, json, meta) {
      const response = await fetch(`${base}/artifacts`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ kind, json, meta }),
      });
      if (!response.ok)
        throw new Error(
          `control plane upload ${kind}: ${response.status} ${await response.text()}`,
        );
      return ((await response.json()) as { id: string }).id;
    },
  };
}

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
             $9, 'agent:interaction', $10, $11)`,
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
