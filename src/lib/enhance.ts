// Playback-side enhancement for narrowband Codec 2 audio — zero card cost.
//
// Codec 2 decodes to 8 kHz PCM, which sounds noticeably muffled next to the
// Lyra wideband path. Two treatments, rendered once through an
// OfflineAudioContext, brighten it without touching a single bit on the card:
//
//  1. Presence EQ — a gentle peak + high shelf lifts the 2–4 kHz consonant
//     band, a tilt correction inside the narrowband range.
//  2. Harmonic bandwidth extension — the render runs at twice the decode
//     rate, and an exciter branch regenerates the 4–7 kHz band that the 8 kHz
//     format cannot carry: the consonant band is full-wave rectified (a
//     WaveShaper), which doubles its frequencies, and the resulting harmonics
//     are band-limited and mixed back in at low level. This is the classic
//     pre-neural technique phone networks used to de-muffle narrowband calls;
//     the synthetic highs track the speech envelope, so fricatives (s, f, t)
//     regain their crispness while pauses stay silent.
//
// Playback itself still goes through the <audio> element in lib/audio.ts,
// which keeps the iOS ringer-switch / camera-suspension exemptions.

import { float32ToPcm } from './audio';

const HIGHPASS_HZ = 100; // vocoder thump/rumble below speech
const PRESENCE_HZ = 2500; // consonant-intelligibility peak
const PRESENCE_Q = 0.9;
const PRESENCE_DB = 3.5;
const SHELF_HZ = 3200; // brighten the top of the narrowband range
const SHELF_DB = 4.5;
// Exciter: source band → rectify → keep only the generated octave-up band.
const EXCITE_SOURCE_HZ = 3000; // center of the 2–4 kHz band feeding the exciter
const EXCITE_SOURCE_Q = 1.4;
const HARMONICS_LOW_HZ = 4200; // synthetic band lives above the decode's Nyquist…
const HARMONICS_HIGH_HZ = 7000; // …and rolls off before it turns fizzy
const HARMONICS_GAIN = 0.32; // ≈ −10 dB — sparkle, not hiss
const PEAK_CEILING = 0.985;

export interface EnhancedPcm {
  pcm: Int16Array;
  sampleRate: number;
}

/** Full-wave-rectification curve for the WaveShaper: |x| doubles every
 * frequency in the signal (even harmonics), turning 2–4 kHz speech energy
 * into 4–8 kHz content. The DC/envelope byproduct is filtered out after. */
function rectifierCurve(points = 1024): Float32Array {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    curve[i] = Math.abs((i / (points - 1)) * 2 - 1);
  }
  return curve;
}

/** Render narrowband PCM through the EQ + bandwidth-extension chain. Returns
 * PCM at twice the input rate on success. Returns the input untouched (same
 * rate) when Web Audio is unavailable or the render fails (old browsers,
 * unsupported sample rate) — the enhancement is strictly best-effort. */
export async function enhanceNarrowband(
  pcm: Int16Array,
  sampleRate: number,
): Promise<EnhancedPcm> {
  if (pcm.length === 0 || typeof OfflineAudioContext === 'undefined') {
    return { pcm, sampleRate };
  }
  try {
    const outRate = sampleRate * 2;
    const ctx = new OfflineAudioContext(1, pcm.length * 2, outRate);
    // The source buffer keeps the decode rate; the context resamples it up.
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
    src.connect(highpass);
    // Main path: the original narrowband content, tilt-corrected.
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
    highpass.connect(presence).connect(shelf).connect(ctx.destination);
    // Exciter path: consonant band → rectifier → keep the octave-up harmonics.
    const exciteSource = new BiquadFilterNode(ctx, {
      type: 'bandpass',
      frequency: EXCITE_SOURCE_HZ,
      Q: EXCITE_SOURCE_Q,
    });
    const rectifier = new WaveShaperNode(ctx, { curve: rectifierCurve() });
    const harmonicsLow = new BiquadFilterNode(ctx, {
      type: 'highpass',
      frequency: HARMONICS_LOW_HZ,
      Q: Math.SQRT1_2,
    });
    const harmonicsHigh = new BiquadFilterNode(ctx, {
      type: 'lowpass',
      frequency: HARMONICS_HIGH_HZ,
      Q: Math.SQRT1_2,
    });
    const harmonicsGain = new GainNode(ctx, { gain: HARMONICS_GAIN });
    highpass
      .connect(exciteSource)
      .connect(rectifier)
      .connect(harmonicsLow)
      .connect(harmonicsHigh)
      .connect(harmonicsGain)
      .connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    // The offline render is float and never clips; pull any boosted peaks
    // back under the ceiling ourselves before quantizing to 16-bit.
    const out = rendered.getChannelData(0);
    limitPeak(out, PEAK_CEILING);
    return { pcm: float32ToPcm(out), sampleRate: outRate };
  } catch {
    return { pcm, sampleRate };
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
