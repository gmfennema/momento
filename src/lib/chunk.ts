// Chunk wire format — the contract between the generator and the player.
//
// Every chunk carries a 6-byte header so scanning is order-independent and
// self-describing:
//
//   offset 0    magic 0x4D ('M') — rejects foreign QR codes
//   offset 1    bits 7–5 format version · bits 4–2 codec mode id · bits 1–0 reserved
//   offset 2–3  cardId, random u16 LE — prevents mixing chunks of two cards
//   offset 4    chunkIndex (u8, 0-based)
//   offset 5    totalChunks (u8, ≥1)
//
// The format version selects the codec (and its mode table):
//   version 0 — Codec 2, 8 kHz; mode id indexes MODE_BY_ID
//   version 1 — Lyra V2, 16 kHz; mode id 0 = 3.2 kbps (others reserved)
//
// No CRC/length field: QR's internal Reed-Solomon already guarantees per-code
// integrity, and the total payload length is the sum of received payload
// lengths (only the last chunk is short).

export const MAGIC = 0x4d;
export const HEADER_BYTES = 6;
export const WIRE_CODEC2 = 0;
export const WIRE_LYRA = 1;
const KNOWN_VERSIONS: readonly number[] = [WIRE_CODEC2, WIRE_LYRA];

/** Codec2 mode ids as carried on the wire. Only a subset is offered for encoding. */
export const MODE_BY_ID = ['3200', '2400', '1600', '1400', '1300', '1200', '700C', '450'] as const;
export type Codec2Mode = (typeof MODE_BY_ID)[number];
export type CodecModeId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** The one Lyra mode currently defined for wire version 1. */
export const LYRA_MODE_3200: CodecModeId = 0;

export interface ChunkHeader {
  version: number;
  modeId: CodecModeId;
  cardId: number;
  chunkIndex: number;
  totalChunks: number;
}

export class NotAMomentoChunk extends Error {}

export function encodeChunk(h: ChunkHeader, payload: Uint8Array): Uint8Array {
  if (h.totalChunks < 1 || h.totalChunks > 255) throw new Error('totalChunks out of range');
  if (h.chunkIndex < 0 || h.chunkIndex >= h.totalChunks) throw new Error('chunkIndex out of range');
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out[0] = MAGIC;
  out[1] = ((h.version & 0b111) << 5) | ((h.modeId & 0b111) << 2);
  out[2] = h.cardId & 0xff;
  out[3] = (h.cardId >> 8) & 0xff;
  out[4] = h.chunkIndex;
  out[5] = h.totalChunks;
  out.set(payload, HEADER_BYTES);
  return out;
}

export function decodeChunk(bytes: Uint8Array): { header: ChunkHeader; payload: Uint8Array } {
  if (bytes.length < HEADER_BYTES || bytes[0] !== MAGIC) {
    throw new NotAMomentoChunk('missing magic');
  }
  const flags = bytes[1]!;
  const header: ChunkHeader = {
    version: (flags >> 5) & 0b111,
    modeId: ((flags >> 2) & 0b111) as CodecModeId,
    cardId: bytes[2]! | (bytes[3]! << 8),
    chunkIndex: bytes[4]!,
    totalChunks: bytes[5]!,
  };
  if (!KNOWN_VERSIONS.includes(header.version)) throw new NotAMomentoChunk('unknown format version');
  if (header.totalChunks < 1 || header.chunkIndex >= header.totalChunks) {
    throw new NotAMomentoChunk('inconsistent chunk counts');
  }
  return { header, payload: bytes.subarray(HEADER_BYTES) };
}

export function randomCardId(): number {
  const buf = new Uint16Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!;
}

/** Split compressed audio into ready-to-encode chunks (header included). */
export function splitPayload(
  data: Uint8Array,
  version: number,
  modeId: CodecModeId,
  maxPayloadPerChunk: number,
  cardId: number = randomCardId(),
): Uint8Array[] {
  if (maxPayloadPerChunk < 1) throw new Error('maxPayloadPerChunk must be ≥1');
  const totalChunks = Math.max(1, Math.ceil(data.length / maxPayloadPerChunk));
  if (totalChunks > 255) throw new Error('payload needs more than 255 chunks');
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const payload = data.subarray(i * maxPayloadPerChunk, (i + 1) * maxPayloadPerChunk);
    chunks.push(
      encodeChunk({ version, modeId, cardId, chunkIndex: i, totalChunks }, payload),
    );
  }
  return chunks;
}

export type AddResult = 'new' | 'duplicate' | 'wrong-card' | 'not-momento';

/** Player-side accumulator. Adopts the first card it sees; order-independent. */
export class ChunkCollector {
  private cardId: number | null = null;
  private version: number | null = null;
  private modeId: CodecModeId | null = null;
  private total: number | null = null;
  private payloads = new Map<number, Uint8Array>();
  wrongCardHits = 0;

  add(bytes: Uint8Array): AddResult {
    let decoded;
    try {
      decoded = decodeChunk(bytes);
    } catch {
      return 'not-momento';
    }
    const { header, payload } = decoded;
    if (this.cardId === null) {
      this.cardId = header.cardId;
      this.version = header.version;
      this.modeId = header.modeId;
      this.total = header.totalChunks;
    } else if (
      header.cardId !== this.cardId ||
      header.version !== this.version ||
      header.totalChunks !== this.total
    ) {
      this.wrongCardHits++;
      return 'wrong-card';
    }
    if (this.payloads.has(header.chunkIndex)) return 'duplicate';
    this.payloads.set(header.chunkIndex, payload.slice());
    return 'new';
  }

  get progress(): { got: number; total: number | null; missing: number[] } {
    const missing: number[] = [];
    if (this.total !== null) {
      for (let i = 0; i < this.total; i++) if (!this.payloads.has(i)) missing.push(i);
    }
    return { got: this.payloads.size, total: this.total, missing };
  }

  get complete(): boolean {
    return this.total !== null && this.payloads.size === this.total;
  }

  assemble(): { version: number; modeId: CodecModeId; data: Uint8Array } {
    if (!this.complete || this.total === null || this.modeId === null || this.version === null) {
      throw new Error('collector incomplete');
    }
    let len = 0;
    for (const p of this.payloads.values()) len += p.length;
    const data = new Uint8Array(len);
    let o = 0;
    for (let i = 0; i < this.total; i++) {
      const p = this.payloads.get(i)!;
      data.set(p, o);
      o += p.length;
    }
    return { version: this.version, modeId: this.modeId, data };
  }

  reset(): void {
    this.cardId = null;
    this.version = null;
    this.modeId = null;
    this.total = null;
    this.payloads.clear();
    this.wrongCardHits = 0;
  }
}
