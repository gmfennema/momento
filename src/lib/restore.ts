// "What the scanner will play" — the one pipeline both the player and the
// generator's preview run.
//
// A card's bytes are only half the story: a Codec 2 card is restored at
// playback time by the neural bandwidth-extension model (lib/bwe.ts), so the
// voice a maker hears when previewing a tier is only honest if the preview
// goes through exactly the same decode + restoration the player does. Hence
// this module, imported by both.
//
// The other job here is the watchdog. enhanceNeuralNarrowband resolves when
// the wasm worker answers — and a worker that dies (OOM on a small phone, a
// wasm trap) never answers at all, so an unbounded await hangs the player on
// "Restoring the voice…" forever. Everything neural runs under a timeout that
// falls back to the always-available DSP polish.

import { codec2Decode, CODEC2_SAMPLE_RATE, codec2Encode } from './codec2';
import { enhanceNeuralNarrowband, neuralBweSupported, resetNeuralBwe } from './bwe';
import { enhanceNarrowband, type EnhancedPcm } from './enhance';
import { lyraDecode, lyraSupported, LYRA_SAMPLE_RATE } from './lyra';
import { mimiDecode, mimiEncode, MIMI_SAMPLE_RATE } from './mimi';
import {
  LYRA_MODE_3200,
  mimiDepth,
  MODE_BY_ID,
  WIRE_LYRA,
  WIRE_MIMI,
  type CodecModeId,
} from './chunk';
import { decimate2 } from './resample';
import type { Tier } from './layout';

/** How the highs in the played audio got there. 'lyra' / 'mimi' — the codec
 * carried them; 'neural' — the restoration model resynthesized them; 'dsp' — the
 * lightweight EQ + exciter fallback. */
export type Restoration = 'lyra' | 'mimi' | 'neural' | 'dsp';

export interface RestoredAudio {
  pcm: Int16Array;
  sampleRate: number;
  restoration: Restoration;
}

export type RestoreStatus = (message: string) => void;

/** A Lyra card whose mode id this build doesn't know — decoding it as 3.2 kbps
 * would play garbage. */
export class UnknownLyraModeError extends Error {}
/** This browser can't run Lyra (no SharedArrayBuffer / cross-origin isolation). */
export class LyraUnavailableError extends Error {}

/** Watchdog budget: a fixed allowance for loading and warming the wasm plus
 * time proportional to the clip. A 10s card gets 60s — several times the ~3s
 * a laptop needs and comfortably more than a slow phone, while still landing
 * on the DSP fallback rather than hanging when the worker is simply gone. */
function defaultTimeoutMs(seconds: number): number {
  return 20_000 + 4_000 * seconds;
}

/** Seam for tests: the neural path is a network + wasm worker, so the watchdog
 * behaviour is only testable if the pieces can be swapped out. */
export interface RestoreDeps {
  neural: typeof enhanceNeuralNarrowband;
  dsp: (pcm: Int16Array, sampleRate: number) => Promise<EnhancedPcm>;
  supported: () => boolean;
  reset: () => void;
  timeoutMs: (seconds: number) => number;
}

const REAL_DEPS: RestoreDeps = {
  neural: enhanceNeuralNarrowband,
  dsp: enhanceNarrowband,
  supported: neuralBweSupported,
  reset: resetNeuralBwe,
  timeoutMs: defaultTimeoutMs,
};

class NeuralTimeout extends Error {}

/** Restore a narrowband Codec 2 decode for playback: neural model if it can
 * run and finish in time, DSP polish otherwise. Never throws for a neural
 * failure — the whole point is that playback always happens. */
