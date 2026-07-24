import { describe, expect, it } from 'vitest';
import { splitPayload } from '../src/lib/chunk';
import { CARD_H_MM, CARD_W_MM, planCard, TIERS } from '../src/lib/layout';
import { chunkMatrix, entryMatrix } from '../src/lib/qr';
import { cardTexture, type RenderInput } from '../src/lib/render';
import { buildTexture, textureRects, type Rect, type TextureSpec } from '../src/lib/texture';

const PLAYER_URL = 'https://gmfennema.github.io/momento/#p';

/** Deterministic stand-in for encoded audio. */
function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  let seed = 0x12345678;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    b[i] = seed >>> 24;
  }
  return b;
}

function baseSpec(over: Partial<TextureSpec> = {}): TextureSpec {
  return {
    widthMm: CARD_W_MM,
    heightMm: CARD_H_MM,
    moduleMm: 0.33,
    latticeXMm: 3.2,
    latticeYMm: 4.1,
    exclusions: [[20, 12, 30, 20]],
    seed: 0xc0de,
    ...over,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a[0] < b[0] + b[2] - 1e-9 &&
    b[0] < a[0] + a[2] - 1e-9 &&
    a[1] < b[1] + b[3] - 1e-9 &&
    b[1] < a[1] + a[3] - 1e-9
  );
}

describe('buildTexture', () => {
  it('never enters an exclusion rect', () => {
    const spec = baseSpec({
      exclusions: [
        [5, 5, 20, 15],
        [40, 25, 25, 18],
        [0, 46, CARD_W_MM, 4],
      ],
    });
    const rects = textureRects(buildTexture(spec));
    expect(rects.length).toBeGreaterThan(100);
    for (const r of rects) {
      for (const ex of spec.exclusions) expect(overlaps(r, ex)).toBe(false);
    }
  });

  it('stays inside the card', () => {
    for (const r of textureRects(buildTexture(baseSpec()))) {
      expect(r[0]).toBeGreaterThanOrEqual(0);
      expect(r[1]).toBeGreaterThanOrEqual(0);
      expect(r[0] + r[2]).toBeLessThanOrEqual(CARD_W_MM + 1e-9);
      expect(r[1] + r[3]).toBeLessThanOrEqual(CARD_H_MM + 1e-9);
    }
  });

  it('aligns to the QR module lattice', () => {
    const spec = baseSpec();
    const field = buildTexture(spec);
    // Cell edges must fall a whole number of modules from the anchor, or the
    // field would sit half a dot off the codes and read as a separate layer.
    const offsetX = (spec.latticeXMm - field.originXMm) / spec.moduleMm;
    const offsetY = (spec.latticeYMm - field.originYMm) / spec.moduleMm;
    expect(Math.abs(offsetX - Math.round(offsetX))).toBeLessThan(1e-9);
    expect(Math.abs(offsetY - Math.round(offsetY))).toBeLessThan(1e-9);
    // …and the field must start off-card on both axes so it bleeds to the trim.
    expect(field.originXMm).toBeLessThan(0);
    expect(field.originYMm).toBeLessThan(0);
  });

  it('is deterministic per seed and varies across seeds', () => {
    const a = buildTexture(baseSpec());
    const b = buildTexture(baseSpec());
    const c = buildTexture(baseSpec({ seed: 0xbeef }));
    expect(Array.from(a.dark)).toEqual(Array.from(b.dark));
    expect(Array.from(a.dark)).not.toEqual(Array.from(c.dark));
    expect(a.coverage).toBeGreaterThan(0.05);
    expect(a.coverage).toBeLessThan(0.5);
  });

  it('caps dark runs in both axes', () => {
    const field = buildTexture(baseSpec({ maxRun: 4 }));
    const { cols, rows, dark } = field;
    const longest = (get: (i: number, j: number) => number, outer: number, inner: number) => {
      let max = 0;
      for (let i = 0; i < outer; i++) {
        let run = 0;
        for (let j = 0; j < inner; j++) {
          run = get(i, j) ? run + 1 : 0;
          if (run > max) max = run;
        }
      }
      return max;
    };
    expect(longest((r, c) => dark[r * cols + c]!, rows, cols)).toBeLessThanOrEqual(4);
    expect(longest((c, r) => dark[r * cols + c]!, cols, rows)).toBeLessThanOrEqual(4);
  });

  it('fades in: cells near an exclusion are sparser than cells far from one', () => {
    const ex: Rect = [30, 15, 25, 20];
    const field = buildTexture(baseSpec({ exclusions: [ex], edgeFadeMm: 0 }));
    const { cols, rows, moduleMm, originXMm, originYMm, dark } = field;
    let nearDark = 0;
    let nearTotal = 0;
    let farDark = 0;
    let farTotal = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = originXMm + (c + 0.5) * moduleMm;
        const y = originYMm + (r + 0.5) * moduleMm;
        const dx = Math.max(ex[0] - x, x - (ex[0] + ex[2]), 0);
        const dy = Math.max(ex[1] - y, y - (ex[1] + ex[3]), 0);
        const gap = Math.hypot(dx, dy) / moduleMm;
        if (gap === 0) continue;
        const bin = gap < 2 ? 'near' : gap > 8 ? 'far' : null;
        if (bin === 'near') {
          nearTotal++;
          nearDark += dark[r * cols + c]!;
        } else if (bin === 'far') {
          farTotal++;
          farDark += dark[r * cols + c]!;
        }
      }
    }
    expect(nearTotal).toBeGreaterThan(20);
    expect(farTotal).toBeGreaterThan(20);
    expect(nearDark / nearTotal).toBeLessThan(farDark / farTotal);
  });

  it('an all-excluded card yields nothing', () => {
    const field = buildTexture(baseSpec({ exclusions: [[0, 0, CARD_W_MM, CARD_H_MM]] }));
    expect(field.coverage).toBe(0);
    expect(textureRects(field)).toEqual([]);
  });
});

