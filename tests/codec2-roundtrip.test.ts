import { describe, expect, it } from 'vitest';
import { codec2Decode, codec2Encode } from '../src/lib/codec2';
import type { Codec2Mode } from '../src/lib/chunk';
import { rmsEnergy, synthPcm } from './helpers/synth-audio';

describe('codec2 wasm round-trip (node)', () => {
  const cases: Array<{ mode: Codec2Mode; expectedBytes: number }> = [
    { mode: '3200', expectedBytes: 4000 },
    { mode: '1600', expectedBytes: 2000 },
    { mode: '700C', expectedBytes: 1000 },
  ];

  for (const { mode, expectedBytes } of cases) {
    it(`mode ${mode}: 10s → ~${expectedBytes}B → 10s`, async () => {
      const pcm = synthPcm(10);
      const bits = await codec2Encode(mode, pcm);
      expect(Math.abs(bits.length - expectedBytes)).toBeLessThanOrEqual(16);
      const out = await codec2Decode(mode, bits);
      expect(Math.abs(out.length - pcm.length)).toBeLessThanOrEqual(8000 * 0.1);
      expect(rmsEnergy(out)).toBeGreaterThan(100); // decoded audio is not silence
    });
  }

  it('repeated sequential calls work (fresh module per call)', async () => {
    for (let i = 0; i < 3; i++) {
      const bits = await codec2Encode('1600', synthPcm(1));
      expect(bits.length).toBeGreaterThan(150);
    }
  });
});
