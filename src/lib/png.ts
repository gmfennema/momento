// Physical size for exported PNGs. A canvas PNG carries no resolution, so
// laser software imports it at whatever DPI it assumes (72 or 96) and the
// maker has to scale it by hand — the one thing the artwork must never be,
// since the dots and the over-burn compensation are drawn to the millimetre.
// A pHYs chunk records the real resolution, so the file imports at card size.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** signature (8) + IHDR chunk (4 length + 4 type + 13 data + 4 CRC) */
const AFTER_IHDR = 33;

/** The PNG with its resolution set to `dpi` (a pHYs chunk right after IHDR,
 * replacing any the encoder wrote). */
export function pngWithDpi(png: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  if (png.length < AFTER_IHDR || SIGNATURE.some((b, i) => png[i] !== b)) {
    throw new Error('not a PNG');
  }
  const pxPerMetre = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  view.setUint32(8, pxPerMetre);
  view.setUint32(12, pxPerMetre);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  // Copy every chunk after IHDR except an existing pHYs.
  const parts: Uint8Array[] = [png.subarray(0, AFTER_IHDR), chunk];
  const src = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let o = AFTER_IHDR; o + 8 <= png.length; ) {
    const end = o + 12 + src.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (type !== 'pHYs') parts.push(png.subarray(o, end));
    o = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
