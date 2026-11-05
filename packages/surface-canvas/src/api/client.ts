/**
 * Outbound HTTP for Surface Studio.
 *
 * Themes stay compiled in. This exists so the sandbox can post a page event
 * without the panel growing a second product. `fetch` is injected — the only
 * Figma-aware call is the one `main.ts` makes when it constructs a client.
 *
 * A down dashboard must never stall a lint. Every method returns an
 * {@link ApiResult}; nothing here throws into the session.
 *
 * PURE.
 */
import { describeError } from "./describe-error.js";
import type {
  ApiFetch,
  ApiResult,
  StudioEvent,
} from "./types.js";

export const API_TIMEOUT_MS = 4000;
export const EVENTS_PATH = "/v1/events";

export interface ApiClient {
  readonly origin: string;
  postEvent(event: StudioEvent): Promise<ApiResult>;
}

export function createApiClient(options: {
  origin: string;
  fetch: ApiFetch;
  timeoutMs?: number;
}): ApiClient {
  const origin = options.origin.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    limitMs = timeoutMs,
  ): Promise<ApiResult> => {
    const url = `${origin}${path.startsWith("/") ? path : `/${path}`}`;
    const init: Parameters<ApiFetch>[1] = {
      method,
      headers: { Accept: "application/json" },
    };
    if (body !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }

    try {
      const response = await withTimeout(options.fetch(url, init), limitMs);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: (await readMessage(response)) || `${response.status} ${response.statusText}`.trim(),
        };
      }
      return { ok: true, status: response.status, data: await readData(response) };
    } catch (err) {
      return { ok: false, status: null, message: errorMessage(err) };
    }
  };

  return {
    origin,
    postEvent: (event) => request("POST", EVENTS_PATH, event),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API timed out after ${ms}ms`)), ms);
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

async function readData(response: { json(): Promise<unknown>; text(): Promise<string> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      const text = await response.text();
      return text === "" ? null : text;
    } catch {
      return null;
    }
  }
}

/**
 * Two error shapes reach here, and both have to be legible.
 *
 *   - Surface Studio's own:  { message }
 *   - the control plane's:   { error: { code, message, details } }
 *
 * Only the first was read, so every relayed API error collapsed to the
 * `422 Unprocessable Entity` fallback and the designer lost the one sentence
 * that said what to do — e.g. an unmapped Figma file naming the fix.
 */
async function readMessage(response: {
  json(): Promise<unknown>;
  text(): Promise<string>;
}): Promise<string> {
  const data = await readData(response);
  const direct = messageIn(data);
  if (direct) return direct;

  if (data && typeof data === "object" && "error" in data) {
    const nested = messageIn((data as { error: unknown }).error);
    if (nested) return nested;
  }

  if (typeof data === "string" && data.trim()) return data.trim();
  return "";
}

function messageIn(value: unknown): string {
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "";
}

function errorMessage(err: unknown): string {
  return describeError(err);
}
