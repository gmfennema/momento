// Card FRONT rendering — the human-facing side. Where the back is a dense
// machine-readable QR mosaic, the front is the keepsake: the Momento brand
// mark, the clip's waveform as a mirrored bar chart, the owner's name line,
// and a nudge to flip the card over. Same pattern as render.ts: one geometry
// pass feeding both an SVG string (vector, print/laser) and a canvas drawer
// (preview + high-DPI PNG).

import { CARD_W_MM, CARD_H_MM } from './layout';

/** Bars across the waveform. Sized so bars stay chunky (≈0.65 mm) on a
 * standard card — thin hairlines disappear in print and engraving. */
export const FRONT_BAR_COUNT = 64;

/** Bars never collapse to nothing: silence renders as a dotted baseline. */
export const MIN_BAR = 0.045;

export interface FrontInput {
  /** normalized bar amplitudes, each in [MIN_BAR, 1] (see computeWaveformBars) */
  bars: number[];
  inverted: boolean;
  /** owner's name / caption, shown under the waveform */
  textLine?: string;
  /** clip length, shown next to the brand mark */
  durationSec?: number;
  widthMm?: number;
  heightMm?: number;
}

/**
 * Reduce PCM to `count` normalized bar heights. RMS per bar (smoother and
 * more "voice-shaped" than peaks), normalized to the loudest bar, with a
 * perceptual curve so quiet passages stay visible.
 */
export function computeWaveformBars(pcm: Int16Array, count: number): number[] {
  const flat = new Array<number>(count).fill(MIN_BAR);
  if (count <= 0 || pcm.length === 0) return flat;
  const per = pcm.length / count;
  const rms = new Array<number>(count);
  let loudest = 0;
  for (let i = 0; i < count; i++) {
    const a = Math.floor(i * per);
    const b = Math.min(pcm.length, Math.max(a + 1, Math.floor((i + 1) * per)));
    let sum = 0;
    for (let j = a; j < b; j++) {
      const v = pcm[j]! / 32768;
      sum += v * v;
    }
    rms[i] = Math.sqrt(sum / (b - a));
    if (rms[i]! > loudest) loudest = rms[i]!;
  }
  if (loudest === 0) return flat;
  return rms.map((r) => Math.max(MIN_BAR, Math.pow(r / loudest, 0.65)));
}

export interface FrontColors {
  bg: string;
  ink: string;
  accent: string;
  muted: string;
}

/** Brand palette in print-safe pairs: deep green on white stock, the bright
 * UI green on black stock (matches the app's --accent). */
function palette(inverted: boolean): FrontColors {
  return inverted
    ? { bg: '#0e1012', ink: '#f0f4f2', accent: '#5eeaa5', muted: '#8b959d' }
    : { bg: '#ffffff', ink: '#16181a', accent: '#2e8f63', muted: '#7d8790' };
}

interface TextSpec {
  xMm: number;
  yMm: number;
  fontMm: number;
  text: string;
}

export interface FrontLayout {
  widthMm: number;
  heightMm: number;
  colors: FrontColors;
  /** rounded bars: [x, y, w, h] in mm, corner radius w/2 */
  bars: Array<[number, number, number, number]>;
  baseline: { x1Mm: number; x2Mm: number; yMm: number; strokeMm: number };
  brandDot: { cxMm: number; cyMm: number; rMm: number };
  brandText: TextSpec;
  duration?: TextSpec;
  name?: TextSpec;
  hint: TextSpec & { letterSpacingMm: number };
}

export function layoutFront(input: FrontInput): FrontLayout {
  const W = input.widthMm ?? CARD_W_MM;
  const H = input.heightMm ?? CARD_H_MM;
  const margin = W * 0.079; // ≈7 mm on a standard card
  const innerW = W - 2 * margin;
  const name = input.textLine?.trim();

  // Waveform: mirrored bars about a center line. With a name line the wave
  // gives up a little height and rides higher.
  const waveCenterY = name ? H * 0.455 : H * 0.48;
  const halfMax = name ? H * 0.17 : H * 0.2;
  const pitch = innerW / Math.max(1, input.bars.length);
  const barW = pitch * 0.55;
  const bars: Array<[number, number, number, number]> = input.bars.map((v, i) => {
    const h = Math.max(barW, Math.min(1, v) * 2 * halfMax);
    return [margin + i * pitch + (pitch - barW) / 2, waveCenterY - h / 2, barW, h];
  });

  const brandFont = H * 0.068;
  const brandY = margin * 0.55 + brandFont / 2 + 1.2;
  const dotR = brandFont * 0.32;

  const nameBase = H * 0.075;
  // Long names shrink instead of overflowing (rough 0.58·em glyph width).
  const nameFont = name
    ? Math.min(nameBase, (innerW * 0.92) / (0.58 * Math.max(1, name.length)))
    : 0;

  return {
    widthMm: W,
    heightMm: H,
    colors: palette(input.inverted),
    bars,
    baseline: { x1Mm: margin, x2Mm: W - margin, yMm: waveCenterY, strokeMm: 0.12 },
    brandDot: { cxMm: margin + dotR, cyMm: brandY, rMm: dotR },
    brandText: {
      xMm: margin + dotR * 2 + brandFont * 0.35,
      yMm: brandY,
      fontMm: brandFont,
      text: 'Momento',
    },
    duration:
      input.durationSec !== undefined
        ? {
            xMm: W - margin,
            yMm: brandY,
            fontMm: brandFont * 0.72,
            text: `${input.durationSec.toFixed(1)}s`,
          }
        : undefined,
    name: name ? { xMm: W / 2, yMm: H * 0.78, fontMm: nameFont, text: name } : undefined,
    hint: {
      xMm: W / 2,
      yMm: H - margin * 0.62,
      fontMm: H * 0.042,
      letterSpacingMm: H * 0.042 * 0.28,
      text: 'SCAN THE BACK TO LISTEN',
    },
  };
}

