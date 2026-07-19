import { describe, expect, it } from 'vitest';
import { base45Length } from '../src/lib/base45';
import { HEADER_BYTES } from '../src/lib/chunk';
import {
  alnumCapacityL,
  AUTO_MODULE_FLOOR_MM,
  CARD_H_MM,
  CARD_W_MM,
  maxChunkBytesForVersion,
  pickAutoTier,
  planCard,
  TIERS,
} from '../src/lib/layout';

describe('planCard', () => {
  const tierBytes = { compact: 1000, balanced: 2000, best: 4000 } as const;

  for (const tier of TIERS) {
    it(`produces a feasible plan for ${tier.key} (${tierBytes[tier.key]}B)`, () => {
      const plan = planCard(tierBytes[tier.key], { inverted: false });
      expect(plan.chunkCount).toBeLessThanOrEqual(255);
      expect(plan.chunkSpecs.length).toBe(plan.chunkCount);
      const capacity = plan.chunkSpecs.reduce((sum, s) => sum + s.payloadBytes, 0);
      expect(capacity).toBeGreaterThanOrEqual(tierBytes[tier.key]);
      // No dead chunk: even without the last one, the payload wouldn't fit.
      expect(capacity - plan.chunkSpecs[plan.chunkSpecs.length - 1]!.payloadBytes)
        .toBeLessThan(tierBytes[tier.key]);
      // Each chunk (header + payload) must fit its QR version.
      for (const s of plan.chunkSpecs) {
        expect(base45Length(HEADER_BYTES + s.payloadBytes)).toBeLessThanOrEqual(
          alnumCapacityL(s.qrVersion),
        );
      }
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

  it('auto tier picks Lyra for a short clip, backs off for a long one', () => {
    // A 6s clip at Lyra's 400 B/s is 2.4 KB — comfortably above the floor.
    const short = pickAutoTier(6, { inverted: false }, true);
    expect(short.codec).toBe('lyra');
    const shortPlan = planCard(Math.ceil(6 * short.bytesPerSec), { inverted: false });
    expect(shortPlan.moduleMm).toBeGreaterThanOrEqual(AUTO_MODULE_FLOOR_MM);

    // At 10s Lyra means 4 KB; auto must never pick a tier below the floor
    // when a comfortable one exists.
    const long = pickAutoTier(10, { inverted: false }, true);
    const longPlan = planCard(Math.ceil(10 * long.bytesPerSec), { inverted: false });
    expect(longPlan.moduleMm).toBeGreaterThanOrEqual(AUTO_MODULE_FLOOR_MM);

    // Auto never picks a lower tier than another that also clears the floor.
    for (const seconds of [1, 3, 5, 8, 10]) {
      const picked = pickAutoTier(seconds, { inverted: false }, true);
      for (const other of TIERS) {
        if (other.bytesPerSec <= picked.bytesPerSec) continue;
        const plan = planCard(Math.ceil(seconds * other.bytesPerSec), { inverted: false });
        expect(plan.moduleMm).toBeLessThan(AUTO_MODULE_FLOOR_MM);
      }
    }
  });

  it('auto tier without Lyra support never picks it', () => {
    for (const seconds of [1, 5, 10]) {
      expect(pickAutoTier(seconds, { inverted: false }, false).codec).toBe('codec2');
    }
  });

  it('non-overlapping cells inside the card, at every layout shape', () => {
    for (const bytes of [300, 1000, 2000, 3216, 4000]) {
      const plan = planCard(bytes, { inverted: false });
      for (const cell of plan.cells) {
        expect(cell.xMm).toBeGreaterThanOrEqual(0);
        expect(cell.yMm).toBeGreaterThanOrEqual(0);
        expect(cell.xMm + cell.sizeMm).toBeLessThanOrEqual(CARD_W_MM);
        expect(cell.yMm + cell.sizeMm).toBeLessThanOrEqual(CARD_H_MM);
      }
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
    }
  });

  it('entry strip layout beats the classic grid where the geometry allows', () => {
    // 10s balanced (≈2KB): moving the entry QR into a side strip lets the
    // main chunks drop a QR version — bigger modules than the classic 0.302mm.
    const plan = planCard(2000, { inverted: false });
    expect(plan.moduleMm).toBeGreaterThan(0.31);
    // Mixed card: main-grid chunks plus small top-up codes in the strip.
    const versions = new Set(plan.chunkSpecs.map((s) => s.qrVersion));
    expect(versions.size).toBeGreaterThan(1);
    // Chunk specs line up with the cell indices they'll be rendered into.
    const chunkCells = plan.cells.filter((c) => c.kind === 'chunk');
    expect(new Set(chunkCells.map((c) => c.index)).size).toBe(plan.chunkCount);
  });

  it('entry strip keeps the entry QR big enough to phone-scan', () => {
    for (const bytes of [500, 1000, 2000, 3216, 4000]) {
      const entry = planCard(bytes, { inverted: false }).cells.find((c) => c.kind === 'entry')!;
      expect(entry.sizeMm).toBeGreaterThanOrEqual(10);
    }
  });

  it('auto tier reaches Lyra for an 8s clip via the entry strip', () => {
    // 8s · 400B/s ≈ 3.2KB used to force the balanced tier; the strip layout
    // keeps Lyra at or above the module floor.
    const tier = pickAutoTier(8, { inverted: false }, true);
    expect(tier.codec).toBe('lyra');
  });
});
