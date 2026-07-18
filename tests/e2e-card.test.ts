// Keystone test: proves the entire physical contract without a browser.
// synth audio → codec2 encode → chunk → QR → SVG card → rasterize → zxing
// scans the card image → collect → assemble → codec2 decode → audio again.

import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const zxingWasm = readFileSync('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');
prepareZXingModule({
  overrides: { wasmBinary: zxingWasm.buffer.slice(zxingWasm.byteOffset, zxingWasm.byteOffset + zxingWasm.byteLength) },
});
import { describe, expect, it } from 'vitest';
import { base45Decode } from '../src/lib/base45';
import { ChunkCollector, splitPayload } from '../src/lib/chunk';
import { codec2Decode, codec2Encode } from '../src/lib/codec2';
import { planCard, TIERS } from '../src/lib/layout';
import { chunkMatrix, entryMatrix } from '../src/lib/qr';
import { renderSvg, type RenderInput } from '../src/lib/render';
import { rmsEnergy, synthPcm } from './helpers/synth-audio';

const PLAYER_URL = 'https://gmfennema.github.io/momento/#p';

async function scanCardSvg(svg: string): Promise<string[]> {
  // ~600 dpi ≈ 23.6 px/mm — a realistic engraving/scanning resolution.
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 2100 } });
  const rendered = resvg.render();
  const png = PNG.sync.read(Buffer.from(rendered.asPng()));
  const imageData = {
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    width: png.width,
    height: png.height,
  };
  const results = await readBarcodes(imageData as ImageData, {
    formats: ['QRCode'],
    tryHarder: true,
    tryInvert: true,
    maxNumberOfSymbols: 64,
  });
  return results.map((r) => r.text);
}

describe('end-to-end card pipeline', () => {
  for (const tier of TIERS) {
    for (const inverted of tier.key === 'balanced' ? [false, true] : [false]) {
      it(`${tier.key}${inverted ? ' (inverted)' : ''}: audio → card image → scanned → audio`, async () => {
        const pcm = synthPcm(10);
        const bits = await codec2Encode(tier.mode, pcm);

        const plan = planCard(bits.length, { inverted, textLine: 'Momento Test' });
        const chunks = splitPayload(bits, tier.modeId, plan.payloadPerChunk, 0xc0de);
        expect(chunks.length).toBe(plan.chunkCount);

        const input: RenderInput = {
          plan,
          matrices: chunks.map((c) => chunkMatrix(c, plan.qrVersion)),
          entry: entryMatrix(PLAYER_URL),
          inverted,
        };
        const texts = await scanCardSvg(renderSvg(input));

        // Entry URL must be among the scanned codes.
        expect(texts).toContain(PLAYER_URL);

        const collector = new ChunkCollector();
        for (const text of texts) {
          if (text === PLAYER_URL) continue;
          let bytes: Uint8Array;
          try {
            bytes = base45Decode(text);
          } catch {
            continue;
          }
          collector.add(bytes);
        }
        expect(collector.progress.missing).toEqual([]);
        expect(collector.complete).toBe(true);

        const { modeId, data } = collector.assemble();
        expect(modeId).toBe(tier.modeId);
        expect(data).toEqual(new Uint8Array(bits));

        const out = await codec2Decode(tier.mode, data);
        expect(Math.abs(out.length - pcm.length)).toBeLessThanOrEqual(800);
        expect(rmsEnergy(out)).toBeGreaterThan(100);
      }, 120_000);
    }
  }
});
