// Card FRONT rendering — the human-facing side. Where the back is a dense
// machine-readable QR mosaic, the front is the keepsake. It comes in designs:
//   wave  — the owner's title across the top, the clip's waveform as a fine
//           mirrored bar chart, and a metadata line (or a flip-me nudge).
//   photo — a photo (an ultrasound, say) down the left, with the title, the
//           waveform (a heartbeat) and the metadata stacked beside it.
// No brand mark. Strictly monochrome — one
// ink on one stock — so the same artwork prints, foils, or laser-engraves.
// Same pattern as render.ts: one geometry pass feeding both an SVG string
// (vector, print/laser) and a canvas drawer (preview + high-DPI PNG).

import { CARD_SIZES, CARD_W_MM, CARD_H_MM, DEFAULT_CARD_SIZE } from './layout';

/** Bars across the waveform. Enough for a fine, engraved-line texture while
 * keeping each bar ≈0.4 mm — comfortably above what printers and laser
 * engravers hold. */
export const FRONT_BAR_COUNT = 72;

/** Bars never collapse to nothing: silence renders as a dotted baseline. */
export const MIN_BAR = 0.045;

export type FrontDesign = 'wave' | 'photo';

export const FRONT_DESIGNS: Record<FrontDesign, string> = {
  wave: 'Waveform',
  photo: 'Photo + heartbeat',
};

/** Bars in the photo design's narrower waveform column. */
export const PHOTO_BAR_COUNT = 30;

/** A photo ready to place: the same pixels as a canvas source (preview, PNG)
 * and a data URL (embedded in the SVG). Already greyscale and levelled. */
export interface FrontPhoto {
  image: CanvasImageSource;
  href: string;
  width: number;
  height: number;
}

export interface FrontInput {
  /** which front design to draw (default: wave) */
  design?: FrontDesign;
  /** photo design only; the frame shows an empty placeholder without one */
  photo?: FrontPhoto;
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
  /** the blank's corner radius; the border follows it (default: metal card) */
  cornerMm?: number;
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
/** Width of the outline around the card's edge. */
const BORDER_MM = 0.2;
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
  /** thin outline tracing the card's own edge and corners */
  border: { insetMm: number; radiusMm: number; strokeMm: number };
  /** the title; absent when the card has none */
  name?: TextSpec;
  /** the metadata — one line on the wave design, stacked on the photo design */
  hints: Array<TextSpec & { letterSpacingMm: number }>;
  /** photo design: where the photo sits (cover-cropped into this frame) */
  photo?: { xMm: number; yMm: number; wMm: number; hMm: number; radiusMm: number; strokeMm: number };
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
  const parts = metadataParts(input);
  return parts.length ? parts.join(' · ') : 'SCAN THE BACK TO LISTEN';
}

function metadataParts(input: FrontInput): string[] {
  const parts: string[] = [];
  const voice = input.voice?.trim();
  if (voice) parts.push(`VOICE: ${voice.toUpperCase()}`);
  const recorded = input.recordedAt ? formatRecorded(input.recordedAt) : '';
  if (recorded) parts.push(`RECORDED: ${recorded}`);
  if (input.durationSec !== undefined && input.durationSec > 0) {
    parts.push(`DURATION: ${formatDuration(input.durationSec)}`);
  }
  return parts;
}

function borderFor(input: FrontInput): FrontLayout['border'] {
  // A 0.2 mm outline on the very edge of the card, following the blank's
  // corner radius. The stroke sits just inside the artboard so none of it is
  // clipped off in the SVG or PNG.
  return {
    insetMm: BORDER_MM / 2,
    radiusMm: Math.max(0, (input.cornerMm ?? CARD_SIZES[DEFAULT_CARD_SIZE].cornerMm) - BORDER_MM / 2),
    strokeMm: BORDER_MM,
  };
}

export function layoutFront(input: FrontInput): FrontLayout {
  return input.design === 'photo' ? layoutPhotoFront(input) : layoutWaveFront(input);
}

/** Photo design: the photo fills a rounded frame down the left; the right
 * column stacks the title, the waveform and the metadata, each centred in it.
 * The bars stay ≥0.4 mm wide, so the column carries fewer of them. */
