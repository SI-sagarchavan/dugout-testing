import type { Rect } from "./ir.ts";
import type { CropPlan } from "./sections.ts";

/** RGBA pixels, four bytes each, row by row (pngjs's shape). */
export interface Image {
  width: number;
  height: number;
  data: Buffer;
}

export interface Png {
  read(bytes: Buffer): Image;
  write(image: Image): Buffer;
  create(width: number, height: number): Image;
}

/** A rectangle of an image, clamped to it. */
export function cut(png: Png, image: Image, rect: Rect): Image {
  const x0 = Math.max(0, Math.min(image.width, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(image.height, Math.round(rect.y)));
  const w = Math.max(1, Math.min(image.width - x0, Math.round(rect.w)));
  const h = Math.max(1, Math.min(image.height - y0, Math.round(rect.h)));
  const out = png.create(w, h);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * image.width + x0) * 4;
    image.data.copy(out.data, y * w * 4, from, from + w * 4);
  }
  return out;
}

/**
 * The image shrunk so its longer side is at most `maxSide`, by averaging the pixels each new one
 * covers; returned as it is when it already fits.
 */
export function fit(png: Png, image: Image, maxSide: number): Image {
  const scale = maxSide / Math.max(image.width, image.height);
  if (scale >= 1) return image;
  return resize(
    png,
    image,
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
}

/** The image at `w`×`h`: shrunk by averaging the pixels each new one covers, grown by repeating. */
export function resize(png: Png, image: Image, w: number, h: number): Image {
  if (w === image.width && h === image.height) return image;
  const out = png.create(w, h);
  const sx = image.width / w;
  const sy = image.height / h;
  for (let y = 0; y < h; y++) {
    const ya = Math.floor(y * sy);
    const yb = Math.max(ya + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const xa = Math.floor(x * sx);
      const xb = Math.max(xa + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = ya; yy < yb; yy++) {
        for (let xx = xa; xx < xb; xx++) {
          const i = (yy * image.width + xx) * 4;
          r += image.data[i] ?? 0;
          g += image.data[i + 1] ?? 0;
          b += image.data[i + 2] ?? 0;
          a += image.data[i + 3] ?? 0;
        }
      }
      const n = (yb - ya) * (xb - xa);
      const o = (y * w + x) * 4;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** `src` painted over `dst` at `x`, `y`, blended by its alpha. Clipped to `dst`. */
export function paste(dst: Image, src: Image, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (sy * src.width + sx) * 4;
      const di = (dy * dst.width + dx) * 4;
      const a = (src.data[si + 3] ?? 0) / 255;
      if (a === 0) continue;
      const da = (dst.data[di + 3] ?? 0) / 255;
      const outA = a + da * (1 - a);
      for (let c = 0; c < 3; c++) {
        const sc = src.data[si + c] ?? 0;
        const dc = dst.data[di + c] ?? 0;
        dst.data[di + c] = Math.round((sc * a + dc * da * (1 - a)) / outA);
      }
      dst.data[di + 3] = Math.round(outA * 255);
    }
  }
}

/** A section's picture, made from its plan with each plate's decoded pixels. */
export function render(png: Png, plan: CropPlan, plateImage: (ref: string) => Image): Image {
  const [only] = plan.parts;
  if (plan.parts.length === 1 && only && only.to.w === plan.width && only.to.h === plan.height) {
    return resize(png, cut(png, plateImage(only.plate.ref), only.from), plan.width, plan.height);
  }
  const out = png.create(plan.width, plan.height);
  out.data.fill(0);
  for (const part of plan.parts) {
    const piece = resize(
      png,
      cut(png, plateImage(part.plate.ref), part.from),
      part.to.w,
      part.to.h,
    );
    paste(out, piece, part.to.x, part.to.y);
  }
  return out;
}
