// Base45 (RFC 9285). The alphabet is exactly the QR alphanumeric charset, so
// Base45 text rides in alphanumeric-mode QR codes and survives any scanner
// that only returns strings (e.g. the native BarcodeDetector API).

export const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const CHAR_TO_VAL = new Map<string, number>(
  [...BASE45_ALPHABET].map((c, i) => [c, i]),
);

export class Base45Error extends Error {}

/** Encoded length in chars for a byte length: 2 bytes → 3 chars, 1 byte → 2 chars. */
export function base45Length(byteLen: number): number {
  return 3 * (byteLen >> 1) + (byteLen % 2 === 1 ? 2 : 0);
}

/** Max byte length whose Base45 encoding fits in `charLen` chars. */
export function maxBytesForChars(charLen: number): number {
  const pairs = Math.floor(charLen / 3);
  const rem = charLen - pairs * 3;
  return pairs * 2 + (rem >= 2 ? 1 : 0);
}

export function base45Encode(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let n = bytes[i]! * 256 + bytes[i + 1]!;
    const c = n % 45;
    n = (n - c) / 45;
    const d = n % 45;
    const e = (n - d) / 45;
    out.push(BASE45_ALPHABET[c]!, BASE45_ALPHABET[d]!, BASE45_ALPHABET[e]!);
  }
  if (bytes.length % 2 === 1) {
    const n = bytes[bytes.length - 1]!;
    out.push(BASE45_ALPHABET[n % 45]!, BASE45_ALPHABET[(n - (n % 45)) / 45]!);
  }
  return out.join('');
}

export function base45Decode(text: string): Uint8Array {
  const rem = text.length % 3;
  if (rem === 1) throw new Base45Error('invalid base45 length');
  const out = new Uint8Array(2 * ((text.length - rem) / 3) + (rem === 2 ? 1 : 0));
  let o = 0;
  const val = (i: number): number => {
    const v = CHAR_TO_VAL.get(text[i]!);
    if (v === undefined) throw new Base45Error(`invalid base45 char at ${i}`);
    return v;
  };
  for (let i = 0; i + 2 < text.length || (rem === 0 && i < text.length); i += 3) {
    const n = val(i) + val(i + 1) * 45 + val(i + 2) * 45 * 45;
    if (n > 0xffff) throw new Base45Error('base45 triple out of range');
    out[o++] = n >> 8;
    out[o++] = n & 0xff;
  }
  if (rem === 2) {
    const i = text.length - 2;
    const n = val(i) + val(i + 1) * 45;
    if (n > 0xff) throw new Base45Error('base45 pair out of range');
    out[o++] = n;
  }
  return out;
}
