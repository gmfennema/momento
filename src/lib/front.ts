// Card FRONT rendering — the human-facing side, the keepsake. Four designs,
// two for each kind of card:
//
//   voice      wave       title over a fine mirrored waveform, one metadata line
//              ring       the waveform as a ring around a monogram, details beside it
//   heartbeat  framed     the ultrasound photo in a frame, heart-monitor trace beside it
//              heartline  the photo fading in from the right edge, title and trace on the left
//
// Strictly monochrome: solid black marks on white, nothing grey (laser software
// would dither grey into fuzz). Laser software engraves the dark marks, so on a
// black card they come out light. The one exception to "same artwork on any
// stock" is a photo: on a black card it must be engraved as a negative to read
// true, so the caller hands in a photo already toned for its stock.
//
// Every design is laid out once into a list of primitive marks (FrontLayout),
// which both the SVG writer and the canvas drawer render — so the preview, the
// PNG and the SVG can never disagree.

import { CARD_SIZES, CARD_W_MM, CARD_H_MM, DEFAULT_CARD_SIZE } from './layout';

export type FrontKind = 'voice' | 'heartbeat';
export type FrontDesign = 'wave' | 'ring' | 'framed' | 'heartline';

export const FRONT_DESIGNS: Record<FrontDesign, { kind: FrontKind; label: string; blurb: string }> = {
  wave: { kind: 'voice', label: 'Classic wave', blurb: 'The waveform under the title, details in one line.' },
  ring: { kind: 'voice', label: 'Ring', blurb: 'The waveform as a ring around an initial.' },
  framed: { kind: 'heartbeat', label: 'Framed', blurb: 'The scan in a frame beside a heart-monitor line.' },
  heartline: { kind: 'heartbeat', label: 'Heartline', blurb: 'The scan fades in from the edge of the card.' },
};

export function designsFor(kind: FrontKind): FrontDesign[] {
  return (Object.keys(FRONT_DESIGNS) as FrontDesign[]).filter((d) => FRONT_DESIGNS[d].kind === kind);
}

/** Bars across the classic waveform: each ≈0.4 mm, above what engravers hold. */
export const FRONT_BAR_COUNT = 72;
/** Bars around the ring. */
export const RING_BAR_COUNT = 64;
/** Bars never collapse to nothing: silence renders as a dotted baseline. */
export const MIN_BAR = 0.045;

/** A photo ready to place: the same pixels as a canvas source (preview, PNG)
 * and a data URL (embedded in the SVG). Already greyscale, levelled, and a
 * negative when the card is black. */
export interface FrontPhoto {
  image: CanvasImageSource;
  href: string;
  width: number;
  height: number;
}

export interface Heartbeat {
  bpm: number;
  /** relative loudness of the first few beats, each in (0, 1] */
  beats: number[];
}

export interface FrontInput {
  /** which design to draw (default: wave) */
  design?: FrontDesign;
  /** normalized bar amplitudes in [MIN_BAR, 1] (see computeWaveformBars);
   * the ring wants RING_BAR_COUNT of them, the classic wave FRONT_BAR_COUNT */
  bars: number[];
  /** heartbeat designs: the photo; a placeholder frame shows without one */
  photo?: FrontPhoto;
  /** heartbeat designs: detected beat (see detectHeartbeat); without one the
   * card shows no rate */
  heartbeat?: Heartbeat;
  /** heartbeat designs: the recording's own sound wave (see computeHeartWave);
   * without one a sample wave stands in */
  heartWave?: HeartWave;
  /** the card's title (e.g. "For Mom") */
  textLine?: string;
  /** speaker credit (voice designs), e.g. "Emma" */
  voice?: string;
  /** date recorded, 'YYYY-MM-DD'; rendered MM.DD.YY */
  recordedAt?: string;
  /** heartbeat designs: the due date, free text as typed ("June 2027",
   * "2027-06-14", "6/14/27"); a recognisable date renders MM.DD.YY, anything
   * else uppercase as typed. Replaces the recording date on these designs. */
  dueDate?: string;
  widthMm?: number;
  heightMm?: number;
  /** the blank's corner radius; the border follows it (default: metal card) */
  cornerMm?: number;
}

// --- audio → marks ---

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

/** Most beats any trace draws. */
export const TRACE_BEATS = 4;

/**
 * Find a steady heartbeat in a clip: the loudness envelope (10 ms frames) of a
 * doppler recording repeats once per beat, so its autocorrelation peaks at the
 * beat period. Accepts 90–200 bpm (fetal rates run ~110–170, adults lower)
 * and only a clear peak; anything else — a voice — returns null.
 */
