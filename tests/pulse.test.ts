import { describe, expect, it } from 'vitest';
import { pulseDecode, pulseEncode, pulseFrames, pulsePayloadBytes, PULSE_SAMPLE_RATE } from '../src/lib/pulse';
import { estimatePayloadBytes, TIERS } from '../src/lib/layout';

/** A synthetic doppler heartbeat: band-limited noise bursts at 150 bpm with
 * silent gaps — the shape of the real recordings this codec is for. */
function heartbeat(seconds: number): Int16Array {
  const n = Math.round(seconds * PULSE_SAMPLE_RATE);
  const out = new Int16Array(n);
  let s = 1;
  let lp = 0;
  let hp = 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const white = s / 2 ** 31 - 1;
    lp += 0.25 * (white - lp); // ≈ below 1 kHz
    hp = lp - (hp * 0.97 + lp * 0.03); // crude rumble cut
    const phase = (i / PULSE_SAMPLE_RATE) % 0.4;
    const env = phase < 0.25 ? 1 : 0;
    out[i] = Math.round(20000 * lp * env);
  }
  return out;
}

function rms(x: Int16Array, a: number, b: number): number {
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / (b - a));
}

describe('pulse codec', () => {
  it('payload size is exactly what the planner expects', () => {
    for (const seconds of [0.5, 3, 9.26, 10]) {
      const pcm = heartbeat(seconds);
      const bytes = pulseEncode(pcm);
      expect(bytes.length).toBe(pulsePayloadBytes(pulseFrames(pcm.length)));
      const tier = TIERS.find((t) => t.codec === 'pulse')!;
      expect(estimatePayloadBytes(seconds, tier)).toBeGreaterThanOrEqual(bytes.length);
      expect(estimatePayloadBytes(seconds, tier) - bytes.length).toBeLessThanOrEqual(3);
    }
    expect(pulsePayloadBytes(1000)).toBeLessThanOrEqual(1765); // ≈175 B/s
  });

  it('round trip keeps the length, the beats and the silent gaps', () => {
    const pcm = heartbeat(4);
    const out = pulseDecode(pulseEncode(pcm));
    expect(out.length - pcm.length).toBeGreaterThanOrEqual(0);
    expect(out.length - pcm.length).toBeLessThan(160);
    // Each 0.4 s beat: loud for 0.25 s, then silent. Compare mid-burst to mid-gap.
    for (let beat = 1; beat < 9; beat++) {
      const t0 = Math.round(beat * 0.4 * PULSE_SAMPLE_RATE);
      const burst = rms(out, t0 + 800, t0 + 3200);
      const gap = rms(out, t0 + 4400, t0 + 6000);
      expect(burst).toBeGreaterThan(2000);
      expect(burst / Math.max(1, gap)).toBeGreaterThan(20);
    }
  });

  it('decodes the same every time (a card always sounds the same)', () => {
    const bytes = pulseEncode(heartbeat(2));
    expect(pulseDecode(bytes)).toEqual(pulseDecode(bytes));
  });

  it('silence and tiny clips do not break', () => {
    const silent = pulseDecode(pulseEncode(new Int16Array(16000)));
    expect(silent.every((v) => v === 0)).toBe(true);
    expect(pulseDecode(pulseEncode(new Int16Array(10))).length).toBe(160);
  });

  it('rejects a truncated payload', () => {
    const bytes = pulseEncode(heartbeat(2));
    expect(() => pulseDecode(bytes.subarray(0, 20))).toThrow(/truncated/);
  });
});
