// Thin wrappers over `qrcode` that return raw module matrices — rendering is
// owned by render.ts so the PNG and SVG outputs share one source of truth.

import qrcode from 'qrcode';
import { base45Decode, base45Encode } from './base45';
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

/** Data chunk → byte-mode QR at ECC L, forced version. Byte mode holds 3%
 * more than Base45 in alphanumeric mode (271 vs 263 bytes at version 10), and
 * the only reader of these codes is zxing, which hands back the raw bytes. */
export function chunkMatrix(chunkBytes: Uint8Array, version: number): BitMatrix {
  const qr = qrcode.create([{ data: Uint8ClampedArray.from(chunkBytes), mode: 'byte' }], {
    version,
    errorCorrectionLevel: 'L',
  });
  return toMatrix(qr);
}

/** Cards engraved before byte mode: Base45 in alphanumeric mode. Kept so
 * tests can still render one and prove the player reads it. */
export function legacyChunkMatrix(chunkBytes: Uint8Array, version: number): BitMatrix {
  const qr = qrcode.create([{ data: base45Encode(chunkBytes), mode: 'alphanumeric' }], {
    version,
    errorCorrectionLevel: 'L',
  });
  return toMatrix(qr);
}

/** The chunk bytes in a scanned code, whichever way the card was written:
 * Base45 text (older cards) or raw byte mode. Returns null for codes that are
 * neither — the entry URL, or anything else in frame. */
export function chunkBytesFromScan(text: string, bytes: Uint8Array): Uint8Array | null {
  try {
    const decoded = base45Decode(text);
    if (decoded[0] === MAGIC) return decoded;
  } catch {
    // not Base45 — fall through to raw bytes
  }
  return bytes[0] === MAGIC ? bytes : null;
}

/** Entry QR: the player URL. ECC M — this is the one code that must always work. */
export function entryMatrix(url: string): BitMatrix {
  const qr = qrcode.create(url, { errorCorrectionLevel: 'M' });
  return toMatrix(qr);
}
