// Card layout planner. Pure math, no DOM — fully unit-testable.
//
// Given the compressed audio size, find the QR version + grid arrangement that
// MAXIMIZES physical module size (the dominant factor in whether an engraved
// card scans), and report the numbers honestly so the UI can warn the maker.

import { maxBytesForChars } from './base45';
import {
  HEADER_BYTES,
  LYRA_MODE_3200,
  WIRE_CODEC2,
  WIRE_LYRA,
  type Codec2Mode,
  type CodecModeId,
} from './chunk';
import { LYRA_BYTES_PER_FRAME, LYRA_BYTES_PER_SEC } from './lyra';

/** Standard US business card. */
export const CARD_W_MM = 88.9;
export const CARD_H_MM = 50.8;

/** QR alphanumeric capacity at ECC level L, versions 1..20 (ISO/IEC 18004). */
const ALNUM_CAPACITY_L = [
  25, 47, 77, 114, 154, 195, 224, 279, 335, 395, 468, 535, 619, 667, 758, 854,
  938, 1046, 1153, 1249,
] as const;

export function alnumCapacityL(version: number): number {
  const c = ALNUM_CAPACITY_L[version - 1];
  if (c === undefined) throw new Error(`unsupported QR version ${version}`);
  return c;
}

interface TierBase {
  key: 'basic' | 'good' | 'best';
  wireVersion: number;
  modeId: CodecModeId;
  bytesPerSec: number;
  /** Bytes the codec emits per frame. Both codecs work in whole frames, so this
   * is exactly how far a real encode can overshoot the nominal rate — and
   * therefore all the slack planning needs (see estimatePayloadBytes). */
  frameBytes: number;
  label: string;
  blurb: string;
}

export type Tier = TierBase &
  ({ codec: 'codec2'; mode: Codec2Mode } | { codec: 'lyra' });

/** Longest clip that may go on a card. Lives here rather than in lib/audio.ts
 * (browser-only) so the planner — and its node tests — can reason about the
 * whole duration range without pulling in Web Audio. */
export const MAX_SECONDS = 10;

/**
 * The quality ladder, cheapest first — three rungs, each a real choice rather
 * than a byte-shaving variant of its neighbour. Every rung is playable on
 * every card: the two Codec 2 rungs are restored by the neural model at
 * playback time (see lib/bwe.ts), so the ladder is about how much of the
 * original voice the card carries, not about how good it can sound.
 *
 * A rung is only offered when its card clears MODULE_FLOOR_MM, so the honest
 * difference between them is how long a clip they can hold.
 */
export const TIERS: readonly Tier[] = [
  {
    key: 'basic',
    codec: 'codec2',
    mode: '1400',
    wireVersion: WIRE_CODEC2,
    modeId: 3,
    bytesPerSec: 175,
    frameBytes: 7,
    label: 'Basic',
    blurb: 'Standard voice, restored by the neural model on playback. Roomiest codes — fits a full-length clip.',
  },
  {
    key: 'good',
    codec: 'codec2',
    mode: '2400',
    wireVersion: WIRE_CODEC2,
    modeId: 1,
    bytesPerSec: 300,
    frameBytes: 6,
    label: 'Good',
    blurb: 'Clearer voice, restored by the neural model on playback. Denser card, so medium-length clips.',
  },
  {
    key: 'best',
    codec: 'lyra',
    wireVersion: WIRE_LYRA,
    modeId: LYRA_MODE_3200,
    bytesPerSec: LYRA_BYTES_PER_SEC,
    frameBytes: LYRA_BYTES_PER_FRAME,
    label: 'Best',
    blurb: 'Natural wideband voice straight from the Lyra neural codec. Densest card; short clips only.',
  },
] as const;

/** Payload estimate for planning before the real encode exists. Both codecs
 * emit whole frames, so the real encode can exceed the nominal rate by at most
 * one frame and never by more — plan with exactly that much slack. (A rounder,
 * larger guess is not free: 16 bytes of imaginary payload is enough to push a
 * plan up a QR version and shrink every module on the card.) */
export function estimatePayloadBytes(seconds: number, tier: Tier): number {
  return Math.ceil(seconds * tier.bytesPerSec) + tier.frameBytes;
}

/** No card is ever laid out denser than this — the dot size a phone camera
 * can find on an engraved card without a perfect shot. It is a hard floor for
 * every tier (deliberately above the 0.30 mm soft warning), not a preference:
 * a tier whose card would fall below it is simply not offered until the clip
 * is short enough, so the generator can never hand back a card the UI would
 * then complain about.
 *
 * The floor also holds the QR version down (a standard card mostly lands on 4
 * columns, where this floor means version ≤ 10, 57 modules a side), and the
 * version matters as much as the millimetres: every extra version is 4 more
 * modules the camera has to resolve across the same symbol. */
