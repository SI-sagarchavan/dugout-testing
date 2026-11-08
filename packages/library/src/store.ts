import { type Client, type Pool, toVector, withTenant } from "@dugout/db";
import { type DataShape, shapeWords } from "./data-shape.ts";
import type { MultimodalEmbeddings } from "./embeddings.ts";
import type { Rect } from "./ir.ts";
import type { Skeleton } from "./skeleton.ts";

/** One sighting of a section: which Handoff, where its IR is, and the section's root in it. */
export interface SectionSource {
  handoffId: string;
  /** How the IR is read: a control-plane artifact id now, an S3 key later. */
  irRef: string;
  nodeId: string;
  fileKey: string | null;
  at: string;
}

export interface NewSection {
  signature: string;
  name: string;
  kind?: string;
  layout: string;
  summary: string;
  caption?: string;
  tags?: string[];
  box: Rect;
  cropKey: string;
  cropWidth: number;
  cropHeight: number;
  /** The picture's bytes, embedded here and not stored in the row. */
  crop: Buffer;
  /** What another tenant is shown of it. */
  skeleton?: Skeleton;
  source: SectionSource;
}

/** A preview built from a Handoff the section was seen in: what puts it in the shared pool. */
export interface SectionPreview {
  runId: string;
  agentId: string;
  handoffId: string;
  previewUrl: string;
  at: string;
}

/**
 * A section as the tenant reading it may see it. Another tenant's comes without which tenant it
 * is, its picture, its layer name, its sources and its previews: what it is shown is the skeleton.
 */
export interface Section {
  id: string;
  tenantId: string;
  /** The reading tenant's own. */
  own: boolean;
  signature: string;
  name: string;
  kind: string;
  layout: string;
  summary: string;
  caption: string;
  /** What search and people see: a model's tags less those a person took away, plus a person's. */
  tags: string[];
  modelTags: string[];
  personTags: string[];
  removedTags: string[];
  box: Rect;
  /** Null for another tenant's section. */
  cropKey: string | null;
  cropWidth: number;
  cropHeight: number;
  sources: SectionSource[];
  skeleton: Skeleton | null;
  /** When a preview was first built from it; null until then, and it is not shared until then. */
  previewedAt: string | null;
  previews: SectionPreview[];
  /** The fields and lists it shows, from the latest preview that bound it to data; no values. */
  dataShape: DataShape | null;
  tree: unknown;
  embeddingModel: string;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SectionQuery {
  text?: string;
  /** PNG bytes: find sections that look like it. */
  image?: Buffer;
  kind?: string;
  layout?: string;
  limit?: number;
  /** `own` (the default): the tenant's sections. `shared`: its own and every shared one. */
  scope?: "own" | "shared";
}

export interface SectionLibrary {
  findBySignature(tenantId: string, signature: string): Promise<Section | undefined>;
  /** A new section, or, when its signature is already there, one more source on that one. */
  add(tenantId: string, section: NewSection): Promise<{ section: Section; created: boolean }>;
  addSource(tenantId: string, id: string, source: SectionSource): Promise<Section>;
  /** One of the tenant's sections, or a shared one of another's. */
  get(tenantId: string, id: string): Promise<Section | undefined>;
  search(tenantId: string, query: SectionQuery): Promise<Array<Section & { score: number }>>;
  /** A model's description replaces the last one; a person's tags and removals stay. */
  describe(
    tenantId: string,
    id: string,
    description: { caption: string; kind: string; tags: string[] },
  ): Promise<Section>;
  /** A person's edit. */
  editTags(
    tenantId: string,
    id: string,
    edit: { add?: string[]; remove?: string[]; kind?: string },
  ): Promise<Section>;
  setHidden(tenantId: string, id: string, hidden: boolean): Promise<Section>;
  setSkeleton(tenantId: string, id: string, skeleton: Skeleton): Promise<Section>;
  /** What data it shows; its words are searched from then on. */
  setDataShape(tenantId: string, id: string, shape: DataShape): Promise<Section>;
  /** The tenant's sections seen in a Handoff. */
  ofHandoff(tenantId: string, handoffId: string): Promise<Section[]>;
  /**
   * A preview was built from a Handoff: every section of the tenant seen in it is now used, and
   * shared from then on. Returns how many. The same run twice changes nothing.
   */
  markPreviewed(tenantId: string, preview: SectionPreview): Promise<number>;
  /** Some section of the tenant was seen in this Handoff. */
  hasHandoff(tenantId: string, handoffId: string): Promise<boolean>;
  /** Whether the tenant's previewed sections are in the shared pool. Yes unless it said no. */
  sharing(tenantId: string): Promise<boolean>;
  setSharing(tenantId: string, shares: boolean): Promise<void>;
}

/** Reciprocal rank fusion's constant, as memory search uses. */
const RRF_K = 60;
/** How far down each ranking is read before fusing. */
const RANKER_DEPTH = 50;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const COLUMNS = `id, tenant_id, signature, name, kind, layout, summary, caption, tags, person_tags,
  removed_tags, box, crop_key, crop_width, crop_height, sources, skeleton, previewed_at, previews,
  data_shape, tree, embedding_model, hidden, created_at, updated_at`;

const clean = (tags: readonly string[]) => [
  ...new Set(tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean)),
];

