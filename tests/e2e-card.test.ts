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
import { pickAutoTier, planCard, TIERS } from '../src/lib/layout';
import { chunkMatrix, entryMatrix } from '../src/lib/qr';
import { renderSvg, type RenderInput } from '../src/lib/render';
import { rmsEnergy, synthPcm } from './helpers/synth-audio';

const PLAYER_URL = 'https://gmfennema.github.io/momento/#p';

/** Separable 3×3 binomial blur — stands in for camera defocus and engraver
 * over-burn, the two things that bleed dark into a code's quiet zone. */
function blur(png: PNG): void {
  const { width: w, height: h, data } = png;
  const pass = (dx: number, dy: number): void => {
    const src = Uint8Array.from(data);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ax = Math.max(0, Math.min(w - 1, x - dx));
        const bx = Math.max(0, Math.min(w - 1, x + dx));
        const ay = Math.max(0, Math.min(h - 1, y - dy));
        const by = Math.max(0, Math.min(h - 1, y + dy));
        for (let c = 0; c < 3; c++) {
          data[(y * w + x) * 4 + c] =
            (src[(ay * w + ax) * 4 + c]! + 2 * src[(y * w + x) * 4 + c]! + src[(by * w + bx) * 4 + c]!) >> 2;
        }
      }
    }
  };
  pass(1, 0);
  pass(0, 1);
}

/** A phone photo of an engraved card rather than a clean render: soft focus,
 * the low contrast of engraved metal or dark stock, and sensor noise. This is
 * what separates a scannable module size from an unscannable one — a crisp
 * rasterization decodes almost any density and proves nothing about density. */
function degrade(png: PNG, seed = 1): void {
  blur(png);
  blur(png);
  const d = png.data;
  let s = seed | 1;
  for (let i = 0; i < d.length; i += 4) {
    s = (s * 1103515245 + 12345) >>> 0;
    const noise = (s / 0xffffffff - 0.5) * 46;
    for (let c = 0; c < 3; c++) {
      // squeeze full black/white into 55..205, then add noise
      d[i + c] = Math.max(0, Math.min(255, 55 + (d[i + c]! / 255) * 150 + noise));
    }
  }
}

async function scanCardSvg(
  svg: string,
  opts: { widthPx?: number; blurred?: boolean; degraded?: boolean } = {},
): Promise<string[]> {
  // ~600 dpi ≈ 23.6 px/mm — a realistic engraving/scanning resolution.
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: opts.widthPx ?? 2100 } });
  const rendered = resvg.render();
  const png = PNG.sync.read(Buffer.from(rendered.asPng()));
  if (opts.degraded) degrade(png);
  else if (opts.blurred) blur(png);
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

/** Payload of the exact size the tier encodes a 10s clip to. The Lyra wasm
 * needs a browser (threads), so its physical contract is proven here with
 * stand-in bytes; the real codec is exercised in the Playwright suite. */
async function payloadFor(tier: (typeof TIERS)[number], pcm: Int16Array): Promise<Uint8Array> {
  if (tier.codec === 'codec2') return codec2Encode(tier.mode, pcm);
  const bits = new Uint8Array(10 * tier.bytesPerSec);
  let seed = 0x12345678;
  for (let i = 0; i < bits.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    bits[i] = seed >>> 24;
  }
  return bits;
}

