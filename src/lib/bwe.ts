// Neural bandwidth extension for narrowband Codec 2 playback — zero card cost.
//
// Runs the LavaSR speech-restoration model (Vocos-style ConvNeXt backbone +
// ISTFT spectrogram head, converted to fp16 ONNX) in the browser through
// onnxruntime-web. The 8 kHz Codec 2 decode is upsampled to 48 kHz, the model
// resynthesizes the frequencies the narrowband format cannot carry, and a
// Linkwitz-Riley crossover keeps the original signal below the cutoff so the
// net only ever *adds* the missing highs.
//
// The DSP mirrors the reference NumPy implementation in
// github.com/Topping1/LavaSR-ONNX (Apache-2.0, derived from
// github.com/ysharma3501/LavaSR) — including its quirks: the mel filterbank
// is built on a 44.1 kHz frequency grid but applied to 48 kHz STFT frames,
// because that is what the shipped weights were trained with.
//
// Everything except the model download is pure math and runs in node tests;
// see enhance.ts for the lightweight always-available DSP fallback.

import { float32ToPcm } from './audio';
import { limitPeak } from './enhance';
import { rfft, irfft, type ComplexBins } from './fft';
import type { InferenceSession, Tensor } from 'onnxruntime-web';

export const BWE_SAMPLE_RATE = 48000;
const N_FFT = 2048;
const HOP = 512;
const WIN = 2048; // == N_FFT
const N_MELS = 80;
// Quirks of the shipped LavaSR weights: mel grid assumes 44.1 kHz audio and
// tops out at 8 kHz even though the model consumes/produces 48 kHz frames.
const MEL_GRID_SR = 44100;
const MEL_FMAX = 8000;
const MEL_LOG_FLOOR = 1e-5;
// Codec 2's own decimator cuts at 3.6 kHz, so everything below that is the
// authentic decode and everything above is the model's reconstruction.
const CROSSOVER_HZ = 3600;
const PEAK_CEILING = 0.985;

const MODEL_FILES = {
  backbone: 'bwe/enhancer-backbone-fp16.onnx',
  specHead: 'bwe/enhancer-spec-head-fp16.onnx',
} as const;
/** Rough total download size, for progress display before headers arrive. */
export const BWE_DOWNLOAD_BYTES = 28_164_072;

type Ort = typeof import('onnxruntime-web');

export interface BweRuntime {
  ort: Ort;
  backbone: InferenceSession;
  specHead: InferenceSession;
}

/** Create ONNX sessions from raw model bytes. The caller configures
 * `ort.env` (thread count, wasm paths) before calling. */
export async function createBweRuntime(
  ort: Ort,
  backboneBytes: Uint8Array,
  specHeadBytes: Uint8Array,
): Promise<BweRuntime> {
  const opts = { executionProviders: ['wasm'] } as InferenceSession.SessionOptions;
  const backbone = await ort.InferenceSession.create(backboneBytes, opts);
  const specHead = await ort.InferenceSession.create(specHeadBytes, opts);
  return { ort, backbone, specHead };
}

/** Upsample mono PCM to 48 kHz by an integer factor with a windowed-sinc
 * (Blackman) interpolation filter cut at the crossover frequency. */
