// Lyra V2 (neural speech codec) encode/decode via the wasm runtime vendored
// in public/lyra/ (see scripts/copy-lyra.mjs). Browser-only: the build uses
// wasm threads, so it needs SharedArrayBuffer and a cross-origin isolated
// page (arranged by the COI service worker / dev-server headers).
//
// The wrapper is a fixed-rate encoder: 3.2 kbps, 20 ms frames — 8 bytes per
// frame, 400 bytes per second — wideband (16 kHz) in and out.

export const LYRA_SAMPLE_RATE = 16000;
export const LYRA_FRAME_SAMPLES = LYRA_SAMPLE_RATE / 50; // 20 ms = 320
export const LYRA_BYTES_PER_FRAME = 8; // 3200 bps · 20 ms
export const LYRA_BYTES_PER_SEC = 400;

interface LyraBundle {
  isLyraReady(): boolean;
  encodeWithLyra(pcm: Float32Array, sampleRateHz: number): Uint8Array;
  decodeWithLyra(bits: Uint8Array, sampleRateHz: number, expectedSamples: number): Float32Array;
}

/** Whether this context can run the Lyra wasm at all. */
export function lyraSupported(): boolean {
  return typeof document !== 'undefined' && typeof SharedArrayBuffer !== 'undefined';
}

let bundle: Promise<LyraBundle> | null = null;

function load(): Promise<LyraBundle> {
  return (bundle ??= (async () => {
    if (!lyraSupported()) {
      throw new Error(
        'This browser cannot run the Lyra voice codec (needs cross-origin isolation).',
      );
    }
    const url = `${import.meta.env.BASE_URL}lyra/lyra_bundle.js`;
    const mod = (await import(/* @vite-ignore */ url)) as LyraBundle;
    // Model download + wasm init happen in the background; poll readiness.
    const deadline = Date.now() + 30_000;
    while (!mod.isLyraReady()) {
      if (Date.now() > deadline) throw new Error('Lyra codec failed to initialize.');
      await new Promise((r) => setTimeout(r, 50));
    }
    return mod;
  })());
}

/** Preload the wasm + models so the first encode/decode doesn't stall. */
export function warmUpLyra(): void {
  if (lyraSupported()) void load().catch(() => {});
}

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i]! / 32768;
  return f32;
}

export function float32ToInt16(f32: Float32Array): Int16Array {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i]! * 32767)));
  }
  return pcm;
}

/** Pad to a whole number of 20 ms frames (the encoder drops partial frames). */
export function padToLyraFrames(pcm: Int16Array): Int16Array {
  const rem = pcm.length % LYRA_FRAME_SAMPLES;
  if (rem === 0 && pcm.length > 0) return pcm;
  const padded = new Int16Array(Math.max(1, Math.ceil(pcm.length / LYRA_FRAME_SAMPLES)) * LYRA_FRAME_SAMPLES);
  padded.set(pcm);
  return padded;
}

/** Encode 16 kHz mono PCM to Lyra bits (8 bytes per 20 ms frame). */
export async function lyraEncode(pcm: Int16Array): Promise<Uint8Array> {
  const mod = await load();
  const framed = padToLyraFrames(pcm);
  const bits = mod.encodeWithLyra(int16ToFloat32(framed), LYRA_SAMPLE_RATE);
  const expected = (framed.length / LYRA_FRAME_SAMPLES) * LYRA_BYTES_PER_FRAME;
  if (bits.length !== expected) {
    throw new Error(`Lyra encode returned ${bits.length} bytes, expected ${expected}`);
  }
  return bits;
}

/** Decode Lyra bits back to 16 kHz mono PCM. */
export async function lyraDecode(bits: Uint8Array): Promise<Int16Array> {
  if (bits.length === 0 || bits.length % LYRA_BYTES_PER_FRAME !== 0) {
    throw new Error('corrupt Lyra payload');
  }
  const mod = await load();
  const samples = (bits.length / LYRA_BYTES_PER_FRAME) * LYRA_FRAME_SAMPLES;
  const f32 = mod.decodeWithLyra(bits, LYRA_SAMPLE_RATE, samples);
  return float32ToInt16(f32);
}
