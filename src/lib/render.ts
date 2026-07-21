// Card rendering — one geometry, two outputs (SVG for laser software, canvas
// for PNG/preview). Adjacent dark modules in a row are merged into single
// rects so the SVG stays small and gap-free for engraving tools.
//
// The card background is ALWAYS white: laser software engraves the dark
// areas, so a black background would engrave the entire card. Inverted mode
// (for black card stock) instead draws a dark plate per QR — symbol plus
// quiet zone — and knocks the modules out in white, so only the code tiles
// get engraved.

import type { BitMatrix } from './qr';
import type { CardPlan, CellPlacement } from './layout';

export interface RenderInput {
  plan: CardPlan;
  /** matrices[i] belongs to chunk index i */
  matrices: BitMatrix[];
  entry: BitMatrix;
  inverted: boolean;
  entryLabel?: string;
}

/** fraction of the entry cell reserved for the "scan me" label strip */
const ENTRY_LABEL_FRACTION = 0.2;

/** Quiet-zone modules included in an inverted symbol's dark plate. Matches
 * layout's inter-symbol spacing (3 per side), plus a quarter module of
 * overlap so adjacent plates merge without hairline seams. */
const PLATE_QUIET_MODULES = 3.25;

interface PlacedSymbol {
  matrix: BitMatrix;
  xMm: number;
  yMm: number;
  sizeMm: number;
  /** dark backdrop for inverted rendering — symbol plus quiet zone (and, for
   * the entry, its label strip); [x, y, w, h] in mm */
  plate: [number, number, number, number];
}

interface EntryGeometry {
  symbol: PlacedSymbol;
  labelXMm: number;
  labelYMm: number;
  labelHeightMm: number;
  labelWidthMm: number;
}

function placeSymbols(input: RenderInput): { symbols: PlacedSymbol[]; entryGeom: EntryGeometry } {
  const symbols: PlacedSymbol[] = [];
  let entryGeom: EntryGeometry | null = null;
  for (const cell of input.plan.cells) {
    if (cell.kind === 'chunk') {
      const m = input.matrices[cell.index!];
      if (!m) throw new Error(`missing matrix for chunk ${cell.index}`);
      const quietMm = (cell.sizeMm / m.size) * PLATE_QUIET_MODULES;
      symbols.push({
        matrix: m,
        xMm: cell.xMm,
        yMm: cell.yMm,
        sizeMm: cell.sizeMm,
        plate: [
          cell.xMm - quietMm,
          cell.yMm - quietMm,
          cell.sizeMm + 2 * quietMm,
          cell.sizeMm + 2 * quietMm,
        ],
      });
    } else {
      // Entry QR is a lower version than the chunk codes, so it can afford to
      // give up a strip for the label and still have far larger modules.
      const label = input.entryLabel ?? 'SCAN TO LISTEN';
      const qrSize = cell.sizeMm * (label ? 1 - ENTRY_LABEL_FRACTION : 1);
      const quietMm = (qrSize / input.entry.size) * PLATE_QUIET_MODULES;
      const symbol: PlacedSymbol = {
        matrix: input.entry,
        xMm: cell.xMm + (cell.sizeMm - qrSize) / 2,
        yMm: cell.yMm,
        sizeMm: qrSize,
        // spans the whole entry cell so the label strip sits on the plate too
        plate: [
          cell.xMm - quietMm,
          cell.yMm - quietMm,
          cell.sizeMm + 2 * quietMm,
          cell.sizeMm + 2 * quietMm,
        ],
      };
      symbols.push(symbol);
      entryGeom = {
        symbol,
        labelXMm: cell.xMm + cell.sizeMm / 2,
        labelYMm: cell.yMm + qrSize + (cell.sizeMm - qrSize) * 0.55,
        labelHeightMm: Math.min(2.2, (cell.sizeMm - qrSize) * 0.7),
        labelWidthMm: cell.sizeMm,
      };
    }
  }
  if (!entryGeom) throw new Error('plan has no entry cell');
  return { symbols, entryGeom };
}

/** Merge each matrix row's dark runs into rects; returns [x, y, w, h] in mm. */
function symbolRects(s: PlacedSymbol): Array<[number, number, number, number]> {
  const rects: Array<[number, number, number, number]> = [];
  const module = s.sizeMm / s.matrix.size;
  for (let row = 0; row < s.matrix.size; row++) {
    let runStart = -1;
    for (let col = 0; col <= s.matrix.size; col++) {
      const dark = col < s.matrix.size && s.matrix.get(row, col);
      if (dark && runStart === -1) runStart = col;
      if (!dark && runStart !== -1) {
        rects.push([
          s.xMm + runStart * module,
          s.yMm + row * module,
          (col - runStart) * module,
          module,
        ]);
        runStart = -1;
      }
    }
  }
  return rects;
}

const FONT_STACK = 'Helvetica, Arial, sans-serif';