describe('end-to-end card pipeline', () => {
  const variants: Array<{ inverted: boolean; textured: boolean }> = [
    { inverted: false, textured: false },
    { inverted: false, textured: true },
    { inverted: true, textured: false },
    { inverted: true, textured: true },
  ];
  for (const tier of TIERS) {
    for (const { inverted, textured } of tier.key === 'balanced' ? variants : variants.slice(0, 2)) {
      const label = [inverted ? 'inverted' : null, textured ? 'textured' : null]
        .filter(Boolean)
        .join(', ');
      it(`${tier.key}${label ? ` (${label})` : ''}: audio → card image → scanned → audio`, async () => {
        const pcm = synthPcm(10);
        const bits = await payloadFor(tier, pcm);

        const plan = planCard(bits.length, { inverted, textured });
        const chunks = splitPayload(bits, tier.wireVersion, tier.modeId, plan.payloadPerChunk, 0xc0de);
        expect(chunks.length).toBe(plan.chunkCount);

        const input: RenderInput = {
          plan,
          matrices: chunks.map((c) => chunkMatrix(c, plan.qrVersion)),
          entry: entryMatrix(PLAYER_URL),
          inverted,
          texture: textured ? { seed: 0xc0de } : undefined,
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

        const { version, modeId, data } = collector.assemble();
        expect(version).toBe(tier.wireVersion);
        expect(modeId).toBe(tier.modeId);
        expect(data).toEqual(new Uint8Array(bits));

        if (tier.codec === 'codec2') {
          const out = await codec2Decode(tier.mode, data);
          expect(Math.abs(out.length - pcm.length)).toBeLessThanOrEqual(800);
          expect(rmsEnergy(out)).toBeGreaterThan(100);
        }
      }, 120_000);
    }
  }

  // What the auto tier's module floor is FOR. A full-length clip is the worst
  // case, and this is the shot that used to lose it: ~900 px across the card
  // (a phone that isn't held close, ≈3 camera pixels per module), soft, noisy
  // and low-contrast. At the old floor these cards came out at QR v11/0.30mm
  // and gave up nothing at this resolution; they need ~1000 px.
  for (const textured of [false, true]) {
    it(`auto tier at 10s${textured ? ' (textured)' : ''}: reads from a degraded 900px shot`, async () => {
      const spec = { inverted: false, textured };
      // Lyra needs a browser; at 10s auto is a Codec 2 rung regardless.
      const tier = pickAutoTier(10, spec, false);
      expect(tier.codec).toBe('codec2');
      const pcm = synthPcm(10);
      const bits = await payloadFor(tier, pcm);
      const plan = planCard(bits.length, spec);
      const chunks = splitPayload(bits, tier.wireVersion, tier.modeId, plan.payloadPerChunk, 0xc0de);
      const texts = await scanCardSvg(
        renderSvg({
          plan,
          matrices: chunks.map((c) => chunkMatrix(c, plan.qrVersion)),
          entry: entryMatrix(PLAYER_URL),
          inverted: false,
          texture: textured ? { seed: 0xc0de } : undefined,
        }),
        { widthPx: 900, degraded: true },
      );
      expect(texts).toContain(PLAYER_URL);
      const collector = new ChunkCollector();
      for (const text of texts) {
        if (text === PLAYER_URL) continue;
        try {
          collector.add(base45Decode(text));
        } catch {
          continue;
        }
      }
      expect(collector.progress.missing).toEqual([]);
    }, 120_000);
  }

  // The texture's whole risk is that dark cells near a code bleed into its
  // quiet zone once the image is soft. Prove a textured card still gives up
  // every chunk at a lower resolution WITH blur — and that a plain card of the
  // same clip is no better off, i.e. the field costs nothing.
  for (const textured of [false, true]) {
    it(`compact${textured ? ' (textured)' : ''}: survives a soft, low-res scan`, async () => {
      const pcm = synthPcm(10);
      const tier = TIERS.find((t) => t.key === 'compact')!;
      const bits = await payloadFor(tier, pcm);
      const plan = planCard(bits.length, { inverted: false, textured });
      const chunks = splitPayload(bits, tier.wireVersion, tier.modeId, plan.payloadPerChunk, 0xc0de);
      const input: RenderInput = {
        plan,
        matrices: chunks.map((c) => chunkMatrix(c, plan.qrVersion)),
        entry: entryMatrix(PLAYER_URL),
        inverted: false,
        texture: textured ? { seed: 0xc0de } : undefined,
      };
      // ~340 dpi across the card, then blurred: a phone photo held too close.
      const texts = await scanCardSvg(renderSvg(input), { widthPx: 1200, blurred: true });
      expect(texts).toContain(PLAYER_URL);
      const collector = new ChunkCollector();
      for (const text of texts) {
        if (text === PLAYER_URL) continue;
        try {
          collector.add(base45Decode(text));
        } catch {
          continue;
        }
      }
      expect(collector.progress.missing).toEqual([]);
    }, 120_000);
  }
});
