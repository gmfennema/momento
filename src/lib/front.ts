// Card FRONT rendering — the human-facing side. Where the back is a dense
// machine-readable QR mosaic, the front is the keepsake: the owner's title
// across the top, the clip's waveform as a fine mirrored bar chart, and a
// metadata line (or a nudge to flip the card over). No brand mark. Strictly monochrome — one
// ink on one stock — so the same artwork prints, foils, or laser-engraves.
// Same pattern as render.ts: one geometry pass feeding both an SVG string
// (vector, print/laser) and a canvas drawer (preview + high-DPI PNG).

import { CARD_W_MM, CARD_H_MM } from './layout';

/** Bars across the waveform. Enough for a fine, engraved-line texture while
 * keeping each bar ≈0.4 mm — comfortably above what printers and laser
 * engravers hold. */
export const FRONT_BAR_COUNT = 72;

/** Bars never collapse to nothing: silence renders as a dotted baseline. */
export const MIN_BAR = 0.045;

export interface FrontInput {
  /** normalized bar amplitudes, each in [MIN_BAR, 1] (see computeWaveformBars) */
  bars: number[];
  /** the card's title (e.g. "For Mom"), shown across the top */
  textLine?: string;
  /** speaker/voice credit for the metadata line (e.g. "Emma") */
  voice?: string;
  /** date the clip was recorded, as 'YYYY-MM-DD'; rendered MM.DD.YY */
  recordedAt?: string;
  /** clip length in seconds; rendered as MM:SS */
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
}

/** One ink, one stock — always black marks on a white background. Laser
 * software engraves the dark areas, so this same artwork serves light and
 * dark stock alike: on a black card the engraved marks simply come out
 * light. (Unlike the QR back, the front has no scan polarity to preserve,
 * so it never inverts.) */
const PALETTE: FrontColors = { bg: '#ffffff', ink: '#000000' };

/** Secondary text (the metadata line) prints as a tone of the same ink. */
const SECONDARY_OPACITY = 0.55;
const BASELINE_OPACITY = 0.25;

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
  /** thin rounded frame inset from the card edge */
  border: { insetMm: number; radiusMm: number; strokeMm: number };
  /** the title across the top; absent when the card has none */
  name?: TextSpec;
  hint: TextSpec & { letterSpacingMm: number };
}

/** Letterspaced, middle-anchored text renders with a trailing space after the
 * last glyph; nudging the anchor by half a space re-centers it optically. */
function centeredX(widthMm: number, letterSpacingMm: number): number {
  return widthMm / 2 + letterSpacingMm / 2;
}

/** MM:SS, clamped so a sub-second clip still shows 00:00 rather than a sign. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → 'MM.DD.YY'; returns '' for anything that doesn't match so a
 * malformed date drops out of the metadata line instead of printing garbage. */
function formatRecorded(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return m ? `${m[2]}.${m[3]}.${m[1]!.slice(2)}` : '';
}

/** The bottom line: dot-separated, all-caps clip metadata (VOICE / RECORDED /
 * DURATION). Fields with no value are omitted; if nothing's known it falls
 * back to the flip-me nudge so the line is never blank. Single spaces around
 * the middot — SVG collapses runs of whitespace, so wider gaps wouldn't
 * survive export and would drift from the canvas preview. */
function metadataLine(input: FrontInput): string {
  const parts: string[] = [];
  const voice = input.voice?.trim();
  if (voice) parts.push(`VOICE: ${voice.toUpperCase()}`);
  const recorded = input.recordedAt ? formatRecorded(input.recordedAt) : '';
  if (recorded) parts.push(`RECORDED: ${recorded}`);
  if (input.durationSec !== undefined && input.durationSec > 0) {
    parts.push(`DURATION: ${formatDuration(input.durationSec)}`);
  }
  return parts.length ? parts.join(' · ') : 'SCAN THE BACK TO LISTEN';
}

