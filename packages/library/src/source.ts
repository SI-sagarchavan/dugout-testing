import { createHash } from "node:crypto";

/**
 * Where a Handoff's files are read from, by ref. The local control plane (`apps/api`) is the one
 * this has today; the FanXP backend's Handoff (signed S3 URLs, ADR 0027) answers the same shape in
 * frame-match's `handoff.ts`, and comes here with ticket 12.
 */

export interface HandoffPlateRef {
  nodeId: string;
  name: string;
  /** How its bytes are read. */
  artifactId: string;
}

export interface HandoffRecord {
  id: string;
  fileKey?: string | null;
  rootNodeId: string | null;
  rootName: string | null;
  irArtifactId: string;
  receivedAt?: string;
  plates: HandoffPlateRef[];
}

export interface HandoffSource {
  listExports(limit: number): Promise<HandoffRecord[]>;
  getExport(id: string): Promise<HandoffRecord>;
  json(ref: string): Promise<unknown>;
  bytes(ref: string): Promise<Buffer>;
}

export function controlPlaneUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.FANOS_API_URL ?? "http://localhost:4100";
}

/** The control plane's exports and artifacts for one project. */
export function createControlPlaneSource(
  project: string,
  opts: { baseUrl?: string; apiKey?: string; fetch?: typeof fetch } = {},
): HandoffSource {
  const base = `${opts.baseUrl ?? controlPlaneUrl()}/v1/projects/${encodeURIComponent(project)}`;
  const send = opts.fetch ?? fetch;
  const apiKey = opts.apiKey ?? process.env.FANOS_API_KEY;
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const request = async (path: string) => {
    let response: Response;
    try {
      response = await send(`${base}${path}`, { headers });
    } catch (err) {
      throw new Error(
        `cannot reach the control plane at ${base} (${(err as Error).message}); start it with \`pnpm dev\``,
      );
    }
    if (!response.ok) {
      throw new Error(`control plane ${path}: ${response.status} ${await response.text()}`);
    }
    return response;
  };
  return {
    async listExports(limit) {
      const body = (await (await request(`/exports?limit=${limit}`)).json()) as {
        exports: HandoffRecord[];
      };
      return body.exports;
    },
    getExport: async (id) =>
      (await (await request(`/exports/${encodeURIComponent(id)}`)).json()) as HandoffRecord,
    json: async (ref) => (await request(`/artifacts/${encodeURIComponent(ref)}/content`)).json(),
    bytes: async (ref) =>
      Buffer.from(
        await (await request(`/artifacts/${encodeURIComponent(ref)}/content`)).arrayBuffer(),
      ),
  };
}

/** One file of a received Handoff, as `GET /surface/service/handoffs/:id` answers it. */
interface SurfaceFile {
  name: string;
  kind: string;
  nodeId: string | null;
  sha256: string;
  /** Presigned GET. */
  url: string;
}

interface SurfaceHandoff {
  handoffId: string;
  source: { rootNodeId?: string | null; rootName?: string | null; fileKey?: string | null };
  receivedAt: string | null;
  files: SurfaceFile[];
}

/** The FanXP backend's API root and the key its service routes take, when both are set. */
export function surfaceConfig(env: NodeJS.ProcessEnv = process.env) {
  const url = env.SURFACE_API_URL?.trim();
  const key = env.SURFACE_SERVICE_KEY?.trim();
  return url && key ? { url, key } : undefined;
}

/**
 * One Handoff's files on S3, read through the FanXP backend for the client the call names (the
 * verified tenant), each checked against the SHA-256 the plugin hashed it with. As frame-match's
 * `createHandoffSource` reads it; the two become one with ticket 12. Refs are the files' names.
 */
export function createSurfaceHandoffSource(
  tenantId: string,
  handoffId: string,
  opts: { url: string; key: string; fetch?: typeof fetch },
): Pick<HandoffSource, "getExport" | "json" | "bytes"> {
  const send = opts.fetch ?? fetch;
  const root = opts.url.replace(/\/+$/, "");
  let held: Promise<SurfaceHandoff> | undefined;
  const read = async (): Promise<SurfaceHandoff> => {
    const response = await send(
      `${root}/surface/service/handoffs/${encodeURIComponent(handoffId)}`,
      {
        headers: {
          "x-surface-service-key": opts.key,
          client: tenantId,
          accept: "application/json",
        },
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      data?: SurfaceHandoff;
      meta?: { message?: string };
    };
    if (!response.ok || !body.data) {
      throw new Error(
        `Surface would not give Handoff ${handoffId} for ${tenantId}: ${body.meta?.message ?? `status ${response.status}`}`,
      );
    }
    return body.data;
  };
  const record = () => {
    held ??= read().catch((err) => {
      held = undefined;
      throw err;
    });
    return held;
  };
  const download = async (name: string): Promise<Buffer> => {
    const file = (await record()).files.find((f) => f.name === name);
    if (!file) throw new Error(`Handoff ${handoffId} has no file "${name}"`);
    const response = await send(file.url);
    if (!response.ok)
      throw new Error(`S3 answered ${response.status} for "${name}" of Handoff ${handoffId}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256.toLowerCase()) {
      throw new Error(`"${name}" of Handoff ${handoffId} is not the file the designer sent`);
    }
    return bytes;
  };
  return {
    async getExport() {
      const handoff = await record();
      const ir = handoff.files.find((f) => f.kind === "ir");
      if (!ir) throw new Error(`Handoff ${handoffId} has no IR`);
      return {
        id: handoff.handoffId,
        fileKey: handoff.source.fileKey ?? null,
        rootNodeId: handoff.source.rootNodeId ?? null,
        rootName: handoff.source.rootName ?? null,
        irArtifactId: ir.name,
        ...(handoff.receivedAt ? { receivedAt: handoff.receivedAt } : {}),
        plates: handoff.files
          .filter((f) => (f.kind === "screenshot" || f.kind === "vector") && f.nodeId)
          .map((f) => ({ nodeId: f.nodeId as string, name: f.name, artifactId: f.name })),
      };
    },
    json: async (name) => JSON.parse((await download(name)).toString("utf8")) as unknown,
    bytes: download,
  };
}
