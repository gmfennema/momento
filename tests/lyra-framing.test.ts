// The Lyra wasm itself needs a browser (threads) and is exercised by the
// Playwright suite; the pure framing/conversion helpers are tested here.
import { describe, expect, it } from 'vitest';
import {
  float32ToInt16,
  int16ToFloat32,
  LYRA_BYTES_PER_FRAME,
  LYRA_BYTES_PER_SEC,
  LYRA_FRAME_SAMPLES,
  LYRA_SAMPLE_RATE,
  padToLyraFrames,
} from '../src/lib/lyra';

describe('lyra framing', () => {
  it('constants are self-consistent (20ms frames at 3.2 kbps)', () => {
    expect(LYRA_FRAME_SAMPLES).toBe(LYRA_SAMPLE_RATE / 50);
    expect(LYRA_BYTES_PER_SEC).toBe(LYRA_BYTES_PER_FRAME * 50);
  });

  it('pads partial frames with silence, leaves whole frames alone', () => {
    const whole = new Int16Array(LYRA_FRAME_SAMPLES * 3);
    expect(padToLyraFrames(whole)).toBe(whole);

    const partial = new Int16Array(LYRA_FRAME_SAMPLES * 2 + 7).fill(123);
    const padded = padToLyraFrames(partial);
    expect(padded.length).toBe(LYRA_FRAME_SAMPLES * 3);
    expect(padded[LYRA_FRAME_SAMPLES * 2 + 6]).toBe(123);
    expect(padded[LYRA_FRAME_SAMPLES * 2 + 7]).toBe(0);
  });

  it('int16/float32 conversion round-trips within quantization error', () => {
    const pcm = new Int16Array([0, 1, -1, 1000, -1000, 32767, -32768]);
    const back = float32ToInt16(int16ToFloat32(pcm));
    for (let i = 0; i < pcm.length; i++) {
      expect(Math.abs(back[i]! - pcm[i]!)).toBeLessThanOrEqual(1);
    }
  });
});