export function detectHeartbeat(pcm: Int16Array, sampleRate: number): Heartbeat | null {
  const hop = Math.round(sampleRate / 100);
  const n = Math.floor(pcm.length / hop);
  if (n < 200) return null; // under 2 s: too few beats to trust
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) sum += (pcm[j]! / 32768) ** 2;
    env[i] = Math.sqrt(sum / hop);
  }
  const mean = env.reduce((a, v) => a + v, 0) / n;
  const e = env.map((v) => v - mean);
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += e[i]! * e[i + lag]!;
    return s;
  };
  const zero = ac(0);
  if (zero <= 0) return null;
  const minLag = Math.floor(6000 / 200);
  const maxLag = Math.ceil(6000 / 90);
  const r: number[] = [];
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) r[lag] = ac(lag) / zero;
  let best = 0;
  let bestR = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag]! > bestR && r[lag]! >= r[lag - 1]! && r[lag]! >= r[lag + 1]!) {
      bestR = r[lag]!;
      best = lag;
    }
  }
  if (!best || bestR < 0.35) return null;
  const [a, b, c] = [r[best - 1]!, r[best]!, r[best + 1]!];
  const shift = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
  const period = best + shift;
  const beats: number[] = [];
  for (let k = 0; k < TRACE_BEATS && (k + 1) * period <= n; k++) {
    let peak = 0;
    for (let i = Math.round(k * period); i < Math.round((k + 1) * period); i++) peak = Math.max(peak, env[i]!);
    beats.push(peak);
  }
  const top = Math.max(...beats);
  return { bpm: Math.round(6000 / period), beats: beats.map((v) => (top > 0 ? v / top : 1)) };
}

/** The heartbeat as engraved: the recording's actual sound wave over a few
 * beats, as [min, max] per column in [−1, 1]. Not an illustration — the
 * doppler's own whooshes, exactly as recorded. */
export type HeartWave = Array<[number, number]>;

/** Columns a heart wave is computed at; layouts merge them down to what the
 * laser can resolve. */
export const HEART_WAVE_COLUMNS = 480;

/**
 * Cut the clearest TRACE_BEATS-beat stretch out of a heartbeat clip and reduce
 * it to min/max columns. "Clearest" = the window whose loudness swings the
 * most between beats, so the beats read as beats. Without a detected rate the
 * window assumes 140 bpm. Normalised to the window's 99th-percentile level so
 * one stray click can't flatten everything else.
 */
export function computeHeartWave(pcm: Int16Array, sampleRate: number, bpm?: number): HeartWave {
  const cols = HEART_WAVE_COLUMNS;
  if (pcm.length === 0) return Array.from({ length: cols }, () => [0, 0] as [number, number]);
  const hop = Math.max(1, Math.round(sampleRate / 100));
  const frames = Math.floor(pcm.length / hop);
  const winFrames = Math.min(frames, Math.round((TRACE_BEATS * 6000) / (bpm ?? 140)));
  let start = 0;
  if (frames > winFrames) {
    const env = new Float64Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let j = i * hop; j < (i + 1) * hop; j++) sum += (pcm[j]! / 32768) ** 2;
      env[i] = Math.sqrt(sum / hop);
    }
    let best = -1;
    for (let i = 0; i + winFrames <= frames; i += 2) {
      let mx = 0;
      let mn = Infinity;
      for (let j = i; j < i + winFrames; j++) {
        const v = (env[j - 1] ?? env[j]!) / 3 + env[j]! / 3 + (env[j + 1] ?? env[j]!) / 3;
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
      const score = mx > 0 ? (mx - mn) / mx : 0;
      if (score > best) {
        best = score;
        start = i;
      }
    }
  }
  const s0 = start * hop;
  const len = Math.max(1, Math.min(pcm.length - s0, winFrames * hop));
  const out: HeartWave = [];
  const mags: number[] = [];
  for (let c = 0; c < cols; c++) {
    const a = s0 + Math.floor((c * len) / cols);
    const b = Math.max(a + 1, s0 + Math.floor(((c + 1) * len) / cols));
    let mn = 0;
    let mx = 0;
    for (let j = a; j < b; j++) {
      const v = pcm[j]! / 32768;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    out.push([mn, mx]);
    mags.push(Math.max(-mn, mx));
  }
  const ref = [...mags].sort((x, y) => x - y)[Math.floor(cols * 0.99)] || 1;
  return out.map(([mn, mx]) => [Math.max(-1, mn / ref), Math.min(1, mx / ref)]);
}

/** A stand-in heart wave for previews before there is a recording: two
 * whooshes a beat, like a doppler, with deterministic grain. */
