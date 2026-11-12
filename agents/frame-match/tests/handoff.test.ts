import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRunState } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import type { ControlPlane } from "../src/control-plane.ts";
import type { Built, Bundle, Measurement } from "../src/frame.ts";
import { createHandoffSource, type FrameSource, readTenantTheme } from "../src/handoff.ts";
import { createMatchTools, type Engine, RunInput } from "../src/tools.ts";

const HANDOFF = "6f1d2c1e-7a3b-4c7e-9a10-0000000000aa";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const ir = Buffer.from(JSON.stringify({ root: { id: "1:2", name: "News grid" } }));
const shot = Buffer.from("png bytes of the whole frame");
const crest = Buffer.from("png bytes of a crest");
const background = Buffer.from("jpeg bytes");

const file = (name: string, kind: string, bytes: Buffer, nodeId: string | null = null) => ({
  name,
  kind,
  nodeId,
  targetNodeId: null,
  contentType: kind === "ir" ? "application/json" : "image/png",
  size: bytes.length,
  sha256: sha(bytes),
  url: `https://s3.test/${encodeURIComponent(name)}?get=1`,
});

/** The backend and S3, answering as they do; `served` swaps the bytes S3 hands back. */
function backend(served: Record<string, Buffer> = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const bytes: Record<string, Buffer> = {
    "frame.json": ir,
    "art-root-1-2.png": shot,
    "art-crest-3-4.png": crest,
    "assets/bg-5-6.jpg": background,
    ...served,
  };
  const answer = {
    handoffId: HANDOFF,
    client: "ibl",
    status: "received",
    source: { rootNodeId: "1:2", rootName: "News grid", fileKey: "abc" },
    receivedAt: "2026-11-06T10:00:00.000Z",
    runId: "run-1",
    expiresIn: 900,
    files: [
      file("frame.json", "ir", ir),
      file("art-root-1-2.png", "screenshot", shot, "1:2"),
      file("art-crest-3-4.png", "vector", crest, "3:4"),
      file("assets/bg-5-6.jpg", "background", background, "5:6"),
    ],
  };
  const fetch: typeof globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.startsWith("http://backend/api/v1/surface/service/handoffs/")) {
      return Response.json({ data: answer, meta: {} });
    }
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    const body = bytes[name];
    return body ? new Response(new Uint8Array(body)) : new Response("NoSuchKey", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const source = (fetch: typeof globalThis.fetch, tenant = "ibl") =>
  createHandoffSource(tenant, HANDOFF, { url: "http://backend/api/v1/", key: "worker-key", fetch });

describe("a Handoff as the frame's source", () => {
  it("reads it for the run's tenant with the service key", async () => {
    const { fetch, calls } = backend();
    await source(fetch).getExport(HANDOFF);
    expect(calls[0]?.url).toBe(`http://backend/api/v1/surface/service/handoffs/${HANDOFF}`);
    expect(calls[0]?.headers).toMatchObject({
      "x-surface-service-key": "worker-key",
      client: "ibl",
    });
  });

  it("is an export whose plates are its screenshots and vector art, and whose IR is its JSON", async () => {
    const { fetch } = backend();
    const record = await source(fetch).getExport(HANDOFF);
    expect(record).toMatchObject({
      id: HANDOFF,
      rootNodeId: "1:2",
      rootName: "News grid",
      fileKey: "abc",
      irArtifactId: "frame.json",
      plates: [
        { nodeId: "1:2", name: "art-root-1-2.png", artifactId: "art-root-1-2.png" },
        { nodeId: "3:4", name: "art-crest-3-4.png", artifactId: "art-crest-3-4.png" },
      ],
      assets: [{ name: "assets/bg-5-6.jpg", artifactId: "assets/bg-5-6.jpg" }],
    });
  });

  it("downloads the files from S3 and reads the IR as JSON", async () => {
    const { fetch } = backend();
    const from = source(fetch);
    const record = await from.getExport(HANDOFF);
    expect(await from.json(record.irArtifactId)).toEqual({
      root: { id: "1:2", name: "News grid" },
    });
    expect(await from.bytes("art-root-1-2.png")).toEqual(shot);
  });

  it("refuses bytes that are not what the designer sent", async () => {
    const { fetch } = backend({ "art-root-1-2.png": Buffer.from("something else") });
    await expect(source(fetch).bytes("art-root-1-2.png")).rejects.toThrow(
      "is not the file the designer sent",
    );
  });

  it("says why when the backend will not give it", async () => {
    const fetch = (async () =>
      Response.json(
        { meta: { message: "Surface handoff not found" } },
        { status: 404 },
      )) as typeof globalThis.fetch;
    await expect(source(fetch, "sb").getExport(HANDOFF)).rejects.toThrow(
      `Surface would not give Handoff ${HANDOFF} for sb: Surface handoff not found`,
    );
  });
});

describe("the run's input", () => {
  it("names one frame: an export or a Handoff", () => {
    expect(RunInput.safeParse({ handoffId: HANDOFF }).success).toBe(true);
    expect(RunInput.safeParse({ exportId: HANDOFF }).success).toBe(true);
    expect(RunInput.safeParse({}).success).toBe(false);
    expect(RunInput.safeParse({ exportId: HANDOFF, handoffId: HANDOFF }).success).toBe(false);
  });
});

describe("a run for a Handoff", () => {
  const measured: Measurement = {
    match: 90,
    comparedPixels: 100,
    coverage: 100,
    estimated: false,
    unchecked: [],
    plates: [],
    conformErrors: 0,
    conformWarnings: 0,
    totalDelta: 0,
    worstDelta: 0,
    placeholderIcons: 0,
    findings: [],
    surfaces: [],
  };
  const bundle = {
    exportId: HANDOFF,
    rootName: "News grid",
    ir: { root: { id: "1:2" } },
    notes: [],
    themeArtifactId: "theme-1",
    themeRaw: { tokens: {} },
    doc: { rootNodeId: "1:2", root: { geometry: { bbox: { x: 0, y: 0, w: 100, h: 10 } } } },
    byId: new Map(),
    plates: [],
  } as unknown as Bundle;
  const built = {
    tree: { schemaVersion: "1", nodes: [] },
    surfaces: { assets: {}, surfaces: {} },
    cropped: [],
    addedTexts: [],
    errors: [],
  } as unknown as Built;

  it("loads it through the run's tenant, and stores its IR beside the tree for bind", async () => {
    const sources: Array<{ tenant: string; id: string }> = [];
    const loaded: Array<{ id: string; theme?: string; source?: FrameSource }> = [];
    const uploads: Array<{ kind: string; meta: Record<string, unknown> }> = [];
    const handoff = {} as FrameSource;
    const engine: Engine = {
      bundle: async (_plane, id, theme, from) => {
        loaded.push({ id, ...(theme ? { theme } : {}), ...(from ? { source: from } : {}) });
        return bundle;
      },
      build: async () => built,
      measure: async () => measured,
      firstPass: async (_b, start) => ({ overrides: start, built, measurement: measured }),
    };
    const plane = {
      upload: async (kind: string, _json: unknown, meta: Record<string, unknown>) => {
        uploads.push({ kind, meta });
        return `${kind}-id`;
      },
    } as unknown as ControlPlane;
    const list = createMatchTools({
      dir: await mkdtemp(join(tmpdir(), "fm-handoff-")),
      engine,
      plane: () => plane,
      handoffs: (tenant, id) => {
        sources.push({ tenant, id });
        return handoff;
      },
      tenantTheme: async (tenant) => ({
        raw: { tokens: { [`theme-of-${tenant}`]: { color: { light: {} } } } },
        theme: { themeId: `theme-of-${tenant}`, themeName: "IBL", tokens: {} },
      }),
      web: "http://web",
    }) as unknown as Array<{ name: string; run(i: unknown, c: unknown): Promise<unknown> }>;
    const run = (name: string, args: unknown = {}) => {
      const tool = list.find((t) => t.name === name);
      if (!tool) throw new Error(name);
      return tool.run(args, {
        tenantId: "ibl",
        runId: "h1",
        signal: new AbortController().signal,
        state: memoryRunState(),
        input: { handoffId: HANDOFF, project: "default" },
      });
    };

    await run("frame.load");
    await run("frame.publish", {
      content: { data: "none", why: "nothing on it is data" },
      slots: [],
    });

    // every load reads it afresh (new signed URLs), always for the run's own tenant
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.tenant === "ibl" && s.id === HANDOFF)).toBe(true);
    // built against the tenant's FanXP theme, stored so the preview reads the same tokens
    expect(loaded[0]).toEqual({ id: HANDOFF, theme: "token_set-id", source: handoff });
    expect(uploads[0]).toEqual({
      kind: "token_set",
      meta: {
        source: "dugout:fanxp-theme",
        client: "ibl",
        themeId: "theme-of-ibl",
        themeName: "IBL",
      },
    });
    expect(uploads.slice(1).map((u) => u.kind)).toEqual(["figma_ir", "surface_set", "dsl_tree"]);
    const tree = uploads.find((u) => u.kind === "dsl_tree");
    expect(tree?.meta).toMatchObject({ handoffId: HANDOFF, irArtifactId: "figma_ir-id" });
    expect(tree?.meta).not.toHaveProperty("exportId");
  });

  it("ends as needing setup when the tenant has no active FanXP theme", async () => {
    const list = createMatchTools({
      dir: await mkdtemp(join(tmpdir(), "fm-handoff-")),
      engine: { bundle: async () => bundle } as unknown as Engine,
      plane: () => ({}) as ControlPlane,
      handoffs: () => ({}) as FrameSource,
      tenantTheme: async () => {
        throw new Error("FanXP has no theme for ibl: Theme not found");
      },
    }) as unknown as Array<{ name: string; run(i: unknown, c: unknown): Promise<unknown> }>;
    const load = list.find((t) => t.name === "frame.load");
    await expect(
      load?.run(
        {},
        {
          tenantId: "ibl",
          runId: "h2",
          signal: new AbortController().signal,
          state: memoryRunState(),
          input: { handoffId: HANDOFF, project: "default" },
        },
      ),
    ).rejects.toMatchObject({ name: "NeedsSetup" });
  });
});

describe("readTenantTheme", () => {
  it("asks for the run's tenant with the service key, and wraps the answer as a token set", async () => {
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    const tokens = { color: { light: { core_neu_00: "#ffffff" } } };
    const send = (async (url: string, init?: RequestInit) => {
      asked.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(
        JSON.stringify({ data: { themeId: "t1", themeName: "Southern Brave", tokens } }),
      );
    }) as typeof fetch;
    const got = await readTenantTheme("sb", { url: "http://fanxp/api/v1/", key: "k", fetch: send });
    expect(asked).toEqual([
      {
        url: "http://fanxp/api/v1/surface/service/theme",
        headers: { "x-surface-service-key": "k", client: "sb", accept: "application/json" },
      },
    ]);
    expect(got.raw).toEqual({ tokens: { t1: tokens } });
    expect(got.theme.themeName).toBe("Southern Brave");
  });

  it("says why when FanXP has no theme for the tenant", async () => {
    const send = (async () =>
      new Response(JSON.stringify({ meta: { message: "sb has no active theme." } }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(
      readTenantTheme("sb", { url: "http://fanxp", key: "k", fetch: send }),
    ).rejects.toThrow("FanXP has no theme for sb: sb has no active theme.");
  });
});
