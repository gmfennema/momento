// Mimi codec: bit packing and resampling are pure math; the round trip runs
// the shipped int8 models through onnxruntime-web's wasm backend in node,
// the same way bwe.test.ts exercises the restoration model.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeChunk, encodeChunk, mimiDepth, mimiModeId, WIRE_MIMI } from '../src/lib/chunk';
import {
  MIMI_CODE_BITS,
  MIMI_FRAME_SAMPLES,
  mimiDecodeWith,
  mimiEncodeWith,
  mimiFramesFor,
  mimiPayloadBytes,
  MimiTimeoutError,
  packCodes,
  resetMimiRuntimeForTests,
  unpackCodes,
  upsample16kTo24k,
  withDeadline,
} from '../src/lib/mimi';
import { rmsEnergy, synthPcm } from './helpers/synth-audio';

describe('Mimi bit packing', () => {
  it('round-trips every depth and recovers the frame count from the length alone', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 21) & 0x7ff;
    for (const depth of [1, 8, 10, 13, 20, 32]) {
      for (const frames of [1, 2, 37, 125]) {
        const codes = Array.from({ length: frames }, () => Array.from({ length: depth }, rand));
        const bytes = packCodes(codes, depth);
        expect(bytes.length).toBe(mimiPayloadBytes(frames, depth));
        expect(bytes.length).toBe(Math.ceil((frames * depth * MIMI_CODE_BITS) / 8));
        expect(unpackCodes(bytes, depth)).toEqual(codes);
      }
    }
  });

  it('carries the depth in the chunk header', () => {
    for (const depth of [1, 10, 20, 32]) {
      const bytes = encodeChunk(
        { version: WIRE_MIMI, modeId: mimiModeId(depth), cardId: 0x1234, chunkIndex: 0, totalChunks: 1 },
        new Uint8Array([1]),
      );
      const { header } = decodeChunk(bytes);
      expect(header.version).toBe(WIRE_MIMI);
      expect(mimiDepth(header.modeId)).toBe(depth);
    }
    expect(() =>
      encodeChunk({ version: WIRE_MIMI, modeId: 32, cardId: 1, chunkIndex: 0, totalChunks: 1 }, new Uint8Array()),
    ).toThrow();
  });
});

describe('16 → 24 kHz resampling', () => {
  it('keeps a tone at its frequency and level, with 1.5× the samples', () => {
    const n = 16000;
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) pcm[i] = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
    const out = upsample16kTo24k(pcm);
    expect(out.length).toBe(24000);
    // Correlate the middle against a 1 kHz sinusoid at 24 kHz.
    let re = 0, im = 0, energy = 0;
    for (let i = 2000; i < 22000; i++) {
      re += out[i]! * Math.cos((2 * Math.PI * 1000 * i) / 24000);
      im += out[i]! * Math.sin((2 * Math.PI * 1000 * i) / 24000);
      energy += out[i]! * out[i]!;
    }
    const amp = (2 * Math.hypot(re, im)) / 20000;
    expect(amp).toBeCloseTo(16000 / 32768, 2);
    // Nearly all the energy is that one tone — no imaging at 15 kHz.
    expect((Math.hypot(re, im) ** 2 * 2) / 20000 / energy).toBeGreaterThan(0.99);
  });

  it('counts frames the way the encoder rounds', () => {
    expect(mimiFramesFor(16000 * 10)).toBe(125);
    expect(mimiFramesFor(1)).toBe(1);
    expect(mimiFramesFor(1280)).toBe(1); // exactly one 80 ms frame
    expect(mimiFramesFor(1281)).toBe(2);
  });
});

describe('Mimi round trip with the shipped models', () => {
  it('encodes and decodes a clip at the depth the card chose', async () => {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'basic' } as const;
    const encoder = await ort.InferenceSession.create(
      new Uint8Array(readFileSync('public/mimi/mimi-encoder-int8.onnx')),
      opts,
    );
    const decoder = await ort.InferenceSession.create(
      new Uint8Array(readFileSync('public/mimi/mimi-decoder-int8.onnx')),
      opts,
    );
    const pcm = synthPcm(3, 16000);
    const depth = 12;
    const bytes = await mimiEncodeWith({ ort, encoder }, pcm, depth);
    const frames = mimiFramesFor(pcm.length);
    expect(bytes.length).toBe(mimiPayloadBytes(frames, depth));

    const out = await mimiDecodeWith({ ort, decoder }, bytes, depth);
    expect(out.length).toBe(frames * MIMI_FRAME_SAMPLES);
    // The codec is lossy and resynthesizes, so compare loudness, not samples.
    const inRms = rmsEnergy(pcm);
    expect(rmsEnergy(out)).toBeGreaterThan(inRms * 0.3);
    expect(rmsEnergy(out)).toBeLessThan(inRms * 3);
    // Shallower decode of the same bytes' prefix codes is still audio.
    const shallow = await mimiDecodeWith({ ort, decoder }, packCodes(unpackCodes(bytes, depth).map((f) => f.slice(0, 8)), 8), 8);
    expect(shallow.length).toBe(out.length);
  }, 120_000);

  it('never emits more bytes than the planner budgeted, at awkward slice lengths', async () => {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const encoder = await ort.InferenceSession.create(
      new Uint8Array(readFileSync('public/mimi/mimi-encoder-int8.onnx')),
      { executionProviders: ['wasm'], graphOptimizationLevel: 'basic' },
    );
    // 6.72 s plus the sample slicePcm's outward rounding adds — the trim that
    // once planned a frame short — and lengths either side of a frame edge.
    for (const n of [107_521, 107_520, 1_280, 1_281, 160_000]) {
      const pcm = synthPcm(n / 16000, 16000);
      const bytes = await mimiEncodeWith({ ort, encoder }, pcm, 16);
      expect(bytes.length).toBe(mimiPayloadBytes(mimiFramesFor(pcm.length), 16));
    }
  }, 120_000);
});

describe('Mimi watchdog', () => {
  it('times out a worker that never answers, then fails fast instead of queueing behind it', async () => {
    resetMimiRuntimeForTests(50);
    await expect(withDeadline('decoder', new Promise(() => {}))).rejects.toBeInstanceOf(MimiTimeoutError);
    const t0 = Date.now();
    // Even work that would succeed is refused: the shared worker is presumed dead.
    await expect(withDeadline('decoder', Promise.resolve(1))).rejects.toBeInstanceOf(MimiTimeoutError);
    expect(Date.now() - t0).toBeLessThan(40);
    resetMimiRuntimeForTests(50);
    await expect(withDeadline('decoder', Promise.resolve(1))).resolves.toBe(1);
  });
});
