import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REGISTRY_DIR } from "./registry.ts";

/**
 * What a server said about one tool when it was last synced. Agents get their tools from here,
 * not from the live server: a tool's description and schema are what the model reads, so a change
 * to them is reviewed (the lock's diff) before any agent sees it.
 */
export const LockedTool = z.object({
  title: z.string().optional(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** What its `structuredContent` holds, when the server says: what code may read of a result. */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  hash: z.string(),
});
export type LockedTool = z.infer<typeof LockedTool>;

/**
 * A resource the registry grants, as the server gave it when synced. Agents read it from here
 * (`<server>.readResource`), not from the live server: like a tool's description, it is what the
 * model reads, so a change to it is reviewed first.
 */
export const LockedResource = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  text: z.string(),
  hash: z.string(),
});
export type LockedResource = z.infer<typeof LockedResource>;

export const Lock = z.object({
  server: z.string(),
  syncedAt: z.string(),
  serverInfo: z.object({ name: z.string(), version: z.string() }),
  protocolVersion: z.string().optional(),
  /** The server's `instructions`: the guidance agents get about its tools. */
  instructions: z.string().optional(),
  instructionsHash: z.string().optional(),
  /** Only the tools the registry entry lists. */
  tools: z.record(z.string(), LockedTool),
  /** Only the resources a capability grants, by URI. */
  resources: z.record(z.string(), LockedResource).optional(),
});
export type Lock = z.infer<typeof Lock>;

/** What `tools/list` gives for one tool, as far as the lock keeps it. */
export interface RemoteTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  annotations?: Record<string, unknown> | undefined;
}

/** What `resources/list` and `resources/read` give for one text resource. */
export interface RemoteResource {
  uri: string;
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  mimeType?: string | undefined;
  text: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export const sha256 = (value: unknown) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;

/**
 * What makes a tool the same tool: everything the model reads, what it says it does, and the
 * shape of what it answers, which code reads.
 */
export function toolHash(tool: RemoteTool): string {
  return sha256({
    name: tool.name,
    title: tool.title,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  });
}

export function resourceHash(resource: RemoteResource): string {
  return sha256({
    uri: resource.uri,
    name: resource.name,
    title: resource.title,
    description: resource.description,
    mimeType: resource.mimeType,
    text: resource.text,
  });
}

export const lockPath = (server: string, dir: string = REGISTRY_DIR) =>
  join(dir, `${server}.lock.json`);

export function readLock(server: string, dir: string = REGISTRY_DIR): Lock | undefined {
  try {
    return Lock.parse(JSON.parse(readFileSync(lockPath(server, dir), "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function writeLock(lock: Lock, dir: string = REGISTRY_DIR): string {
  const path = lockPath(lock.server, dir);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(lock, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return path;
}

/** The tools whose live definition is not the locked one, with what changed. */
export function drift(lock: Lock, live: RemoteTool[]): Map<string, string> {
  const byName = new Map(live.map((t) => [t.name, t]));
  const changed = new Map<string, string>();
  for (const [name, locked] of Object.entries(lock.tools)) {
    const now = byName.get(name);
    if (!now) changed.set(name, "the server no longer has it");
    else if (toolHash(now) !== locked.hash)
      changed.set(name, "its description, schemas or annotations changed");
  }
  return changed;
}
