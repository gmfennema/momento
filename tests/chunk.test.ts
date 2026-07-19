import { describe, expect, it } from 'vitest';
import {
  ChunkCollector,
  decodeChunk,
  encodeChunk,
  splitPayload,
  splitPayloadSizes,
  WIRE_CODEC2,
  WIRE_LYRA,
  type CodecModeId,
} from '../src/lib/chunk';

describe('chunk header', () => {
  it('round-trips across versions, mode ids, and boundary indices', () => {
    for (const version of [WIRE_CODEC2, WIRE_LYRA]) {
      for (const modeId of [0, 2, 6, 7] as CodecModeId[]) {
        for (const [chunkIndex, totalChunks] of [
          [0, 1],
          [0, 255],
          [254, 255],
        ]) {
          const payload = new Uint8Array([1, 2, 3]);
          const bytes = encodeChunk(
            { version, modeId, cardId: 0xbeef, chunkIndex: chunkIndex!, totalChunks: totalChunks! },
            payload,
          );
          const { header, payload: p } = decodeChunk(bytes);
          expect(header).toEqual({
            version,
            modeId,
            cardId: 0xbeef,
            chunkIndex,
            totalChunks,
          });
          expect(p).toEqual(payload);
        }
      }
    }
  });

  it('rejects garbage, foreign data, and unknown versions', () => {
    expect(() => decodeChunk(new Uint8Array([0x00, 1, 2, 3, 4, 5, 6]))).toThrow();
    expect(() => decodeChunk(new Uint8Array([]))).toThrow();
    // https URL-looking ASCII (entry QR text fed to the collector)
    expect(() => decodeChunk(new TextEncoder().encode('https://example.com/#p'))).toThrow();
    const future = encodeChunk(
      { version: 5, modeId: 0, cardId: 1, chunkIndex: 0, totalChunks: 1 },
      new Uint8Array([1]),
    );
    expect(() => decodeChunk(future)).toThrow();
  });
});

describe('split + collect', () => {
  it('reassembles shuffled chunks exactly', () => {
    const data = new Uint8Array(2000);
    crypto.getRandomValues(data);
    const chunks = splitPayload(data, WIRE_LYRA, 0, 180, 0x1234);
    expect(chunks.length).toBe(Math.ceil(2000 / 180));
    const shuffled = [...chunks].sort(() => Math.random() - 0.5);
    const collector = new ChunkCollector();
    for (const c of shuffled) expect(collector.add(c)).toBe('new');
    expect(collector.complete).toBe(true);
    const { version, modeId, data: out } = collector.assemble();
    expect(version).toBe(WIRE_LYRA);
    expect(modeId).toBe(0);
    expect(out).toEqual(data);
  });

  it('handles duplicates, wrong cards, and garbage', () => {
    const a = splitPayload(new Uint8Array(100), WIRE_CODEC2, 0, 60, 1);
    const b = splitPayload(new Uint8Array(100), WIRE_CODEC2, 0, 60, 2);
    const collector = new ChunkCollector();
    expect(collector.add(a[0]!)).toBe('new');
    expect(collector.add(a[0]!)).toBe('duplicate');
    expect(collector.add(b[0]!)).toBe('wrong-card');
    expect(collector.wrongCardHits).toBe(1);
    expect(collector.add(new TextEncoder().encode('WIFI:S:foo;;'))).toBe('not-momento');
    expect(collector.complete).toBe(false);
    expect(collector.progress).toEqual({ got: 1, total: 2, missing: [1] });
    expect(collector.add(a[1]!)).toBe('new');
    expect(collector.complete).toBe(true);
  });

  it('rejects chunks of a different wire version as wrong-card', () => {
    const v0 = splitPayload(new Uint8Array(100), WIRE_CODEC2, 0, 60, 42);
    const v1 = splitPayload(new Uint8Array(100), WIRE_LYRA, 0, 60, 42);
    const collector = new ChunkCollector();
    expect(collector.add(v0[0]!)).toBe('new');
    expect(collector.add(v1[1]!)).toBe('wrong-card');
  });

  it('reassembles shuffled uneven chunks (entry-strip cards)', () => {
    // Like a strip card: big main chunks followed by small top-up codes.
    const data = new Uint8Array(2016);
    crypto.getRandomValues(data);
    const sizes = [288, 288, 288, 288, 288, 288, 180, 180]; // last lands short
    const chunks = splitPayloadSizes(data, WIRE_CODEC2, 2, sizes, 0x7777);
    expect(chunks.length).toBe(sizes.length);
    const shuffled = [...chunks].sort(() => Math.random() - 0.5);
    const collector = new ChunkCollector();
    for (const c of shuffled) expect(collector.add(c)).toBe('new');
    expect(collector.complete).toBe(true);
    expect(collector.assemble().data).toEqual(data);
  });

  it('rejects a chunk plan that disagrees with the payload size', () => {
    const data = new Uint8Array(100);
    // middle chunk would be left partially empty
    expect(() => splitPayloadSizes(data, WIRE_CODEC2, 0, [60, 60, 60], 1)).toThrow();
    // payload overflows the plan
    expect(() => splitPayloadSizes(data, WIRE_CODEC2, 0, [60, 30], 1)).toThrow();
  });

  it('single-chunk card works', () => {
    const data = new Uint8Array([9, 8, 7]);
    const chunks = splitPayload(data, WIRE_CODEC2, 6, 500, 7);
    expect(chunks.length).toBe(1);
    const collector = new ChunkCollector();
    collector.add(chunks[0]!);
    expect(collector.complete).toBe(true);
    expect(collector.assemble().data).toEqual(data);
  });
});
