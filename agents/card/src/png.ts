import { deflateSync, inflateSync } from "node:zlib";

/** The preview page. A transparent screenshot is filled with this before a vision model sees it. */
const PAGE = [0x0a, 0x0a, 0x0a] as const;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Fill transparent pixels with the near-black page. An opaque PNG is returned unchanged. */
export function flattenOnPage(png: Buffer): Buffer {
  let decoded: Decoded | undefined;
  try {
    decoded = decodePng(png);
  } catch {
    return png;
  }
  if (!decoded) return png;
  let transparent = false;
  const { rgba } = decoded;
  for (let i = 3; i < rgba.length; i += 4) {
    const alpha = rgba[i] ?? 255;
    if (alpha === 255) continue;
    transparent = true;
    const cover = alpha / 255;
    const at = i - 3;
    rgba[at] = Math.round((rgba[at] ?? 0) * cover + PAGE[0] * (1 - cover));
    rgba[at + 1] = Math.round((rgba[at + 1] ?? 0) * cover + PAGE[1] * (1 - cover));
    rgba[at + 2] = Math.round((rgba[at + 2] ?? 0) * cover + PAGE[2] * (1 - cover));
    rgba[i] = 255;
  }
  return transparent ? encodePng(decoded.width, decoded.height, rgba) : png;
}

export function rgbaOf(png: Buffer): Decoded | undefined {
  return decodePng(png);
}

/** 8-bit RGB or RGBA, not interlaced. Anything else is left for the caller to pass through. */
function decodePng(png: Buffer): Decoded | undefined {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) return undefined;
  let width = 0;
  let height = 0;
  let color = 0;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) return undefined;
      color = data[9] ?? 0;
      if (color !== 2 && color !== 6) return undefined;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || idat.length === 0) return undefined;
  const channels = color === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const recon = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src] ?? 0;
    src += 1;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (recon[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (recon[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (recon[(y - 1) * stride + x - channels] ?? 0) : 0;
      const byte = raw[src] ?? 0;
      src += 1;
      recon[y * stride + x] = (byte + predictor(filter, left, up, upLeft)) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = recon[i * channels] ?? 0;
    rgba[i * 4 + 1] = recon[i * channels + 1] ?? 0;
    rgba[i * 4 + 2] = recon[i * channels + 2] ?? 0;
    rgba[i * 4 + 3] = channels === 4 ? (recon[i * channels + 3] ?? 255) : 255;
  }
  return { width, height, rgba };
}

function predictor(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) return paeth(left, up, upLeft);
  return 0;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  return du <= dul ? up : upLeft;
}

export function pngFromRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  return encodePng(width, height, rgba);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
