import { describe, expect, it } from 'vitest';
import { CARD_H_MM, CARD_W_MM } from '../src/lib/layout';
import {
  computeWaveformBars,
  designsFor,
  detectHeartbeat,
  FRONT_BAR_COUNT,
  FRONT_DESIGNS,
  layoutFront,
  metadataParts,
  MIN_BAR,
  MIN_STROKE_MM,
  monogram,
  renderFrontSvg,
  RING_BAR_COUNT,
  TRACE_BEATS,
  type FrontDesign,
  type FrontInput,
  type FrontLayout,
  type Mark,
  type TextMark,
} from '../src/lib/front';
import { toneGrey } from '../src/lib/photo';

function tonePcm(seconds: number, hz = 220, sampleRate = 16000): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < pcm.length; i++) {
    const env = Math.sin((Math.PI * i) / pcm.length);
    pcm[i] = Math.round(20000 * env * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  }
  return pcm;
}

/** Noise bursts at a given rate: 60% of each beat loud, the rest quiet. */
function doppler(seconds: number, bpm: number, sampleRate = 16000): Int16Array {
  const pcm = new Int16Array(seconds * sampleRate);
  const period = (60 / bpm) * sampleRate;
  let s = 7;
  for (let i = 0; i < pcm.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const loud = (i % period) / period < 0.6;
    pcm[i] = Math.round((s / 2 ** 32 - 0.5) * (loud ? 30000 : 1500));
  }
  return pcm;
}

const photo = { image: {} as CanvasImageSource, href: 'data:image/png;base64,AA==', width: 1100, height: 1000 };

function input(design: FrontDesign, over: Partial<FrontInput> = {}): FrontInput {
  const heart = FRONT_DESIGNS[design].kind === 'heartbeat';
  return {
    design,
    bars: computeWaveformBars(tonePcm(5), design === 'ring' ? RING_BAR_COUNT : FRONT_BAR_COUNT),
    textLine: heart ? 'Baby Grace' : 'For Mom',
    voice: heart ? undefined : 'Emma',
    recordedAt: '2026-11-20',
    photo: heart ? photo : undefined,
    heartbeat: heart ? { bpm: 152, beats: [1, 0.8, 0.9, 0.85] } : undefined,
    ...over,
  };
}

const ALL: FrontDesign[] = ['wave', 'ring', 'framed', 'heartline'];
const texts = (L: FrontLayout) => L.marks.filter((m): m is TextMark => m.kind === 'text');
const ofKind = <K extends Mark['kind']>(L: FrontLayout, k: K) => L.marks.filter((m) => m.kind === k) as Extract<Mark, { kind: K }>[];

/** Every point any mark covers, roughly — for "stays on the card" checks. */
function extents(L: FrontLayout): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (const m of L.marks) {
    if (m.kind === 'bars') for (const r of m.rects) out.push(r);
    if (m.kind === 'radial') {
      const r = m.r0Mm + Math.max(...m.bars.map(([, l]) => l));
      out.push([m.cxMm - r, m.cyMm - r, 2 * r, 2 * r]);
    }
    if (m.kind === 'line') {
      const xs = m.points.map(([x]) => x);
      const ys = m.points.map(([, y]) => y);
      out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]);
    }
    if (m.kind === 'text') {
      const x = m.align === 'middle' ? m.xMm - m.maxWidthMm / 2 : m.align === 'end' ? m.xMm - m.maxWidthMm : m.xMm;
      out.push([x, m.yMm - m.fontMm / 2, m.maxWidthMm, m.fontMm]);
    }
  }
  return out;
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

  it('reflects the envelope, and silence degrades to the floor', () => {
    const bars = computeWaveformBars(tonePcm(5), 32);
    expect(bars[16]!).toBeGreaterThan(bars[0]!);
    for (const b of computeWaveformBars(new Int16Array(16000), 10)) expect(b).toBe(MIN_BAR);
    for (const b of computeWaveformBars(tonePcm(0.001), 64)) expect(Number.isFinite(b)).toBe(true);
  });
});

