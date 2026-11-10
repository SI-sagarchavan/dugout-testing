/**
 * What a Handoff puts on S3: which files, of what kind and type, and the hash the backend will
 * sign into each upload URL. Pure: no Figma, no network.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  manifestOf,
  prepareHandoff,
  sniffImageType,
  UnsupportedAssetError,
  type HandoffInput,
} from "../src/api/index.js";
import { toHex, utf8 } from "../src/api/uploads.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBP"), 1]);
const GIF = Uint8Array.from(Buffer.from("GIF89a...."));
const SVG = Uint8Array.from(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'));

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const input = (over: Partial<HandoffInput> = {}): HandoffInput => ({
  jsonName: "Home-1-2.ir.json",
  json: '{"root":{"name":"Café ✓"}}',
  screenshots: [],
  assets: [],
  ...over,
});

describe("utf8", () => {
  it.each(["", "abc", "Café", "✓ ok", "日本語", "😀 emoji", "a\u0000b"])("encodes %j like TextEncoder", (text) => {
    expect([...utf8(text)]).toEqual([...new TextEncoder().encode(text)]);
  });

  it("turns a lone surrogate into U+FFFD, as TextEncoder does", () => {
    expect([...utf8("a\ud800b")]).toEqual([...new TextEncoder().encode("a\ud800b")]);
  });
});

describe("sniffImageType", () => {
  it.each([
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["webp", WEBP, "image/webp"],
    ["svg", SVG, "image/svg+xml"],
    ["svg with leading space", Uint8Array.from(Buffer.from("  \n<svg/>")), "image/svg+xml"],
  ])("knows %s from its bytes", (_label, bytes, type) => {
    expect(sniffImageType(bytes)).toBe(type);
  });

  it.each([
    ["gif", GIF],
    ["empty", new Uint8Array()],
    ["text", Uint8Array.from(Buffer.from("hello"))],
    ["a RIFF that is not WebP", Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")])],
  ])("does not guess at %s", (_label, bytes) => {
    expect(sniffImageType(bytes)).toBeNull();
  });
});

describe("prepareHandoff", () => {
  it("hashes the bytes that will be uploaded, in hex", async () => {
    const { files } = await prepareHandoff(input({ screenshots: [{ name: "hero-1-3.png", nodeId: "1:3", bytes: PNG }] }));
    const ir = files.find((f) => f.kind === "ir")!;
    expect(ir.sha256).toBe(sha(Buffer.from('{"root":{"name":"Café ✓"}}')));
    expect(ir.size).toBe(Buffer.byteLength('{"root":{"name":"Café ✓"}}'));
    expect(ir.contentType).toBe("application/json");
    const shot = files.find((f) => f.name === "hero-1-3.png")!;
    expect(shot.sha256).toBe(sha(PNG));
    expect(shot.size).toBe(PNG.length);
  });

  it("hashes like a real SHA-256, at every block boundary and for a big picture", async () => {
    const { sha256 } = await import("../src/auth/pkce.js");
    expect(toHex(sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 2_000_003]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 0xff);
      expect(toHex(sha256(bytes))).toBe(sha(bytes));
    }
  });

  it("puts the IR first and sends section pictures and the whole-frame picture as screenshots", async () => {
    const { files } = await prepareHandoff(
      input({
        screenshots: [
          { name: "Hero-1-3.png", nodeId: "1:3", bytes: PNG },
          { name: "art-root-Home-1-2.png", nodeId: "1:2", bytes: PNG },
        ],
      }),
    );
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ["Home-1-2.ir.json", "ir"],
      ["Hero-1-3.png", "screenshot"],
      ["art-root-Home-1-2.png", "screenshot"],
    ]);
    expect(files.find((f) => f.name === "Hero-1-3.png")!.nodeId).toBe("1:3");
  });

  it("sends art that the IR cannot describe (vector, mask) as vector", async () => {
    const { files } = await prepareHandoff(
      input({
        screenshots: [
          { name: "art-vector-Crest-1-5.png", nodeId: "1:5", bytes: PNG },
          { name: "art-mask-Swoosh-1-6.png", nodeId: "1:6", bytes: PNG },
        ],
      }),
    );
    expect(files.filter((f) => f.kind === "vector").map((f) => f.name)).toEqual([
      "art-vector-Crest-1-5.png",
      "art-mask-Swoosh-1-6.png",
    ]);
  });

  it("sends content photos too: static or data-driven is decided after the Handoff", async () => {
    const result = await prepareHandoff(
      input({
        screenshots: [
          { name: "art-image-Player-1-7.png", nodeId: "1:7", bytes: PNG },
          { name: "art-vector-Crest-1-5.png", nodeId: "1:5", bytes: PNG },
        ],
      }),
    );
    const photo = result.files.find((f) => f.name === "art-image-Player-1-7.png");
    expect(photo).toMatchObject({ kind: "vector", nodeId: "1:7" });
    expect(result.skipped).toEqual([]);
  });

  it("leaves out an empty picture rather than send a file with no bytes", async () => {
    const result = await prepareHandoff(
      input({ screenshots: [{ name: "Empty-1-3.png", nodeId: "1:3", bytes: new Uint8Array() }] }),
    );
    expect(result.files).toHaveLength(1);
    expect(result.skipped).toEqual(["Empty-1-3.png"]);
  });

  it("describes a marked background: the node it paints, where its bytes came from, its real type", async () => {
    const { files } = await prepareHandoff(
      input({
        assets: [
          { name: "hero", nodeId: "1:20", targetNodeId: "1:9", bytes: JPEG, source: "original" },
          { name: "pitch", nodeId: "1:21", targetNodeId: "1:10", bytes: PNG, source: "rendered" },
        ],
      }),
    );
    const hero = files.find((f) => f.kind === "background" && f.nodeId === "1:20")!;
    expect(hero).toMatchObject({
      name: "assets/hero-1-20.jpg",
      contentType: "image/jpeg",
      targetNodeId: "1:9",
      provenance: "original",
    });
    expect(files.find((f) => f.nodeId === "1:21")).toMatchObject({
      name: "assets/pitch-1-21.png",
      provenance: "rendered",
    });
  });

  it("takes a background's type from its bytes, not from what it was called", async () => {
    const { files } = await prepareHandoff(
      input({ assets: [{ name: "logo.png", nodeId: "1:1", targetNodeId: "1:2", bytes: WEBP, source: "original" }] }),
    );
    expect(files.find((f) => f.kind === "background")).toMatchObject({ contentType: "image/webp" });
  });

  it("refuses a background that is not a type the backend takes, naming it", async () => {
    await expect(
      prepareHandoff(
        input({ assets: [{ name: "spin", nodeId: "1:1", targetNodeId: "1:2", bytes: GIF, source: "original" }] }),
      ),
    ).rejects.toThrow(UnsupportedAssetError);
    await expect(
      prepareHandoff(
        input({ assets: [{ name: "spin", nodeId: "1:1", targetNodeId: "1:2", bytes: GIF, source: "original" }] }),
      ),
    ).rejects.toThrow(/"spin" is not a PNG, JPEG, WebP or SVG/);
  });

  it("keeps file names unique within a send, which the backend requires", async () => {
    const { files } = await prepareHandoff(
      input({
        screenshots: [
          { name: "Hero-1-3.png", nodeId: "1:3", bytes: PNG },
          { name: "Hero-1-3.png", nodeId: "1:3", bytes: JPEG },
        ],
      }),
    );
    const names = files.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("Hero-1-3-2.png");
  });

  it("waits between files, so hashing a big frame does not hang the panel", async () => {
    let ticks = 0;
    await prepareHandoff(input({ screenshots: [{ name: "a.png", nodeId: "1:3", bytes: PNG }] }), async () => {
      ticks++;
    });
    expect(ticks).toBe(2);
  });
});

describe("manifestOf", () => {
  it("is the description of each file, without its bytes", async () => {
    const { files } = await prepareHandoff(input());
    const manifest = manifestOf(files);
    expect(manifest[0]).toEqual({
      name: "Home-1-2.ir.json",
      kind: "ir",
      contentType: "application/json",
      size: files[0]!.size,
      sha256: files[0]!.sha256,
    });
    expect(JSON.stringify(manifest)).not.toContain("bytes");
  });
});
