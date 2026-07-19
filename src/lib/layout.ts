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
import { LYRA_BYTES_PER_SEC } from './lyra';

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
  key: 'compact' | 'balanced' | 'best';
  wireVersion: number;
  modeId: CodecModeId;
  bytesPerSec: number;
  label: string;
  blurb: string;
}

export type Tier = TierBase &
  ({ codec: 'codec2'; mode: Codec2Mode } | { codec: 'lyra' });

export const TIERS: readonly Tier[] = [
  {
    key: 'compact',
    codec: 'codec2',
    mode: '700C',
    wireVersion: WIRE_CODEC2,
    modeId: 6,
    bytesPerSec: 100,
    label: 'Compact',
    blurb: 'Smallest codes, easiest to engrave & scan. Voice sounds robotic.',
  },
  {
    key: 'balanced',
    codec: 'codec2',
    mode: '1600',
    wireVersion: WIRE_CODEC2,
    modeId: 2,
    bytesPerSec: 200,
    label: 'Balanced',
    blurb: 'Decent speech quality with comfortably scannable codes.',
  },
  {
    key: 'best',
    codec: 'lyra',
    wireVersion: WIRE_LYRA,
    modeId: LYRA_MODE_3200,
    bytesPerSec: LYRA_BYTES_PER_SEC,
    label: 'Best',
    blurb: 'Natural, clear voice (Lyra neural codec). Denser card; playback needs a modern phone.',
  },
] as const;

/** Conservative payload estimate for planning before the real encode exists.
 * Codec 2 output wobbles a few bytes around the nominal rate and the Lyra
 * path pads to whole 20 ms frames (< 16 bytes either way), so plan with slack
 * rather than let the real encode land one chunk denser than the tier
 * decision assumed. */
export function estimatePayloadBytes(seconds: number, tier: Tier): number {
  return Math.ceil(seconds * tier.bytesPerSec) + 16;
}

/** The auto tier refuses to go denser than this. 0.25 mm is where engravers
 * and phone cameras start genuinely failing (the hard warning); the softer
 * 0.30 mm comfort band is still allowed — those cards scan fine when cleanly
 * engraved, and the UI keeps its warning. */
export const AUTO_MODULE_FLOOR_MM = 0.25;

/** Pick the highest-quality tier whose card keeps modules at a reliably
 * scannable size for this clip length — i.e. spend the card's real capacity
 * instead of a fixed preset. Falls back to the least dense card when even the
 * compact tier is below the floor. */
export function pickAutoTier(
  seconds: number,
  spec: CardSpec,
  allowLyra: boolean,
): Tier {
  let fallback: { tier: Tier; moduleMm: number } | null = null;
  for (const tier of [...TIERS].reverse()) {
    if (tier.codec === 'lyra' && !allowLyra) continue;
    let plan: CardPlan;
    try {
      plan = planCard(estimatePayloadBytes(seconds, tier), spec);
    } catch {
      continue; // doesn't fit on the card at all
    }
    if (plan.moduleMm >= AUTO_MODULE_FLOOR_MM) return tier;
    if (!fallback || plan.moduleMm > fallback.moduleMm) fallback = { tier, moduleMm: plan.moduleMm };
  }
  if (!fallback) throw new Error('audio too large to fit on a card');
  return fallback.tier;
}

export type LayoutWarning = 'module-below-0.30' | 'module-below-0.25' | 'text-dropped';

export interface CardSpec {
  widthMm?: number;
  heightMm?: number;
  /** outer margin around all codes */
  marginMm?: number;
  textLine?: string;
  inverted: boolean;
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
  /** modules across a chunk QR symbol (17 + 4·version) */
  symbolModules: number;
  cells: CellPlacement[];
  textLine?: string;
  textYMm?: number;
  textHeightMm?: number;
  warnings: LayoutWarning[];
}

/** modules of quiet zone kept between adjacent symbols (per side) */
const QUIET_MODULES = 3;
const TEXT_STRIP_MM = 5;
/** below this the text strip is dropped instead of shrinking modules */
const MODULE_FLOOR_FOR_TEXT_MM = 0.3;

export function maxChunkBytesForVersion(version: number): number {
  return maxBytesForChars(alnumCapacityL(version));
}

export function planCard(totalBytes: number, spec: CardSpec): CardPlan {
  const widthMm = spec.widthMm ?? CARD_W_MM;
  const heightMm = spec.heightMm ?? CARD_H_MM;
  const marginMm = spec.marginMm ?? 4;

  const usableW = widthMm - 2 * marginMm;

  interface Candidate {
    version: number;
    chunks: number;
    payloadPerChunk: number;
    cols: number;
    rows: number;
    moduleMm: number;
    withText: boolean;
  }

  const evaluate = (withText: boolean): Candidate | null => {
    const usableH = heightMm - 2 * marginMm - (withText ? TEXT_STRIP_MM : 0);
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
      const cellModules = symbolModules + 2 * QUIET_MODULES;
      for (let cols = 1; cols <= 12; cols++) {
        const rows = Math.ceil(cellsNeeded / cols);
        const cellMm = Math.min(usableW / cols, usableH / rows);
        if (cellMm <= 0) continue;
        const moduleMm = cellMm / cellModules;
        if (!best || moduleMm > best.moduleMm ||
            (moduleMm === best.moduleMm && chunks < best.chunks)) {
          best = { version, chunks, payloadPerChunk, cols, rows, moduleMm, withText };
        }
      }
    }
    return best;
  };

  const warnings: LayoutWarning[] = [];
  const wantText = !!spec.textLine && spec.textLine.trim().length > 0;
  let chosen = evaluate(wantText);
  if (!chosen) throw new Error('audio too large to fit on a card');
  if (wantText && chosen.moduleMm < MODULE_FLOOR_FOR_TEXT_MM) {
    const withoutText = evaluate(false);
    if (withoutText && withoutText.moduleMm > chosen.moduleMm) {
      chosen = withoutText;
      warnings.push('text-dropped');
    }
  }

  if (chosen.moduleMm < 0.25) warnings.push('module-below-0.25');
  else if (chosen.moduleMm < 0.3) warnings.push('module-below-0.30');

  const { version, chunks, payloadPerChunk, cols, rows, moduleMm } = chosen;
  const symbolModules = 17 + 4 * version;
  const symbolMm = symbolModules * moduleMm;
  const cellMm = (symbolModules + 2 * QUIET_MODULES) * moduleMm;

  // Center the grid inside the usable area.
  const usableH = heightMm - 2 * marginMm - (chosen.withText ? TEXT_STRIP_MM : 0);
  const gridW = cols * cellMm;
  const gridH = rows * cellMm;
  const x0 = marginMm + (usableW - gridW) / 2;
  const y0 = marginMm + (usableH - gridH) / 2;

  const cells: CellPlacement[] = [];
  const cellsNeeded = chunks + 1;
  for (let i = 0; i < cellsNeeded; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const xMm = x0 + col * cellMm + QUIET_MODULES * moduleMm;
    const yMm = y0 + row * cellMm + QUIET_MODULES * moduleMm;
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
    symbolModules,
    cells,
    textLine: chosen.withText ? spec.textLine!.trim() : undefined,
    textYMm: chosen.withText ? y0 + gridH + TEXT_STRIP_MM / 2 : undefined,
    textHeightMm: chosen.withText ? TEXT_STRIP_MM * 0.6 : undefined,
    warnings,
  };
}
