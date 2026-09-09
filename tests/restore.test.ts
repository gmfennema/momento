import { describe, expect, it } from 'vitest';
import { restoreCodec2, type RestoreDeps } from '../src/lib/restore';

const CODEC2_RATE = 8000;

/** A decode of a 1s narrowband clip — content is irrelevant here, the
 * restoration functions are stubbed. */
function decoded(): Int16Array {
  return new Int16Array(CODEC2_RATE);
}

function deps(over: Partial<RestoreDeps>): RestoreDeps {
  return {
    neural: async (pcm, sampleRate) => ({ pcm, sampleRate: sampleRate * 6 }),
    dsp: async (pcm, sampleRate) => ({ pcm, sampleRate: sampleRate * 2 }),
    supported: () => true,
    reset: () => {},
    timeoutMs: () => 25,
    ...over,
  };
}

describe('restoreCodec2', () => {
  it('uses the neural restoration when it finishes in time', async () => {
    const out = await restoreCodec2(decoded(), CODEC2_RATE, 1, undefined, deps({}));
    expect(out.restoration).toBe('neural');
    expect(out.sampleRate).toBe(48000);
  });

  it('falls back to the DSP polish when the neural model never settles', async () => {
    // The failure this guards: a dead onnxruntime worker never rejects, so an
    // unbounded await leaves the player stuck on "Restoring the voice…".
    let resets = 0;
    const messages: string[] = [];
    const out = await restoreCodec2(
      decoded(),
      CODEC2_RATE,
      1,
      (m) => messages.push(m),
      deps({
        neural: () => new Promise(() => {}), // never settles, never rejects
        reset: () => {
          resets++;
        },
      }),
    );
    expect(out.restoration).toBe('dsp');
    expect(out.sampleRate).toBe(16000);
    // The wedged runtime must be dropped so the next card gets a fresh one.
    expect(resets).toBe(1);
    expect(messages.at(-1)).toContain('standard restoration');
  });

  it('keeps waiting while the model is still downloading, then completes', async () => {
    // A slow connection is not a dead worker: every progress report re-arms
    // the watchdog, so a 27 MB download that outlasts one budget still ends
    // in the neural voice as long as bytes keep arriving.
    let resets = 0;
    const out = await restoreCodec2(
      decoded(),
      CODEC2_RATE,
      1,
      undefined,
      deps({
        neural: async (pcm, sampleRate, onProgress) => {
          // Six progress reports 15 ms apart = 90 ms, well past the 25 ms budget.
          for (let i = 1; i <= 6; i++) {
            await new Promise((r) => setTimeout(r, 15));
            onProgress?.(i * 1000, 6000);
          }
          await new Promise((r) => setTimeout(r, 10));
          return { pcm, sampleRate: sampleRate * 6 };
        },
        reset: () => {
          resets++;
        },
      }),
    );
    expect(out.restoration).toBe('neural');
    expect(resets).toBe(0);
  });

  it('still times out when the download stalls', async () => {
    let resets = 0;
    const out = await restoreCodec2(
      decoded(),
      CODEC2_RATE,
      1,
      undefined,
      deps({
        neural: (_pcm, _rate, onProgress) => {
          onProgress?.(1000, 6000);
          return new Promise(() => {}); // bytes stop arriving, worker never answers
        },
        reset: () => {
          resets++;
        },
      }),
    );
    expect(out.restoration).toBe('dsp');
    expect(resets).toBe(1);
  });

  it('falls back when the neural path throws, without resetting the runtime', async () => {
    let resets = 0;
    const out = await restoreCodec2(
      decoded(),
      CODEC2_RATE,
      1,
      undefined,
      deps({
        neural: async () => {
          throw new Error('wasm failed to load');
        },
        reset: () => {
          resets++;
        },
      }),
    );
    expect(out.restoration).toBe('dsp');
    expect(resets).toBe(0);
  });

  it('goes straight to the DSP polish where the neural path cannot run', async () => {
    let neuralCalls = 0;
    const out = await restoreCodec2(
      decoded(),
      CODEC2_RATE,
      1,
      undefined,
      deps({
        supported: () => false,
        neural: async (pcm, sampleRate) => {
          neuralCalls++;
          return { pcm, sampleRate };
        },
      }),
    );
    expect(out.restoration).toBe('dsp');
    expect(neuralCalls).toBe(0);
  });
});
