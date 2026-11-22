import { describe, expect, it } from 'vitest';
import { CARD_H_MM, CARD_W_MM } from '../src/lib/layout';
import {
  computeWaveformBars,
  FRONT_BAR_COUNT,
  layoutFront,
  MIN_BAR,
  PHOTO_BAR_COUNT,
  renderFrontSvg,
} from '../src/lib/front';
import { toneGrey } from '../src/lib/photo';

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
    expect(L.hints[0]!.yMm).toBeLessThan(CARD_H_MM);
    // The title sits across the top, clear above the tallest bar.
    expect(L.name!.yMm + L.name!.fontMm / 2).toBeLessThan(Math.min(...L.bars.map(([, y]) => y)));
  });

  it('outlines the very edge of the card, following its corners', () => {
    const L = layoutFront(input({ voice: 'Emma', recordedAt: '2021-06-18', durationSec: 8 }));
    const { insetMm, strokeMm, radiusMm } = L.border;
    // The stroke's outer edge lands exactly on the card edge.
    expect(insetMm - strokeMm / 2).toBeCloseTo(0, 6);
    expect(strokeMm).toBeLessThanOrEqual(0.3);
    expect(radiusMm + strokeMm / 2).toBeCloseTo(3.18, 6);
    expect(layoutFront(input({ cornerMm: 0 })).border.radiusMm).toBe(0);
    const inner = insetMm + strokeMm / 2;
    for (const [x, y, w, h] of L.bars) {
      expect(x).toBeGreaterThan(inner);
      expect(y).toBeGreaterThan(inner);
      expect(x + w).toBeLessThan(L.widthMm - inner);
      expect(y + h).toBeLessThan(L.heightMm - inner);
    }
    expect(L.name!.yMm - L.name!.fontMm / 2).toBeGreaterThan(inner);
    expect(L.hints[0]!.yMm + L.hints[0]!.fontMm / 2).toBeLessThan(L.heightMm - inner - 1);
  });

  it('bars are mirrored around one center line', () => {
    const L = layoutFront(input());
    for (const [, y, , h] of L.bars) {
      expect(y + h / 2).toBeCloseTo(L.baseline.yMm, 6);
    }
  });

  it('omits the title when absent and recenters the wave', () => {
    const bare = layoutFront(input({ textLine: undefined }));
    expect(bare.name).toBeUndefined();
    expect(bare.baseline.yMm).toBeLessThan(layoutFront(input()).baseline.yMm);
  });

  it('shrinks long names instead of overflowing', () => {
    const short = layoutFront(input({ textLine: 'Jo' })).name!.fontMm;
    const long = layoutFront(input({ textLine: 'A'.repeat(40) })).name!.fontMm;
    expect(long).toBeLessThan(short);
    expect(0.52 * 40 * long).toBeLessThanOrEqual(CARD_W_MM);
  });

  it('is strictly monochrome — black ink on white stock', () => {
    // The front never inverts: laser software engraves the dark marks, so
    // the same artwork serves light and dark cards alike.
    const L = layoutFront(input());
    expect(L.colors).toEqual({ bg: '#ffffff', ink: '#000000' });
  });

  it('builds the metadata line: uppercase voice, MM.DD.YY date, MM:SS duration', () => {
    const L = layoutFront(input({ voice: 'Emma', recordedAt: '2021-06-18', durationSec: 8 }));
    expect(L.hints[0]!.text).toBe('VOICE: EMMA · RECORDED: 06.18.21 · DURATION: 00:08');
  });

  it('omits absent metadata fields', () => {
    expect(layoutFront(input({ durationSec: 75 })).hints[0]!.text).toBe('DURATION: 01:15');
    expect(layoutFront(input({ voice: 'Pop', durationSec: 8 })).hints[0]!.text).toBe(
      'VOICE: POP · DURATION: 00:08',
    );
  });

  it('drops a malformed recorded date instead of printing garbage', () => {
    expect(layoutFront(input({ recordedAt: 'nonsense', durationSec: 8 })).hints[0]!.text).toBe(
      'DURATION: 00:08',
    );
  });

  it('falls back to the flip nudge when no metadata is known', () => {
    expect(layoutFront(input()).hints[0]!.text).toBe('SCAN THE BACK TO LISTEN');
  });
});