export function sampleHeartWave(): HeartWave {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  return Array.from({ length: HEART_WAVE_COLUMNS }, (_, c) => {
    const ph = ((c / HEART_WAVE_COLUMNS) * TRACE_BEATS) % 1;
    const e = Math.exp(-(((ph - 0.2) / 0.08) ** 2)) + 0.62 * Math.exp(-(((ph - 0.52) / 0.1) ** 2)) + 0.05;
    return [-Math.min(1, e * (0.35 + 0.65 * rand())), Math.min(1, e * (0.35 + 0.65 * rand()))] as [number, number];
  });
}

// --- the marks every design is built from ---

export type FontRole = 'display' | 'caps';

export interface TextMark {
  kind: 'text';
  xMm: number;
  yMm: number;
  fontMm: number;
  text: string;
  role: FontRole;
  align: 'start' | 'middle' | 'end';
  letterSpacingMm: number;
  /** the widest the text may run; the canvas squeezes to it, the SVG too */
  maxWidthMm: number;
}

export type Mark =
  /** rounded bars [x, y, w, h], corner radius w/2 */
  | { kind: 'bars'; rects: Array<[number, number, number, number]> }
  /** bars standing out from a circle: each [angle (rad, 0 = up, clockwise), length] */
  | { kind: 'radial'; cxMm: number; cyMm: number; r0Mm: number; wMm: number; bars: Array<[number, number]> }
  | TextMark
  | { kind: 'line'; points: Array<[number, number]>; strokeMm: number }
  | { kind: 'circle'; cxMm: number; cyMm: number; rMm: number; strokeMm: number }
  /** a photo, cover-cropped into its box; `fadeMm` feathers its left edge
   * into the stock; `clip` rounds it to its own radius or to the card's edge */
  | {
      kind: 'photo';
      xMm: number;
      yMm: number;
      wMm: number;
      hMm: number;
      radiusMm: number;
      outlineMm: number;
      fadeMm: number;
      /** clip to the card's own rounded edge instead of the box (bleeds) */
      clipToCard: boolean;
    }
  /** where the photo will go, before there is one */
  | { kind: 'placeholder'; xMm: number; yMm: number; wMm: number; hMm: number; radiusMm: number };

export interface FrontColors {
  bg: string;
  ink: string;
}

const PALETTE: FrontColors = { bg: '#ffffff', ink: '#000000' };

/** Thinnest line drawn anywhere: thinner than this doesn't engrave cleanly. */
export const MIN_STROKE_MM = 0.2;

export interface FrontLayout {
  design: FrontDesign;
  widthMm: number;
  heightMm: number;
  cornerMm: number;
  colors: FrontColors;
  /** thin outline tracing the card's own edge and corners */
  border: { insetMm: number; radiusMm: number; strokeMm: number };
  marks: Mark[];
}

// --- type ---

/** Titles and initials in Cormorant Garamond; the small letterspaced caps in
 * Jost, whose even strokes and lining figures survive engraving at 1.6 mm
 * where a Garamond's hairlines and old-style figures don't. Both ship with the
 * station (fontsource), so the canvas PNG renders them exactly; the SVG falls
 * back to system faces where they aren't installed. */
export const FONT_FAMILIES: Record<FontRole, string> = {
  display: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  caps: "Jost, 'Avenir Next', 'Helvetica Neue', Arial, sans-serif",
};
export const FONT_WEIGHT: Record<FontRole, number> = { display: 500, caps: 500 };

/** Rough advance per character, in ems, for fitting text without a canvas.
 * Generous on purpose: running short is harmless, running long is clipped. */
function textWidthMm(text: string, fontMm: number, role: FontRole, letterSpacingMm: number): number {
  const em = role === 'caps' ? 0.66 : 0.5;
  return text.length * (fontMm * em + letterSpacingMm);
}

/** The largest font ≤ `maxFont` at which `text` fits in `widthMm`. */
function fitFont(text: string, maxFont: number, widthMm: number, role: FontRole, tracking = 0): number {
  const at = (f: number) => textWidthMm(text, f, role, f * tracking);
  return at(maxFont) <= widthMm ? maxFont : (maxFont * widthMm) / at(maxFont);
}

function text(
  t: string,
  xMm: number,
  yMm: number,
  fontMm: number,
  role: FontRole,
  align: TextMark['align'],
  maxWidthMm: number,
  tracking = role === 'caps' ? 0.14 : 0.01,
): TextMark {
  return { kind: 'text', xMm, yMm, fontMm, text: t, role, align, letterSpacingMm: fontMm * tracking, maxWidthMm };
}

// --- metadata ---

function formatRecorded(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return m ? `${m[2]}.${m[3]}.${m[1]!.slice(2)}` : '';
}

/** A due date as engraved: a recognisable numeric date becomes MM.DD.YY,
 * anything else ("June 2027") is kept, uppercase. */