export async function restoreCodec2(
  decoded: Int16Array,
  sampleRate: number,
  seconds: number,
  onStatus?: RestoreStatus,
  deps: RestoreDeps = REAL_DEPS,
): Promise<RestoredAudio> {
  if (deps.supported()) {
    // Now that inference runs off the main thread (bwe.ts sets ort's proxy
    // flag), the page can actually paint — so show the clock. Silence during a
    // 30s restore on a phone is indistinguishable from a crash.
    let restoringSince = 0;
    // The watchdog is re-armed every time model bytes arrive: a slow but live
    // download (27 MB on a phone connection can take longer than the whole
    // budget) is not a wedged worker, and must not cost the neural voice.
    // Inference gets the full budget from the moment the download completes.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let rejectWatchdog: ((e: Error) => void) | undefined;
    const arm = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => rejectWatchdog?.(new NeuralTimeout()), deps.timeoutMs(seconds));
    };
    const onProgress = (loaded: number, total: number): void => {
      if (loaded < total) {
        restoringSince = 0;
        arm();
        onStatus?.(
          `Restoring the voice — fetching the model (${(loaded / 1048576).toFixed(1)} of ${Math.round(total / 1048576)} MB, one-time)…`,
        );
      } else if (!restoringSince) {
        restoringSince = Date.now();
        arm();
        onStatus?.('Restoring the voice with the neural model…');
      }
    };
    const ticker = setInterval(() => {
      if (!restoringSince) return;
      const elapsed = Math.round((Date.now() - restoringSince) / 1000);
      if (elapsed > 0) onStatus?.(`Restoring the voice with the neural model… ${elapsed}s`);
    }, 1000);
    try {
      const enhanced = await Promise.race([
        deps.neural(decoded, sampleRate, onProgress),
        new Promise<never>((_, reject) => {
          rejectWatchdog = reject;
          arm();
        }),
      ]);
      return { pcm: enhanced.pcm, sampleRate: enhanced.sampleRate, restoration: 'neural' };
    } catch (e) {
      // A wedged worker stays wedged; drop the memoized runtime so the next
      // card (or the next preview) gets a fresh one instead of the corpse.
      if (e instanceof NeuralTimeout) deps.reset();
      onStatus?.("Neural restoration didn't finish on this device — using the standard restoration…");
    } finally {
      clearTimeout(watchdog);
      clearInterval(ticker);
    }
  }
  const polished = await deps.dsp(decoded, sampleRate);
  return { pcm: polished.pcm, sampleRate: polished.sampleRate, restoration: 'dsp' };
}

/** Card bytes → the audio a scanner plays. The single source of truth for
 * "what does this card sound like", shared by the player and the generator's
 * tier preview. */
export async function decodeForPlayback(
  version: number,
  modeId: CodecModeId,
  data: Uint8Array,
  onStatus?: RestoreStatus,
): Promise<RestoredAudio> {
  if (version === WIRE_MIMI) {
    // Wideband (24 kHz) by construction — nothing to restore.
    onStatus?.('Rebuilding the voice…');
    const pcm = await mimiDecode(data, mimiDepth(modeId), (loaded, total) => {
      onStatus?.(
        loaded < total
          ? `Rebuilding the voice — fetching the model (${(loaded / 1048576).toFixed(1)} of ${Math.round(total / 1048576)} MB, one-time)…`
          : 'Rebuilding the voice…',
      );
    });
    return { pcm, sampleRate: MIMI_SAMPLE_RATE, restoration: 'mimi' };
  }
  if (version === WIRE_LYRA) {
    if (modeId !== LYRA_MODE_3200) throw new UnknownLyraModeError(`lyra mode ${modeId}`);
    if (!lyraSupported()) throw new LyraUnavailableError('lyra needs cross-origin isolation');
    const pcm = await lyraDecode(data);
    // Lyra is wideband by construction — nothing to restore.
    return { pcm, sampleRate: LYRA_SAMPLE_RATE, restoration: 'lyra' };
  }
  const decoded = await codec2Decode(MODE_BY_ID[modeId]!, data);
  return restoreCodec2(decoded, CODEC2_SAMPLE_RATE, decoded.length / CODEC2_SAMPLE_RATE, onStatus);
}

/** Generator side of the same contract: 16 kHz pipeline PCM → card bytes.
 * `depth` is the Mimi code stack the card has room for (layout.mimiDepthFor);
 * Codec 2 ignores it. */
export async function encodeForTier(tier: Tier, pcm16k: Int16Array, depth: number): Promise<Uint8Array> {
  return tier.codec === 'mimi'
    ? mimiEncode(pcm16k, depth)
    : codec2Encode(tier.mode, decimate2(pcm16k));
}

/** The wire mode id a card written by `encodeForTier` carries. */
export function modeIdForTier(tier: Tier, depth: number): CodecModeId {
  return tier.codec === 'mimi' ? depth - 1 : tier.modeId;
}

/** Encode a clip for a tier and immediately play it back through the player's
 * pipeline — i.e. hear the actual card. The encoded bytes come back too, since
 * they are exactly what the card plan needs and re-encoding is not free. */
export async function previewForTier(
  tier: Tier,
  pcm16k: Int16Array,
  depth: number,
  onStatus?: RestoreStatus,
): Promise<RestoredAudio & { bytes: Uint8Array }> {
  onStatus?.(tier.codec === 'mimi' ? 'Encoding (first time: fetching the voice model)…' : 'Encoding…');
  const bytes = await encodeForTier(tier, pcm16k, depth);
  const restored = await decodeForPlayback(tier.wireVersion, modeIdForTier(tier, depth), bytes, onStatus);
  return { ...restored, bytes };
}
