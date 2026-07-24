// Playback enhancement (presence EQ + bandwidth extension): the Web Audio
// render itself only exists in a real browser, so these tests cover the
// plumbing around it — int16↔float conversion, the 2× output rate, peak
// safety, and the fall-back-to-raw-decode paths — using a minimal fake
// OfflineAudioContext whose "render" is a filterless 2× upsample.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { enhanceNarrowband, limitPeak } from '../src/lib/enhance';

function makePcm(): Int16Array {
  const pcm = new Int16Array(160);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 12000);
  }
  return pcm;
}

interface FakeBuffer {
  getChannelData(c: number): Float32Array;
}

class FakeOfflineAudioContext {
  destination = {};
  private src: { buffer: FakeBuffer | null } | null = null;
  constructor(
    public channels: number,
    public length: number,
    public sampleRate: number,
  ) {}
  createBuffer(_channels: number, len: number, _rate: number): FakeBuffer {
    const data = new Float32Array(len);
    return { getChannelData: () => data };
  }
  createBufferSource(): {
    buffer: FakeBuffer | null;
    connect(n: unknown): unknown;
    start(): void;
  } {
    const node = {
      buffer: null as FakeBuffer | null,
      connect: (n: unknown) => n,
      start: () => {},
    };
    this.src = node;
    return node;
  }
  // Stand-in for the real render: no filtering, just the source resampled up
  // to the context rate (nearest-neighbor), so values round-trip exactly.
  async startRendering(): Promise<FakeBuffer> {
    const src = this.src!.buffer!.getChannelData(0);
    const out = new Float32Array(this.length);
    const step = src.length / this.length;
    for (let i = 0; i < out.length; i++) out[i] = src[Math.floor(i * step)]!;
    return { getChannelData: () => out };
  }
}

class FakeNode {
  constructor(_ctx: unknown, _opts: unknown) {}
  connect(n: unknown): unknown {
    return n;
  }
}

function stubWebAudio(): void {
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
  vi.stubGlobal('BiquadFilterNode', FakeNode);
  vi.stubGlobal('WaveShaperNode', FakeNode);
  vi.stubGlobal('GainNode', FakeNode);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enhanceNarrowband', () => {
  it('returns the raw decode at its own rate when Web Audio is unavailable (node)', async () => {
    const pcm = makePcm();
    const out = await enhanceNarrowband(pcm, 8000);
    expect(out.pcm).toBe(pcm);
    expect(out.sampleRate).toBe(8000);
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
    expect(out.pcm).toBe(pcm);
    expect(out.sampleRate).toBe(8000);
  });

  it('renders at twice the decode rate and round-trips samples within quantization error', async () => {
    stubWebAudio();
    const pcm = makePcm();
    const out = await enhanceNarrowband(pcm, 8000);
    expect(out.pcm).not.toBe(pcm);
    expect(out.sampleRate).toBe(16000);
    // Same duration at double the rate.
    expect(out.pcm.length).toBe(pcm.length * 2);
    // The fake render is a nearest-neighbor upsample, so every input sample
    // survives at its doubled position.
    for (let i = 0; i < pcm.length; i++) {
      expect(Math.abs(out.pcm[i * 2]! - pcm[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it('leaves empty clips alone', async () => {
    const pcm = new Int16Array(0);
    const out = await enhanceNarrowband(pcm, 8000);
    expect(out.pcm).toBe(pcm);
    expect(out.sampleRate).toBe(8000);
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