export function upsampleTo48k(pcm: Int16Array, sampleRate: number): Float32Array {
  const factor = BWE_SAMPLE_RATE / sampleRate;
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`cannot upsample ${sampleRate} Hz to ${BWE_SAMPLE_RATE} Hz by an integer factor`);
  }
  const x = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) x[i] = pcm[i]! / 32768;
  if (factor === 1) return x;

  const half = 16 * factor; // 16 input samples of support each side
  const fc = CROSSOVER_HZ / BWE_SAMPLE_RATE;
  const h = new Float64Array(2 * half + 1);
  for (let u = -half; u <= half; u++) {
    const sinc = u === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * u) / (Math.PI * u);
    const w =
      0.42 -
      0.5 * Math.cos((Math.PI * (u + half)) / half) +
      0.08 * Math.cos((2 * Math.PI * (u + half)) / half);
    h[u + half] = sinc * w;
  }
  // Normalize each polyphase branch to unity DC gain so the output has no
  // sub-sample amplitude ripple.
  for (let p = 0; p < factor; p++) {
    let sum = 0;
    for (let k = p; k < h.length; k += factor) sum += h[k]!;
    if (sum > 1e-12) {
      for (let k = p; k < h.length; k += factor) h[k]! /= sum;
    }
  }
  const out = new Float32Array(pcm.length * factor);
  for (let o = 0; o < out.length; o++) {
    // input samples i with |o - i·factor| ≤ half contribute
    const iMin = Math.max(0, Math.ceil((o - half) / factor));
    const iMax = Math.min(pcm.length - 1, Math.floor((o + half) / factor));
    let acc = 0;
    for (let i = iMin; i <= iMax; i++) acc += x[i]! * h[o - i * factor + half]!;
    out[o] = acc;
  }
  return out;
}

/** Periodic Hann window (numpy hanning(n+1)[:-1]), as used by Vocos. */
function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Reflect-pad (numpy 'reflect': edge sample not repeated). */
function padReflect(x: Float32Array, pad: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n + 2 * pad);
  for (let i = 0; i < n; i++) out[pad + i] = x[i]!;
  for (let i = 0; i < pad; i++) {
    out[i] = x[Math.min(n - 1, pad - i)]!;
    out[pad + n + i] = x[Math.max(0, n - 2 - i)]!;
  }
  return out;
}

interface MelBank {
  fb: Float64Array; // [N_MELS][N_FFT/2+1]
  bins: number;
}

const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOGSTEP = Math.log(6.4) / 27;

function hzToMelSlaney(f: number): number {
  return f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOGSTEP : f / F_SP;
}

function melToHzSlaney(m: number): number {
  return m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL)) : F_SP * m;
}

let melBank: MelBank | null = null;

function buildMelBank(): MelBank {
  if (melBank) return melBank;
  const bins = N_FFT / 2 + 1;
  const fftFreqs = new Float64Array(bins);
  for (let i = 0; i < bins; i++) fftFreqs[i] = (i * (MEL_GRID_SR / 2)) / (bins - 1);
  const mMin = hzToMelSlaney(0);
  const mMax = hzToMelSlaney(MEL_FMAX);
  const fPts = new Float64Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    fPts[i] = melToHzSlaney(mMin + ((mMax - mMin) * i) / (N_MELS + 1));
  }
  const fb = new Float64Array(N_MELS * bins);
  for (let m = 0; m < N_MELS; m++) {
    const lowDiff = Math.max(fPts[m + 1]! - fPts[m]!, 1e-12);
    const highDiff = Math.max(fPts[m + 2]! - fPts[m + 1]!, 1e-12);
    const enorm = 2 / Math.max(fPts[m + 2]! - fPts[m]!, 1e-12);
    for (let f = 0; f < bins; f++) {
      const lower = (fftFreqs[f]! - fPts[m]!) / lowDiff;
      const upper = (fPts[m + 2]! - fftFreqs[f]!) / highDiff;
      fb[m * bins + f] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
  }
  melBank = { fb, bins };
  return melBank;
}

/** Log-mel features with padding='same' reflect framing, matching the
 * reference MelSpectrogramFrontend. Returns [N_MELS][frames] row-major. */
export function melSpectrogram(wav48: Float32Array): { mel: Float32Array; frames: number } {
  const pad = (WIN - HOP) / 2;
  const padded = padReflect(wav48, pad);
  const frames = Math.floor((padded.length - WIN) / HOP) + 1;
  if (frames < 1) throw new Error('clip too short for the neural enhancer');
  const { fb, bins } = buildMelBank();
  const window = hannPeriodic(WIN);
  const mel = new Float32Array(N_MELS * frames);
  const frame = new Float64Array(WIN);
  const mag = new Float64Array(bins);
  for (let t = 0; t < frames; t++) {
    const start = t * HOP;
    for (let i = 0; i < WIN; i++) frame[i] = padded[start + i]! * window[i]!;
    const spec = rfft(frame, N_FFT);
    for (let f = 0; f < bins; f++) {
      mag[f] = Math.hypot(spec.re[f]!, spec.im[f]!);
    }
    for (let m = 0; m < N_MELS; m++) {
      let acc = 0;
      const row = m * bins;
      for (let f = 0; f < bins; f++) acc += fb[row + f]! * mag[f]!;
      mel[m * frames + t] = Math.log(Math.max(acc, MEL_LOG_FLOOR));
    }
  }
  return { mel, frames };
}