export function formatDue(raw: string): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const iso = formatRecorded(t);
  if (iso) return iso;
  const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (us && +us[1]! >= 1 && +us[1]! <= 12 && +us[2]! >= 1 && +us[2]! <= 31) {
    return `${us[1]!.padStart(2, '0')}.${us[2]!.padStart(2, '0')}.${us[3]!.slice(-2)}`;
  }
  return t.toUpperCase();
}

/** The clip's metadata fields, uppercase, absent ones omitted. */
export function metadataParts(input: FrontInput): string[] {
  const parts: string[] = [];
  const isHeart = input.design === 'framed' || input.design === 'heartline';
  const voice = input.voice?.trim();
  if (voice && !isHeart) parts.push(`VOICE: ${voice.toUpperCase()}`);
  if (isHeart) {
    const due = input.dueDate ? formatDue(input.dueDate) : '';
    if (due) parts.push(`DUE: ${due}`);
  } else {
    const recorded = input.recordedAt ? formatRecorded(input.recordedAt) : '';
    if (recorded) parts.push(`RECORDED: ${recorded}`);
  }
  if (isHeart && input.heartbeat) parts.push(`HEART RATE: ${input.heartbeat.bpm} BPM`);
  return parts;
}

/** The one-line metadata of the classic wave, with the flip-me nudge when
 * nothing is known. Single spaces around the middot: SVG collapses runs of
 * whitespace, so wider gaps would drift from the canvas. */
function metadataLine(input: FrontInput): string {
  const parts = metadataParts(input);
  return parts.length ? parts.join(' · ') : 'SCAN THE BACK TO LISTEN';
}

/** A monogram for the ring: the voice's initial, else the first meaningful
 * word of the title ("For Mom" → M). */
export function monogram(input: FrontInput): string {
  const skip = new Set(['for', 'to', 'the', 'a', 'an', 'my', 'from', 'love', 'with', 'and', 'of']);
  const voice = input.voice?.trim();
  if (voice && /\p{L}/u.test(voice)) return voice.match(/\p{L}/u)![0]!.toUpperCase();
  const words = (input.textLine ?? '').split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const word = words.find((w) => !skip.has(w.toLowerCase())) ?? words[0];
  return word ? word.match(/\p{L}/u)![0]!.toUpperCase() : '';
}

// --- heart-monitor trace ---

/** One heartbeat on a monitor over u ∈ [0, 1]: flat, a small P bump, the sharp
 * Q-R-S spike, a rounded T wave, flat again. Heights in units of the R spike. */
/** The heart wave's columns: as wide as any engraved bar may be thin
 * (0.38 mm, the same floor as the voice waveform's bars), with stock between
 * them the laser won't close up. */
const WAVE_BAR_MM = 0.38;
const WAVE_PITCH_MM = 0.6;

/** The heart wave from x1 to x2, centred on `cy`, peaks reaching `half`
 * above and below. `share` of the wave is drawn (Heartline shows 3 of 4
 * beats). Each column is a min-to-max bar at the thinnest engravable width. */
function heartWaveMark(wave: HeartWave, share: number, x1: number, x2: number, cy: number, half: number): Mark {
  const src = wave.slice(0, Math.max(1, Math.round(wave.length * share)));
  const n = Math.max(8, Math.floor((x2 - x1) / WAVE_PITCH_MM));
  const pitch = (x2 - x1) / n;
  const w = WAVE_BAR_MM;
  const rects: Array<[number, number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * src.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * src.length) / n));
    let mn = 0;
    let mx = 0;
    for (let k = a; k < b && k < src.length; k++) {
      mn = Math.min(mn, src[k]![0]);
      mx = Math.max(mx, src[k]![1]);
    }
    const top = cy - mx * half;
    const h = Math.max(w, (mx - mn) * half);
    rects.push([x1 + (i + 0.5) * pitch - w / 2, h === w ? cy - w / 2 : top, w, h]);
  }
  return { kind: 'bars', rects };
}

// --- layouts ---

export function layoutFront(input: FrontInput): FrontLayout {
  const design = input.design ?? 'wave';
  const W = input.widthMm ?? CARD_W_MM;
  const H = input.heightMm ?? CARD_H_MM;
  const cornerMm = input.cornerMm ?? CARD_SIZES[DEFAULT_CARD_SIZE].cornerMm;
  const marks =
    design === 'ring'
      ? ringMarks(input, W, H)
      : design === 'framed'
        ? framedMarks(input, W, H)
        : design === 'heartline'
          ? heartlineMarks(input, W, H, cornerMm)
          : waveMarks(input, W, H);
  // The outline sits on the very edge of the card, following the blank's
  // corners; its stroke stays just inside the artboard so nothing is clipped.
  const border = {
    insetMm: MIN_STROKE_MM / 2,
    radiusMm: Math.max(0, cornerMm - MIN_STROKE_MM / 2),
    strokeMm: MIN_STROKE_MM,
  };
  return { design, widthMm: W, heightMm: H, cornerMm, colors: PALETTE, border, marks };
}

