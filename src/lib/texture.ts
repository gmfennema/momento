// Card-back TEXTURE — the pixel field the data codes sit inside.
//
// The back used to read as a tidy grid of QR tiles floating in white space.
// This fills the whole card with a module-aligned field of dark/light cells at
// exactly the QR module pitch, so the eye sees one continuous mosaic and the
// codes look buried in it rather than pasted onto it.
//
// The one thing that must survive: QR detection needs a LIGHT quiet zone
// around each symbol — ZXing finds a symbol by matching the 1:1:3:1:1 run
// ratio through a finder pattern, and a dark cell touching the symbol edge
// lengthens the first run and the match fails. So every symbol (plus the entry
// window and the name line) contributes an exclusion rect the field never
// enters, and density then FADES IN over a few modules beyond it. The fade is
// what sells the illusion: the codes dissolve into the static instead of
// sitting in visible rectangular gutters.
//
// Pure math, no DOM — deterministic for a given seed so a card re-renders
// identically for preview, PNG, and SVG.

/** [x, y, w, h] in mm */
export type Rect = [number, number, number, number];

export interface TextureSpec {
  widthMm: number;
  heightMm: number;
  /** module pitch — same as the chunk QRs so the card reads as one mosaic */
  moduleMm: number;
  /** any point on the QR module lattice; the field aligns to it */
  latticeXMm: number;
  latticeYMm: number;
  /** regions the field must never enter (quiet zones, entry window, name line) */
  exclusions: Rect[];
  /** deterministic per card */
  seed: number;
  /** peak dark fraction, before local cloud modulation */
  density?: number;
  /** modules over which density ramps from 0 to full past an exclusion */
  fadeModules?: number;
  /** How far the fade's start wanders outward, in modules. A constant fade
   * gives every code a tidy rectangular halo, which is exactly the "tiles
   * pasted on white" look this replaces; letting the start drift makes the
   * boundary ragged so the codes dissolve into the field. Only ever pushes the
   * field further away, so the guaranteed quiet ring is never eaten into. */
  boundaryJitterModules?: number;
  /** density also fades to 0 within this distance of the card edge */
  edgeFadeMm?: number;
  /** longest run of dark cells allowed in a row or column */
  maxRun?: number;
}

export interface TextureField {
  widthMm: number;
  heightMm: number;
  moduleMm: number;
  cols: number;
  rows: number;
  /** top-left of cell (0, 0); may be slightly off-card so the field bleeds */
  originXMm: number;
  originYMm: number;
  /** row-major, 1 = dark */
  dark: Uint8Array;
  /** dark cells as a fraction of the card area — how much extra gets engraved */
  coverage: number;
}

const DEFAULT_DENSITY = 0.42;
const DEFAULT_FADE_MODULES = 1.5;
const DEFAULT_BOUNDARY_JITTER_MODULES = 1;
const DEFAULT_EDGE_FADE_MM = 0.6;
const DEFAULT_MAX_RUN = 4;

/** Integer hash → [0, 1). Cheap, and stable across platforms (all 32-bit). */
function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Bilinear value noise on the integer lattice. */
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const sx = smoothstep(x - xi);
  const sy = smoothstep(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

/** Gentle low-frequency variation so the field looks like a field, not TV
 * static: some patches thin out, others thicken. Scales are in modules. */
function clouds(mx: number, my: number, seed: number): number {
  return (
    0.6 * valueNoise(mx / 15, my / 15, seed) +
    0.3 * valueNoise(mx / 6, my / 6, (seed ^ 0x9e3779b9) >>> 0) +
    0.1 * valueNoise(mx / 2.5, my / 2.5, (seed ^ 0x85ebca6b) >>> 0)
  );
}

/** Distance in mm from a whole cell (centre `cx,cy`, half-width `half`) to the
 * outside of a rect; 0 when the cell touches it at all. Measuring the cell
 * rather than its centre matters because exclusions like the name-line band
 * don't land on the module lattice — a centre test would let cells poke a
 * fraction of a module into them. */
function cellDistToRect(cx: number, cy: number, half: number, [rx, ry, rw, rh]: Rect): number {
  const dx = Math.max(rx - (cx + half), cx - half - (rx + rw), 0);
  const dy = Math.max(ry - (cy + half), cy - half - (ry + rh), 0);
  return dx === 0 ? dy : dy === 0 ? dx : Math.hypot(dx, dy);
}

/** Break dark runs longer than `maxRun` in both axes. Keeps the field reading
 * as fine grain instead of blotches, and denies ZXing's finder-pattern search
 * the long dark runs that would make the noise worth a decode attempt. */
function capRuns(dark: Uint8Array, cols: number, rows: number, maxRun: number): void {
  for (let r = 0; r < rows; r++) {
    let run = 0;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (dark[i]) {
        if (++run > maxRun) {
          dark[i] = 0;
          run = 0;
        }
      } else run = 0;
    }
  }
  for (let c = 0; c < cols; c++) {
    let run = 0;
    for (let r = 0; r < rows; r++) {
      const i = r * cols + c;
      if (dark[i]) {
        if (++run > maxRun) {
          dark[i] = 0;
          run = 0;
        }
      } else run = 0;
    }
  }
}

