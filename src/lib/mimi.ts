// Mimi (Kyutai's neural speech codec) encode/decode via onnxruntime-web.
//
// Mimi turns 24 kHz speech into 12.5 frames a second, each frame a stack of up
// to 32 residual-vector-quantizer codes of 11 bits. The stack is ordered by
// importance — code 0 is semantic, every code after it refines the residual —
// so a card can keep any prefix of it: depth N costs N·11·12.5 bits a second
// and decodes to recognisably the same voice at every depth, just with more
// detail as N grows. The generator picks the deepest stack the card can hold
// (layout.ts mimiDepthFor), so a short clip sounds better than a long one
// instead of the ladder being a fixed menu.
//
// The models in public/mimi/ are derived from kyutai/mimi (CC-BY-4.0; see
// public/mimi/NOTICE.md): the encoder is the onnx-community export, the
// decoder a fixed 10 s graph that takes all 32 code rows plus a per-row mask
// so one file decodes any depth. Both carry int8 weights (DequantizeLinear),
// which is what keeps the player's download near 60 MB.
//
// Pure helpers (bit packing, resampling) run in node tests; the sessions are
// created by the caller-supplied loader so tests can feed model bytes from
// disk the same way bwe.test.ts does.

// No imports from audio.ts: it re-exports from layout.ts, which imports this
// module's constants at load time — a cycle that breaks whichever loads first.
import type { InferenceSession } from 'onnxruntime-web';

export const MIMI_SAMPLE_RATE = 24000;
export const MIMI_FRAME_RATE = 12.5;
export const MIMI_FRAME_SAMPLES = MIMI_SAMPLE_RATE / MIMI_FRAME_RATE; // 1920
export const MIMI_CODE_BITS = 11;
export const MIMI_MAX_DEPTH = 32;
/** Frames the decoder graph is built for: 10 s, the longest clip a card takes. */
export const MIMI_GRAPH_FRAMES = 125;
const GRAPH_SAMPLES = MIMI_GRAPH_FRAMES * MIMI_FRAME_SAMPLES;

/** Card bytes for `frames` frames at `depth` codes each (frame-major, MSB-first). */
export function mimiPayloadBytes(frames: number, depth: number): number {
  return Math.ceil((frames * depth * MIMI_CODE_BITS) / 8);
}

/** Frames of audio in a clip of this many 16 kHz samples (the encoder rounds up). */
export function mimiFramesFor(samples16k: number): number {
  return Math.ceil((samples16k * 1.5) / MIMI_FRAME_SAMPLES);
}

/** Pack codes[frame][level] for levels < depth, frame-major, 11 bits each,
 * MSB first. Frame-major means the payload length alone tells the decoder how
 * many frames there are: the padding at the end is always under 8 bits, and a
 * frame is at least 11. */
export function packCodes(codes: ArrayLike<number>[], depth: number): Uint8Array {
  const out = new Uint8Array(mimiPayloadBytes(codes.length, depth));
  let bit = 0;
  for (const frame of codes) {
    for (let level = 0; level < depth; level++) {
      const v = frame[level]!;
      for (let b = MIMI_CODE_BITS - 1; b >= 0; b--, bit++) {
        if ((v >> b) & 1) out[bit >> 3]! |= 0x80 >> (bit & 7);
      }
    }
  }
  return out;
}

export function unpackCodes(bytes: Uint8Array, depth: number): number[][] {
  const frames = Math.floor((bytes.length * 8) / (depth * MIMI_CODE_BITS));
  const codes: number[][] = [];
  let bit = 0;
  for (let f = 0; f < frames; f++) {
    const frame: number[] = [];
    for (let level = 0; level < depth; level++) {
      let v = 0;
      for (let b = 0; b < MIMI_CODE_BITS; b++, bit++) {
        v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
      }
      frame.push(v);
    }
    codes.push(frame);
  }
  return codes;
}

// 16 kHz → 24 kHz: upsample by 3, low-pass at the input Nyquist (with a little
// guard band), keep every second sample. Blackman-windowed sinc, polyphase
// branches normalised to unity DC gain — the same construction as bwe.ts.
const UP = 3;
const DOWN = 2;
const HALF_TAPS = 16 * UP;
const RESAMPLE_KERNEL = (() => {
  const fc = 7600 / (16000 * UP);
  const h = new Float64Array(2 * HALF_TAPS + 1);
  for (let u = -HALF_TAPS; u <= HALF_TAPS; u++) {
    const sinc = u === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * u) / (Math.PI * u);
    const w =
      0.42 -
      0.5 * Math.cos((Math.PI * (u + HALF_TAPS)) / HALF_TAPS) +
      0.08 * Math.cos((2 * Math.PI * (u + HALF_TAPS)) / HALF_TAPS);
    h[u + HALF_TAPS] = sinc * w;
  }
  for (let p = 0; p < UP; p++) {
    let sum = 0;
    for (let k = p; k < h.length; k += UP) sum += h[k]!;
    for (let k = p; k < h.length; k += UP) h[k]! /= sum;
  }
  return h;
})();

