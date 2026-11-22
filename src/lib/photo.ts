// Photo prep for the photo front design. A photo is only ever held in memory
// for the session: it's decoded, turned into one greyscale tone image and
// placed on the card — nothing is uploaded or stored.

import type { FrontPhoto } from './front';

/** Longest side kept. A ~45 mm frame at 1200 dpi is ~2100 px, so this keeps
 * full engraving detail without dragging a 12 MP phone photo around. */
const MAX_SIDE = 2400;

/**
 * Greyscale + auto-levels, in place on RGBA pixels. Photos of ultrasound
 * printouts come out murky (grey blacks, dull whites); stretching the 1st–99th
 * percentile to full range gives the laser real blacks and whites to work
 * with. `negative` flips the tones: laser software engraves the dark areas,
 * and on a black card engraved areas come out light — so to keep an
 * ultrasound's bright tissue bright on black metal, the artwork is a negative.
 */
export function toneGrey(data: Uint8ClampedArray, negative: boolean): void {
  const n = data.length / 4;
  const grey = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const y = Math.round(0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!);
    grey[i] = y;
    hist[y]!++;
  }
  const lo = percentile(hist, n, 0.01);
  const hi = Math.max(lo + 1, percentile(hist, n, 0.99));
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    const out = Math.round(t * 255);
    lut[v] = negative ? 255 - out : out;
  }
  for (let i = 0; i < n; i++) {
    const v = lut[grey[i]!]!;
    const o = i * 4;
    data[o] = data[o + 1] = data[o + 2] = v;
    data[o + 3] = 255;
  }
}

function percentile(hist: Uint32Array, total: number, q: number): number {
  const target = total * q;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc > target) return v;
  }
  return 255;
}

/** Decoded once per chosen file; tone variants are cheap to remake from it. */
export async function decodePhoto(file: Blob): Promise<ImageBitmap> {
  // Browsers apply EXIF orientation here, so phone photos come out upright.
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

export function tonePhoto(bitmap: ImageBitmap, negative: boolean): FrontPhoto {
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  const img = ctx.getImageData(0, 0, width, height);
  toneGrey(img.data, negative);
  ctx.putImageData(img, 0, 0);
  // PNG keeps the tones exact for the laser; it only lives in the SVG export.
  return { image: canvas, href: canvas.toDataURL('image/png'), width, height };
}
