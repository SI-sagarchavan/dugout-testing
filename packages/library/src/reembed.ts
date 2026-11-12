import { type Pool, toVector } from "@dugout/db";
import type { CropStore } from "./crops.ts";
import type { MultimodalEmbeddings } from "./embeddings.ts";

/** How many sections another embedder made, by the model that made them. */
export async function staleSections(
  pool: Pool,
  model: string,
  tenantId?: string,
): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `select embedding_model, count(*)::int as n from library_sections
     where embedding_model <> $1 and ($2::text is null or tenant_id = $2)
     group by embedding_model`,
    [model, tenantId ?? null],
  );
  return Object.fromEntries(rows.map((r) => [String(r.embedding_model), Number(r.n)]));
}

/**
 * Embeds again every section another embedder made: its words (the stored `search_text`) and its
 * picture (read from the crop store). Vectors of two models cannot be compared, so after the
 * embedder changes nothing old is found until this has run. Every tenant's sections, so it takes
 * the admin pool. A section whose picture is gone is left as it was and counted in `missing`.
 */
export async function reembedSections(opts: {
  pool: Pool;
  embeddings: MultimodalEmbeddings;
  crops: CropStore;
  tenantId?: string;
  batch?: number;
  onBatch?: (done: number) => void;
}): Promise<{ done: number; missing: string[] }> {
  const { pool, embeddings, crops } = opts;
  const missing: string[] = [];
  let done = 0;
  for (;;) {
    const { rows } = await pool.query(
      `select id, search_text, crop_key from library_sections
       where embedding_model <> $1 and ($3::text is null or tenant_id = $3) and id <> all($4::uuid[])
       order by id limit $2`,
      [embeddings.model, opts.batch ?? 8, opts.tenantId ?? null, missing],
    );
    if (rows.length === 0) return { done, missing };
    for (const row of rows) {
      const id = String(row.id);
      let png: Buffer;
      try {
        png = await crops.get(String(row.crop_key));
      } catch {
        missing.push(id);
        continue;
      }
      const [[text], [image]] = await Promise.all([
        embeddings.embedText([String(row.search_text)]),
        embeddings.embedImages([png]),
      ]);
      await pool.query(
        `update library_sections set text_embedding = $2::vector, image_embedding = $3::vector,
           embedding_model = $4 where id = $1`,
        [id, toVector(text ?? []), toVector(image ?? []), embeddings.model],
      );
      done++;
      opts.onBatch?.(done);
    }
  }
}