const FONT_STACK = 'Helvetica, Arial, sans-serif';

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderFrontSvg(input: FrontInput): string {
  const L = layoutFront(input);
  const { colors: c } = L;
  const fmt = (n: number) => Number(n.toFixed(4));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.widthMm}mm" height="${L.heightMm}mm" ` +
      `viewBox="0 0 ${L.widthMm} ${L.heightMm}">`,
    `<rect width="${L.widthMm}" height="${L.heightMm}" fill="${c.bg}"/>`,
    `<line x1="${fmt(L.baseline.x1Mm)}" y1="${fmt(L.baseline.yMm)}" ` +
      `x2="${fmt(L.baseline.x2Mm)}" y2="${fmt(L.baseline.yMm)}" ` +
      `stroke="${c.muted}" stroke-width="${L.baseline.strokeMm}" opacity="0.35"/>`,
  );
  for (const [x, y, w, h] of L.bars) {
    parts.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
        `rx="${fmt(w / 2)}" fill="${c.accent}"/>`,
    );
  }
  parts.push(
    `<circle cx="${fmt(L.brandDot.cxMm)}" cy="${fmt(L.brandDot.cyMm)}" ` +
      `r="${fmt(L.brandDot.rMm)}" fill="${c.accent}"/>`,
    text(L.brandText, { fill: c.ink, weight: 700, anchor: 'start' }),
  );
  if (L.duration) parts.push(text(L.duration, { fill: c.muted, anchor: 'end' }));
  if (L.name) parts.push(text(L.name, { fill: c.ink, weight: 600, anchor: 'middle' }));
  parts.push(
    text(L.hint, {
      fill: c.muted,
      weight: 600,
      anchor: 'middle',
      letterSpacingMm: L.hint.letterSpacingMm,
    }),
  );
  parts.push('</svg>');
  return parts.join('\n');

  function text(
    t: TextSpec,
    opts: { fill: string; anchor: string; weight?: number; letterSpacingMm?: number },
  ): string {
    return (
      `<text x="${fmt(t.xMm)}" y="${fmt(t.yMm)}" font-family="${FONT_STACK}" ` +
      `font-size="${fmt(t.fontMm)}"` +
      (opts.weight ? ` font-weight="${opts.weight}"` : '') +
      (opts.letterSpacingMm ? ` letter-spacing="${fmt(opts.letterSpacingMm)}"` : '') +
      ` text-anchor="${opts.anchor}" dominant-baseline="middle" fill="${opts.fill}">` +
      `${escapeXml(t.text)}</text>`
    );
  }
}

/** Draw the card front at `pxPerMm` — used for the live preview and the
 * high-DPI PNG export, exactly like drawCard for the back. */
export function drawFront(
  ctx: CanvasRenderingContext2D,
  input: FrontInput,
  pxPerMm: number,
): void {
  const L = layoutFront(input);
  const { colors: c } = L;
  const px = (mm: number) => mm * pxPerMm;

  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, Math.round(px(L.widthMm)), Math.round(px(L.heightMm)));

  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = c.muted;
  ctx.lineWidth = Math.max(1, px(L.baseline.strokeMm));
  ctx.beginPath();
  ctx.moveTo(px(L.baseline.x1Mm), px(L.baseline.yMm));
  ctx.lineTo(px(L.baseline.x2Mm), px(L.baseline.yMm));
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = c.accent;
  ctx.beginPath();
  for (const [x, y, w, h] of L.bars) roundedRectPath(ctx, px(x), px(y), px(w), px(h), px(w) / 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(px(L.brandDot.cxMm), px(L.brandDot.cyMm), px(L.brandDot.rMm), 0, Math.PI * 2);
  ctx.fill();

  ctx.textBaseline = 'middle';
  ctx.fillStyle = c.ink;
  ctx.textAlign = 'left';
  ctx.font = `700 ${px(L.brandText.fontMm)}px ${FONT_STACK}`;
  ctx.fillText(L.brandText.text, px(L.brandText.xMm), px(L.brandText.yMm));

  if (L.duration) {
    ctx.fillStyle = c.muted;
    ctx.textAlign = 'right';
    ctx.font = `${px(L.duration.fontMm)}px ${FONT_STACK}`;
    ctx.fillText(L.duration.text, px(L.duration.xMm), px(L.duration.yMm));
  }
  if (L.name) {
    ctx.fillStyle = c.ink;
    ctx.textAlign = 'center';
    ctx.font = `600 ${px(L.name.fontMm)}px ${FONT_STACK}`;
    ctx.fillText(L.name.text, px(L.name.xMm), px(L.name.yMm), px(L.widthMm) * 0.92);
  }

  ctx.fillStyle = c.muted;
  ctx.textAlign = 'center';
  ctx.font = `600 ${px(L.hint.fontMm)}px ${FONT_STACK}`;
  // letterSpacing is a newer canvas property; browsers without it ignore the
  // assignment and the hint just renders a touch tighter.
  ctx.letterSpacing = `${px(L.hint.letterSpacingMm)}px`;
  ctx.fillText(L.hint.text, px(L.hint.xMm), px(L.hint.yMm));
  ctx.letterSpacing = '0px';
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