/** 16 kHz PCM → 24 kHz float in [-1, 1]. */
export function upsample16kTo24k(pcm: Int16Array): Float32Array {
  const out = new Float32Array(Math.floor((pcm.length * UP) / DOWN));
  for (let o = 0; o < out.length; o++) {
    const pos = o * DOWN; // position on the 48 kHz (×3) grid
    const iMin = Math.max(0, Math.ceil((pos - HALF_TAPS) / UP));
    const iMax = Math.min(pcm.length - 1, Math.floor((pos + HALF_TAPS) / UP));
    let acc = 0;
    for (let i = iMin; i <= iMax; i++) acc += pcm[i]! * RESAMPLE_KERNEL[pos - i * UP + HALF_TAPS]!;
    out[o] = acc / 32768;
  }
  return out;
}

export interface MimiSessions {
  ort: typeof import('onnxruntime-web');
  encoder?: InferenceSession;
  decoder?: InferenceSession;
}

/** Encode 16 kHz pipeline PCM to card bytes at `depth` codes per frame. */
export async function mimiEncodeWith(
  s: MimiSessions,
  pcm16k: Int16Array,
  depth: number,
): Promise<Uint8Array> {
  if (!s.encoder) throw new Error('mimi encoder not loaded');
  const audio = upsample16kTo24k(pcm16k);
  const frames = Math.min(MIMI_GRAPH_FRAMES, mimiFramesFor(pcm16k.length));
  const input = new s.ort.Tensor('float32', audio, [1, 1, audio.length]);
  const out = await s.encoder.run({ input_values: input });
  const t = out.audio_codes!;
  const [, levels, steps] = t.dims as [number, number, number];
  const data = t.data as BigInt64Array;
  if (levels < depth) throw new Error(`mimi encoder returned ${levels} levels, need ${depth}`);
  const codes: number[][] = [];
  for (let f = 0; f < Math.min(frames, steps); f++) {
    const frame: number[] = [];
    for (let level = 0; level < depth; level++) frame.push(Number(data[level * steps + f]!));
    codes.push(frame);
  }
  return packCodes(codes, depth);
}

/** Decode card bytes back to 24 kHz PCM. */
export async function mimiDecodeWith(
  s: MimiSessions,
  bytes: Uint8Array,
  depth: number,
): Promise<Int16Array> {
  if (!s.decoder) throw new Error('mimi decoder not loaded');
  if (depth < 1 || depth > MIMI_MAX_DEPTH) throw new Error(`bad mimi depth ${depth}`);
  const codes = unpackCodes(bytes, depth);
  if (codes.length === 0 || codes.length > MIMI_GRAPH_FRAMES) throw new Error('corrupt Mimi payload');
  const grid = new BigInt64Array(MIMI_MAX_DEPTH * MIMI_GRAPH_FRAMES);
  codes.forEach((frame, f) =>
    frame.forEach((v, level) => (grid[level * MIMI_GRAPH_FRAMES + f] = BigInt(v))),
  );
  const mask = new Float32Array(MIMI_MAX_DEPTH);
  mask.fill(1, 0, depth);
  const out = await s.decoder.run({
    codes: new s.ort.Tensor('int64', grid, [1, MIMI_MAX_DEPTH, MIMI_GRAPH_FRAMES]),
    mask: new s.ort.Tensor('float32', mask, [MIMI_MAX_DEPTH]),
  });
  const audio = out.audio!.data as Float32Array;
  // The graph always renders 10 s; the decoder is causal, so the padding frames
  // only ever affect audio after the clip's own end — cut it there.
  const n = Math.min(GRAPH_SAMPLES, codes.length * MIMI_FRAME_SAMPLES);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i]! * 32767)));
  return pcm;
}

// ---------------------------------------------------------------------------
// Browser entry: lazy sessions, memoized per model so the player never pays
// for the encoder.

const MODEL_FILES = {
  encoder: 'mimi/mimi-encoder-int8.onnx',
  decoder: 'mimi/mimi-decoder-int8.onnx',
} as const;

export function mimiSupported(): boolean {
  return typeof document !== 'undefined' && typeof WebAssembly === 'object';
}

type ModelKind = keyof typeof MODEL_FILES;
const sessions: Partial<Record<ModelKind, Promise<InferenceSession>>> = {};

/** Download progress per model, broadcast so a decode screen that subscribes
 * late (the scanner starts the download while codes are still being read)
 * still sees the live figure. */
export type MimiProgress = (loadedBytes: number, totalBytes: number) => void;
const progress: Record<ModelKind, { loaded: number; total: number; listeners: Set<MimiProgress> }> = {
  encoder: { loaded: 0, total: 0, listeners: new Set() },
  decoder: { loaded: 0, total: 0, listeners: new Set() },
};

export function onMimiProgress(kind: ModelKind, cb: MimiProgress): () => void {
  const p = progress[kind];
  p.listeners.add(cb);
  if (p.total) cb(p.loaded, p.total);
  return () => p.listeners.delete(cb);
}

