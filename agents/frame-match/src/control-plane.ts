/** The FanOS control plane, where a designer's Handoff is stored. Everything here is read by id. */
export interface ExportRecord {
  id: string;
  fileKey?: string | null;
  rootNodeId: string | null;
  rootName: string | null;
  irArtifactId: string;
  receivedAt?: string;
  plates: Array<{ nodeId: string; name: string; artifactId: string }>;
  assets?: Array<{ name: string; artifactId: string }>;
}

export interface ControlPlane {
  listExports(limit: number): Promise<ExportRecord[]>;
  getExport(id: string): Promise<ExportRecord>;
  json(artifactId: string): Promise<unknown>;
  bytes(artifactId: string): Promise<Buffer>;
  newestArtifactId(kind: string): Promise<string | undefined>;
  upload(kind: string, json: unknown, meta: Record<string, unknown>): Promise<string>;
}

export function controlPlaneUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.FANOS_API_URL ?? "http://localhost:4100";
}

/**
 * The Next.js site (`apps/web`), which renders a stored tree as a page with the renderer's client
 * components running, so a carousel swipes. Its preview is `/preview/<project>/<tree id>`.
 */
export function webUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FANOS_WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function createControlPlane(
  project: string,
  opts: { baseUrl?: string; apiKey?: string; fetch?: typeof fetch } = {},
): ControlPlane {
  const base = `${opts.baseUrl ?? controlPlaneUrl()}/v1/projects/${encodeURIComponent(project)}`;
  const send = opts.fetch ?? fetch;
  const apiKey = opts.apiKey ?? process.env.FANOS_API_KEY;
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const request = async (path: string, init?: RequestInit) => {
    const response = await send(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) {
      throw new Error(`control plane ${path}: ${response.status} ${await response.text()}`);
    }
    return response;
  };
  return {
    async listExports(limit) {
      const body = (await (await request(`/exports?limit=${limit}`)).json()) as {
        exports: ExportRecord[];
      };
      return body.exports;
    },
    getExport: async (id) =>
      (await (await request(`/exports/${encodeURIComponent(id)}`)).json()) as ExportRecord,
    json: async (id) => (await request(`/artifacts/${encodeURIComponent(id)}/content`)).json(),
    bytes: async (id) =>
      Buffer.from(
        await (await request(`/artifacts/${encodeURIComponent(id)}/content`)).arrayBuffer(),
      ),
    async newestArtifactId(kind) {
      // A theme this agent stored is one frame's copy with its raw paints in, not the project's.
      const body = (await (await request(`/artifacts?kind=${kind}&limit=100`)).json()) as {
        artifacts?: Array<{ id?: string; meta?: { source?: unknown } }>;
      };
      return body.artifacts?.find((a) => !String(a.meta?.source ?? "").startsWith("dugout:"))?.id;
    },
    async upload(kind, json, meta) {
      const body = (await (
        await request("/artifacts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind, json, meta }),
        })
      ).json()) as { id: string };
      return body.id;
    },
  };
}