export const MODULE_FLOOR_MM = 0.32;

/** Does this clip length fit this tier at a scannable density? */
export function tierFits(seconds: number, tier: Tier, spec: CardSpec): boolean {
  try {
    return planCard(estimatePayloadBytes(seconds, tier), spec).moduleMm >= MODULE_FLOOR_MM;
  } catch {
    return false; // doesn't fit on the card at all
  }
}

/** Longest clip (in 0.1s steps) this tier can hold on this card. Module size
 * is monotone non-increasing in payload bytes, so the durations that fit are a
 * prefix of the range and a binary search over tenths is exact. Returns 0 when
 * even the shortest clip is too dense — which the ladder's cheapest rung never
 * is, but callers shouldn't have to know that. */
export function maxSecondsForTier(tier: Tier, spec: CardSpec): number {
  const steps = Math.round(MAX_SECONDS * 10);
  if (tierFits(MAX_SECONDS, tier, spec)) return MAX_SECONDS;
  if (!tierFits(0.1, tier, spec)) return 0;
  let fits = 1;
  let fails = steps;
  while (fails - fits > 1) {
    const mid = (fits + fails) >> 1;
    if (tierFits(mid / 10, tier, spec)) fits = mid;
    else fails = mid;
  }
  return fits / 10;
}

/** The best-sounding tier this clip can actually have: the last rung in TIERS
 * order whose card still clears the floor. Nothing below the floor is ever
 * returned — a clip that fits no rung at all is a hard error, not a warning. */
export function bestTierThatFits(
  seconds: number,
  spec: CardSpec,
  allowLyra: boolean,
): Tier {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    const tier = TIERS[i]!;
    if (tier.codec === 'lyra' && !allowLyra) continue;
    if (tierFits(seconds, tier, spec)) return tier;
  }
  throw new Error('audio too large to fit on a card');
}

export type LayoutWarning = 'module-below-0.30' | 'module-below-0.25' | 'texture-cramped';

export interface CardSpec {
  widthMm?: number;
  heightMm?: number;
  /** outer margin around all codes */
  marginMm?: number;
  inverted: boolean;
  /** Lay the card out for a textured back: widen the space between codes so
   * the pixel field can reach full density between them, paid for out of
   * surplus module size (see planCard). */
  textured?: boolean;
}

export interface CellPlacement {
  col: number;
  row: number;
  kind: 'chunk' | 'entry';
  /** chunk index for kind 'chunk' */
  index?: number;
  /** top-left of the QR symbol itself (quiet zone excluded), mm */
  xMm: number;
  yMm: number;
  /** rendered size of the QR symbol, mm */
  sizeMm: number;
}

export interface CardPlan {
  widthMm: number;
  heightMm: number;
  qrVersion: number;
  chunkCount: number;
  payloadPerChunk: number;
  grid: { cols: number; rows: number };
  moduleMm: number;
  /** light modules between a symbol and its cell edge (half the code-to-code
   * gap) — wider on a textured back so the field has room to live there */
  gutterModules: number;
  /** modules across a chunk QR symbol (17 + 4·version) */
  symbolModules: number;
  cells: CellPlacement[];
  warnings: LayoutWarning[];
}

/** modules of quiet zone kept between adjacent symbols (per side) */
const QUIET_MODULES = 3;

/** Per-side gutters the textured back tries, widest first. The field needs
 * roughly 3 clean modules + a fade either side of a code before it can reach
 * full density, so 7 buys a few modules of real static between neighbours; 5
 * gets a thinner seam; 3 is the plain-card spacing (field only in the margins
 * and any unused cell). */
const TEXTURE_GUTTER_LADDER = [7, 5, 3] as const;

/** A textured card stops growing modules here and spends the rest on space for
 * the field: a short clip can otherwise end up with dots far larger than any
 * engraver or phone camera was struggling with. */
const TEXTURE_MODULE_CAP_MM = 0.35;

/** …but never below this. Wide gutters are cosmetic; scanning is not — so the
 * field may not push a card below the universal scannability floor. */
const TEXTURE_MODULE_FLOOR_MM = MODULE_FLOOR_MM;

export function maxChunkBytesForVersion(version: number): number {
  return maxBytesForChars(alnumCapacityL(version));
}

/**
 * Choose the card geometry. A plain back keeps the historical behaviour:
 * maximise module size at the standard gutter. A textured back walks the gutter
 * ladder widest-first and takes the roomiest spacing whose modules still clear
 * the comfort floor — so the field gets space only where the clip left some,
 * and a dense clip silently falls back to the plain geometry rather than
 * trading away scannability for looks.
 */