export function layoutFront(input: FrontInput): FrontLayout {
  const W = input.widthMm ?? CARD_W_MM;
  const H = input.heightMm ?? CARD_H_MM;
  const margin = W * 0.09; // ≈8 mm on a standard card
  const innerW = W - 2 * margin;
  const name = input.textLine?.trim();

  // Waveform: fine mirrored bars about a hairline center rule. With a title
  // across the top the wave gives up a little height and rides lower.
  const waveCenterY = name ? H * 0.535 : H * 0.5;
  const halfMax = name ? H * 0.19 : H * 0.22;
  const pitch = innerW / Math.max(1, input.bars.length);
  const barW = pitch * 0.42;
  const bars: Array<[number, number, number, number]> = input.bars.map((v, i) => {
    const h = Math.max(barW, Math.min(1, v) * 2 * halfMax);
    return [margin + i * pitch + (pitch - barW) / 2, waveCenterY - h / 2, barW, h];
  });

  const nameBase = H * 0.076;
  // Long names shrink instead of overflowing (rough 0.52·em serif glyph width).
  const nameFont = name
    ? Math.min(nameBase, (innerW * 0.85) / (0.52 * Math.max(1, name.length)))
    : 0;

  const hintFont = H * 0.0325;
  // The metadata line is far denser than the old three-word nudge, so it
  // tracks tighter to stay within the margins even with a long voice credit.
  const hintLs = hintFont * 0.12;

  return {
    widthMm: W,
    heightMm: H,
    colors: PALETTE,
    bars,
    baseline: { x1Mm: margin, x2Mm: W - margin, yMm: waveCenterY, strokeMm: 0.1 },
    // A hairline frame, 3 mm in from the edge: inside the metal card's 3.18 mm
    // corner radius, and 0.2 mm wide so a laser or printer holds it cleanly.
    border: { insetMm: 3, radiusMm: 1.2, strokeMm: 0.2 },
    name: name ? { xMm: W / 2, yMm: H * 0.19, fontMm: nameFont, text: name } : undefined,
    hint: {
      xMm: centeredX(W, hintLs),
      yMm: H * 0.875,
      fontMm: hintFont,
      letterSpacingMm: hintLs,
      text: metadataLine(input),
    },
  };
}

/** Classic serif stack for the type; the waveform carries the modernity. */
const FONT_SERIF = "Georgia, 'Times New Roman', serif";

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
      `stroke="${c.ink}" stroke-width="${L.baseline.strokeMm}" opacity="${BASELINE_OPACITY}"/>`,
    `<rect x="${fmt(L.border.insetMm)}" y="${fmt(L.border.insetMm)}" ` +
      `width="${fmt(L.widthMm - 2 * L.border.insetMm)}" height="${fmt(L.heightMm - 2 * L.border.insetMm)}" ` +
      `rx="${fmt(L.border.radiusMm)}" fill="none" stroke="${c.ink}" stroke-width="${L.border.strokeMm}"/>`,
  );
  for (const [x, y, w, h] of L.bars) {
    parts.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
        `rx="${fmt(w / 2)}" fill="${c.ink}"/>`,
    );
  }
  if (L.name) parts.push(text(L.name, {}));
  parts.push(
    text(L.hint, { opacity: SECONDARY_OPACITY, letterSpacingMm: L.hint.letterSpacingMm }),
  );
  parts.push('</svg>');
  return parts.join('\n');

  function text(
    t: TextSpec,
    opts: { opacity?: number; letterSpacingMm?: number },
  ): string {
    return (
      `<text x="${fmt(t.xMm)}" y="${fmt(t.yMm)}" font-family="${FONT_SERIF}" ` +
      `font-size="${fmt(t.fontMm)}"` +
      (opts.letterSpacingMm ? ` letter-spacing="${fmt(opts.letterSpacingMm)}"` : '') +
      (opts.opacity !== undefined ? ` opacity="${opts.opacity}"` : '') +
      ` text-anchor="middle" dominant-baseline="middle" fill="${c.ink}">` +
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
  ctx.globalAlpha = BASELINE_OPACITY;
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = Math.max(1, px(L.baseline.strokeMm));
  ctx.beginPath();
  ctx.moveTo(px(L.baseline.x1Mm), px(L.baseline.yMm));
  ctx.lineTo(px(L.baseline.x2Mm), px(L.baseline.yMm));
  ctx.stroke();
  ctx.restore();

  const b = L.border;
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = Math.max(1, px(b.strokeMm));
  ctx.beginPath();
  roundedRectPath(
    ctx,
    px(b.insetMm),
    px(b.insetMm),
    px(L.widthMm - 2 * b.insetMm),
    px(L.heightMm - 2 * b.insetMm),
    px(b.radiusMm),
  );
  ctx.stroke();

  ctx.fillStyle = c.ink;
  ctx.beginPath();
  for (const [x, y, w, h] of L.bars) roundedRectPath(ctx, px(x), px(y), px(w), px(h), px(w) / 2);
  ctx.fill();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // letterSpacing is a newer canvas property; browsers without it ignore the
  // assignment and the letterspaced lines just render a touch tighter.
  ctx.save();
  ctx.globalAlpha = SECONDARY_OPACITY;
  ctx.font = `${px(L.hint.fontMm)}px ${FONT_SERIF}`;
  ctx.letterSpacing = `${px(L.hint.letterSpacingMm)}px`;
  ctx.fillText(L.hint.text, px(L.hint.xMm), px(L.hint.yMm));
  ctx.letterSpacing = '0px';
  ctx.restore();

  if (L.name) {
    ctx.font = `${px(L.name.fontMm)}px ${FONT_SERIF}`;
    ctx.fillText(L.name.text, px(L.name.xMm), px(L.name.yMm), px(L.widthMm) * 0.85);
  }
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
