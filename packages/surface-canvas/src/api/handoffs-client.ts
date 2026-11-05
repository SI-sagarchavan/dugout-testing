/**
 * The three steps of a Handoff, against the FanXP backend:
 *
 *   1. `POST /surface/handoffs`              tell it every file; it answers one signed upload URL for
 *                                         each file S3 does not hold yet
 *   2. `PUT <url>`                        the file's bytes, straight to S3, never through the backend
 *   3. `POST /surface/handoffs/:id/complete` the backend looks at S3 and accepts the send only if every
 *                                         object is the size and SHA-256 that was promised
 *
 * Nothing here throws into the session: every step answers with a value, and a network
 * failure is a value too. `fetch` is injected.
 *
 * PURE.
 */
import { z } from "zod";
import { messageOf, unwrap } from "../auth/client.js";
import { describeError } from "./describe-error.js";
import type { ApiFetch } from "./types.js";
import { manifestOf, type ManifestFile, type PreparedFile } from "./uploads.js";

export const HANDOFFS_PATH = "/surface/handoffs";
const JSON_TIMEOUT_MS = 30_000;
/** A section picture is a few MB; on a slow connection that is a while. */
const UPLOAD_TIMEOUT_MS = 120_000;
/** How many files are in flight at once. */
export const UPLOAD_CONCURRENCY = 4;

const startAnswer = z.object({
  handoffId: z.string().min(1),
  expiresIn: z.number(),
  uploads: z.array(
    z.object({
      name: z.string(),
      method: z.literal("PUT"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()),
    }),
  ),
  /** Files S3 already holds, from an earlier send of the same bytes. */
  present: z.array(z.string()),
});

const completeAnswer = z.object({
  handoffId: z.string().min(1),
  status: z.string(),
  files: z.number(),
});

export type StartedHandoff = z.infer<typeof startAnswer>;
export type Upload = StartedHandoff["uploads"][number];

/** Why a step failed, in the terms the caller acts on. */
export interface Failure {
  ok: false;
  /** HTTP status, or null when nothing answered. */
  status: number | null;
  /** 401: the plugin's token is dead. */
  unauthorized: boolean;
  /** 403: the user can no longer send for this client. */
  forbidden: boolean;
  message: string;
}

export type Step<T> = { ok: true; value: T } | Failure;

export interface HandoffSource {
  fileKey: string | null;
  fileName: string;
  pageName: string;
  rootNodeId: string | null;
  rootName: string | null;
  frames: Array<{ frameId: string; name: string }>;
  summary?: Record<string, unknown>;
}

export interface HandoffsClient {
  start(accessToken: string, client: string, source: HandoffSource, files: ManifestFile[]): Promise<Step<StartedHandoff>>;
  upload(upload: Upload, bytes: Uint8Array): Promise<Step<null>>;
  complete(accessToken: string, handoffId: string): Promise<Step<{ handoffId: string; files: number }>>;
}

export function createHandoffsClient(options: { baseUrl: string; fetch: ApiFetch }): HandoffsClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  /** `fromBackend`: only the backend's own 401 and 403 mean sign-in or access. S3's mean something else. */
  const failure = (status: number | null, message: string, fromBackend = true): Failure => ({
    ok: false,
    status,
    unauthorized: fromBackend && status === 401,
    forbidden: fromBackend && status === 403,
    message,
  });

  const postJson = async (
    path: string,
    body: unknown,
    accessToken: string,
  ): Promise<{ status: number; data: unknown; raw: unknown } | Failure> => {
    try {
      const response = await withTimeout(
        options.fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
        }),
        JSON_TIMEOUT_MS,
      );
      let raw: unknown = null;
      try {
        raw = await response.json();
      } catch {
        raw = null;
      }
      if (!response.ok) {
        return failure(response.status, messageOf(raw) || `The backend answered ${response.status}.`);
      }
      return { status: response.status, data: unwrap(raw), raw };
    } catch (err) {
      return failure(null, `Couldn’t reach ${baseUrl} (${describeError(err)}). Is the backend running?`);
    }
  };

  return {
    async start(accessToken, client, source, files) {
      const result = await postJson(HANDOFFS_PATH, { client, source, files }, accessToken);
      if ("ok" in result) return result;
      const parsed = startAnswer.safeParse(result.data);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : failure(result.status, "The backend’s answer to the send was not what the plugin expected.");
    },

    async upload(upload, bytes) {
      try {
        const response = await withTimeout(
          options.fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes }),
          UPLOAD_TIMEOUT_MS,
        );
        if (response.ok) return { ok: true, value: null };
        return failure(response.status, `S3 refused "${upload.name}": ${await s3Reason(response)}`, false);
      } catch (err) {
        return failure(
          null,
          `Couldn’t upload "${upload.name}" (${describeError(err)}). Check your connection, then send again.`,
          false,
        );
      }
    },

    async complete(accessToken, handoffId) {
      const result = await postJson(`${HANDOFFS_PATH}/${handoffId}/complete`, {}, accessToken);
      if ("ok" in result) return result;
      const parsed = completeAnswer.safeParse(result.data);
      return parsed.success
        ? { ok: true, value: { handoffId: parsed.data.handoffId, files: parsed.data.files } }
        : failure(result.status, "The backend’s answer to the send was not what the plugin expected.");
    },
  };
}

/** S3 answers an error as XML: `<Code>` is the part worth showing. */
async function s3Reason(response: { status: number; statusText: string; text(): Promise<string> }): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
  const status = `${response.status} ${response.statusText}`.trim();
  return code ? `${status}, ${code}${message ? ` (${message})` : ""}` : status;
}

export interface HandoffOutcome {
  handoffId: string;
  /** Files uploaded now. */
  uploaded: number;
  /** Files S3 already held. */
  present: number;
}

/**
 * Run a whole Handoff: start, upload what is missing, complete.
 *
 * A file that fails is tried once more (a connection blip), and only then does the send
 * fail with that file named. The backend's `complete` is the judge of whether it worked.
 */
export async function runHandoff(deps: {
  client: HandoffsClient;
  accessToken: string;
  tenant: string;
  source: HandoffSource;
  files: readonly PreparedFile[];
  /** Called as each file lands: `done` of `total` to upload. */
  onProgress?: (done: number, total: number) => void;
}): Promise<Step<HandoffOutcome>> {
  const started = await deps.client.start(deps.accessToken, deps.tenant, deps.source, manifestOf(deps.files));
  if (!started.ok) return started;

  const bytesByName = new Map(deps.files.map((file) => [file.name, file.bytes]));
  const { uploads } = started.value;
  let done = 0;
  deps.onProgress?.(0, uploads.length);

  let failed: Failure | null = null;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!failed && next < uploads.length) {
      const upload = uploads[next++]!;
      const bytes = bytesByName.get(upload.name);
      if (!bytes) {
        failed = failure_(`The backend asked for "${upload.name}", which is not in this send.`);
        return;
      }
      let result = await deps.client.upload(upload, bytes);
      if (!result.ok) result = await deps.client.upload(upload, bytes);
      if (!result.ok) {
        failed = result;
        return;
      }
      deps.onProgress?.(++done, uploads.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, uploads.length) }, worker));
  if (failed) return failed;

  const completed = await deps.client.complete(deps.accessToken, started.value.handoffId);
  if (!completed.ok) return completed;
  return {
    ok: true,
    value: { handoffId: started.value.handoffId, uploaded: uploads.length, present: started.value.present.length },
  };
}

function failure_(message: string): Failure {
  return { ok: false, status: null, unauthorized: false, forbidden: false, message };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