export function planCard(totalBytes: number, spec: CardSpec): CardPlan {
  if (!spec.textured) return planAtGutter(totalBytes, spec, QUIET_MODULES);
  for (const gutter of TEXTURE_GUTTER_LADDER) {
    let plan: CardPlan;
    try {
      plan = planAtGutter(totalBytes, spec, gutter, TEXTURE_MODULE_CAP_MM);
    } catch {
      continue; // this spacing doesn't fit the card at all
    }
    if (plan.moduleMm < TEXTURE_MODULE_FLOOR_MM) continue;
    if (gutter === QUIET_MODULES) plan.warnings.push('texture-cramped');
    return plan;
  }
  const plan = planAtGutter(totalBytes, spec, QUIET_MODULES);
  plan.warnings.push('texture-cramped');
  return plan;
}

function planAtGutter(
  totalBytes: number,
  spec: CardSpec,
  gutterModules: number,
  cap?: number,
): CardPlan {
  const widthMm = spec.widthMm ?? CARD_W_MM;
  const heightMm = spec.heightMm ?? CARD_H_MM;
  // Every millimetre of margin is module size the codes never get: at the
  // 4-column layout a standard card ends up in, 1 mm off each side is ~2.5%
  // more dot. 3 mm is still a normal safe zone for trimming and engraver
  // alignment; a textured back has no white border left to protect, so its
  // codes can sit a little closer to the trim edge still.
  const marginMm = spec.marginMm ?? (spec.textured ? 2.5 : 3);

  const usableW = widthMm - 2 * marginMm;
  const usableH = heightMm - 2 * marginMm;

  interface Candidate {
    version: number;
    chunks: number;
    payloadPerChunk: number;
    cols: number;
    rows: number;
    /** the size actually rendered — the fitted module size, capped */
    moduleMm: number;
  }

  const evaluate = (): Candidate | null => {
    let best: Candidate | null = null;
    for (let version = 2; version <= 16; version++) {
      const chunkBytes = maxChunkBytesForVersion(version);
      const payloadPerChunk = chunkBytes - HEADER_BYTES;
      if (payloadPerChunk < 1) continue;
      const chunks = Math.max(1, Math.ceil(totalBytes / payloadPerChunk));
      if (chunks > 255) continue;
      const cellsNeeded = chunks + 1; // + entry QR
      const symbolModules = 17 + 4 * version;
      // each cell = symbol + shared quiet zone spacing
      const cellModules = symbolModules + 2 * gutterModules;
      for (let cols = 1; cols <= 12; cols++) {
        const rows = Math.ceil(cellsNeeded / cols);
        const cellMm = Math.min(usableW / cols, usableH / rows);
        if (cellMm <= 0) continue;
        const fitted = cellMm / cellModules;
        // Candidates that all reach the cap are equally scannable, so the
        // tie-break (fewest codes) is what picks among them.
        const moduleMm = cap === undefined ? fitted : Math.min(fitted, cap);
        if (!best || moduleMm > best.moduleMm ||
            (moduleMm === best.moduleMm && chunks < best.chunks)) {
          best = { version, chunks, payloadPerChunk, cols, rows, moduleMm };
        }
      }
    }
    return best;
  };

  const warnings: LayoutWarning[] = [];
  const chosen = evaluate();
  if (!chosen) throw new Error('audio too large to fit on a card');

  if (chosen.moduleMm < 0.25) warnings.push('module-below-0.25');
  else if (chosen.moduleMm < 0.3) warnings.push('module-below-0.30');

  const { version, chunks, payloadPerChunk, cols, rows, moduleMm } = chosen;
  const symbolModules = 17 + 4 * version;
  const symbolMm = symbolModules * moduleMm;
  const cellMm = (symbolModules + 2 * gutterModules) * moduleMm;

  // Center the grid inside the usable area.
  const gridW = cols * cellMm;
  const gridH = rows * cellMm;
  const x0 = marginMm + (usableW - gridW) / 2;
  const y0 = marginMm + (usableH - gridH) / 2;

  const cells: CellPlacement[] = [];
  const cellsNeeded = chunks + 1;
  for (let i = 0; i < cellsNeeded; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const xMm = x0 + col * cellMm + gutterModules * moduleMm;
    const yMm = y0 + row * cellMm + gutterModules * moduleMm;
    if (i === 0) {
      cells.push({ col, row, kind: 'entry', xMm, yMm, sizeMm: symbolMm });
    } else {
      cells.push({ col, row, kind: 'chunk', index: i - 1, xMm, yMm, sizeMm: symbolMm });
    }
  }

  return {
    widthMm,
    heightMm,
    qrVersion: version,
    chunkCount: chunks,
    payloadPerChunk,
    grid: { cols, rows },
    moduleMm,
    gutterModules,
    symbolModules,
    cells,
    warnings,
  };
}