describe('designs', () => {
  it('two for each kind of card', () => {
    expect(designsFor('voice')).toEqual(['wave', 'ring']);
    expect(designsFor('heartbeat')).toEqual(['framed', 'heartline']);
  });

  for (const d of ALL) {
    it(`${d}: every mark stays inside the card, clear of the edge outline`, () => {
      const L = layoutFront(input(d));
      expect(L.widthMm).toBe(CARD_W_MM);
      expect(L.heightMm).toBe(CARD_H_MM);
      const edge = L.border.insetMm + L.border.strokeMm;
      for (const [x, y, w, h] of extents(L)) {
        expect(x).toBeGreaterThan(edge);
        expect(y).toBeGreaterThan(edge);
        expect(x + w).toBeLessThan(L.widthMm - edge);
        expect(y + h).toBeLessThan(L.heightMm - edge);
      }
    });

    it(`${d}: nothing thinner than an engraver holds`, () => {
      const L = layoutFront(input(d));
      for (const m of L.marks) {
        if (m.kind === 'line' || m.kind === 'circle') expect(m.strokeMm).toBeGreaterThanOrEqual(MIN_STROKE_MM);
        if (m.kind === 'bars') for (const [, , w] of m.rects) expect(w).toBeGreaterThanOrEqual(0.38);
        if (m.kind === 'radial') expect(m.wMm).toBeGreaterThanOrEqual(0.4);
        if (m.kind === 'text' && m.role === 'caps') expect(m.fontMm).toBeGreaterThanOrEqual(1.2);
      }
    });

    it(`${d}: solid black on white — nothing grey for the laser to dither`, () => {
      const svg = renderFrontSvg(input(d));
      expect(svg).not.toMatch(/opacity=/);
      expect(layoutFront(input(d)).colors).toEqual({ bg: '#ffffff', ink: '#000000' });
    });

    it(`${d}: text never overlaps another text`, () => {
      const t = texts(layoutFront(input(d)));
      for (let i = 0; i < t.length; i++) {
        for (let j = i + 1; j < t.length; j++) {
          const a = t[i]!;
          const b = t[j]!;
          const gap = Math.abs(a.yMm - b.yMm) - (a.fontMm + b.fontMm) / 2;
          // Horizontal extent from the text's own estimated width.
          const span = (t: TextMark): [number, number] => {
            const w = Math.min(t.maxWidthMm, t.text.length * t.fontMm * (t.role === 'caps' ? 0.66 : 0.5));
            const x0 = t.align === 'middle' ? t.xMm - w / 2 : t.align === 'end' ? t.xMm - w : t.xMm;
            return [x0, x0 + w];
          };
          const [a0, a1] = span(a);
          const [b0, b1] = span(b);
          if (a0 < b1 && b0 < a1) expect(gap).toBeGreaterThan(-0.05);
        }
      }
    });
  }

  it('outline traces the very edge of the card, following its corners', () => {
    const L = layoutFront(input('wave'));
    expect(L.border.insetMm - L.border.strokeMm / 2).toBeCloseTo(0, 6);
    expect(L.border.radiusMm + L.border.strokeMm / 2).toBeCloseTo(3.18, 6);
    expect(layoutFront(input('wave', { cornerMm: 0 })).border.radiusMm).toBe(0);
  });

  it('long titles shrink instead of overflowing', () => {
    for (const d of ALL) {
      const title = (t: string) => texts(layoutFront(input(d, { textLine: t }))).find((m) => m.text === t)!;
      const short = title('Jo');
      const long = title('A'.repeat(40));
      expect(long.fontMm).toBeLessThan(short.fontMm);
      expect(40 * long.fontMm * 0.5).toBeLessThanOrEqual(long.maxWidthMm + 0.01);
    }
  });
});

describe('wave', () => {
  it('builds the metadata line: uppercase voice, MM.DD.YY date, MM:SS duration', () => {
    const t = texts(layoutFront(input('wave', { recordedAt: '2021-06-18' })));
    expect(t.at(-1)!.text).toBe('VOICE: EMMA · RECORDED: 06.18.21');
  });

  it('omits absent fields, drops a malformed date, and nudges when nothing is known', () => {
    const line = (o: Partial<FrontInput>) => texts(layoutFront(input('wave', o))).at(-1)!.text;
    expect(line({ recordedAt: undefined })).toBe('VOICE: EMMA');
    expect(line({ recordedAt: 'nonsense' })).toBe('VOICE: EMMA');
    expect(line({ voice: undefined, recordedAt: undefined })).toBe('SCAN THE BACK TO LISTEN');
  });

  it('bars are mirrored around one centre line', () => {
    const [bars] = ofKind(layoutFront(input('wave')), 'bars');
    const mid = bars!.rects[0]![1] + bars!.rects[0]![3] / 2;
    for (const [, y, , h] of bars!.rects) expect(y + h / 2).toBeCloseTo(mid, 6);
  });
});

