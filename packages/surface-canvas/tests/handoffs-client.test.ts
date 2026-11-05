/**
 * The three steps of a Handoff against a fake backend and a fake S3. Fetch is injected, so
 * nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import {
  createHandoffsClient,
  runHandoff,
  UPLOAD_CONCURRENCY,
  type ApiFetch,
  type ApiFetchResponse,
  type PreparedFile,
  type HandoffSource,
} from "../src/api/index.js";

const BASE = "http://localhost:4000/fanxp/api/v1";
const source: HandoffSource = {
  fileKey: null,
  fileName: "Southern Brave",
  pageName: "Home",
  rootNodeId: "1:2",
  rootName: "Home",
  frames: [{ frameId: "1:2", name: "Home" }],
};

const file = (name: string, size = 3): PreparedFile => ({
  name,
  kind: "screenshot",
  contentType: "image/png",
  size,
  sha256: "a".repeat(64),
  bytes: new Uint8Array(size).fill(7),
});

const reply = (status: number, body: unknown, text?: string): ApiFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Error",
  json: async () => body,
  text: async () => text ?? JSON.stringify(body),
});

/** The backend's envelope. */
const envelope = (data: unknown) => ({ data, meta: { message: "ok", code: "SUCCESS" } });

const uploadFor = (name: string) => ({
  name,
  method: "PUT" as const,
  url: `https://bucket.s3.us-east-1.amazonaws.com/ibl/surface-handoffs/aa/aa/${name}?sig=1`,
  headers: { "Content-Type": "image/png", "x-amz-checksum-sha256": "q1M=", "x-amz-tagging": "kind=surface-handoff" },
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

/** A backend that wants every named file, and an S3 that takes (or refuses) them. */
function world(opts: {
  want?: string[];
  present?: string[];
  start?: ApiFetchResponse;
  put?: (url: string, attempt: number) => ApiFetchResponse | Error;
  complete?: ApiFetchResponse;
}) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  const fetch: ApiFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body });
    if (url === `${BASE}/surface/handoffs`) {
      return (
        opts.start ??
        reply(
          201,
          envelope({
            handoffId: "handoff-1",
            expiresIn: 900,
            uploads: (opts.want ?? []).map(uploadFor),
            present: opts.present ?? [],
          }),
        )
      );
    }
    if (url === `${BASE}/surface/handoffs/handoff-1/complete`) {
      return opts.complete ?? reply(200, envelope({ handoffId: "handoff-1", status: "received", files: 2 }));
    }
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    const result = opts.put ? opts.put(url, attempt) : reply(200, "");
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetch, calls, peak: () => peak, puts: () => calls.filter((c) => c.method === "PUT") };
}

const run = (w: ReturnType<typeof world>, files: PreparedFile[], onProgress?: (d: number, t: number) => void) =>
  runHandoff({
    client: createHandoffsClient({ baseUrl: BASE, fetch: w.fetch }),
    accessToken: "tok",
    tenant: "ibl",
    source,
    files,
    onProgress,
  });

describe("start", () => {
  it("sends the client, the page and the manifest, with the plugin's token", async () => {
    const w = world({ want: ["a.png"] });
    await run(w, [file("a.png")]);
    const call = w.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["Authorization"]).toBe("Bearer tok");
    const body = JSON.parse(String(call.body));
    expect(body.client).toBe("ibl");
    expect(body.source.fileName).toBe("Southern Brave");
    expect(body.files).toEqual([
      { name: "a.png", kind: "screenshot", contentType: "image/png", size: 3, sha256: "a".repeat(64) },
    ]);
  });

  it("never puts file bytes in the JSON", async () => {
    const w = world({ want: ["a.png"] });
    await run(w, [file("a.png")]);
    expect(String(w.calls[0]!.body)).not.toContain("bytes");
  });

  it.each([
    [401, { unauthorized: true, forbidden: false }],
    [403, { unauthorized: false, forbidden: true }],
    [422, { unauthorized: false, forbidden: false }],
  ])("reports a %s from the backend in terms the plugin acts on", async (status, flags) => {
    const w = world({ start: reply(status, { meta: { message: "Surface design rejected" } }) });
    const result = await run(w, [file("a.png")]);
    expect(result).toMatchObject({ ok: false, status, ...flags, message: "Surface design rejected" });
    expect(w.puts()).toHaveLength(0);
  });

  it("says what it was reaching when nothing answers", async () => {
    const result = await runHandoff({
      client: createHandoffsClient({
        baseUrl: BASE,
        fetch: async () => {
          throw new Error("Failed to fetch");
        },
      }),
      accessToken: "tok",
      tenant: "ibl",
      source,
      files: [file("a.png")],
    });
    expect(result).toMatchObject({ ok: false, status: null, unauthorized: false });
    if (!result.ok) expect(result.message).toMatch(/Couldn’t reach http:\/\/localhost:4000.*backend running/);
  });

  it("rejects an answer that is not what it expected rather than guess", async () => {
    const w = world({ start: reply(201, envelope({ nope: true })) });
    const result = await run(w, [file("a.png")]);
    expect(result.ok).toBe(false);
  });
});

