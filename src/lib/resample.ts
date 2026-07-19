// 2:1 decimation (16 kHz → 8 kHz) for the Codec 2 path. A plain FIR low-pass
// (Blackman-windowed sinc, cutoff safely below the 4 kHz output Nyquist)
// applied at the input rate, evaluated only at even samples. Pure math — runs
// in both browser and node tests.

const TAPS = 63; // odd → symmetric, integer group delay of (TAPS-1)/2
const CUTOFF = 3600 / 16000; // normalized to the input rate

function buildKernel(): Float32Array {
  const k = new Float32Array(TAPS);
  const mid = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const t = i - mid;
    const sinc = t === 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * t) / (Math.PI * t);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    k[i] = sinc * w;
    sum += k[i]!;
  }
  for (let i = 0; i < TAPS; i++) k[i]! /= sum; // unity DC gain
  return k;
}

const KERNEL = buildKernel();

/** Downsample 16-bit mono PCM by exactly 2× with anti-alias filtering. */
export function decimate2(pcm: Int16Array): Int16Array {
  const outLen = Math.floor(pcm.length / 2);
  const out = new Int16Array(outLen);
  const mid = (TAPS - 1) / 2;
  for (let o = 0; o < outLen; o++) {
    const center = o * 2;
    let acc = 0;
    for (let i = 0; i < TAPS; i++) {
      const idx = center + i - mid;
      if (idx >= 0 && idx < pcm.length) acc += KERNEL[i]! * pcm[idx]!;
    }
    out[o] = Math.max(-32768, Math.min(32767, Math.round(acc)));
  }
  return out;
}
