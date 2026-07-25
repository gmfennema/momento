import { describe, expect, it } from 'vitest';
import { base45Length } from '../src/lib/base45';
import { HEADER_BYTES } from '../src/lib/chunk';
import {
  alnumCapacityL,
  AUTO_MODULE_FLOOR_MM,
  CARD_H_MM,
  CARD_W_MM,
  estimatePayloadBytes,
  maxChunkBytesForVersion,
  pickAutoTier,
  planCard,
  TIERS,
} from '../src/lib/layout';

describe('planCard', () => {
  for (const tier of TIERS) {
    const bytes = estimatePayloadBytes(10, tier);
    it(`produces a feasible plan for ${tier.key} (${bytes}B)`, () => {
      const plan = planCard(bytes, { inverted: false });
      expect(plan.chunkCount).toBeLessThanOrEqual(255);
      expect(plan.chunkCount * plan.payloadPerChunk).toBeGreaterThanOrEqual(bytes);
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

  it('auto tier picks Lyra for a short clip, backs off for a long one', () => {
    // A 4s clip at Lyra's 400 B/s is 1.6 KB — still above the floor.
    const short = pickAutoTier(4, { inverted: false }, true);
    expect(short.codec).toBe('lyra');

    // At 10s Lyra means 4 KB; auto must back off to a Codec 2 rung.
    const long = pickAutoTier(10, { inverted: false }, true);
    expect(long.codec).toBe('codec2');

    // Whatever it picks, at every length, must clear the floor…
    for (const seconds of [1, 3, 4, 5, 6, 8, 10]) {
      const picked = pickAutoTier(seconds, { inverted: false }, true);
      const plan = planCard(estimatePayloadBytes(seconds, picked), { inverted: false });
      expect(plan.moduleMm).toBeGreaterThanOrEqual(AUTO_MODULE_FLOOR_MM);
      // …and nothing better may also clear it.
      for (const other of TIERS) {
        if (other.bytesPerSec <= picked.bytesPerSec) continue;
        const alt = planCard(estimatePayloadBytes(seconds, other), { inverted: false });
        expect(alt.moduleMm).toBeLessThan(AUTO_MODULE_FLOOR_MM);
      }
    }
  });

  it('auto never hands back a card the UI would warn about', () => {
    for (const textured of [false, true]) {
      for (let tenths = 5; tenths <= 100; tenths++) {
        const seconds = tenths / 10;
        const spec = { inverted: false, textured };
        const tier = pickAutoTier(seconds, spec, true);
        const plan = planCard(estimatePayloadBytes(seconds, tier), spec);
        expect(plan.warnings).not.toContain('module-below-0.30');
        expect(plan.warnings).not.toContain('module-below-0.25');
        expect(plan.moduleMm).toBeGreaterThanOrEqual(AUTO_MODULE_FLOOR_MM);
      }
    }
  });

  it('auto tier without Lyra support never picks it', () => {
    for (const seconds of [1, 5, 10]) {
      expect(pickAutoTier(seconds, { inverted: false }, false).codec).toBe('codec2');
    }
  });

  it('textured backs buy gutter space out of surplus module size, never below the auto floor', () => {
    for (const bytes of [400, 1000, 2000, 4000]) {
      const plain = planCard(bytes, { inverted: false });
      const textured = planCard(bytes, { inverted: false, textured: true });
      // Wide gutters are cosmetic: they may never drag modules under the
      // scannability floor, and never below what the plain card manages.
      if (textured.gutterModules > 3) {
        expect(textured.moduleMm).toBeGreaterThanOrEqual(AUTO_MODULE_FLOOR_MM);
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
