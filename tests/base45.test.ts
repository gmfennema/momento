import { describe, expect, it } from 'vitest';
import {
  BASE45_ALPHABET,
  Base45Error,
  base45Decode,
  base45Encode,
  base45Length,
  maxBytesForChars,
} from '../src/lib/base45';

const enc = new TextEncoder();

describe('base45 (RFC 9285)', () => {
  it('matches RFC vectors', () => {
    expect(base45Encode(enc.encode('AB'))).toBe('BB8');
    expect(base45Encode(enc.encode('Hello!!'))).toBe('%69 VD92EX0');
    expect(base45Encode(enc.encode('base-45'))).toBe('UJCLQE7W581');
    expect(new TextDecoder().decode(base45Decode('QED8WEX0'))).toBe('ietf!');
  });

  it('round-trips random data of every length 0..300', () => {
    for (let len = 0; len <= 300; len++) {
      const data = new Uint8Array(len);
      crypto.getRandomValues(data);
      const text = base45Encode(data);
      expect(text.length).toBe(base45Length(len));
      for (const ch of text) expect(BASE45_ALPHABET.includes(ch)).toBe(true);
      expect(base45Decode(text)).toEqual(data);
    }
  });

  it('maxBytesForChars inverts base45Length', () => {
    for (let chars = 0; chars <= 1000; chars++) {
      const n = maxBytesForChars(chars);
      expect(base45Length(n)).toBeLessThanOrEqual(chars);
      expect(base45Length(n + 1)).toBeGreaterThan(chars);
    }
  });

  it('rejects malformed input', () => {
    expect(() => base45Decode('A')).toThrow(Base45Error);
    expect(() => base45Decode('ab!')).toThrow(Base45Error);
    expect(() => base45Decode('::.')).toThrow(Base45Error); // triple overflow
    expect(() => base45Decode('::')).toThrow(Base45Error); // pair overflow
  });
});