/** Classic: the title across the top, the clip as fine mirrored bars, one
 * letterspaced line of details at the foot. Everything centred. */
function waveMarks(input: FrontInput, W: number, H: number): Mark[] {
  const margin = W * 0.09;
  const innerW = W - 2 * margin;
  const name = input.textLine?.trim();
  const centerY = name ? H * 0.535 : H * 0.5;
  const halfMax = name ? H * 0.19 : H * 0.22;
  const pitch = innerW / Math.max(1, input.bars.length);
  const barW = pitch * 0.42;
  const rects: Array<[number, number, number, number]> = input.bars.map((v, i) => {
    const h = Math.max(barW, Math.min(1, v) * 2 * halfMax);
    return [margin + i * pitch + (pitch - barW) / 2, centerY - h / 2, barW, h];
  });
  const marks: Mark[] = [{ kind: 'bars', rects }];
  if (name) marks.push(text(name, W / 2, H * 0.19, fitFont(name, H * 0.085, innerW * 0.9, 'display'), 'display', 'middle', innerW));
  const line = metadataLine(input);
  const hintMax = H * 0.03;
  marks.push(text(line, W / 2, H * 0.875, fitFont(line, hintMax, innerW, 'caps', 0.14), 'caps', 'middle', innerW));
  return marks;
}

/** Ring: the clip wrapped once around a circle, starting at the top and
 * running clockwise, with an initial in the middle; the title, a short rule
 * and the details stacked to its right, left-aligned. */
function ringMarks(input: FrontInput, W: number, H: number): Mark[] {
  const rOut = H * 0.36;
  const cx = H * 0.5;
  const cy = H * 0.5;
  const r0 = rOut * 0.56;
  const count = Math.max(1, input.bars.length);
  const wMm = Math.max(0.4, ((2 * Math.PI * r0) / count) * 0.42);
  const span = rOut - r0;
  // Silence keeps a short stub (not a dot), so the ring reads as one shape.
  const floor = span * 0.14;
  const bars: Array<[number, number]> = input.bars.map((v, i) => [
    (2 * Math.PI * i) / count,
    floor + Math.max(0, Math.min(1, v) - 0.045) * (span - floor),
  ]);
  const marks: Mark[] = [
    { kind: 'radial', cxMm: cx, cyMm: cy, r0Mm: r0, wMm, bars },
    { kind: 'circle', cxMm: cx, cyMm: cy, rMm: r0 - H * 0.03, strokeMm: MIN_STROKE_MM },
  ];
  const initial = monogram(input);
  if (initial) marks.push(text(initial, cx, cy + r0 * 0.04, r0 * 1.05, 'display', 'middle', r0 * 1.5, 0));

  const x0 = cx + rOut + W * 0.075;
  const colW = W - H * 0.11 - x0;
  const name = input.textLine?.trim();
  const parts = metadataParts(input);
  const lines = parts.length ? parts : ['SCAN THE BACK', 'TO LISTEN'];
  const capsFont = Math.min(H * 0.029, ...lines.map((l) => fitFont(l, H * 0.029, colW, 'caps', 0.14)));
  const gap = capsFont * 1.95;
  const nameFont = name ? fitFont(name, H * 0.095, colW, 'display') : 0;
  // Centre the column's block vertically on the ring.
  const ruleGap = H * 0.055;
  const blockH = (name ? nameFont * 0.9 + ruleGap : 0) + ruleGap * 0.6 + (lines.length - 1) * gap + capsFont;
  let y = cy - blockH / 2;
  if (name) {
    marks.push(text(name, x0, y + nameFont * 0.45, nameFont, 'display', 'start', colW));
    y += nameFont * 0.9 + ruleGap * 0.55;
  }
  marks.push({ kind: 'line', points: [[x0, y], [x0 + Math.min(colW, W * 0.1), y]], strokeMm: MIN_STROKE_MM });
  y += ruleGap * 0.6 + capsFont / 2;
  for (const l of lines) {
    marks.push(text(l, x0, y, capsFont, 'caps', 'start', colW));
    y += gap;
  }
  return marks;
}

/** Framed: the scan in a rounded frame down the left; the title, the heart
 * trace and the stacked details centred in the column beside it. */
