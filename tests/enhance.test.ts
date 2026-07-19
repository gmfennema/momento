// Playback presence EQ: the Web Audio render itself only exists in a real
// browser, so these tests cover the plumbing around it — int16↔float
// conversion, peak safety, and the fall-back-to-raw-decode paths — using a
// minimal fake OfflineAudioContext whose "render" is an identity pass.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { enhanceNarrowband, limitPeak } from '../src/lib/enhance';

function makePcm(): Int16Array {
  const pcm = new Int16Array(160);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 12000);
  }
  return pcm;
}

class FakeOfflineAudioContext {
  destination = {};
  private src: { buffer: { getChannelData(c: number): Float32Array } | null } | null = null;
  constructor(
    public channels: number,
    public length: number,
    public sampleRate: number,
  ) {}
  createBuffer(_channels: number, len: number): { getChannelData(c: number): Float32Array } {
    const data = new Float32Array(len);
    return { getChannelData: () => data };
  }
  createBufferSource(): {
    buffer: { getChannelData(c: number): Float32Array } | null;
    connect(n: unknown): unknown;
    start(): void;
  } {
    const node = {
      buffer: null as { getChannelData(c: number): Float32Array } | null,
      connect: (n: unknown) => n,
      start: () => {},
    };
    this.src = node;
    return node;
  }
  async startRendering(): Promise<{ getChannelData(c: number): Float32Array }> {
    return this.src!.buffer!;
  }
}

class FakeBiquadFilterNode {
  constructor(_ctx: unknown, _opts: unknown) {}
  connect(n: unknown): unknown {
    return n;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enhanceNarrowband', () => {
  it('returns the raw decode when Web Audio is unavailable (node)', async () => {
    const pcm = makePcm();
    const out = await enhanceNarrowband(pcm, 8000);
    expect(out).toBe(pcm);
  });

  it('returns the raw decode when the render throws (unsupported rate)', async () => {
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        constructor() {
          throw new Error('sample rate not supported');
        }
      },
    );
    const pcm = makePcm();
    const out = await enhanceNarrowband(pcm, 8000);
    expect(out).toBe(pcm);
  });

  it('round-trips samples through an identity render within quantization error', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    vi.stubGlobal('BiquadFilterNode', FakeBiquadFilterNode);
    const pcm = makePcm();
    const out = await enhanceNarrowband(pcm, 8000);
    expect(out).not.toBe(pcm);
    expect(out.length).toBe(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      expect(Math.abs(out[i]! - pcm[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it('leaves empty clips alone', async () => {
    const pcm = new Int16Array(0);
    expect(await enhanceNarrowband(pcm, 8000)).toBe(pcm);
  });
});

describe('limitPeak', () => {
  it('scales an over-ceiling clip down uniformly', () => {
    const f32 = new Float32Array([0.5, -2.0, 1.0]);
    limitPeak(f32, 0.985);
    expect(Math.max(...Array.from(f32, Math.abs))).toBeCloseTo(0.985, 5);
    // Relative shape preserved.
    expect(f32[0]! / f32[2]!).toBeCloseTo(0.5, 5);
    expect(f32[1]!).toBeLessThan(0);
  });

  it('leaves clips already under the ceiling untouched', () => {
    const f32 = new Float32Array([0.3, -0.9, 0.985]);
    const before = Array.from(f32);
    limitPeak(f32, 0.985);
    expect(Array.from(f32)).toEqual(before);
  });
});
