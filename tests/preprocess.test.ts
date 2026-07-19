import { describe, expect, it } from 'vitest';
import { activeBounds, highPass, normalize, preparePcm } from '../src/lib/preprocess';

const SR = 16000;

function tone(seconds: number, hz: number, amp: number, sr = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let acc = 0;
  for (let i = from; i < to; i++) acc += x[i]! * x[i]!;
  return Math.sqrt(acc / Math.max(1, to - from));
}

describe('highPass', () => {
  it('removes DC and rumble but keeps speech-band content', () => {
    const speech = tone(1, 440, 0.4);
    const rumble = tone(1, 20, 0.4);
    const dc = 0.3;
    const mixed = new Float32Array(speech.length);
    for (let i = 0; i < mixed.length; i++) mixed[i] = speech[i]! + rumble[i]! + dc;

    highPass(mixed, SR);
    // Skip the filter's settling transient before measuring.
    const settled = mixed.subarray(SR / 4);
    let mean = 0;
    for (const v of settled) mean += v;
    mean /= settled.length;
    expect(Math.abs(mean)).toBeLessThan(0.01); // DC gone
    const speechRms = rms(speech, SR / 4);
    expect(rms(settled as Float32Array)).toBeGreaterThan(speechRms * 0.8);
    expect(rms(settled as Float32Array)).toBeLessThan(speechRms * 1.25); // rumble gone, tone kept
  });
});

describe('normalize', () => {
  it('boosts a quiet clip to near full scale', () => {
    const quiet = tone(1, 300, 0.05);
    const gain = normalize(quiet);
    expect(gain).toBeGreaterThan(10);
    const peak = Math.max(...Array.from(quiet).map(Math.abs));
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThanOrEqual(0.985);
  });

  it('is not defeated by a single click', () => {
    const quiet = tone(1, 300, 0.05);
    quiet[100] = 1.0; // click
    normalize(quiet);
    expect(rms(quiet, SR / 2)).toBeGreaterThan(0.3);
  });

  it('attenuates an over-hot clip and leaves silence alone', () => {
    const hot = tone(1, 300, 1.4);
    normalize(hot);
    expect(Math.max(...Array.from(hot).map(Math.abs))).toBeLessThanOrEqual(0.985);

    const silence = new Float32Array(SR);
    expect(normalize(silence)).toBe(1);
    expect(rms(silence)).toBe(0);
  });
});

describe('activeBounds', () => {
  it('finds speech surrounded by silence', () => {
    const clip = new Float32Array(SR * 5);
    clip.set(tone(2, 300, 0.4), SR * 2); // 2s..4s active
    const bounds = activeBounds(clip, SR)!;
    expect(bounds).not.toBeNull();
    expect(bounds.startSec).toBeGreaterThan(1.5);
    expect(bounds.startSec).toBeLessThanOrEqual(2.0);
    expect(bounds.endSec).toBeGreaterThanOrEqual(4.0);
    expect(bounds.endSec).toBeLessThan(4.5);
  });

  it('survives a real noise floor', () => {
    const clip = new Float32Array(SR * 5);
    let seed = 42;
    for (let i = 0; i < clip.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      clip[i] = ((seed / 2 ** 32) - 0.5) * 0.01; // ~-40 dBFS noise
    }
    const speech = tone(2, 300, 0.4);
    for (let i = 0; i < speech.length; i++) clip[SR * 2 + i]! += speech[i]!;
    const bounds = activeBounds(clip, SR)!;
    expect(bounds.startSec).toBeGreaterThan(1.5);
    expect(bounds.endSec).toBeLessThan(4.5);
  });

  it('returns null for silence (caller keeps the clip)', () => {
    expect(activeBounds(new Float32Array(SR), SR)).toBeNull();
  });
});

describe('preparePcm', () => {
  it('trims, normalizes, and reports what it did', () => {
    const clip = new Float32Array(SR * 6);
    clip.set(tone(2, 300, 0.05), SR * 2); // quiet tone at 2s..4s
    const prep = preparePcm(clip, SR);
    const seconds = prep.pcm.length / SR;
    expect(seconds).toBeGreaterThan(1.9);
    expect(seconds).toBeLessThan(3.0);
    expect(prep.trimmedLeadSec).toBeGreaterThan(1);
    expect(prep.trimmedTailSec).toBeGreaterThan(1);
    expect(prep.gain).toBeGreaterThan(5);
    let peak = 0;
    for (const v of prep.pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(20000);
  });

  it('keeps an all-quiet clip instead of deleting it', () => {
    const clip = new Float32Array(SR * 2);
    const prep = preparePcm(clip, SR);
    expect(prep.pcm.length).toBe(clip.length);
    expect(prep.trimmedLeadSec).toBe(0);
  });
});
