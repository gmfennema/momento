import { describe, expect, it } from 'vitest';
import { CARD_H_MM, CARD_W_MM } from '../src/lib/layout';
import {
  computeWaveformBars,
  FRONT_BAR_COUNT,
  layoutFront,
  MIN_BAR,
  renderFrontSvg,
} from '../src/lib/front';

function tonePcm(seconds: number, hz = 220, sampleRate = 16000): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sampleRate;
    // amplitude envelope so bars vary: loud middle, quiet edges
    const env = Math.sin((Math.PI * i) / pcm.length);
    pcm[i] = Math.round(20000 * env * Math.sin(2 * Math.PI * hz * t));
  }
  return pcm;
}

describe('computeWaveformBars', () => {
  it('returns `count` bars, all within [MIN_BAR, 1], loudest at 1', () => {
    const bars = computeWaveformBars(tonePcm(5), FRONT_BAR_COUNT);
    expect(bars.length).toBe(FRONT_BAR_COUNT);
    for (const b of bars) {
      expect(b).toBeGreaterThanOrEqual(MIN_BAR);
      expect(b).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...bars)).toBeCloseTo(1, 5);
  });

  it('reflects the envelope: middle bars taller than edge bars', () => {
    const bars = computeWaveformBars(tonePcm(5), 32);
    expect(bars[16]!).toBeGreaterThan(bars[0]!);
    expect(bars[16]!).toBeGreaterThan(bars[31]!);
  });

  it('silence and empty input degrade to the floor, not NaN', () => {
    for (const pcm of [new Int16Array(16000), new Int16Array(0)]) {
      const bars = computeWaveformBars(pcm, 10);
      expect(bars.length).toBe(10);
      for (const b of bars) expect(b).toBe(MIN_BAR);
    }
  });

  it('handles more bars than samples', () => {
    const bars = computeWaveformBars(tonePcm(0.001), 64);
    expect(bars.length).toBe(64);
    for (const b of bars) expect(Number.isFinite(b)).toBe(true);
  });
});

describe('layoutFront', () => {
  const input = (over = {}) => ({
    bars: computeWaveformBars(tonePcm(5), FRONT_BAR_COUNT),
    inverted: false,
    textLine: 'Nana & Pop, 1987',
    ...over,
  });

  it('keeps every element inside the card', () => {
    const L = layoutFront(input());
    expect(L.widthMm).toBe(CARD_W_MM);
    expect(L.heightMm).toBe(CARD_H_MM);
    for (const [x, y, w, h] of L.bars) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(CARD_W_MM);
      expect(y + h).toBeLessThanOrEqual(CARD_H_MM);
    }
    expect(L.hint.yMm).toBeLessThan(CARD_H_MM);
    expect(L.name!.yMm).toBeGreaterThan(Math.max(...L.bars.map(([, y, , h]) => y + h)));
  });

  it('bars are mirrored around one center line', () => {
    const L = layoutFront(input());
    for (const [, y, , h] of L.bars) {
      expect(y + h / 2).toBeCloseTo(L.baseline.yMm, 6);
    }
  });

  it('omits the name when absent and recenters the wave', () => {
    const bare = layoutFront(input({ textLine: undefined }));
    expect(bare.name).toBeUndefined();
    expect(bare.baseline.yMm).toBeGreaterThan(layoutFront(input()).baseline.yMm);
  });

  it('shrinks long names instead of overflowing', () => {
    const short = layoutFront(input({ textLine: 'Jo' })).name!.fontMm;
    const long = layoutFront(input({ textLine: 'A'.repeat(40) })).name!.fontMm;
    expect(long).toBeLessThan(short);
    expect(0.52 * 40 * long).toBeLessThanOrEqual(CARD_W_MM);
  });

  it('is strictly monochrome, flipped by invert', () => {
    const light = layoutFront(input());
    const dark = layoutFront(input({ inverted: true }));
    expect(light.colors).toEqual({ bg: '#ffffff', ink: '#000000' });
    expect(dark.colors).toEqual({ bg: '#000000', ink: '#ffffff' });
  });
});

describe('renderFrontSvg', () => {
  const input = {
    bars: computeWaveformBars(tonePcm(5), FRONT_BAR_COUNT),
    inverted: false,
    textLine: 'Smith & Sons <est. 1987>',
  };

  it('emits a card-sized SVG with one rounded rect per bar', () => {
    const svg = renderFrontSvg(input);
    expect(svg).toContain(`width="${CARD_W_MM}mm"`);
    expect(svg).toContain(`height="${CARD_H_MM}mm"`);
    expect((svg.match(/<rect [^>]*rx=/g) ?? []).length).toBe(FRONT_BAR_COUNT);
    expect(svg).toContain('MOMENTO');
    expect(svg).toContain('letter-spacing');
    expect(svg).toContain('SCAN THE BACK TO LISTEN');
  });

  it('uses no color outside the two-tone ink/stock pair', () => {
    for (const inverted of [false, true]) {
      const svg = renderFrontSvg({ ...input, inverted });
      const colors = new Set(svg.match(/#[0-9a-f]{6}/gi)?.map((s) => s.toLowerCase()));
      expect(colors).toEqual(new Set(['#ffffff', '#000000']));
    }
  });

  it('escapes XML in the name line', () => {
    const svg = renderFrontSvg(input);
    expect(svg).not.toContain('<est.');
    expect(svg).toContain('Smith &#38; Sons &#60;est. 1987&#62;');
  });
});
