// Playback-side presence EQ for narrowband Codec 2 audio — zero card cost.
//
// Codec 2 decodes to 8 kHz PCM, which sounds noticeably muffled next to the
// Lyra wideband path. A gentle presence peak + high shelf, rendered once
// through an OfflineAudioContext, lifts the 2–4 kHz consonant band and makes
// speech clearer without touching a single bit on the card. Playback itself
// still goes through the <audio> element in lib/audio.ts, which keeps the
// iOS ringer-switch / camera-suspension exemptions.
//
// This is deliberately NOT bandwidth extension: at an 8 kHz sample rate there
// is nothing above the 4 kHz Nyquist to recover — only a tilt correction
// inside the band. All frequencies below are chosen for that band.

import { float32ToPcm } from './audio';

const HIGHPASS_HZ = 100; // vocoder thump/rumble below speech
const PRESENCE_HZ = 2500; // consonant-intelligibility peak
const PRESENCE_Q = 0.9;
const PRESENCE_DB = 3.5;
const SHELF_HZ = 3200; // brighten the top of the narrowband range
const SHELF_DB = 4.5;
const PEAK_CEILING = 0.985;

/** Render narrowband PCM through the presence EQ chain. Returns the input
 * untouched when Web Audio is unavailable or the render fails (old browsers,
 * unsupported sample rate) — the enhancement is strictly best-effort. */
export async function enhanceNarrowband(
  pcm: Int16Array,
  sampleRate: number,
): Promise<Int16Array> {
  if (pcm.length === 0 || typeof OfflineAudioContext === 'undefined') return pcm;
  try {
    const ctx = new OfflineAudioContext(1, pcm.length, sampleRate);
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    const input = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) input[i] = pcm[i]! / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const highpass = new BiquadFilterNode(ctx, {
      type: 'highpass',
      frequency: HIGHPASS_HZ,
      Q: Math.SQRT1_2,
    });
    const presence = new BiquadFilterNode(ctx, {
      type: 'peaking',
      frequency: PRESENCE_HZ,
      Q: PRESENCE_Q,
      gain: PRESENCE_DB,
    });
    const shelf = new BiquadFilterNode(ctx, {
      type: 'highshelf',
      frequency: SHELF_HZ,
      gain: SHELF_DB,
    });
    src.connect(highpass).connect(presence).connect(shelf).connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    // The offline render is float and never clips; pull any boosted peaks
    // back under the ceiling ourselves before quantizing to 16-bit.
    const out = rendered.getChannelData(0);
    limitPeak(out, PEAK_CEILING);
    return float32ToPcm(out);
  } catch {
    return pcm;
  }
}

/** Uniformly scale the clip down so no sample exceeds `ceiling`, in place.
 * Leaves clips already under the ceiling untouched. */
export function limitPeak(f32: Float32Array, ceiling: number): void {
  let peak = 0;
  for (let i = 0; i < f32.length; i++) {
    const mag = Math.abs(f32[i]!);
    if (mag > peak) peak = mag;
  }
  if (peak <= ceiling) return;
  const gain = ceiling / peak;
  for (let i = 0; i < f32.length; i++) f32[i] = f32[i]! * gain;
}
