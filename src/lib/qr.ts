// Thin wrappers over `qrcode` that return raw module matrices — rendering is
// owned by render.ts so the PNG and SVG outputs share one source of truth.

import qrcode from 'qrcode';
import { MAGIC } from './chunk';

export interface BitMatrix {
  size: number;
  /** row-major, truthy = dark module */
  get(row: number, col: number): boolean;
}

function toMatrix(qr: ReturnType<typeof qrcode.create>): BitMatrix {
  const { size, data } = qr.modules;
  return {
    size,
    get: (row, col) => data[row * size + col] === 1,
  };
}

/** Data chunk → byte-mode QR at ECC L, forced version. The only reader of
 * these codes is zxing, which hands back the raw bytes. */
export function chunkMatrix(chunkBytes: Uint8Array, version: number): BitMatrix {
  const qr = qrcode.create([{ data: Uint8ClampedArray.from(chunkBytes), mode: 'byte' }], {
    version,
    errorCorrectionLevel: 'L',
  });
  return toMatrix(qr);
}

/** The chunk bytes in a scanned code, or null for codes that aren't a chunk —
 * the entry URL, or anything else in frame. */
export function chunkBytesFromScan(_text: string, bytes: Uint8Array): Uint8Array | null {
  return bytes[0] === MAGIC ? bytes : null;
}

/** Entry QR: the player URL. ECC M — this is the one code that must always work. */
export function entryMatrix(url: string): BitMatrix {
  const qr = qrcode.create(url, { errorCorrectionLevel: 'M' });
  return toMatrix(qr);
}