export function renderSvg(input: RenderInput): string {
  const { plan, inverted } = input;
  const { symbols, entryGeom } = placeSymbols(input);
  const fg = inverted ? '#ffffff' : '#000000';
  const fmt = (n: number) => Number(n.toFixed(4));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.widthMm}mm" height="${plan.heightMm}mm" ` +
      `viewBox="0 0 ${plan.widthMm} ${plan.heightMm}" shape-rendering="crispEdges">`,
    `<rect width="${plan.widthMm}" height="${plan.heightMm}" fill="#ffffff"/>`,
  );
  if (inverted) {
    const plates = symbols
      .map(({ plate: [x, y, w, h] }) => `M${fmt(x)} ${fmt(y)}h${fmt(w)}v${fmt(h)}h${fmt(-w)}z`)
      .join('');
    parts.push(`<path d="${plates}" fill="#000000"/>`);
  }
  for (const s of symbols) {
    // Slight overlap (2% of a module) between vertically adjacent rects kills
    // hairline gaps in rasterizers and laser software.
    const bleed = (s.sizeMm / s.matrix.size) * 0.02;
    const d = symbolRects(s)
      .map(
        ([x, y, w, h]) =>
          `M${fmt(x)} ${fmt(y)}h${fmt(w)}v${fmt(h + bleed)}h${fmt(-w)}z`,
      )
      .join('');
    parts.push(`<path d="${d}" fill="${fg}"/>`);
  }
  const label = input.entryLabel ?? 'SCAN TO LISTEN';
  if (label) {
    parts.push(
      `<text x="${fmt(entryGeom.labelXMm)}" y="${fmt(entryGeom.labelYMm)}" ` +
        `font-family="${FONT_STACK}" font-size="${fmt(entryGeom.labelHeightMm)}" ` +
        `font-weight="bold" text-anchor="middle" dominant-baseline="middle" ` +
        `textLength="${fmt(entryGeom.labelWidthMm * 0.95)}" lengthAdjust="spacingAndGlyphs" ` +
        `fill="${fg}">${escapeXml(label)}</text>`,
    );
  }
  if (plan.textLine && plan.textYMm !== undefined && plan.textHeightMm !== undefined) {
    // The name line sits on the (always white) background, never on a plate.
    parts.push(
      `<text x="${fmt(plan.widthMm / 2)}" y="${fmt(plan.textYMm)}" ` +
        `font-family="${FONT_STACK}" font-size="${fmt(plan.textHeightMm)}" ` +
        `text-anchor="middle" dominant-baseline="middle" fill="#000000">` +
        `${escapeXml(plan.textLine)}</text>`,
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Draw the card onto a canvas 2D context at `pxPerMm`. Used for both the live
 * preview and the high-DPI PNG export (1200 dpi ≈ 47.24 px/mm).
 */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  pxPerMm: number,
): void {
  const { plan, inverted } = input;
  const { symbols, entryGeom } = placeSymbols(input);
  const fg = inverted ? '#ffffff' : '#000000';
  const W = Math.round(plan.widthMm * pxPerMm);
  const H = Math.round(plan.heightMm * pxPerMm);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (inverted) {
    ctx.fillStyle = '#000000';
    for (const { plate: [x, y, w, h] } of symbols) {
      ctx.fillRect(
        Math.round(x * pxPerMm),
        Math.round(y * pxPerMm),
        Math.round(w * pxPerMm),
        Math.round(h * pxPerMm),
      );
    }
  }
  ctx.fillStyle = fg;

  for (const s of symbols) {
    // Integer-aligned module grid: distribute pixels so edges stay crisp.
    const x0 = s.xMm * pxPerMm;
    const y0 = s.yMm * pxPerMm;
    const modulePx = (s.sizeMm * pxPerMm) / s.matrix.size;
    const edge = (i: number) => Math.round(x0 + i * modulePx);
    const edgeY = (i: number) => Math.round(y0 + i * modulePx);
    for (let row = 0; row < s.matrix.size; row++) {
      let runStart = -1;
      for (let col = 0; col <= s.matrix.size; col++) {
        const dark = col < s.matrix.size && s.matrix.get(row, col);
        if (dark && runStart === -1) runStart = col;
        if (!dark && runStart !== -1) {
          ctx.fillRect(
            edge(runStart),
            edgeY(row),
            edge(col) - edge(runStart),
            edgeY(row + 1) - edgeY(row),
          );
          runStart = -1;
        }
      }
    }
  }

  const label = input.entryLabel ?? 'SCAN TO LISTEN';
  if (label) {
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${entryGeom.labelHeightMm * pxPerMm}px ${FONT_STACK}`;
    const maxWidth = entryGeom.labelWidthMm * 0.95 * pxPerMm;
    ctx.fillText(label, entryGeom.labelXMm * pxPerMm, entryGeom.labelYMm * pxPerMm, maxWidth);
  }
  if (plan.textLine && plan.textYMm !== undefined && plan.textHeightMm !== undefined) {
    // The name line sits on the (always white) background, never on a plate.
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${plan.textHeightMm * pxPerMm}px ${FONT_STACK}`;
    ctx.fillText(plan.textLine, (plan.widthMm / 2) * pxPerMm, plan.textYMm * pxPerMm);
  }
}