export function buildTexture(spec: TextureSpec): TextureField {
  const {
    widthMm,
    heightMm,
    moduleMm,
    exclusions,
    seed,
    density = DEFAULT_DENSITY,
    fadeModules = DEFAULT_FADE_MODULES,
    boundaryJitterModules = DEFAULT_BOUNDARY_JITTER_MODULES,
    edgeFadeMm = DEFAULT_EDGE_FADE_MM,
    maxRun = DEFAULT_MAX_RUN,
  } = spec;
  if (!(moduleMm > 0)) throw new Error('texture needs a positive module size');

  // Snap the field to the QR module lattice, starting one module off-card so
  // the pattern bleeds past the trim edge instead of stopping short of it.
  const phaseX = spec.latticeXMm - Math.floor(spec.latticeXMm / moduleMm) * moduleMm;
  const phaseY = spec.latticeYMm - Math.floor(spec.latticeYMm / moduleMm) * moduleMm;
  const originXMm = phaseX - moduleMm;
  const originYMm = phaseY - moduleMm;
  const cols = Math.ceil((widthMm - originXMm) / moduleMm);
  const rows = Math.ceil((heightMm - originYMm) / moduleMm);

  const dark = new Uint8Array(cols * rows);
  const fadeMm = fadeModules * moduleMm;
  const half = moduleMm / 2;

  for (let r = 0; r < rows; r++) {
    const cy = originYMm + (r + 0.5) * moduleMm;
    for (let c = 0; c < cols; c++) {
      const cx = originXMm + (c + 0.5) * moduleMm;

      let gap = Infinity;
      for (const rect of exclusions) {
        const d = cellDistToRect(cx, cy, half, rect);
        if (d === 0) {
          gap = 0;
          break;
        }
        if (d < gap) gap = d;
      }
      if (gap === 0) continue;

      // Push the boundary outward by a slowly-varying amount so the light ring
      // around each code ripples instead of squaring off.
      const setback =
        boundaryJitterModules > 0
          ? boundaryJitterModules * moduleMm * valueNoise(c / 9, r / 9, (seed ^ 0xc2b2ae35) >>> 0)
          : 0;
      let fade = fadeMm > 0 ? smoothstep((gap - setback) / fadeMm) : gap > setback ? 1 : 0;
      if (edgeFadeMm > 0) {
        const edge = Math.min(cx, cy, widthMm - cx, heightMm - cy);
        fade *= smoothstep(edge / edgeFadeMm);
      }
      if (fade <= 0) continue;

      const p = density * fade * (0.3 + 1.4 * clouds(c, r, seed));
      if (p <= 0) continue;
      if (hash2(c, r, (seed ^ 0x27d4eb2f) >>> 0) < p) dark[r * cols + c] = 1;
    }
  }

  capRuns(dark, cols, rows, maxRun);

  let count = 0;
  for (let i = 0; i < dark.length; i++) count += dark[i]!;
  return {
    widthMm,
    heightMm,
    moduleMm,
    cols,
    rows,
    originXMm,
    originYMm,
    dark,
    coverage: (count * moduleMm * moduleMm) / (widthMm * heightMm),
  };
}

/** Merge each row's dark runs into rects, clipped to the card. Same shape as
 * the QR symbol rects so both feed one SVG path / one canvas fill loop. */
export function textureRects(field: TextureField): Rect[] {
  const { cols, rows, moduleMm, originXMm, originYMm, dark } = field;
  const rects: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    const y = originYMm + r * moduleMm;
    const y0 = Math.max(0, y);
    const y1 = Math.min(field.heightMm, y + moduleMm);
    if (y1 <= y0) continue;
    let runStart = -1;
    for (let c = 0; c <= cols; c++) {
      const isDark = c < cols && dark[r * cols + c] === 1;
      if (isDark && runStart === -1) runStart = c;
      if (!isDark && runStart !== -1) {
        const x0 = Math.max(0, originXMm + runStart * moduleMm);
        const x1 = Math.min(field.widthMm, originXMm + c * moduleMm);
        if (x1 > x0) rects.push([x0, y0, x1 - x0, y1 - y0]);
        runStart = -1;
      }
    }
  }
  return rects;
}
