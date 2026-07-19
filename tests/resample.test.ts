import { describe, expect, it } from 'vitest';
import { decimate2 } from '../src/lib/resample';

function tone16k(seconds: number, hz: number, amp = 10000): Int16Array {
  const sr = 16000;
  const out = new Int16Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / sr));
  return out;
}

function rms(pcm: Int16Array, skip = 0): number {
  let acc = 0;
  for (let i = skip; i < pcm.length; i++) acc += pcm[i]! * pcm[i]!;
  return Math.sqrt(acc / Math.max(1, pcm.length - skip));
}

describe('decimate2 (16 kHz → 8 kHz)', () => {
  it('halves the length', () => {
    expect(decimate2(tone16k(1, 440)).length).toBe(8000);
  });

  it('passes speech-band content at unity gain', () => {
    const inRms = rms(tone16k(1, 440));
    const outRms = rms(decimate2(tone16k(1, 440)), 100);
    expect(outRms / inRms).toBeGreaterThan(0.95);
    expect(outRms / inRms).toBeLessThan(1.05);
  });

  it('suppresses content above the output Nyquist (anti-aliasing)', () => {
    // 6 kHz is above the 4 kHz output Nyquist: without filtering it would
    // alias to 2 kHz at full amplitude.
    const out = decimate2(tone16k(1, 6000));
    expect(rms(out, 100) / rms(tone16k(1, 6000))).toBeLessThan(0.02);
  });
});
