/**
 * What a Handoff puts on S3, and the manifest that describes it.
 *
 * The backend is told every file up front (name, kind, type, size, SHA-256) and signs one
 * upload URL for each. It signs those exact values into the URL, so what is described here
 * has to be what is uploaded, byte for byte: the hash is taken from the same bytes that are
 * PUT.
 *
 * Four kinds ship (see `.scratch/surface-studio-fanxp/handoff-flow.md`):
 *   ir          the frame, as JSON
 *   screenshot  the section pictures and the whole-frame picture, for the pixel diff
 *   vector      art the IR cannot describe: a crest, an icon, a swoosh, a mask
 *   background  an image the designer marked, as their own bytes
 * Every picture ships, content photos too (`art-image-`): the plugin cannot know whether a layer
 * is static or filled from data. The compiler draws the shipped picture as the image's own, and
 * `bind` replaces it only where it binds a field.
 *
 * PURE. No Figma, no DOM, no platform crypto (see `auth/pkce.ts`).
 */
import { ART_PLATE_PREFIX } from "../art-plates.js";
import { sha256Async } from "../auth/pkce.js";

export type HandoffFileKind = "ir" | "screenshot" | "vector" | "background";

/** One file of a send: its manifest entry, and the bytes the hash was taken from. */
export interface PreparedFile {
  name: string;
  nodeId?: string;
  /** A background: the node it paints. */
  targetNodeId?: string;
  /** A background: the designer's own bytes, or the node re-exported. */
  provenance?: "original" | "rendered";
  kind: HandoffFileKind;
  contentType: string;
  size: number;
  sha256: string;
  bytes: Uint8Array;
}

export type ManifestFile = Omit<PreparedFile, "bytes">;

/** A background whose bytes are a type the backend does not take. The designer can act on this. */
export class UnsupportedAssetError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is not a PNG, JPEG, WebP or SVG image. Re-export it as one of those, then send again.`,
    );
    this.name = "UnsupportedAssetError";
  }
}

export interface HandoffInput {
  jsonName: string;
  json: string;
  screenshots: ReadonlyArray<{ name: string; nodeId: string; bytes: Uint8Array }>;
  assets: ReadonlyArray<{
    name: string;
    nodeId: string;
    targetNodeId: string;
    bytes: Uint8Array;
    source: "original" | "rendered";
  }>;
}

export interface PreparedHandoff {
  files: PreparedFile[];
  /** Names left out on purpose, so the designer is told what did not go. */
  skipped: string[];
}

/**
 * Hash and describe every file of an export.
 *
 * `tick` is awaited between files: hashing a few MB in the sandbox takes a while, and it
 * must not hold the thread so long that the panel looks hung.
 */
export async function prepareHandoff(
  input: HandoffInput,
  tick: () => Promise<void> = async () => {},
): Promise<PreparedHandoff> {
  const files: PreparedFile[] = [];
  const skipped: string[] = [];
  const used = new Set<string>();
  const unique = (name: string): string => {
    let candidate = name;
    for (let n = 2; used.has(candidate); n++) candidate = name.replace(/(\.[^./]+)?$/, `-${n}$1`);
    used.add(candidate);
    return candidate;
  };

  const add = async (file: Omit<PreparedFile, "size" | "sha256" | "name"> & { name: string }) => {
    await tick();
    files.push({
      ...file,
      name: unique(file.name),
      size: file.bytes.length,
      sha256: toHex(await sha256Async(file.bytes, tick)),
    });
  };

  await add({
    name: input.jsonName,
    kind: "ir",
    contentType: "application/json",
    bytes: utf8(input.json),
  });

  for (const shot of input.screenshots) {
    if (shot.bytes.length === 0) {
      skipped.push(shot.name);
      continue;
    }
    await add({
      name: shot.name,
      nodeId: shot.nodeId,
      kind: kindOfPicture(shot.name),
      contentType: "image/png",
      bytes: shot.bytes,
    });
  }

  for (const asset of input.assets) {
    if (asset.bytes.length === 0) {
      skipped.push(asset.name);
      continue;
    }
    const type = sniffImageType(asset.bytes);
    if (!type) throw new UnsupportedAssetError(asset.name);
    await add({
      name: `assets/${asset.name}-${asset.nodeId.replace(/:/g, "-")}.${EXTENSION[type]}`,
      nodeId: asset.nodeId,
      targetNodeId: asset.targetNodeId,
      provenance: asset.source,
      kind: "background",
      contentType: type,
      bytes: asset.bytes,
    });
  }

  return { files, skipped };
}

/** The whole-frame picture is a screenshot; the pictures of single layers are art. */
function kindOfPicture(name: string): HandoffFileKind {
  if (!name.startsWith(ART_PLATE_PREFIX)) return "screenshot";
  return name.startsWith(`${ART_PLATE_PREFIX}root-`) ? "screenshot" : "vector";
}

export function manifestOf(files: readonly PreparedFile[]): ManifestFile[] {
  return files.map(({ bytes: _bytes, ...entry }) => entry);
}

const EXTENSION = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
} as const;

type ImageType = keyof typeof EXTENSION;

/** The image type of some bytes, from what they start with. Not from a name: a name can lie. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  // SVG is text: an `<svg` (or an `<?xml` that leads to one) near the top.
  const head = ascii(bytes, 0, 512).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < Math.min(to, bytes.length); i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += (byte < 16 ? "0" : "") + byte.toString(16);
  return out;
}

/** UTF-8 by hand: the sandbox does not promise `TextEncoder`. Lone surrogates become U+FFFD. */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }
  return Uint8Array.from(out);
}
