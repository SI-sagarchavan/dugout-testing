import { createHash } from "node:crypto";
import type { ControlPlane, ExportRecord } from "./control-plane.ts";

/**
 * Where a frame's own files come from: its IR and its screenshots, by id. The control plane is one
 * (an export), a Handoff in the FanXP backend is the other. The theme and everything the agent
 * stores still go to the control plane until the Surface MCP server replaces it (ADR 0027).
 */
export type FrameSource = Pick<ControlPlane, "getExport" | "json" | "bytes">;

/** One file of a received Handoff, as `GET /surface/service/handoffs/:id` answers it. */
export interface HandoffFile {
  name: string;
  kind: string;
  nodeId: string | null;
  targetNodeId: string | null;
  contentType: string;
  size: number;
  sha256: string;
  /** Presigned GET, valid for the answer's `expiresIn` seconds. */
  url: string;
}

export interface HandoffRecord {
  handoffId: string;
  client: string;
  status: string;
  source: { rootNodeId?: string | null; rootName?: string | null; fileKey?: string | null };
  receivedAt: string | null;
  files: HandoffFile[];
}

export class HandoffError extends Error {}

/** The backend's API root (`…/fanxp/api/v1`) and the key its service routes take. */
export function handoffConfig(env: NodeJS.ProcessEnv = process.env) {
  const url = env.SURFACE_API_URL?.trim();
  const key = env.SURFACE_SERVICE_KEY?.trim();
  return url && key ? { url, key } : undefined;
}

/** The theme a tenant has active in FanXP, as `GET /surface/service/theme` answers it. */
export interface TenantTheme {
  themeId: string;
  themeName: string | null;
  /** One theme's tokens, in the theme's export shape (`color.light`, `gradient.light`, …). */
  tokens: Record<string, unknown>;
}

/**
 * The tenant's active FanXP theme: the source of truth for every token. Surface Studio and every
 * FanXP page draw with it, so a section built against any other set of tokens shows its own and not
 * the page's: the fixtures fades were drawn with two tokens that only a control-plane copy had, and
 * painted nothing in Studio. The answer is wrapped as a token set (`{ tokens: { <themeId>: … } }`),
 * the shape the compiler reads.
 */
export async function readTenantTheme(
  tenantId: string,
  opts: { url: string; key: string; fetch?: typeof fetch },
): Promise<{ raw: { tokens: Record<string, unknown> }; theme: TenantTheme }> {
  const send = opts.fetch ?? fetch;
  const response = await send(`${opts.url.replace(/\/+$/, "")}/surface/service/theme`, {
    headers: {
      "x-surface-service-key": opts.key,
      client: tenantId,
      accept: "application/json",
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: TenantTheme;
    meta?: { message?: string };
  };
  const theme = body.data;
  if (!response.ok || !theme?.themeId || !theme.tokens) {
    throw new HandoffError(
      `FanXP has no theme for ${tenantId}: ${body.meta?.message ?? `status ${response.status}`}`,
    );
  }
  return { raw: { tokens: { [theme.themeId]: theme.tokens } }, theme };
}

/**
 * The files a designer's Handoff put on S3, read through the FanXP backend. The backend answers
 * only for the client the call names, which is the run's verified tenant (the client code), never
 * an id the model gave. Each file is checked against the SHA-256 the plugin hashed it with, so
 * what the agent measures is byte for byte what the designer sent.
 *
 * The answer is an `ExportRecord` whose artifact ids are the Handoff's file names, so the rest of
 * frame-match reads a Handoff exactly as it reads an export. Screenshots and vector art are its
 * plates, in the order the plugin sent them, as the control plane stores them.
 */
export function createHandoffSource(
  tenantId: string,
  handoffId: string,
  opts: { url: string; key: string; fetch?: typeof fetch },
): FrameSource {
  const send = opts.fetch ?? fetch;
  const root = opts.url.replace(/\/+$/, "");
  let held: Promise<HandoffRecord> | undefined;

  const read = async (): Promise<HandoffRecord> => {
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
      data?: HandoffRecord;
      meta?: { message?: string };
    };
    if (!response.ok || !body.data) {
      throw new HandoffError(
        `Surface would not give Handoff ${handoffId} for ${tenantId}: ${body.meta?.message ?? `status ${response.status}`}`,
      );
    }
    return body.data;
  };
  /** One read per source; a failed one is tried again next time. */
  const record = () => {
    held ??= read().catch((err) => {
      held = undefined;
      throw err;
    });
    return held;
  };

  const fileNamed = async (name: string) => {
    const file = (await record()).files.find((f) => f.name === name);
    if (!file) throw new HandoffError(`Handoff ${handoffId} has no file "${name}"`);
    return file;
  };

  const download = async (name: string): Promise<Buffer> => {
    const file = await fileNamed(name);
    const response = await send(file.url);
    if (!response.ok) {
      throw new HandoffError(
        `S3 answered ${response.status} for "${name}" of Handoff ${handoffId}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256.toLowerCase()) {
      throw new HandoffError(`"${name}" of Handoff ${handoffId} is not the file the designer sent`);
    }
    return bytes;
  };

  return {
    async getExport(): Promise<ExportRecord> {
      const handoff = await record();
      const ir = handoff.files.find((f) => f.kind === "ir");
      if (!ir) throw new HandoffError(`Handoff ${handoffId} has no IR`);
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
        assets: handoff.files
          .filter((f) => f.kind === "background")
          .map((f) => ({ name: f.name, artifactId: f.name })),
      };
    },
    json: async (name) => JSON.parse((await download(name)).toString("utf8")) as unknown,
    bytes: download,
  };
}