describe('cardTexture (placed on a real plan)', () => {
  const cases = TIERS.flatMap((tier) =>
    [false, true].map((inverted) => ({ tier, inverted })),
  );

  for (const { tier, inverted } of cases) {
    it(`${tier.key}${inverted ? ' inverted' : ''}: keeps every code's quiet zone clear`, () => {
      const bits = bytes(10 * tier.bytesPerSec);
      const plan = planCard(bits.length, { inverted, textured: true });
      const chunks = splitPayload(bits, tier.wireVersion, tier.modeId, plan.payloadPerChunk, 0xc0de);
      const input: RenderInput = {
        plan,
        matrices: chunks.map((c) => chunkMatrix(c, plan.qrVersion)),
        entry: entryMatrix(PLAYER_URL),
        inverted,
        texture: { seed: 0xc0de },
      };
      const field = cardTexture(input);
      expect(field).not.toBeNull();
      expect(field!.rects.length).toBeGreaterThan(100);

      // Non-inverted codes need 3 clear modules; inverted ones carry their own
      // dark plate (3.25 modules), which is the quiet zone after the scanner
      // inverts the image, so the field may run up to the plate edge.
      const clearMm = inverted ? 0 : 3 * plan.moduleMm;
      for (const cell of plan.cells) {
        const guard: Rect = [
          cell.xMm - clearMm,
          cell.yMm - clearMm,
          cell.sizeMm + 2 * clearMm,
          cell.sizeMm + 2 * clearMm,
        ];
        for (const r of field!.rects) expect(overlaps(r, guard)).toBe(false);
      }
    });
  }

  it('is absent when the back is left plain', () => {
    const bits = bytes(1000);
    const tier = TIERS[0]!;
    const plan = planCard(bits.length, { inverted: false });
    const chunks = splitPayload(bits, tier.wireVersion, tier.modeId, plan.payloadPerChunk, 1);
    expect(
      cardTexture({
        plan,
        matrices: chunks.map((c) => chunkMatrix(c, plan.qrVersion)),
        entry: entryMatrix(PLAYER_URL),
        inverted: false,
      }),
    ).toBeNull();
  });
});
