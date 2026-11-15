// Laser over-burn compensation: the geometry is a true erosion/dilation of the
// code, and a compensated card survives the engraver it was drawn for.

import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { mimiModeId, splitPayload } from '../src/lib/chunk';
import { CARD_SIZES, mimiDepthFor, planCard, type CardSizeKey } from '../src/lib/layout';
import { mimiPayloadBytes } from '../src/lib/mimi';
import { chunkBytesFromScan, chunkMatrix, entryMatrix, type BitMatrix } from '../src/lib/qr';
import { DEFAULT_BURN_MM, renderSvg, symbolRects } from '../src/lib/render';

const wasm = readFileSync('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');
prepareZXingModule({
  overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) },
});

function randomMatrix(size: number, seed: number): BitMatrix {
  const bits: boolean[] = [];
  let s = seed;
  for (let i = 0; i < size * size; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    bits.push(s >>> 31 === 1);
  }
  return { size, get: (r, c) => bits[r * size + c]! };
}

describe('symbolRects with over-burn compensation', () => {
  const SIZE = 9;
  const SUB = 10; // samples per module
  const matrix = randomMatrix(SIZE, 42);
  const dark = (r: number, c: number): boolean => r >= 0 && c >= 0 && r < SIZE && c < SIZE && matrix.get(r, c);

  /** Is the sample at (x, y) — in module units — covered by the rects? */
  function covered(rects: Array<[number, number, number, number]>, x: number, y: number): boolean {
    return rects.some(([rx, ry, rw, rh]) => x > rx && x < rx + rw && y > ry && y < ry + rh);
  }

  for (const grow of [0.3, -0.3]) {
    it(`${grow > 0 ? 'grows' : 'shrinks'} the dark area by exactly a square of that size`, () => {
      const rects = symbolRects({ matrix, xMm: 0, yMm: 0, sizeMm: SIZE }, grow);
      const c = Math.abs(grow);
      let checked = 0;
      for (let iy = -SUB; iy < (SIZE + 1) * SUB; iy++) {
        for (let ix = -SUB; ix < (SIZE + 1) * SUB; ix++) {
          const x = (ix + 0.5) / SUB;
          const y = (iy + 0.5) / SUB;
          // Skip samples within a hair of a moved edge, where float ties decide.
          const nearEdge = [x - c, x + c, y - c, y + c].some((v) => Math.abs(v - Math.round(v)) < 0.02);
          if (nearEdge) continue;
          const corners = [
            dark(Math.floor(y - c), Math.floor(x - c)),
            dark(Math.floor(y - c), Math.floor(x + c)),
            dark(Math.floor(y + c), Math.floor(x - c)),
            dark(Math.floor(y + c), Math.floor(x + c)),
          ];
          // c < half a module, so the square around a sample meets at most the
          // four modules its corners land in.
          const expected = grow > 0 ? corners.some(Boolean) : corners.every(Boolean);
          expect(covered(rects, x, y), `sample ${x},${y}`).toBe(expected);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(5000);
    });
  }
});

/** The engraver: everything drawn black comes out `r` px larger per edge. */
function engrave(png: PNG, r: number): void {
  const { width: W, height: H, data } = png;
  const src = new Uint8Array(W * H);
  const tmp = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) src[i] = data[i * 4]!;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 255;
      for (let d = -r; d <= r; d++) m = Math.min(m, src[y * W + Math.min(W - 1, Math.max(0, x + d))]!);
      tmp[y * W + x] = m;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 255;
      for (let d = -r; d <= r; d++) m = Math.min(m, tmp[Math.min(H - 1, Math.max(0, y + d)) * W + x]!);
      data[(y * W + x) * 4] = data[(y * W + x) * 4 + 1] = data[(y * W + x) * 4 + 2] = m;
    }
  }
}

/** A phone frame of the whole card: box-filter down by `f`. */
function shrink(png: PNG, f: number): ImageData {
  const W = Math.floor(png.width / f);
  const H = Math.floor(png.height / f);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += png.data[((y * f + dy) * png.width + x * f + dx) * 4]!;
      const o = (y * W + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = sum / (f * f);
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H } as ImageData;
}

describe('a compensated card through a real engraver', () => {
  const PX_PER_MM = 50;
  const PLAYER_URL = 'https://gmfennema.github.io/momento/#p';

  async function chunksRead(
    size: CardSizeKey,
    inverted: boolean,
    burnMm: number,
    engraverMm: number,
  ): Promise<{ data: number; total: number; entry: boolean }> {
    const { widthMm, heightMm } = CARD_SIZES[size];
    const spec = { inverted, textured: true, widthMm, heightMm };
    const depth = mimiDepthFor(10, spec)!;
    const bits = new Uint8Array(mimiPayloadBytes(125, depth)).map((_, i) => (i * 2654435761) >>> 24);
    const plan = planCard(bits.length, spec);
    const chunks = splitPayload(bits, 2, mimiModeId(depth), plan.payloadPerChunk, 0x1234);
    const svg = renderSvg({
      plan,
      matrices: chunks.map((c) => chunkMatrix(c, plan.qrVersion)),
      entry: entryMatrix(PLAYER_URL),
      inverted,
      burnMm,
      texture: { seed: 7 },
    });
    const png = PNG.sync.read(
      Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(plan.widthMm * PX_PER_MM) } }).render().asPng()),
    );
    engrave(png, Math.round(engraverMm * PX_PER_MM));
    // 12.5 px/mm: the whole card across a 1080p frame.
    const results = await readBarcodes(shrink(png, 4), {
      formats: ['QRCode'],
      tryHarder: true,
      tryInvert: true,
      maxNumberOfSymbols: 24,
    });
    return {
      data: new Set(results.flatMap((r) => chunkBytesFromScan(r.text, r.bytes) ?? []).map((b) => b[4])).size,
      total: plan.chunkCount,
      entry: results.some((r) => r.text === PLAYER_URL),
    };
  }

  for (const size of Object.keys(CARD_SIZES) as CardSizeKey[]) {
    for (const inverted of [true, false]) {
      const name = `${size}, ${inverted ? 'inverted (black card)' : 'plain'}`;
      // From a perfect engraver to one burning twice as wide as assumed.
      for (const engraverMm of [0, 0.08, 0.16]) {
        it(`${name}: default compensation reads after ${engraverMm} mm of over-burn`, async () => {
          const read = await chunksRead(size, inverted, DEFAULT_BURN_MM, engraverMm);
          expect(read).toEqual({ data: read.total, total: read.total, entry: true });
        }, 60_000);
      }
      it(`${name}: uncompensated artwork is lost at 0.12 mm of over-burn`, async () => {
        // The failure this option exists for; if a reader upgrade ever makes
        // this pass, the default deserves a fresh measurement.
        const read = await chunksRead(size, inverted, 0, 0.12);
        expect(read.data).toBeLessThan(read.total);
      }, 60_000);
    }
  }
});
