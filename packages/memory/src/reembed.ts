import { type Pool, toVector } from "@dugout/db";
import type { EmbeddingClient } from "./embeddings.ts";

/** How many rows another embedder made, by the model that made them. */
export async function staleEmbeddings(
  pool: Pool,
  model: string,
  tenantId?: string,
): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `select embedding_model, count(*)::int as n from memory_items
     where embedding_model <> $1 and ($2::text is null or tenant_id = $2)
     group by embedding_model`,
    [model, tenantId ?? null],
  );
  return Object.fromEntries(rows.map((r) => [String(r.embedding_model), Number(r.n)]));
}

/**
 * Embeds again every row another embedder made (ADR 0034): vectors from two embedders cannot be
 * compared, so after the embedder changes nothing old is found until this has run. It reads every
 * tenant's rows and the shared ones, so it takes the admin pool. The text embedded is the row's
 * content; a lesson's vector no longer carries the run input it was learned on, which was an id.
 */
export async function reembed(opts: {
  pool: Pool;
  embeddings: EmbeddingClient;
  /** One tenant's rows only; without it every tenant's and the shared ones. */
  tenantId?: string;
  batch?: number;
  onBatch?: (done: number) => void;
}): Promise<number> {
  const { pool, embeddings } = opts;
  let done = 0;
  for (;;) {
    const { rows } = await pool.query(
      `select id, content from memory_items
       where embedding_model <> $1 and ($3::text is null or tenant_id = $3)
       order by id limit $2`,
      [embeddings.model, opts.batch ?? 16, opts.tenantId ?? null],
    );
    if (rows.length === 0) return done;
    const vectors = await embeddings.embed(rows.map((r) => String(r.content)));
    for (const [i, row] of rows.entries()) {
      await pool.query(
        `update memory_items set embedding = $2::vector, embedding_model = $3 where id = $1`,
        [row.id, toVector(vectors[i] ?? []), embeddings.model],
      );
    }
    done += rows.length;
    opts.onBatch?.(done);
  }
}
