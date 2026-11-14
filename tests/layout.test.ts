import { describe, expect, it } from 'vitest';
import { HEADER_BYTES } from '../src/lib/chunk';
import {
  bestTierThatFits,
  byteCapacityL,
  CARD_H_MM,
  CARD_W_MM,
  estimatePayloadBytes,
  MAX_SECONDS,
  maxChunkBytesForVersion,
  maxSecondsForTier,
  MIMI_MAX_DEPTH_ON_CARD,
  MIMI_MIN_DEPTH,
  mimiDepthFor,
  MODULE_FLOOR_MM,
  planCard,
  TIERS,
} from '../src/lib/layout';
import { mimiPayloadBytes } from '../src/lib/mimi';

describe('planCard', () => {
  for (const tier of TIERS) {
    const bytes = estimatePayloadBytes(10, tier);
    it(`produces a feasible plan for ${tier.key} (${bytes}B)`, () => {
      const plan = planCard(bytes, { inverted: false });
      expect(plan.chunkCount).toBeLessThanOrEqual(255);
      expect(plan.chunkCount * plan.payloadPerChunk).toBeGreaterThanOrEqual(bytes);
      // Largest chunk (header + payload) must fit the chosen QR version.
      const chunkBytes = HEADER_BYTES + plan.payloadPerChunk;
      expect(chunkBytes).toBeLessThanOrEqual(byteCapacityL(plan.qrVersion));
      // Every cell must lie inside the card.
      for (const cell of plan.cells) {
        expect(cell.xMm).toBeGreaterThanOrEqual(0);
        expect(cell.yMm).toBeGreaterThanOrEqual(0);
        expect(cell.xMm + cell.sizeMm).toBeLessThanOrEqual(CARD_W_MM);
        expect(cell.yMm + cell.sizeMm).toBeLessThanOrEqual(CARD_H_MM);
      }
      // Exactly one entry cell + chunkCount chunk cells.
      expect(plan.cells.filter((c) => c.kind === 'entry').length).toBe(1);
      expect(plan.cells.filter((c) => c.kind === 'chunk').length).toBe(plan.chunkCount);
      expect(plan.moduleMm).toBeGreaterThan(0.15);
    });
  }

  it('the basic tier at 10s stays at or above the 0.30mm scannability floor', () => {
    const plan = planCard(2000, { inverted: false });
    expect(plan.moduleMm).toBeGreaterThanOrEqual(0.3);
    expect(plan.warnings).not.toContain('module-below-0.30');
  });

  it('warns when modules get small (best tier)', () => {
    const plan = planCard(4000, { inverted: false });
    // 4KB is dense; expect the plan to be honest about it either way.
    if (plan.moduleMm < 0.3) {
      expect(
        plan.warnings.includes('module-below-0.30') || plan.warnings.includes('module-below-0.25'),
      ).toBe(true);
    }
  });

  it('reports the longest clip each tier can hold', () => {
    // Mimi at its shallowest depth holds a full clip; the depth it actually
    // gets is the card's to choose (see the mimiDepthFor tests).
    const expected: Record<string, number> = { best: 10, basic: 10 };
    for (const textured of [false, true]) {
      const spec = { inverted: false, textured };
      for (const tier of TIERS) {
        expect(maxSecondsForTier(tier, spec)).toBeCloseTo(expected[tier.key]!, 6);
      }
    }
  });

  it('the reported maximum is exactly where the floor is crossed', () => {
    for (const textured of [false, true]) {
      const spec = { inverted: false, textured };
      for (const tier of TIERS) {
        const max = maxSecondsForTier(tier, spec);
        expect(planCard(estimatePayloadBytes(max, tier), spec).moduleMm).toBeGreaterThanOrEqual(
          MODULE_FLOOR_MM,
        );
        if (max < MAX_SECONDS) {
          const over = Math.round((max + 0.1) * 10) / 10;
          let moduleMm = 0;
          try {
            moduleMm = planCard(estimatePayloadBytes(over, tier), spec).moduleMm;
          } catch {
            moduleMm = 0; // doesn't fit at all, which is well under the floor
          }
          expect(moduleMm).toBeLessThan(MODULE_FLOOR_MM);
        }
      }
    }
  });

  it('picks Mimi for every clip length when the browser can run it', () => {
    for (const textured of [false, true]) {
      for (const seconds of [0.5, 4, 7, 10]) {
        expect(bestTierThatFits(seconds, { inverted: false, textured }, true).codec).toBe('mimi');
      }
    }
  });

  it('never picks Mimi when the browser cannot run it', () => {
    for (const seconds of [1, 3, 5, 10]) {
      expect(bestTierThatFits(seconds, { inverted: false }, false).codec).toBe('codec2');
    }
  });

  it('never hands back a card the UI would warn about', () => {
    for (const textured of [false, true]) {
      for (let tenths = 5; tenths <= 100; tenths++) {
        const seconds = tenths / 10;
        const spec = { inverted: false, textured };
        const tier = bestTierThatFits(seconds, spec, true);
        const plan = planCard(estimatePayloadBytes(seconds, tier), spec);
        expect(plan.warnings).not.toContain('module-below-0.30');
        expect(plan.warnings).not.toContain('module-below-0.25');
        expect(plan.moduleMm).toBeGreaterThanOrEqual(MODULE_FLOOR_MM);
        // …and no higher rung may also clear it.
        for (const other of TIERS.slice(TIERS.indexOf(tier) + 1)) {
          const alt = planCard(estimatePayloadBytes(seconds, other), spec);
          expect(alt.moduleMm).toBeLessThan(MODULE_FLOOR_MM);
        }
      }
    }
  });

  it('textured backs buy gutter space out of surplus module size, never below the floor', () => {
    for (const bytes of [400, 1000, 2000, 4000]) {
      const plain = planCard(bytes, { inverted: false });
      const textured = planCard(bytes, { inverted: false, textured: true });
      // Wide gutters are cosmetic: they may never drag modules under the
      // scannability floor, and never below what the plain card manages.
      if (textured.gutterModules > 3) {
        expect(textured.moduleMm).toBeGreaterThanOrEqual(MODULE_FLOOR_MM);
        expect(textured.warnings).not.toContain('texture-cramped');
      } else {
        expect(textured.warnings).toContain('texture-cramped');
        expect(textured.moduleMm).toBeGreaterThanOrEqual(plain.moduleMm - 1e-9);
      }
      for (const cell of textured.cells) {
        expect(cell.xMm).toBeGreaterThanOrEqual(0);
        expect(cell.yMm).toBeGreaterThanOrEqual(0);
        expect(cell.xMm + cell.sizeMm).toBeLessThanOrEqual(CARD_W_MM);
        expect(cell.yMm + cell.sizeMm).toBeLessThanOrEqual(CARD_H_MM);
      }
    }
  });

  it('a plain back is unchanged by the texture work', () => {
    const plan = planCard(2000, { inverted: false });
    expect(plan.gutterModules).toBe(3);
    expect(plan.warnings).not.toContain('texture-cramped');
  });

  it('non-overlapping cells', () => {
    const plan = planCard(2000, { inverted: false });
    for (let i = 0; i < plan.cells.length; i++) {
      for (let j = i + 1; j < plan.cells.length; j++) {
        const a = plan.cells[i]!;
        const b = plan.cells[j]!;
        const overlap =
          a.xMm < b.xMm + b.sizeMm &&
          b.xMm < a.xMm + a.sizeMm &&
          a.yMm < b.yMm + b.sizeMm &&
          b.yMm < a.yMm + a.sizeMm;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe('mimiDepthFor', () => {
  const frames = (seconds: number) => Math.ceil(seconds * 12.5 - 1e-9);

  it('fills the card as deep as the floor allows, and no deeper', () => {
    for (const textured of [false, true]) {
      const spec = { inverted: false, textured };
      for (let tenths = 5; tenths <= 100; tenths++) {
        const seconds = tenths / 10;
        const depth = mimiDepthFor(seconds, spec)!;
        expect(depth).toBeGreaterThanOrEqual(MIMI_MIN_DEPTH);
        expect(depth).toBeLessThanOrEqual(MIMI_MAX_DEPTH_ON_CARD);
        expect(planCard(mimiPayloadBytes(frames(seconds), depth), spec).moduleMm).toBeGreaterThanOrEqual(
          MODULE_FLOOR_MM,
        );
        if (depth < MIMI_MAX_DEPTH_ON_CARD) {
          let deeper = 0;
          try {
            deeper = planCard(mimiPayloadBytes(frames(seconds), depth + 1), spec).moduleMm;
          } catch {
            deeper = 0;
          }
          expect(deeper).toBeLessThan(MODULE_FLOOR_MM);
        }
      }
    }
  });

  it('gives a full 10s clip at least 10 codes a frame, and a short one the cap', () => {
    for (const textured of [false, true]) {
      const spec = { inverted: false, textured };
      expect(mimiDepthFor(10, spec)!).toBeGreaterThanOrEqual(10);
      expect(mimiDepthFor(4.4, spec)).toBe(MIMI_MAX_DEPTH_ON_CARD);
    }
  });

  it('never gets deeper as the clip gets longer', () => {
    let prev = Infinity;
    for (let tenths = 5; tenths <= 100; tenths++) {
      const depth = mimiDepthFor(tenths / 10, { inverted: false })!;
      expect(depth).toBeLessThanOrEqual(prev);
      prev = depth;
    }
  });
});
