/**
 * Reads a Send from the control plane: what `/preview/<project>/<ref>` renders.
 *
 * Server only. The API key stays in this process and never reaches the browser.
 *
 * The rules are Studio's static preview's (`apps/surface-studio/server/plugin-api.ts`), so the
 * same link renders the same tree in both: `ref` is a pipeline run or a `dsl_tree` artifact, and
 * `?tree=`, `?theme=`, `?surfaces=`, `?data=` and `?plan=` name artifacts that override what the
 * run or the project supplies.
 */

import type { BindingPlan } from "@fanos/dsl";

const API_URL = (process.env.FANOS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");
const API_KEY = process.env.FANOS_API_KEY?.trim() || null;

/** A preview that cannot be drawn, with the HTTP status and the reason a person reads. */
export class PreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Send {
  tree: unknown;
  theme: unknown;
  surfaces?: unknown;
  data?: Record<string, unknown>;
  plan?: BindingPlan;
}

type Query = Record<string, string | string[] | undefined>;

function param(query: Query, name: string): string | undefined {
  const value = query[name];
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

export async function readSend(project: string, ref: string, query: Query): Promise<Send> {
  const base = `${API_URL}/v1/projects/${encodeURIComponent(project)}`;
  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: API_KEY ? { authorization: `Bearer ${API_KEY}` } : {},
      cache: "no-store",
    });

  const json = async (id: string) => {
    const response = await get(`/artifacts/${encodeURIComponent(id)}/content`);
    if (!response.ok) throw new PreviewError(502, `artifact ${id} could not be read (${response.status})`);
    return response.json() as Promise<unknown>;
  };
  /** The project's newest artifact of a kind. Only for a bare tree: a run records its own. */
  const latest = async (kind: string) => {
    const response = await get(`/artifacts?kind=${encodeURIComponent(kind)}&limit=1`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { artifacts?: { id: string }[]; items?: { id: string }[] };
    return (body.artifacts ?? body.items ?? [])[0]?.id;
  };

  let defaults: { tree?: string; theme?: string; surfaces?: string } = {};
  const run = await get(`/runs/${encodeURIComponent(ref)}`).catch((err: unknown) => {
    throw new PreviewError(502, `the control plane at ${API_URL} could not be reached: ${String(err)}`);
  });
  if (run.ok) {
    const body = (await run.json()) as {
      status?: string;
      input?: { themeArtifact?: string };
      steps?: Array<{ name?: string; outputArtifactId?: string | null; detail?: { surfaceSetArtifact?: string } }>;
    };
    const compile = body.steps?.find((s) => s.name === "compile");
    defaults = {
      tree: compile?.outputArtifactId ?? undefined,
      theme: body.input?.themeArtifact,
      surfaces: compile?.detail?.surfaceSetArtifact,
    };
    if (!param(query, "tree") && !defaults.tree) {
      throw new PreviewError(
        409,
        body.status === "succeeded"
          ? "this run produced no compiled tree — pass ?tree=<dsl_tree artifact id> to preview another"
          : `run is ${body.status ?? "unknown"} — nothing to preview yet`,
      );
    }
  } else {
    const artifact = await get(`/artifacts/${encodeURIComponent(ref)}`);
    if (!artifact.ok) {
      throw new PreviewError(artifact.status === 404 ? 404 : artifact.status, `${ref} is neither a run nor a readable artifact`);
    }
    defaults = { tree: ref, theme: await latest("token_set"), surfaces: await latest("surface_set") };
  }

  const tree = param(query, "tree") ?? defaults.tree;
  const theme = param(query, "theme") ?? defaults.theme;
  const surfaces = param(query, "surfaces") ?? defaults.surfaces;
  const data = param(query, "data");
  // A plan is looked up only when there is data for it to fill.
  const planRef = param(query, "plan") ?? (data ? await latest("binding_plan") : undefined);
  if (!tree) throw new PreviewError(409, "nothing to render — pass ?tree=<dsl_tree artifact id>");
  if (!theme) throw new PreviewError(409, "no theme to render against — pass ?theme=<token_set artifact id>");

  const [treeJson, themeJson, surfacesJson, dataJson, planJson] = await Promise.all([
    json(tree),
    json(theme),
    surfaces ? json(surfaces) : undefined,
    data ? readData(data, json) : undefined,
    planRef ? json(planRef) : undefined,
  ]);
  return {
    tree: treeJson,
    theme: themeJson,
    ...(surfacesJson !== undefined ? { surfaces: surfacesJson } : {}),
    ...(dataJson !== undefined ? { data: dataJson as Record<string, unknown> } : {}),
    ...(planJson !== undefined ? { plan: planJson as BindingPlan } : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?data=` is a `sample_data` artifact id, or the name of a dataset file the API serves. */
async function readData(ref: string, json: (id: string) => Promise<unknown>): Promise<unknown> {
  if (UUID.test(ref)) return json(ref);
  const response = await fetch(`${API_URL}/v1/data/${encodeURIComponent(ref)}`, {
    headers: API_KEY ? { authorization: `Bearer ${API_KEY}` } : {},
    cache: "no-store",
  });
  if (!response.ok) {
    throw new PreviewError(422, `no dataset "${ref}" (${response.status}) — expected an artifact id, or a file in apps/api/data/`);
  }
  return response.json();
}