export function effectiveTags(model: string[], person: string[], removed: string[]): string[] {
  const gone = new Set(removed);
  return clean([...model.filter((t) => !gone.has(t)), ...person]);
}

/** What a section's words embedding and full-text search read. */
export function searchText(s: {
  kind: string;
  caption: string;
  tags: string[];
  summary: string;
  layout: string;
  dataShape?: DataShape | null;
}): string {
  return [
    `${s.kind}${s.layout !== "none" ? `, ${s.layout}` : ""}.`,
    s.caption,
    s.tags.length ? `Tags: ${s.tags.join(", ")}.` : "",
    s.dataShape ? shapeWords(s.dataShape) : "",
    `Structure: ${s.summary}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Words OR-ed into a tsquery; anything that isn't a word is dropped, so input can't break it. */
const orQuery = (text: string) =>
  [...new Set(text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].slice(0, 32).join(" | ");

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

function toSection(r: Record<string, unknown>, viewer: string): Section {
  const modelTags = (r.tags as string[]) ?? [];
  const personTags = (r.person_tags as string[]) ?? [];
  const removedTags = (r.removed_tags as string[]) ?? [];
  const own = String(r.tenant_id) === viewer;
  const section: Section = {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    own,
    signature: String(r.signature),
    name: String(r.name),
    kind: String(r.kind),
    layout: String(r.layout),
    summary: String(r.summary),
    caption: String(r.caption),
    tags: effectiveTags(modelTags, personTags, removedTags),
    modelTags,
    personTags,
    removedTags,
    box: r.box as Rect,
    cropKey: String(r.crop_key),
    cropWidth: Number(r.crop_width),
    cropHeight: Number(r.crop_height),
    sources: (r.sources as SectionSource[]) ?? [],
    skeleton: (r.skeleton as Skeleton | null) ?? null,
    previewedAt: r.previewed_at ? iso(r.previewed_at) : null,
    previews: (r.previews as SectionPreview[]) ?? [],
    dataShape: (r.data_shape as DataShape | null) ?? null,
    tree: r.tree ?? null,
    embeddingModel: String(r.embedding_model),
    hidden: Boolean(r.hidden),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
  if (own) return section;
  // the club it came from, its pictures and where it was sent stay that club's
  return {
    ...section,
    tenantId: "",
    name: "",
    cropKey: null,
    sources: [],
    previews: [],
    modelTags: [],
    personTags: [],
    removedTags: [],
  };
}

export function createSectionLibrary(opts: {
  pool: Pool;
  embeddings: MultimodalEmbeddings;
  /**
   * Words and pictures share one space, so a text query also ranks pictures and an image query
   * also ranks words. Off for the hash embedder, whose two kinds of vector mean nothing together.
   */
  crossModal?: boolean;
}): SectionLibrary {
  const { pool, embeddings } = opts;
  const crossModal = opts.crossModal ?? embeddings.model !== "hash-v1";
  const tx = <T>(tenantId: string, fn: (db: Client) => Promise<T>) =>
    withTenant(pool, tenantId, fn);
  const textVector = async (text: string) =>
    toVector((await embeddings.embedText([text]))[0] ?? []);

  const one = async (db: Client, viewer: string, sql: string, params: unknown[]) => {
    const { rows } = await db.query(sql, params);
    if (!rows[0]) throw new Error("section not found");
    return toSection(rows[0], viewer);
  };

  /** Re-embeds a section's words after its caption, kind or tags changed. */
  const rewrite = async (db: Client, section: Section) => {
    const text = searchText(section);
    return one(
      db,
      section.tenantId,
      `update library_sections set search_text = $2, text_embedding = $3::vector,
         updated_at = now()
       where id = $1 returning ${COLUMNS}`,
      [section.id, text, await textVector(text)],
    );
  };

  const appendSource = (db: Client, tenantId: string, id: string, source: SectionSource) =>
    one(
      db,
      tenantId,
      // the same Handoff's same layer is one sighting, however often it is indexed
      `update library_sections set
         sources = case
           when sources @> jsonb_build_array(jsonb_build_object('handoffId', $3::text, 'nodeId', $4::text))
           then sources else sources || $2::jsonb end,
         updated_at = now()
       where id = $1 and tenant_id = $5 returning ${COLUMNS}`,
      [id, JSON.stringify([source]), source.handoffId, source.nodeId, tenantId],
    );

  const library: SectionLibrary = {
    findBySignature: (tenantId, signature) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from library_sections where tenant_id = $1 and signature = $2`,
          [tenantId, signature],
        );
        return rows[0] ? toSection(rows[0], tenantId) : undefined;
      }),

    async add(tenantId, s) {
      const kind = s.kind ?? "other";
      const tags = clean(s.tags ?? []);
      const caption = s.caption ?? "";
      const text = searchText({ kind, caption, tags, summary: s.summary, layout: s.layout });
      const [[textVec], [imageVec]] = await Promise.all([
        embeddings.embedText([text]),
        embeddings.embedImages([s.crop]),
      ]);
      return tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `insert into library_sections (tenant_id, signature, name, kind, layout, summary, caption,
             tags, box, crop_key, crop_width, crop_height, sources, embedding_model, text_embedding,
             image_embedding, search_text, skeleton)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::vector,
             $16::vector, $17, $18)
           on conflict (tenant_id, signature) do nothing
           returning ${COLUMNS}`,
          [
            tenantId,
            s.signature,
            s.name,
            kind,
            s.layout,
            s.summary,
            caption,
            tags,
            JSON.stringify(s.box),
            s.cropKey,
            s.cropWidth,
            s.cropHeight,
            JSON.stringify([s.source]),
            embeddings.model,
            toVector(textVec ?? []),
            toVector(imageVec ?? []),
            text,
            s.skeleton ? JSON.stringify(s.skeleton) : null,
          ],
        );
        if (rows[0]) return { section: toSection(rows[0], tenantId), created: true };
        const existing = await db.query(
          "select id from library_sections where tenant_id = $1 and signature = $2",
          [tenantId, s.signature],
        );
        const id = existing.rows[0]?.id as string | undefined;
        if (!id) throw new Error(`section ${s.signature} neither added nor found`);
        return { section: await appendSource(db, tenantId, id, s.source), created: false };
      });
    },

    addSource: (tenantId, id, source) =>
      tx(tenantId, (db) => appendSource(db, tenantId, id, source)),

    get: (tenantId, id) =>
      tx(tenantId, async (db) => {
        // row-level security decides what else is readable: another tenant's shared sections
        const { rows } = await db.query(
          `select ${COLUMNS} from library_sections
           where id = $2 and (tenant_id = $1 or not hidden)`,
          [tenantId, id],
        );
        return rows[0] ? toSection(rows[0], tenantId) : undefined;
      }),

    async search(tenantId, q) {
      const text = q.text?.trim() ?? "";
      const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      if (!text && !q.image) throw new Error("a search needs words, an image, or both");
      const [textVec, imageVec] = await Promise.all([
        text ? textVector(text) : undefined,
        q.image ? embeddings.embedImages([q.image]).then(([v]) => toVector(v ?? [])) : undefined,
      ]);

      const shared = q.scope === "shared";
      const params: unknown[] = [tenantId, q.kind ?? null, q.layout ?? null, RANKER_DEPTH, shared];
      const param = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const rankers: string[] = [];
      const byVector = (column: string, vector: string) =>
        `select id, row_number() over (order by ${column} <=> ${vector}::vector) as r
         from candidates order by ${column} <=> ${vector}::vector limit $4`;
      if (textVec) {
        const v = param(textVec);
        rankers.push(byVector("text_embedding", v));
        if (crossModal) rankers.push(byVector("image_embedding", v));
        const words = orQuery(text);
        if (words) {
          const w = param(words);
          rankers.push(
            `select id, row_number() over (order by ts_rank_cd(tsv, tq) desc) as r
             from candidates, to_tsquery('english', ${w}) tq
             where tsv @@ tq order by ts_rank_cd(tsv, tq) desc limit $4`,
          );
        }
      }
      if (imageVec) {
        const v = param(imageVec);
        rankers.push(byVector("image_embedding", v));
        if (crossModal) rankers.push(byVector("text_embedding", v));
      }
      const limitParam = param(limit);

      return tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `with candidates as (
             select * from library_sections
             -- shared: row-level security lets through others' shared sections and no more
             where ($5 or tenant_id = $1) and not hidden
               and ($2::text is null or kind = $2) and ($3::text is null or layout = $3)
           ),
           ranks as (
             ${rankers.map((r) => `(${r})`).join("\n union all\n")}
           ),
           fused as (
             select id, sum(1.0 / (${RRF_K} + r)) as score from ranks group by id
           )
           select ${COLUMNS.split(",")
             .map((c) => `c.${c.trim()}`)
             .join(", ")}, f.score
           from fused f join candidates c using (id)
           order by f.score desc, c.updated_at desc
           limit ${limitParam}`,
          params,
        );
        return rows.map((r) => ({ ...toSection(r, tenantId), score: Number(r.score) }));
      });
    },

    describe: (tenantId, id, d) =>
      tx(tenantId, async (db) => {
        const section = await one(
          db,
          tenantId,
          `update library_sections set caption = $2, kind = $3, tags = $4, updated_at = now()
           where id = $1 and tenant_id = $5 returning ${COLUMNS}`,
          [id, d.caption.trim(), d.kind, clean(d.tags), tenantId],
        );
        return rewrite(db, section);
      }),

    editTags: (tenantId, id, edit) =>
      tx(tenantId, async (db) => {
        const current = await one(
          db,
          tenantId,
          `select ${COLUMNS} from library_sections where id = $1 and tenant_id = $2 for update`,
          [id, tenantId],
        );
        const add = clean(edit.add ?? []);
        const remove = new Set(clean(edit.remove ?? []));
        const personTags = clean([...current.personTags, ...add]).filter((t) => !remove.has(t));
        // a tag a person adds back is no longer removed; one a model wrote and a person took away is
        const removedTags = clean([
          ...current.removedTags.filter((t) => !add.includes(t)),
          ...current.modelTags.filter((t) => remove.has(t)),
        ]);
        const section = await one(
          db,
          tenantId,
          `update library_sections set person_tags = $2, removed_tags = $3, kind = $4,
             updated_at = now()
           where id = $1 and tenant_id = $5 returning ${COLUMNS}`,
          [id, personTags, removedTags, edit.kind ?? current.kind, tenantId],
        );
        return rewrite(db, section);
      }),

    setHidden: (tenantId, id, hidden) =>
      tx(tenantId, (db) =>
        one(
          db,
          tenantId,
          `update library_sections set hidden = $2, updated_at = now()
           where id = $1 and tenant_id = $3 returning ${COLUMNS}`,
          [id, hidden, tenantId],
        ),
      ),

    setSkeleton: (tenantId, id, skeleton) =>
      tx(tenantId, (db) =>
        one(
          db,
          tenantId,
          `update library_sections set skeleton = $2, updated_at = now()
           where id = $1 and tenant_id = $3 returning ${COLUMNS}`,
          [id, JSON.stringify(skeleton), tenantId],
        ),
      ),

    setDataShape: (tenantId, id, shape) =>
      tx(tenantId, async (db) => {
        const section = await one(
          db,
          tenantId,
          `update library_sections set data_shape = $2, updated_at = now()
           where id = $1 and tenant_id = $3 returning ${COLUMNS}`,
          [id, JSON.stringify(shape), tenantId],
        );
        return rewrite(db, section);
      }),

    ofHandoff: (tenantId, handoffId) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from library_sections where tenant_id = $1
             and sources @> jsonb_build_array(jsonb_build_object('handoffId', $2::text))
           order by created_at`,
          [tenantId, handoffId],
        );
        return rows.map((r) => toSection(r, tenantId));
      }),

    markPreviewed: (tenantId, p) =>
      tx(tenantId, async (db) => {
        const { rowCount } = await db.query(
          `update library_sections set
             previewed_at = least(coalesce(previewed_at, $4::timestamptz), $4::timestamptz),
             previews = previews || $3::jsonb,
             updated_at = now()
           where tenant_id = $1
             and sources @> jsonb_build_array(jsonb_build_object('handoffId', $2::text))
             and not previews @> jsonb_build_array(jsonb_build_object('runId', $5::text))`,
          [tenantId, p.handoffId, JSON.stringify([p]), p.at, p.runId],
        );
        return rowCount ?? 0;
      }),

    hasHandoff: (tenantId, handoffId) =>
      tx(tenantId, async (db) => {
        const { rowCount } = await db.query(
          `select 1 from library_sections where tenant_id = $1
             and sources @> jsonb_build_array(jsonb_build_object('handoffId', $2::text)) limit 1`,
          [tenantId, handoffId],
        );
        return (rowCount ?? 0) > 0;
      }),

    sharing: (tenantId) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query("select shares from library_tenants where tenant_id = $1", [
          tenantId,
        ]);
        return rows[0] ? Boolean(rows[0].shares) : true;
      }),

    setSharing: (tenantId, shares) =>
      tx(tenantId, async (db) => {
        await db.query(
          `insert into library_tenants (tenant_id, shares) values ($1, $2)
           on conflict (tenant_id) do update set shares = $2, updated_at = now()`,
          [tenantId, shares],
        );
      }),
  };
  return library;
}