/** Overlap-add iSTFT with padding='same' and window-square normalization,
 * matching the reference ISTFTReconstructor. `real`/`imag` are [bins][frames]
 * row-major. */
export function istftSame(
  real: Float32Array,
  imag: Float32Array,
  frames: number,
  targetLen: number,
): Float32Array {
  const bins = N_FFT / 2 + 1;
  const window = hannPeriodic(WIN);
  const pad = (WIN - HOP) / 2;
  const outLen = (frames - 1) * HOP + WIN;
  const y = new Float64Array(outLen);
  const env = new Float64Array(outLen);
  const col: ComplexBins = { re: new Float64Array(bins), im: new Float64Array(bins) };
  for (let t = 0; t < frames; t++) {
    for (let f = 0; f < bins; f++) {
      col.re[f] = real[f * frames + t]!;
      col.im[f] = imag[f * frames + t]!;
    }
    const seg = irfft(col, N_FFT);
    const start = t * HOP;
    for (let i = 0; i < WIN; i++) {
      const w = window[i]!;
      y[start + i] = y[start + i]! + seg[i]! * w;
      env[start + i] = env[start + i]! + w * w;
    }
  }
  const out = new Float32Array(targetLen);
  const n = Math.min(targetLen, outLen - 2 * pad);
  for (let i = 0; i < n; i++) {
    out[i] = y[pad + i]! / Math.max(env[pad + i]!, 1e-8);
  }
  return out;
}

/** One RBJ biquad pass, in place. */
function biquad(
  x: Float32Array,
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
}

function butterworth(x: Float32Array, type: 'lowpass' | 'highpass', fcHz: number): void {
  const w0 = (2 * Math.PI * fcHz) / BWE_SAMPLE_RATE;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) * Math.SQRT1_2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;
  if (type === 'lowpass') {
    biquad(x, (1 - cosW0) / 2, 1 - cosW0, (1 - cosW0) / 2, a0, a1, a2);
  } else {
    biquad(x, (1 + cosW0) / 2, -(1 + cosW0), (1 + cosW0) / 2, a0, a1, a2);
  }
}

/** Linkwitz-Riley 4th-order merge: the original decode below the crossover,
 * the model's reconstruction above. LR4 = two cascaded Butterworth biquads
 * per band; the two bands sum back to flat magnitude. Modifies both inputs. */
