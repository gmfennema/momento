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

/** Width of the entry-strip column (also the cell size of the small top-up
 * codes stacked under the entry code). 14 mm keeps the entry QR comfortably
 * phone-scannable while freeing the rest of the card for audio; it also fits
 * two stacked small codes inside the card height, which is what pushes the
 * Lyra-capable clip length past 8 s. */
export const ENTRY_STRIP_MM = 14;
/** Fixed quiet border around the entry symbol inside its strip cell — the
 * entry QR is low-version, so its own modules (not the chunks') set the quiet
 * zone it needs. */
const ENTRY_INSET_MM = 1.5;

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

/** Per-chunk QR version and payload capacity, in chunk-index order. All
 * chunks share one version on a classic grid card; an entry-strip card
 * appends smaller top-up codes with their own version. */
export interface ChunkSpec {
  qrVersion: number;
  payloadBytes: number;
}

export interface CardPlan {
  widthMm: number;
  heightMm: number;
  /** QR version of the main (grid) chunks */
  qrVersion: number;
  chunkCount: number;
  /** payload capacity of a main-grid chunk */
  payloadPerChunk: number;
  /** one entry per chunk, in index order — the source of truth for splitting */
  chunkSpecs: ChunkSpec[];
  grid: { cols: number; rows: number };
  /** smallest module on the card (what scannability warnings key off) */
  moduleMm: number;
  /** modules across a main-grid chunk QR symbol (17 + 4·version) */
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

interface GridCandidate {
  family: 'grid';
  version: number;
  chunks: number;
  payloadPerChunk: number;
  cols: number;
  rows: number;
  moduleMm: number;
  withText: boolean;
}

/** Entry QR lives in a narrow left column instead of a full grid cell; the
 * leftover column height holds small "top-up" chunk codes. The main chunks
 * get the rest of the card at a lower QR version → bigger modules. */
interface StripCandidate {
  family: 'strip';
  version: number;
  chunks: number;
  payloadPerChunk: number;
  cols: number;
  rows: number;
  /** smallest module on the card: min(main grid, top-up codes) */
  moduleMm: number;
  withText: boolean;
  bigChunks: number;
  smallVersion: number;
  smallCount: number;
  smallPayload: number;
}

type Candidate = GridCandidate | StripCandidate;

export function planCard(totalBytes: number, spec: CardSpec): CardPlan {
  const widthMm = spec.widthMm ?? CARD_W_MM;
  const heightMm = spec.heightMm ?? CARD_H_MM;
  const marginMm = spec.marginMm ?? 4;

  const usableW = widthMm - 2 * marginMm;

  const evaluate = (withText: boolean): Candidate | null => {
    const usableH = heightMm - 2 * marginMm - (withText ? TEXT_STRIP_MM : 0);
    let best: Candidate | null = null;
    const consider = (c: Candidate): void => {
      if (!best || c.moduleMm > best.moduleMm ||
          (c.moduleMm === best.moduleMm && c.chunks < best.chunks)) {
        best = c;
      }
    };

    // Family 1: classic uniform grid, entry QR occupying one cell.
    for (let version = 2; version <= 16; version++) {
      const payloadPerChunk = maxChunkBytesForVersion(version) - HEADER_BYTES;
      if (payloadPerChunk < 1) continue;
      const chunks = Math.max(1, Math.ceil(totalBytes / payloadPerChunk));
      if (chunks > 255) continue;
      const cellsNeeded = chunks + 1; // + entry QR
      // each cell = symbol + shared quiet zone spacing
      const cellModules = 17 + 4 * version + 2 * QUIET_MODULES;
      for (let cols = 1; cols <= 12; cols++) {
        const rows = Math.ceil(cellsNeeded / cols);
        const cellMm = Math.min(usableW / cols, usableH / rows);
        if (cellMm <= 0) continue;
        consider({
          family: 'grid', version, chunks, payloadPerChunk, cols, rows,
          moduleMm: cellMm / cellModules, withText,
        });
      }
    }

    // Family 2: entry strip. Considered second, so on an exact module tie the
    // simpler classic grid wins.
    const stripW = usableW - ENTRY_STRIP_MM;
    const maxSmall = Math.floor((usableH - ENTRY_STRIP_MM) / ENTRY_STRIP_MM);
    if (stripW > 0 && usableH >= ENTRY_STRIP_MM) {
      for (let version = 2; version <= 16; version++) {
        const payloadPerChunk = maxChunkBytesForVersion(version) - HEADER_BYTES;
        if (payloadPerChunk < 1) continue;
        const cellModules = 17 + 4 * version + 2 * QUIET_MODULES;
        const maxBig = Math.min(255, Math.ceil(totalBytes / payloadPerChunk));
        for (let bigChunks = 1; bigChunks <= maxBig; bigChunks++) {
          const leftover = totalBytes - bigChunks * payloadPerChunk;
          // Either the main grid alone covers the payload (only legal when no
          // big chunk would be empty), or top-up codes at version u cover the
          // leftover. Every chunk of a plan carries data — the split fills
          // main chunks first, so only the very last chunk may run short.
          const variants: Array<{ smallVersion: number; smallCount: number; smallPayload: number }> = [];
          if (leftover <= 0) {
            if (bigChunks === maxBig) variants.push({ smallVersion: 0, smallCount: 0, smallPayload: 0 });
          } else {
            for (let u = 2; u <= 16; u++) {
              const smallPayload = maxChunkBytesForVersion(u) - HEADER_BYTES;
              if (smallPayload < 1) continue;
              const smallCount = Math.ceil(leftover / smallPayload);
              if (smallCount > maxSmall || bigChunks + smallCount > 255) continue;
              variants.push({ smallVersion: u, smallCount, smallPayload });
            }
          }
          for (const v of variants) {
            const smallModuleMm = v.smallCount > 0
              ? ENTRY_STRIP_MM / (17 + 4 * v.smallVersion + 2 * QUIET_MODULES)
              : Infinity;
            for (let cols = 1; cols <= 12; cols++) {
              const rows = Math.ceil(bigChunks / cols);
              const cellMm = Math.min(stripW / cols, usableH / rows);
              if (cellMm <= 0) continue;
              consider({
                family: 'strip', version, chunks: bigChunks + v.smallCount,
                payloadPerChunk, cols, rows,
                moduleMm: Math.min(cellMm / cellModules, smallModuleMm),
                withText, bigChunks,
                smallVersion: v.smallVersion, smallCount: v.smallCount,
                smallPayload: v.smallPayload,
              });
            }
          }
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

  const usableH = heightMm - 2 * marginMm - (chosen.withText ? TEXT_STRIP_MM : 0);
  const { version, chunks, payloadPerChunk, cols, rows } = chosen;
  const symbolModules = 17 + 4 * version;

  const cells: CellPlacement[] = [];
  const chunkSpecs: ChunkSpec[] = [];
  let textYMm: number | undefined;

  if (chosen.family === 'grid') {
    const { moduleMm } = chosen;
    const symbolMm = symbolModules * moduleMm;
    const cellMm = (symbolModules + 2 * QUIET_MODULES) * moduleMm;
    // Center the grid inside the usable area.
    const gridW = cols * cellMm;
    const gridH = rows * cellMm;
    const x0 = marginMm + (usableW - gridW) / 2;
    const y0 = marginMm + (usableH - gridH) / 2;
    for (let i = 0; i < chunks + 1; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const xMm = x0 + col * cellMm + QUIET_MODULES * moduleMm;
      const yMm = y0 + row * cellMm + QUIET_MODULES * moduleMm;
      if (i === 0) {
        cells.push({ col, row, kind: 'entry', xMm, yMm, sizeMm: symbolMm });
      } else {
        cells.push({ col, row, kind: 'chunk', index: i - 1, xMm, yMm, sizeMm: symbolMm });
        chunkSpecs.push({ qrVersion: version, payloadBytes: payloadPerChunk });
      }
    }
    textYMm = chosen.withText ? y0 + gridH + TEXT_STRIP_MM / 2 : undefined;
  } else {
    const { bigChunks, smallVersion, smallCount, smallPayload } = chosen;
    const E = ENTRY_STRIP_MM;
    const stripW = usableW - E;
    // Main grid, centered in the area right of the strip.
    const cellMm = Math.min(stripW / cols, usableH / rows);
    const bigModuleMm = cellMm / (symbolModules + 2 * QUIET_MODULES);
    const symbolMm = symbolModules * bigModuleMm;
    const gridW = cols * cellMm;
    const gridH = rows * cellMm;
    const x0 = marginMm + E + (stripW - gridW) / 2;
    const y0 = marginMm + (usableH - gridH) / 2;
    // Strip stack (entry on top, small codes below), centered vertically.
    const stackH = E * (1 + smallCount);
    const sy0 = marginMm + (usableH - stackH) / 2;
    cells.push({
      col: 0, row: 0, kind: 'entry',
      xMm: marginMm + ENTRY_INSET_MM,
      yMm: sy0 + ENTRY_INSET_MM,
      sizeMm: E - 2 * ENTRY_INSET_MM,
    });
    for (let i = 0; i < bigChunks; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      cells.push({
        col, row, kind: 'chunk', index: i,
        xMm: x0 + col * cellMm + QUIET_MODULES * bigModuleMm,
        yMm: y0 + row * cellMm + QUIET_MODULES * bigModuleMm,
        sizeMm: symbolMm,
      });
      chunkSpecs.push({ qrVersion: version, payloadBytes: payloadPerChunk });
    }
    const smallModuleMm = E / (17 + 4 * smallVersion + 2 * QUIET_MODULES);
    for (let j = 0; j < smallCount; j++) {
      cells.push({
        col: 0, row: 1 + j, kind: 'chunk', index: bigChunks + j,
        xMm: marginMm + QUIET_MODULES * smallModuleMm,
        yMm: sy0 + E * (1 + j) + QUIET_MODULES * smallModuleMm,
        sizeMm: (17 + 4 * smallVersion) * smallModuleMm,
      });
      chunkSpecs.push({ qrVersion: smallVersion, payloadBytes: smallPayload });
    }
    // The name line keeps its reserved strip along the card bottom.
    textYMm = chosen.withText ? marginMm + usableH + TEXT_STRIP_MM / 2 : undefined;
  }

  return {
    widthMm,
    heightMm,
    qrVersion: version,
    chunkCount: chunks,
    payloadPerChunk,
    chunkSpecs,
    grid: { cols, rows },
    moduleMm: chosen.moduleMm,
    symbolModules,
    cells,
    textLine: chosen.withText ? spec.textLine!.trim() : undefined,
    textYMm,
    textHeightMm: chosen.withText ? TEXT_STRIP_MM * 0.6 : undefined,
    warnings,
  };
}