function framedMarks(input: FrontInput, W: number, H: number): Mark[] {
  const margin = H * 0.1;
  const frameH = H - 2 * margin;
  const aspect = input.photo ? input.photo.width / input.photo.height : 1.05;
  const frameW = Math.min(W * 0.5, frameH * Math.min(1.2, Math.max(0.8, aspect)));
  const marks: Mark[] = [
    input.photo
      ? { kind: 'photo', xMm: margin, yMm: margin, wMm: frameW, hMm: frameH, radiusMm: 1.6, outlineMm: MIN_STROKE_MM, fadeMm: 0, clipToCard: false }
      : { kind: 'placeholder', xMm: margin, yMm: margin, wMm: frameW, hMm: frameH, radiusMm: 1.6 },
  ];
  const colX1 = margin + frameW + W * 0.05;
  const colX2 = W - margin * 0.9;
  const colW = colX2 - colX1;
  const mid = (colX1 + colX2) / 2;
  const name = input.textLine?.trim();
  if (name) marks.push(text(name, mid, margin + H * 0.065, fitFont(name, H * 0.08, colW * 0.95, 'display'), 'display', 'middle', colW));
  const wave = input.heartWave ?? sampleHeartWave();
  marks.push(heartWaveMark(wave, 1, colX1, colX2, name ? H * 0.5 : H * 0.44, H * 0.13));
  const parts = metadataParts(input);
  const lines = parts.length ? parts : ['SCAN THE BACK', 'TO LISTEN'];
  const capsFont = Math.min(H * 0.029, ...lines.map((l) => fitFont(l, H * 0.029, colW, 'caps', 0.14)));
  const gap = capsFont * 1.85;
  const last = H - margin - capsFont * 0.5;
  lines.forEach((l, i) => marks.push(text(l, mid, last - (lines.length - 1 - i) * gap, capsFont, 'caps', 'middle', colW)));
  return marks;
}

/** Heartline: the scan bleeds off the right edge and fades into the card to
 * its left; the title, due date, heart trace and rate sit left-aligned in the
 * clear space. */
function heartlineMarks(input: FrontInput, W: number, H: number, cornerMm: number): Mark[] {
  const photoX = W * 0.38;
  const marks: Mark[] = [
    input.photo
      ? { kind: 'photo', xMm: photoX, yMm: 0, wMm: W - photoX, hMm: H, radiusMm: cornerMm, outlineMm: 0, fadeMm: (W - photoX) * 0.42, clipToCard: true }
      : { kind: 'placeholder', xMm: photoX + W * 0.08, yMm: H * 0.1, wMm: W - photoX - W * 0.08 - H * 0.1, hMm: H * 0.8, radiusMm: 1.6 },
  ];
  const x0 = H * 0.14;
  const colW = W * 0.5 - x0;
  const name = input.textLine?.trim();
  let y = H * 0.25;
  if (name) {
    const f = fitFont(name, H * 0.11, colW, 'display');
    marks.push(text(name, x0, y, f, 'display', 'start', colW));
    y += f * 0.85;
  }
  const due = input.dueDate ? formatDue(input.dueDate) : '';
  const dueLine = due ? `DUE ${due}` : '';
  const capsFont = H * 0.029;
  if (dueLine) marks.push(text(dueLine, x0, y + capsFont * 0.9, capsFont, 'caps', 'start', colW));
  const wave = input.heartWave ?? sampleHeartWave();
  marks.push(heartWaveMark(wave, 0.75, x0, W * 0.47, H * 0.635, H * 0.11));
  const footLine = input.heartbeat ? `${input.heartbeat.bpm} BPM` : 'SCAN THE BACK TO LISTEN';
  marks.push(text(footLine, x0, H * 0.875, fitFont(footLine, capsFont, colW, 'caps', 0.14), 'caps', 'start', colW));
  return marks;
}

// --- rendering ---

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const PLACEHOLDER_TEXT = 'ADD THE SCAN';