describe('renderFrontSvg', () => {
  const input = {
    bars: computeWaveformBars(tonePcm(5), FRONT_BAR_COUNT),
    textLine: 'Smith & Sons <est. 1987>',
    voice: 'Emma',
    recordedAt: '2021-06-18',
    durationSec: 8,
  };

  it('emits a card-sized SVG with one rounded rect per bar', () => {
    const svg = renderFrontSvg(input);
    expect(svg).toContain(`width="${CARD_W_MM}mm"`);
    expect(svg).toContain(`height="${CARD_H_MM}mm"`);
    // one rounded rect per bar, plus the border
    expect((svg.match(/<rect [^>]*rx=/g) ?? []).length).toBe(FRONT_BAR_COUNT + 1);
    expect(svg).toMatch(/<rect [^>]*fill="none"[^>]*stroke-width="0.2"/);
    expect(svg).not.toContain('MOMENTO');
    expect(svg).toContain('letter-spacing');
    expect(svg).toContain('VOICE: EMMA · RECORDED: 06.18.21 · DURATION: 00:08');
  });

  it('uses no color outside the two-tone ink/stock pair', () => {
    const svg = renderFrontSvg(input);
    const colors = new Set(svg.match(/#[0-9a-f]{6}/gi)?.map((s) => s.toLowerCase()));
    expect(colors).toEqual(new Set(['#ffffff', '#000000']));
  });

  it('escapes XML in the name line', () => {
    const svg = renderFrontSvg(input);
    expect(svg).not.toContain('<est.');
    expect(svg).toContain('Smith &#38; Sons &#60;est. 1987&#62;');
  });
});

describe('photo design', () => {
  const photo = { image: {} as CanvasImageSource, href: 'data:image/png;base64,AA==', width: 1100, height: 1000 };
  const input = (over = {}) => ({
    design: 'photo' as const,
    photo,
    bars: computeWaveformBars(tonePcm(5), PHOTO_BAR_COUNT),
    textLine: 'Baby Fennema',
    recordedAt: '2026-11-20',
    durationSec: 9,
    ...over,
  });

  it('puts the photo on the left and everything else in the column beside it', () => {
    const L = layoutFront(input());
    const p = L.photo!;
    expect(p.xMm).toBeGreaterThan(3.18); // clear of the rounded corner
    expect(p.yMm + p.hMm).toBeLessThan(CARD_H_MM - 3);
    const colStart = p.xMm + p.wMm;
    for (const [x, y, w, h] of L.bars) {
      expect(x).toBeGreaterThan(colStart);
      expect(x + w).toBeLessThan(CARD_W_MM - 3);
      expect(y).toBeGreaterThan(0);
      expect(y + h).toBeLessThan(CARD_H_MM);
      expect(w).toBeGreaterThanOrEqual(0.38); // engravable bar width
    }
    expect(L.name!.xMm).toBeGreaterThan(colStart);
    expect(L.name!.yMm + L.name!.fontMm / 2).toBeLessThan(Math.min(...L.bars.map(([, y]) => y)));
  });

  it('stacks metadata one field per line, below the waveform', () => {
    const L = layoutFront(input());
    expect(L.hints.map((h) => h.text)).toEqual(['RECORDED: 11.20.26', 'DURATION: 00:09']);
    const lowestBar = Math.max(...L.bars.map(([, y, , h]) => y + h));
    expect(L.hints[0]!.yMm - L.hints[0]!.fontMm / 2).toBeGreaterThan(lowestBar);
    expect(L.hints[1]!.yMm).toBeGreaterThan(L.hints[0]!.yMm);
  });

  it('embeds the photo in the SVG, clipped to its frame', () => {
    const svg = renderFrontSvg(input());
    expect(svg).toContain('<clipPath id="photo-frame">');
    expect(svg).toContain(`href="${photo.href}"`);
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
  });

  it('draws an empty frame until a photo is chosen', () => {
    const L = layoutFront(input({ photo: undefined }));
    expect(L.photo).toBeDefined();
    expect(renderFrontSvg(input({ photo: undefined }))).not.toContain('<image');
  });
});

describe('toneGrey', () => {
  it('stretches murky greys to full range, and flips them for a negative', () => {
    const px = (v: number) => [v, v, v, 255];
    const make = () => new Uint8ClampedArray([...Array(50)].flatMap(() => px(60)).concat([...Array(50)].flatMap(() => px(180))));
    const pos = make();
    toneGrey(pos, false);
    expect(pos[0]).toBe(0);
    expect(pos[pos.length - 4]).toBe(255);
    const neg = make();
    toneGrey(neg, true);
    expect(neg[0]).toBe(255);
    expect(neg[neg.length - 4]).toBe(0);
  });
});
