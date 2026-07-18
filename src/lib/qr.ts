// Thin wrappers over `qrcode` that return raw module matrices — rendering is
// owned by render.ts so the PNG and SVG outputs share one source of truth.

import qrcode from 'qrcode';
import { base45Encode } from './base45';

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

/** Data chunk → Base45 → alphanumeric-mode QR at ECC L, forced version. */
export function chunkMatrix(chunkBytes: Uint8Array, version: number): BitMatrix {
  const text = base45Encode(chunkBytes);
  const qr = qrcode.create([{ data: text, mode: 'alphanumeric' }], {
    version,
    errorCorrectionLevel: 'L',
  });
  return toMatrix(qr);
}

/** Entry QR: the player URL. ECC M — this is the one code that must always work. */
export function entryMatrix(url: string): BitMatrix {
  const qr = qrcode.create(url, { errorCorrectionLevel: 'M' });
  return toMatrix(qr);
}