export function renderFrontSvg(input: FrontInput): string {
  const L = layoutFront(input);
  const { colors: c } = L;
  const f = (n: number) => Number(n.toFixed(4));
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.widthMm}mm" height="${L.heightMm}mm" viewBox="0 0 ${L.widthMm} ${L.heightMm}">`,
    `<rect width="${L.widthMm}" height="${L.heightMm}" fill="${c.bg}"/>`,
  ];
  let ids = 0;
  for (const m of L.marks) {
    switch (m.kind) {
      case 'bars':
        for (const [x, y, w, h] of m.rects) {
          out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(w / 2)}" fill="${c.ink}"/>`);
        }
        break;
      case 'radial':
        for (const [a, len] of m.bars) {
          const deg = (a * 180) / Math.PI;
          out.push(
            `<rect x="${f(m.cxMm - m.wMm / 2)}" y="${f(m.cyMm - m.r0Mm - len)}" width="${f(m.wMm)}" height="${f(len)}" ` +
              `rx="${f(m.wMm / 2)}" fill="${c.ink}" transform="rotate(${f(deg)} ${f(m.cxMm)} ${f(m.cyMm)})"/>`,
          );
        }
        break;
      case 'circle':
        out.push(`<circle cx="${f(m.cxMm)}" cy="${f(m.cyMm)}" r="${f(m.rMm)}" fill="none" stroke="${c.ink}" stroke-width="${m.strokeMm}"/>`);
        break;
      case 'line':
        out.push(
          `<polyline points="${m.points.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}" fill="none" stroke="${c.ink}" ` +
            `stroke-width="${m.strokeMm}" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
        break;
      case 'text': {
        const anchor = m.align;
        // Letterspacing trails the last glyph; nudge centred text back by half.
        const x = m.align === 'middle' ? m.xMm + m.letterSpacingMm / 2 : m.xMm;
        out.push(
          `<text x="${f(x)}" y="${f(m.yMm)}" font-family="${FONT_FAMILIES[m.role]}" font-weight="${FONT_WEIGHT[m.role]}" ` +
            `font-size="${f(m.fontMm)}"${m.letterSpacingMm ? ` letter-spacing="${f(m.letterSpacingMm)}"` : ''} ` +
            `text-anchor="${anchor}" dominant-baseline="middle" fill="${c.ink}">${escapeXml(m.text)}</text>`,
        );
        break;
      }
      case 'photo': {
        if (!input.photo) break;
        const id = `p${ids++}`;
        const box = `x="${f(m.xMm)}" y="${f(m.yMm)}" width="${f(m.wMm)}" height="${f(m.hMm)}"`;
        const clip = m.clipToCard
          ? `<rect x="0" y="0" width="${L.widthMm}" height="${L.heightMm}" rx="${f(L.cornerMm)}"/>`
          : `<rect ${box} rx="${f(m.radiusMm)}"/>`;
        out.push(`<clipPath id="${id}c">${clip}</clipPath>`);
        let mask = '';
        if (m.fadeMm > 0) {
          out.push(
            `<linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="${f(m.xMm)}" y1="0" x2="${f(m.xMm + m.fadeMm)}" y2="0">` +
              `<stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>`,
            `<mask id="${id}m" maskUnits="userSpaceOnUse"><rect ${box} fill="url(#${id}g)"/></mask>`,
          );
          mask = ` mask="url(#${id}m)"`;
        }
        // xMidYMid slice is the same centred cover-crop the canvas draws.
        out.push(
          `<image href="${input.photo.href}" ${box} preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}c)"${mask}/>`,
        );
        if (m.outlineMm > 0) {
          out.push(`<rect ${box} rx="${f(m.radiusMm)}" fill="none" stroke="${c.ink}" stroke-width="${m.outlineMm}"/>`);
        }
        break;
      }
      case 'placeholder':
        out.push(
          `<rect x="${f(m.xMm)}" y="${f(m.yMm)}" width="${f(m.wMm)}" height="${f(m.hMm)}" rx="${f(m.radiusMm)}" fill="none" ` +
            `stroke="${c.ink}" stroke-width="${MIN_STROKE_MM}" stroke-dasharray="1 1"/>`,
        );
        break;
    }
  }
  const b = L.border;
  out.push(
    `<rect x="${f(b.insetMm)}" y="${f(b.insetMm)}" width="${f(L.widthMm - 2 * b.insetMm)}" height="${f(L.heightMm - 2 * b.insetMm)}" ` +
      `rx="${f(b.radiusMm)}" fill="none" stroke="${c.ink}" stroke-width="${b.strokeMm}"/>`,
    '</svg>',
  );
  return out.join('\n');
}

/** Draw the card front at `pxPerMm` — the live preview, the design
 * thumbnails and the high-DPI PNG all come through here. */
