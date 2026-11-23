// "What the scanner will play" — the one pipeline both the player and the
// generator's preview run, so the sound a maker previews is exactly what a
// scan plays. Two codecs, chosen by the card itself: Mimi for voices, Pulse
// for heartbeats. Never a fallback: if a card's codec can't run, decoding
// fails and the caller says so.

import { pulseDecode, pulseEncode, PULSE_SAMPLE_RATE } from './pulse';
import { mimiDecode, mimiEncode, MIMI_SAMPLE_RATE } from './mimi';
import { mimiDepth, WIRE_MIMI, WIRE_PULSE, type CodecModeId } from './chunk';
import type { Tier } from './layout';

/** Which codec rebuilt the audio. */
export type Restoration = 'mimi' | 'pulse';

export interface RestoredAudio {
  pcm: Int16Array;
  sampleRate: number;
  restoration: Restoration;
}

export type RestoreStatus = (message: string) => void;

/** A card in a format this build doesn't know (a future mode, or a retired
 * prototype codec). */
export class UnknownCardError extends Error {}

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
    onStatus?.('Extracting the voice…');
    const pcm = await mimiDecode(data, mimiDepth(modeId), (loaded, total) => {
      onStatus?.(
        loaded < total
          ? `Extracting the voice — first time on this phone (${(loaded / 1048576).toFixed(1)} of ${Math.round(total / 1048576)} MB)…`
          : 'Extracting the voice…',
      );
    });
    return { pcm, sampleRate: MIMI_SAMPLE_RATE, restoration: 'mimi' };
  }
  if (version === WIRE_PULSE) {
    if (modeId !== 0) throw new UnknownCardError(`pulse mode ${modeId}`);
    // Rebuilt from shaped noise — nothing to download.
    return { pcm: pulseDecode(data), sampleRate: PULSE_SAMPLE_RATE, restoration: 'pulse' };
  }
  throw new UnknownCardError(`wire version ${version}`);
}

/** Generator side of the same contract: 16 kHz pipeline PCM → card bytes.
 * `depth` is the Mimi code stack the card has room for (layout.mimiDepthFor);
 * Pulse ignores it. */
export async function encodeForTier(tier: Tier, pcm16k: Int16Array, depth: number): Promise<Uint8Array> {
  return tier.codec === 'mimi' ? mimiEncode(pcm16k, depth) : pulseEncode(pcm16k);
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
