import { createBedrockClient, loadEnv, loadModelConfig } from "@dugout/core";
import { createPool, type Pool } from "@dugout/db";
import { createSectionLibrary, likeFinder, loadMultimodalEmbeddings } from "@dugout/library";
import { defaultMcpHost } from "@dugout/mcp";
import {
  createMemoryStore,
  createModelLessonWriter,
  createThreadNotes,
  loadEmbeddings,
} from "@dugout/memory";
import { loadTracing } from "@dugout/tracing";
import { sharedWritesAuto } from "./subagents.ts";

/** The model that turns a reviewer's words into a lesson: a short rewrite, so a cheap one; a `global.*` profile, so it runs in any region. */
export const LESSON_MODEL = "haiku";

/**
 * Reads whether a tenant opted in to shared writes under one approval (`sharedWritesAuto`), from
 * its house facts in Postgres: for a host that approves without asking (`--yes`), which reads it
 * for the tenant it verified.
 */
export function sharedWritesOptIn(pool: Pool): (tenantId: string) => Promise<boolean> {
  const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
  return (tenantId) => sharedWritesAuto(store, tenantId);
}

/** Real deps for CLI and API runs: .env, model client, Postgres-backed memory, lessons, tracing. */
export function liveDeps() {
  loadEnv();
  const models = loadModelConfig();
  const client = createBedrockClient({ models });
  const pool = createPool();
  const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
  const lessons = createModelLessonWriter(client, LESSON_MODEL);
  // the registry's MCP servers, one connection per server and tenant for the process
  const mcp = defaultMcpHost();
  // what each thread's earlier runs did, for the next run in it (ADR 0031)
  const threads = createThreadNotes(pool);
  // undefined unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set; a run's Langfuse
  // session is its thread, so a Handoff and every later run on its section replay together
  const tracing = loadTracing(process.env, { sessionOf: threads.threadOf });
  // which sections are like one, read from the section library in code (ADR 0034)
  const like = likeFinder(createSectionLibrary({ pool, embeddings: loadMultimodalEmbeddings() }));
  return { models, client, pool, store, lessons, tracing, mcp, threads, like };
}
