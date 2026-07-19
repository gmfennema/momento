// Conditioning applied to every clip before it is trimmed/encoded. Vocoders
// are far more fragile than general audio codecs: rumble confuses pitch
// tracking, quiet input quantizes badly, and leading/trailing silence burns
// card capacity at a fixed bitrate. Pure math — runs in node tests.

import { float32ToPcm } from './audio';

export interface PreparedPcm {
  pcm: Int16Array;
  /** seconds of silence dropped from the start / end */
  trimmedLeadSec: number;
  trimmedTailSec: number;
  gain: number;
}

/** Full conditioning chain: high-pass → drop edge silence → normalize. */
export function preparePcm(f32: Float32Array, sampleRate: number): PreparedPcm {
  highPass(f32, sampleRate);
  const durationSec = f32.length / sampleRate;
  let bounds = activeBounds(f32, sampleRate);
  // A trim that leaves less than a playable clip means the detector misread
  // the content (e.g. everything was near-threshold) — keep the whole clip.
  if (bounds && bounds.endSec - bounds.startSec < 0.3) bounds = null;
  let active = f32;
  let trimmedLeadSec = 0;
  let trimmedTailSec = 0;
  if (bounds) {
    active = f32.subarray(
      Math.floor(bounds.startSec * sampleRate),
      Math.ceil(bounds.endSec * sampleRate),
    );
    trimmedLeadSec = bounds.startSec;
    trimmedTailSec = durationSec - bounds.endSec;
  }
  const gain = normalize(active);
  return { pcm: float32ToPcm(active), trimmedLeadSec, trimmedTailSec, gain };
}

/** 2nd-order Butterworth high-pass (RBJ cookbook), in place. Kills DC and
 * sub-speech rumble that vocoder pitch trackers choke on. */
export function highPass(pcm: Float32Array, sampleRate: number, cutoffHz = 80): void {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / Math.SQRT2; // 2·Q with Q = 1/√2
  const b0 = (1 + cosW0) / 2;
  const b1 = -(1 + cosW0);
  const b2 = (1 + cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x0 = pcm[i]!;
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    pcm[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
}

/** Gain the clip so its near-peak (99.5th percentile of |sample|) sits at
 * -1 dBFS, in place. Percentile-based so a single click doesn't defeat the
 * normalization; the few samples above it are hard-clamped. Boost is capped
 * so near-silence isn't amplified into noise. */
export function normalize(pcm: Float32Array, targetPeak = 0.891, maxBoost = 24): number {
  if (pcm.length === 0) return 1;
  const magnitudes = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) magnitudes[i] = Math.abs(pcm[i]!);
  magnitudes.sort();
  const nearPeak = magnitudes[Math.min(pcm.length - 1, Math.floor(pcm.length * 0.995))]!;
  if (nearPeak < 1e-5) return 1; // effectively silence — leave it alone
  const gain = Math.min(maxBoost, targetPeak / nearPeak);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.max(-0.985, Math.min(0.985, pcm[i]! * gain));
  }
  return gain;
}

export interface ActiveBounds {
  startSec: number;
  endSec: number;
}

/** Find where the clip's actual content starts and ends, so leading/trailing
 * silence can be dropped (fixed bitrate → silence costs card space). Frames
 * are judged against a threshold derived from the clip's own noise floor and
 * peak, then padded, so quiet-but-intentional speech survives. Returns null
 * when the whole clip is quiet — callers should keep it untouched. */
export function activeBounds(
  pcm: Float32Array,
  sampleRate: number,
  padSec = 0.15,
): ActiveBounds | null {
  const frame = Math.round(sampleRate * 0.02);
  const frames = Math.floor(pcm.length / frame);
  if (frames < 3) return null;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) acc += pcm[i]! * pcm[i]!;
    rms[f] = Math.sqrt(acc / frame);
  }
  const sorted = rms.slice().sort();
  const noiseFloor = sorted[Math.floor(frames * 0.1)]!;
  // 95th-percentile frame RMS, not the absolute max — one mic bump must not
  // raise the bar above soft speech.
  const loud = sorted[Math.min(frames - 1, Math.floor(frames * 0.95))]!;
  if (sorted[frames - 1]! < 1e-4) return null;
  // Above 4× the noise floor AND above -32 dB relative to the loud frames.
  const threshold = Math.max(noiseFloor * 4, loud * 0.025, 1e-4);
  let first = -1;
  let last = -1;
  for (let f = 0; f < frames; f++) {
    if (rms[f]! >= threshold) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return null;
  return {
    startSec: Math.max(0, (first * frame) / sampleRate - padSec),
    endSec: Math.min(pcm.length / sampleRate, ((last + 1) * frame) / sampleRate + padSec),
  };
}