export function lr4Merge(enhanced: Float32Array, original: Float32Array): Float32Array {
  butterworth(original, 'lowpass', CROSSOVER_HZ);
  butterworth(original, 'lowpass', CROSSOVER_HZ);
  butterworth(enhanced, 'highpass', CROSSOVER_HZ);
  butterworth(enhanced, 'highpass', CROSSOVER_HZ);
  const n = Math.min(enhanced.length, original.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = original[i]! + enhanced[i]!;
  return out;
}

/** Full neural enhancement: narrowband PCM in, 48 kHz wideband PCM out. */
export async function bweEnhance(
  rt: BweRuntime,
  pcm: Int16Array,
  sampleRate: number,
): Promise<Int16Array> {
  const wav48 = upsampleTo48k(pcm, sampleRate);
  const { mel, frames } = melSpectrogram(wav48);
  const melTensor = new rt.ort.Tensor('float32', mel, [1, N_MELS, frames]);
  const { hidden } = await rt.backbone.run({ mel: melTensor });
  const headOut = await rt.specHead.run({ hidden: hidden as Tensor });
  const real = headOut.real!.data as Float32Array;
  const imag = headOut.imag!.data as Float32Array;
  const enhanced = istftSame(real, imag, frames, wav48.length);
  const merged = lr4Merge(enhanced, wav48);
  limitPeak(merged, PEAK_CEILING);
  return float32ToPcm(merged);
}

// ---------------------------------------------------------------------------
// Browser entry: lazy module + model download with progress, memoized.

export type BweProgress = (loadedBytes: number, totalBytes: number) => void;

export function neuralBweSupported(): boolean {
  return typeof document !== 'undefined' && typeof WebAssembly === 'object' && typeof fetch === 'function';
}

let runtime: Promise<BweRuntime> | null = null;

// Download progress is broadcast to listeners rather than tied to one caller:
// the scanner warms the model up in the background while codes are still
// being read, and the decode screen subscribes later to show live progress
// of that same download.
const progressListeners = new Set<BweProgress>();
let bytesLoaded = 0;

function reportProgress(bytes: number): void {
  bytesLoaded = Math.min(bytesLoaded + bytes, BWE_DOWNLOAD_BYTES);
  for (const cb of progressListeners) cb(bytesLoaded, BWE_DOWNLOAD_BYTES);
}

/** Subscribe to model-download progress (fires immediately with the current
 * state). Returns an unsubscribe function. */
export function onBweProgress(cb: BweProgress): () => void {
  progressListeners.add(cb);
  cb(bytesLoaded, BWE_DOWNLOAD_BYTES);
  return () => progressListeners.delete(cb);
}

/** Start fetching the wasm + models in the background so a decode right
 * after scanning doesn't stall on the download. */
export function warmUpNeuralBwe(): void {
  if (neuralBweSupported()) void loadRuntime().catch(() => {});
}

async function fetchWithProgress(
  url: string,
  onChunk: (bytes: number) => void,
): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onChunk(buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function loadRuntime(): Promise<BweRuntime> {
  if (!runtime) {
    const loading = (async () => {
      const base = import.meta.env.BASE_URL;
      // The wasm-EP-only bundle build: the emscripten glue is inlined into
      // the JS chunk, so at runtime only the .wasm binary is fetched — a
      // plain fetch from public/ort/ (see scripts/copy-ort.mjs), which works
      // in both the dev server and the built app. The object form matters: a
      // string prefix would make ort re-import the glue .mjs from that path,
      // which the dev server refuses to serve as a module.
      const ort = await import('onnxruntime-web/wasm');
      ort.env.wasm.wasmPaths = { wasm: `${base}ort/ort-wasm-simd-threaded.wasm` };
      // Threads need cross-origin isolation (same requirement as Lyra);
      // without it the wasm still runs, just single-threaded.
      const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1;
      ort.env.wasm.numThreads = typeof SharedArrayBuffer !== 'undefined' ? Math.min(4, cores) : 1;
      const [backboneBytes, specHeadBytes] = await Promise.all([
        fetchWithProgress(`${base}${MODEL_FILES.backbone}`, reportProgress),
        fetchWithProgress(`${base}${MODEL_FILES.specHead}`, reportProgress),
      ]);
      return createBweRuntime(ort, backboneBytes, specHeadBytes);
    })();
    // Don't cache a failure — a flaky download shouldn't disable the neural
    // path for the rest of the session when a retry would succeed. Reset the
    // progress counter so a retry reports honestly from zero.
    loading.catch(() => {
      if (runtime === loading) {
        runtime = null;
        bytesLoaded = 0;
      }
    });
    runtime = loading;
  }
  return runtime;
}

/** Browser-side neural enhancement of a narrowband decode. Downloads the
 * model on first use (~27 MB, cached by the service worker afterwards). */
export async function enhanceNeuralNarrowband(
  pcm: Int16Array,
  sampleRate: number,
  onProgress?: BweProgress,
): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const unsubscribe = onProgress ? onBweProgress(onProgress) : null;
  try {
    const rt = await loadRuntime();
    const out = await bweEnhance(rt, pcm, sampleRate);
    return { pcm: out, sampleRate: BWE_SAMPLE_RATE };
  } finally {
    unsubscribe?.();
  }
}