function layoutPhotoFront(input: FrontInput): FrontLayout {
  const W = input.widthMm ?? CARD_W_MM;
  const H = input.heightMm ?? CARD_H_MM;
  const margin = H * 0.1; // ≈5.4 mm: clear of the blank's rounded corners
  const frameH = H - 2 * margin;
  const aspect = input.photo ? input.photo.width / input.photo.height : 1;
  // Follow the photo's shape within reason; a panorama is cropped, not
  // allowed to crowd the column out.
  const frameW = Math.min(W * 0.5, frameH * Math.min(1.2, Math.max(0.8, aspect)));
  const gap = W * 0.05;
  const colX1 = margin + frameW + gap;
  const colX2 = W - margin * 0.9;
  const colW = colX2 - colX1;
  const colMid = (colX1 + colX2) / 2;
  const name = input.textLine?.trim();

  const waveCenterY = name ? H * 0.5 : H * 0.42;
  const halfMax = H * 0.14;
  const count = Math.max(1, input.bars.length);
  const pitch = colW / count;
  const barW = pitch * 0.45;
  const bars: Array<[number, number, number, number]> = input.bars.map((v, i) => {
    const h = Math.max(barW, Math.min(1, v) * 2 * halfMax);
    return [colX1 + i * pitch + (pitch - barW) / 2, waveCenterY - h / 2, barW, h];
  });

  const nameBase = H * 0.07;
  const nameFont = name
    ? Math.min(nameBase, (colW * 0.95) / (0.52 * Math.max(1, name.length)))
    : 0;

  // Metadata stacks one field per line at the foot of the column; a field too
  // long for the column shrinks (≈0.62 em per caps glyph plus tracking).
  const parts = metadataParts(input);
  const lines = parts.length ? parts : ['SCAN THE BACK', 'TO LISTEN'];
  const longest = Math.max(...lines.map((l) => l.length));
  const hintFont = Math.min(H * 0.03, colW / (longest * 0.74));
  const hintLs = hintFont * 0.12;
  const lineGap = hintFont * 1.75;
  const lastY = H - margin - hintFont * 0.5;

  return {
    widthMm: W,
    heightMm: H,
    colors: PALETTE,
    bars,
    baseline: { x1Mm: colX1, x2Mm: colX2, yMm: waveCenterY, strokeMm: 0.1 },
    border: borderFor(input),
    name: name ? { xMm: colMid, yMm: margin + H * 0.06, fontMm: nameFont, text: name } : undefined,
    hints: lines.map((text, i) => ({
      xMm: colMid + hintLs / 2,
      yMm: lastY - (lines.length - 1 - i) * lineGap,
      fontMm: hintFont,
      letterSpacingMm: hintLs,
      text,
    })),
    photo: { xMm: margin, yMm: margin, wMm: frameW, hMm: frameH, radiusMm: 1.6, strokeMm: BORDER_MM },
  };
}

function layoutWaveFront(input: FrontInput): FrontLayout {
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
    border: borderFor(input),
    name: name ? { xMm: W / 2, yMm: H * 0.19, fontMm: nameFont, text: name } : undefined,
    hints: [
      {
        xMm: centeredX(W, hintLs),
        yMm: H * 0.898,
        fontMm: hintFont,
        letterSpacingMm: hintLs,
        text: metadataLine(input),
      },
    ],
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
  if (L.photo) {
    const p = L.photo;
    const box = `x="${fmt(p.xMm)}" y="${fmt(p.yMm)}" width="${fmt(p.wMm)}" height="${fmt(p.hMm)}" rx="${fmt(p.radiusMm)}"`;
    if (input.photo) {
      // xMidYMid slice is the same centred cover-crop the canvas draws.
      parts.push(
        `<clipPath id="photo-frame"><rect ${box}/></clipPath>`,
        `<image href="${input.photo.href}" x="${fmt(p.xMm)}" y="${fmt(p.yMm)}" ` +
          `width="${fmt(p.wMm)}" height="${fmt(p.hMm)}" preserveAspectRatio="xMidYMid slice" ` +
          `clip-path="url(#photo-frame)"/>`,
      );
    }
    parts.push(`<rect ${box} fill="none" stroke="${c.ink}" stroke-width="${p.strokeMm}"/>`);
  }
  for (const [x, y, w, h] of L.bars) {
    parts.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
        `rx="${fmt(w / 2)}" fill="${c.ink}"/>`,
    );
  }
  if (L.name) parts.push(text(L.name, {}));
  for (const h of L.hints) {
    parts.push(text(h, { opacity: SECONDARY_OPACITY, letterSpacingMm: h.letterSpacingMm }));
  }
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

  if (L.photo) {
    const p = L.photo;
    const frame = () => {
      ctx.beginPath();
      roundedRectPath(ctx, px(p.xMm), px(p.yMm), px(p.wMm), px(p.hMm), px(p.radiusMm));
    };
    if (input.photo) {
      // Centred cover-crop: the photo fills the frame, the overflow is cut.
      const ph = input.photo;
      const scale = Math.max(p.wMm / ph.width, p.hMm / ph.height);
      const sw = p.wMm / scale;
      const sh = p.hMm / scale;
      ctx.save();
      frame();
      ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        ph.image,
        (ph.width - sw) / 2,
        (ph.height - sh) / 2,
        sw,
        sh,
        px(p.xMm),
        px(p.yMm),
        px(p.wMm),
        px(p.hMm),
      );
      ctx.restore();
    }
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = Math.max(1, px(p.strokeMm));
    frame();
    ctx.stroke();
  }

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
  for (const h of L.hints) {
    ctx.font = `${px(h.fontMm)}px ${FONT_SERIF}`;
    ctx.letterSpacing = `${px(h.letterSpacingMm)}px`;
    ctx.fillText(h.text, px(h.xMm), px(h.yMm));
  }
  ctx.letterSpacing = '0px';
  ctx.restore();

  if (L.name) {
    ctx.font = `${px(L.name.fontMm)}px ${FONT_SERIF}`;
    const maxW = L.photo ? L.widthMm - L.photo.xMm - L.photo.wMm - 2 * L.photo.xMm : L.widthMm * 0.85;
    ctx.fillText(L.name.text, px(L.name.xMm), px(L.name.yMm), px(maxW));
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