describe("upload", () => {
  it("PUTs the file's exact bytes to the signed URL with exactly the headers it was given", async () => {
    const w = world({ want: ["a.png"] });
    await run(w, [file("a.png", 5)]);
    const put = w.puts()[0]!;
    expect(put.url).toBe(uploadFor("a.png").url);
    expect(put.headers).toEqual(uploadFor("a.png").headers);
    expect([...(put.body as Uint8Array)]).toEqual([7, 7, 7, 7, 7]);
  });

  it("sends the backend's token to the backend only, never to S3", async () => {
    const w = world({ want: ["a.png"] });
    await run(w, [file("a.png")]);
    expect(w.puts()[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("uploads only what the backend asked for", async () => {
    const w = world({ want: ["b.png"], present: ["a.png"] });
    const result = await run(w, [file("a.png"), file("b.png")]);
    expect(w.puts().map((c) => c.url)).toEqual([uploadFor("b.png").url]);
    expect(result).toMatchObject({ ok: true, value: { uploaded: 1, present: 1 } });
  });

  it("tries a file once more before giving up on it", async () => {
    const w = world({ want: ["a.png"], put: (_url, attempt) => (attempt === 1 ? new Error("blip") : reply(200, "")) });
    const result = await run(w, [file("a.png")]);
    expect(result.ok).toBe(true);
    expect(w.puts()).toHaveLength(2);
  });

  it("fails the send naming the file and S3's reason, and does not call complete", async () => {
    const xml = "<Error><Code>SignatureDoesNotMatch</Code><Message>The signature does not match</Message></Error>";
    const w = world({ want: ["a.png"], put: () => reply(403, null, xml) });
    const result = await run(w, [file("a.png")]);
    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) {
      expect(result.message).toContain('S3 refused "a.png"');
      expect(result.message).toContain("SignatureDoesNotMatch");
    }
    expect(w.calls.some((c) => c.url.endsWith("/complete"))).toBe(false);
  });

  it("does not take an S3 403 for the user losing access to the client", async () => {
    const w = world({ want: ["a.png"], put: () => reply(403, null, "<Error><Code>AccessDenied</Code></Error>") });
    const result = await run(w, [file("a.png")]);
    expect(result).toMatchObject({ ok: false, forbidden: false, unauthorized: false });
  });

  it("tells the designer to check their connection when S3 cannot be reached", async () => {
    const w = world({ want: ["a.png"], put: () => new Error("Failed to fetch") });
    const result = await run(w, [file("a.png")]);
    expect(result).toMatchObject({ ok: false, status: null });
    if (!result.ok) expect(result.message).toMatch(/Couldn’t upload "a.png".*connection/);
  });

  it("keeps no more than a few files in flight at once", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `f${i}.png`);
    const w = world({ want: names });
    await run(w, names.map((n) => file(n)));
    expect(w.puts()).toHaveLength(12);
    expect(w.peak()).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
    expect(w.peak()).toBeGreaterThan(1);
  });

  it("reports progress as files land", async () => {
    const seen: Array<[number, number]> = [];
    const w = world({ want: ["a.png", "b.png"] });
    await run(w, [file("a.png"), file("b.png")], (d, t) => seen.push([d, t]));
    expect(seen[0]).toEqual([0, 2]);
    expect(seen.at(-1)).toEqual([2, 2]);
  });

  it("fails if the backend asks for a file the plugin does not have", async () => {
    const w = world({ want: ["ghost.png"] });
    const result = await run(w, [file("a.png")]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("ghost.png");
  });
});

describe("complete", () => {
  it("is called after every upload, and its answer is the verdict", async () => {
    const w = world({ want: ["a.png"] });
    const result = await run(w, [file("a.png")]);
    expect(result).toMatchObject({ ok: true, value: { handoffId: "handoff-1" } });
    const order = w.calls.map((c) => c.method + " " + c.url.replace(/\?.*/, "").split("/").slice(-1)[0]);
    expect(order).toEqual(["POST handoffs", "PUT a.png", "POST complete"]);
  });

  it("surfaces the backend's list of what is wrong when the send is incomplete", async () => {
    const w = world({
      want: ["a.png"],
      complete: reply(409, { meta: { message: '"a.png" does not match its SHA-256.' } }),
    });
    const result = await run(w, [file("a.png")]);
    expect(result).toMatchObject({ ok: false, status: 409 });
    if (!result.ok) expect(result.message).toBe('"a.png" does not match its SHA-256.');
  });

  it("completes a send where S3 already held everything, with nothing to upload", async () => {
    const w = world({ want: [], present: ["a.png"] });
    const result = await run(w, [file("a.png")]);
    expect(result).toMatchObject({ ok: true, value: { uploaded: 0, present: 1 } });
    expect(w.puts()).toHaveLength(0);
  });
});