/** The model couldn't be downloaded — worth a retry, unlike a bad payload. */
export class MimiDownloadError extends Error {}

async function fetchModel(kind: ModelKind): Promise<Uint8Array> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${MODEL_FILES[kind]}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const p = progress[kind];
    // Only a progress hint: a compressing proxy can report the wire size.
    p.total = Number(res.headers.get('content-length')) || 0;
    p.loaded = 0;
    if (!res.body || !p.total) return new Uint8Array(await res.arrayBuffer());
    const parts: Uint8Array[] = [];
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      p.loaded += value.length;
      for (const cb of p.listeners) cb(Math.min(p.loaded, p.total), p.total);
    }
    const out = new Uint8Array(p.loaded);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  } catch (e) {
    throw new MimiDownloadError(`fetch ${MODEL_FILES[kind]}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
let ortModule: Promise<typeof import('onnxruntime-web')> | null = null;

function loadOrt(): Promise<typeof import('onnxruntime-web')> {
  // Same runtime configuration as the neural restorer (bwe.ts): the wasm-only
  // bundle, its binary from public/ort/, and inference proxied to a worker so
  // the page keeps painting during a multi-second decode.
  return (ortModule ??= (async () => {
    const ort = await import('onnxruntime-web/wasm');
    ort.env.wasm.wasmPaths = { wasm: `${import.meta.env.BASE_URL}ort/ort-wasm-simd-threaded.wasm` };
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1;
    ort.env.wasm.numThreads = typeof SharedArrayBuffer !== 'undefined' ? Math.min(4, cores) : 1;
    ort.env.wasm.proxy = true;
    return ort as unknown as typeof import('onnxruntime-web');
  })());
}

function loadSession(kind: ModelKind): Promise<InferenceSession> {
  let pending = sessions[kind];
  if (!pending) {
    pending = (async () => {
      const ort = await loadOrt();
      const bytes = await fetchModel(kind);
      // 'basic' keeps ort-web's layer-norm fusion away from the exported
      // transformer, which it otherwise mis-rewrites at session creation.
      // Creation runs in the same worker as inference, so it gets the same
      // deadline: a dead worker never answers this either.
      return withDeadline(
        kind,
        ort.InferenceSession.create(bytes, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'basic',
        }),
      );
    })();
    // Don't cache a failure — a flaky download shouldn't disable Mimi for the
    // rest of the session when a retry would succeed.
    pending.catch(() => {
      if (sessions[kind] === pending) delete sessions[kind];
    });
    sessions[kind] = pending;
  }
  return pending;
}

/** Start fetching a model in the background (player: decoder while scanning). */
export function warmUpMimi(kind: ModelKind): void {
  if (mimiSupported()) void loadSession(kind).catch(() => {});
}

/** Deadline for session creation and for each inference. A 10 s clip takes
 * ~2 s on a laptop and well under this on any phone that can run it at all; a
 * worker that dies silently (OOM, wasm trap) never answers, and the player
 * must not sit on "Rebuilding the voice…" forever. The download itself is not
 * timed — a slow connection is not a hang. */
let inferenceTimeoutMs = 90_000;

/** The runtime stopped answering. onnxruntime runs every session through one
 * shared proxy worker that can't be replaced in-page, so the only recovery is
 * a fresh page — callers should offer a reload (the player keeps the scanned
 * bytes across it). */
export class MimiTimeoutError extends Error {}

/** Set once anything times out: further calls fail fast instead of queueing
 * behind the dead worker. */
let wedged = false;

/** Test seam: a short deadline, and a clean slate between cases. */
export function resetMimiRuntimeForTests(timeoutMs: number): void {
  inferenceTimeoutMs = timeoutMs;
  wedged = false;
}

export async function withDeadline<T>(kind: ModelKind, work: Promise<T>): Promise<T> {
  if (wedged) throw new MimiTimeoutError('mimi runtime is not responding');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MimiTimeoutError(`mimi ${kind} timed out`)), inferenceTimeoutMs);
      }),
    ]);
  } catch (e) {
    if (e instanceof MimiTimeoutError) {
      wedged = true;
      delete sessions[kind];
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function mimiEncode(pcm16k: Int16Array, depth: number): Promise<Uint8Array> {
  if (wedged) throw new MimiTimeoutError('mimi runtime is not responding');
  const [ort, encoder] = await Promise.all([loadOrt(), loadSession('encoder')]);
  return withDeadline('encoder', mimiEncodeWith({ ort, encoder }, pcm16k, depth));
}

export async function mimiDecode(
  bytes: Uint8Array,
  depth: number,
  onProgress?: MimiProgress,
): Promise<Int16Array> {
  if (wedged) throw new MimiTimeoutError('mimi runtime is not responding');
  const unsubscribe = onProgress ? onMimiProgress('decoder', onProgress) : null;
  try {
    const [ort, decoder] = await Promise.all([loadOrt(), loadSession('decoder')]);
    return await withDeadline('decoder', mimiDecodeWith({ ort, decoder }, bytes, depth));
  } finally {
    unsubscribe?.();
  }
}
