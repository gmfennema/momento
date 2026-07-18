import { describe, expect, it } from 'vitest';
import { base45Length } from '../src/lib/base45';
import { HEADER_BYTES } from '../src/lib/chunk';
import {
  alnumCapacityL,
  CARD_H_MM,
  CARD_W_MM,
  maxChunkBytesForVersion,
  planCard,
  TIERS,
} from '../src/lib/layout';

describe('planCard', () => {
  const tierBytes = { compact: 1000, balanced: 2000, best: 4000 } as const;

  for (const tier of TIERS) {
    it(`produces a feasible plan for ${tier.key} (${tierBytes[tier.key]}B)`, () => {
      const plan = planCard(tierBytes[tier.key], { inverted: false });
      expect(plan.chunkCount).toBeLessThanOrEqual(255);
      expect(plan.chunkCount * plan.payloadPerChunk).toBeGreaterThanOrEqual(
        tierBytes[tier.key],
      );
      // Largest chunk (header + payload) must fit the chosen QR version.
      const chunkBytes = HEADER_BYTES + plan.payloadPerChunk;
      expect(base45Length(chunkBytes)).toBeLessThanOrEqual(alnumCapacityL(plan.qrVersion));
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

  it('balanced tier at 10s stays at or above the 0.30mm scannability floor', () => {
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

  it('keeps text when there is room, drops it when it would crush modules', () => {
    const roomy = planCard(1000, { inverted: false, textLine: 'Gabe Fennema' });
    expect(roomy.textLine).toBe('Gabe Fennema');
    expect(roomy.textYMm).toBeDefined();

    const dense = planCard(4000, { inverted: false, textLine: 'Gabe Fennema' });
    if (dense.textLine === undefined) {
      expect(dense.warnings).toContain('text-dropped');
    }
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