export function drawFront(ctx: CanvasRenderingContext2D, input: FrontInput, pxPerMm: number): void {
  const L = layoutFront(input);
  const { colors: c } = L;
  const px = (mm: number) => mm * pxPerMm;
  ctx.save();
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, Math.round(px(L.widthMm)), Math.round(px(L.heightMm)));
  ctx.fillStyle = c.ink;
  ctx.strokeStyle = c.ink;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const m of L.marks) {
    switch (m.kind) {
      case 'bars':
        ctx.beginPath();
        for (const [x, y, w, h] of m.rects) roundedRectPath(ctx, px(x), px(y), px(w), px(h), px(w) / 2);
        ctx.fill();
        break;
      case 'radial':
        for (const [a, len] of m.bars) {
          ctx.save();
          ctx.translate(px(m.cxMm), px(m.cyMm));
          ctx.rotate(a);
          ctx.beginPath();
          roundedRectPath(ctx, px(-m.wMm / 2), px(-m.r0Mm - len), px(m.wMm), px(len), px(m.wMm) / 2);
          ctx.fill();
          ctx.restore();
        }
        break;
      case 'circle':
        ctx.lineWidth = px(m.strokeMm);
        ctx.beginPath();
        ctx.arc(px(m.cxMm), px(m.cyMm), px(m.rMm), 0, 2 * Math.PI);
        ctx.stroke();
        break;
      case 'line':
        ctx.lineWidth = px(m.strokeMm);
        ctx.beginPath();
        m.points.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), px(y)) : ctx.moveTo(px(x), px(y))));
        ctx.stroke();
        break;
      case 'text':
        ctx.font = `${FONT_WEIGHT[m.role]} ${px(m.fontMm)}px ${FONT_FAMILIES[m.role]}`;
        // letterSpacing is newer; browsers without it render a touch tighter.
        ctx.letterSpacing = `${px(m.letterSpacingMm)}px`;
        ctx.textAlign = m.align === 'middle' ? 'center' : m.align === 'end' ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.text, px(m.align === 'middle' ? m.xMm + m.letterSpacingMm / 2 : m.xMm), px(m.yMm), px(m.maxWidthMm));
        ctx.letterSpacing = '0px';
        break;
      case 'photo':
        if (input.photo) drawPhoto(ctx, m, input.photo, L, px);
        break;
      case 'placeholder': {
        ctx.lineWidth = Math.max(1, px(MIN_STROKE_MM));
        ctx.setLineDash([px(1), px(1)]);
        ctx.beginPath();
        roundedRectPath(ctx, px(m.xMm), px(m.yMm), px(m.wMm), px(m.hMm), px(m.radiusMm));
        ctx.stroke();
        ctx.setLineDash([]);
        const fs = L.heightMm * 0.03;
        ctx.font = `${FONT_WEIGHT.caps} ${px(fs)}px ${FONT_FAMILIES.caps}`;
        ctx.letterSpacing = `${px(fs * 0.14)}px`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(PLACEHOLDER_TEXT, px(m.xMm + m.wMm / 2 + fs * 0.07), px(m.yMm + m.hMm / 2));
        ctx.letterSpacing = '0px';
        break;
      }
    }
  }
  const b = L.border;
  ctx.lineWidth = Math.max(1, px(b.strokeMm));
  ctx.beginPath();
  roundedRectPath(ctx, px(b.insetMm), px(b.insetMm), px(L.widthMm - 2 * b.insetMm), px(L.heightMm - 2 * b.insetMm), px(b.radiusMm));
  ctx.stroke();
  ctx.restore();
}

function drawPhoto(
  ctx: CanvasRenderingContext2D,
  m: Extract<Mark, { kind: 'photo' }>,
  photo: FrontPhoto,
  L: FrontLayout,
  px: (mm: number) => number,
): void {
  const w = Math.max(1, Math.round(px(m.wMm)));
  const h = Math.max(1, Math.round(px(m.hMm)));
  // Centred cover-crop into an offscreen box, feathered there, then placed.
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const o = off.getContext('2d')!;
  const scale = Math.max(m.wMm / photo.width, m.hMm / photo.height);
  const sw = m.wMm / scale;
  const sh = m.hMm / scale;
  o.imageSmoothingQuality = 'high';
  o.drawImage(photo.image, (photo.width - sw) / 2, (photo.height - sh) / 2, sw, sh, 0, 0, w, h);
  if (m.fadeMm > 0) {
    o.globalCompositeOperation = 'destination-in';
    const g = o.createLinearGradient(0, 0, px(m.fadeMm), 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    o.fillStyle = g;
    o.fillRect(0, 0, w, h);
  }
  ctx.save();
  ctx.beginPath();
  if (m.clipToCard) roundedRectPath(ctx, 0, 0, px(L.widthMm), px(L.heightMm), px(L.cornerMm));
  else roundedRectPath(ctx, px(m.xMm), px(m.yMm), px(m.wMm), px(m.hMm), px(m.radiusMm));
  ctx.clip();
  ctx.drawImage(off, px(m.xMm), px(m.yMm));
  ctx.restore();
  if (m.outlineMm > 0) {
    ctx.lineWidth = Math.max(1, px(m.outlineMm));
    ctx.beginPath();
    roundedRectPath(ctx, px(m.xMm), px(m.yMm), px(m.wMm), px(m.hMm), px(m.radiusMm));
    ctx.stroke();
  }
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