describe('ring', () => {
  it('wraps the clip once around a circle, starting at the top', () => {
    const [r] = ofKind(layoutFront(input('ring')), 'radial');
    expect(r!.bars.length).toBe(RING_BAR_COUNT);
    expect(r!.bars[0]![0]).toBe(0);
    expect(r!.bars.at(-1)![0]).toBeLessThan(2 * Math.PI);
    // Silence keeps a stub, so the ring reads as one shape.
    expect(Math.min(...r!.bars.map(([, l]) => l))).toBeGreaterThan(0.5);
  });

  it('puts an initial in the middle: the voice, else the title', () => {
    expect(monogram({ bars: [], voice: 'emma' })).toBe('E');
    expect(monogram({ bars: [], textLine: 'For Mom' })).toBe('M');
    expect(monogram({ bars: [], textLine: 'To my Nana' })).toBe('N');
    expect(monogram({ bars: [] })).toBe('');
    const L = layoutFront(input('ring'));
    const [r] = ofKind(L, 'radial');
    const initial = texts(L).find((t) => t.text === 'E')!;
    expect(initial.xMm).toBeCloseTo(r!.cxMm, 6);
  });

  it('stacks the details one per line to the right of the ring', () => {
    const L = layoutFront(input('ring'));
    const [r] = ofKind(L, 'radial');
    const right = r!.cxMm + r!.r0Mm + Math.max(...r!.bars.map(([, l]) => l));
    const details = texts(L).filter((t) => t.role === 'caps');
    expect(details.map((t) => t.text)).toEqual(['VOICE: EMMA', 'RECORDED: 11.20.26']);
    for (const t of details) expect(t.xMm).toBeGreaterThan(right);
  });
});

describe('heartbeat designs', () => {
  it('framed: the photo in a frame on the left, everything else beside it', () => {
    const L = layoutFront(input('framed'));
    const [p] = ofKind(L, 'photo');
    expect(p!.clipToCard).toBe(false);
    expect(p!.outlineMm).toBeGreaterThanOrEqual(MIN_STROKE_MM);
    for (const t of texts(L)) expect(t.xMm - t.maxWidthMm / 2).toBeGreaterThan(p!.xMm + p!.wMm - 0.5);
    expect(texts(L).map((t) => t.text)).toContain('HEART RATE: 152 BPM');
  });

  it('heartline: the photo bleeds off the right edge and fades in from the left', () => {
    const L = layoutFront(input('heartline'));
    const [p] = ofKind(L, 'photo');
    expect(p!.clipToCard).toBe(true);
    expect(p!.xMm + p!.wMm).toBeCloseTo(CARD_W_MM, 6);
    expect(p!.fadeMm).toBeGreaterThan(p!.wMm * 0.25);
    expect(texts(L).map((t) => t.text)).toContain('152 BPM');
    const svg = renderFrontSvg(input('heartline'));
    expect(svg).toContain('<mask');
    expect(svg).toContain(`href="${photo.href}"`);
  });

  it('draws a placeholder frame until there is a scan, never an image', () => {
    for (const d of ['framed', 'heartline'] as const) {
      const L = layoutFront(input(d, { photo: undefined }));
      expect(ofKind(L, 'placeholder').length).toBe(1);
      expect(renderFrontSvg(input(d, { photo: undefined }))).not.toContain('<image');
    }
  });

  it('no card shows the clip length', () => {
    for (const d of ALL) expect(texts(layoutFront(input(d))).map((t) => t.text).join()).not.toMatch(/DURATION|\d\d:\d\d/);
  });

  it('a voice field never shows on a heartbeat card', () => {
    expect(metadataParts(input('framed', { voice: 'Emma' })).join()).not.toContain('VOICE');
  });

  it('without a detected beat the trace still draws, with no rate', () => {
    const L = layoutFront(input('framed', { heartbeat: undefined }));
    expect(ofKind(L, 'line').length).toBe(1);
    expect(texts(L).map((t) => t.text).join()).not.toContain('BPM');
  });
});

describe('detectHeartbeat', () => {
  it('finds the heart rate of a doppler-like clip', () => {
    for (const bpm of [110, 140, 155, 180]) {
      const hb = detectHeartbeat(doppler(6, bpm), 16000)!;
      expect(hb).not.toBeNull();
      expect(Math.abs(hb.bpm - bpm)).toBeLessThanOrEqual(3);
      expect(hb.beats.length).toBe(TRACE_BEATS);
      expect(Math.max(...hb.beats)).toBeCloseTo(1, 6);
    }
  });

  it('finds no heartbeat in a voice-like tone or a short clip', () => {
    expect(detectHeartbeat(tonePcm(5), 16000)).toBeNull();
    expect(detectHeartbeat(doppler(1, 150), 16000)).toBeNull();
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
