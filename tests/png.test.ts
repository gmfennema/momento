import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { pngWithDpi } from '../src/lib/png';

function chunks(png: Uint8Array): Array<{ type: string; data: Uint8Array }> {
  const out: Array<{ type: string; data: Uint8Array }> = [];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let o = 8; o + 8 <= png.length; ) {
    const len = view.getUint32(o);
    out.push({ type: String.fromCharCode(...png.subarray(o + 4, o + 8)), data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

describe('pngWithDpi', () => {
  const img = new PNG({ width: 3, height: 2 });
  img.data.fill(200);
  const plain = new Uint8Array(PNG.sync.write(img));

  it('records the resolution so the file imports at its physical size', () => {
    const out = pngWithDpi(plain, 1200);
    const phys = chunks(out).filter((c) => c.type === 'pHYs');
    expect(phys).toHaveLength(1);
    const v = new DataView(phys[0]!.data.buffer, phys[0]!.data.byteOffset, 9);
    expect(v.getUint32(0)).toBe(47244); // 1200 dpi in px per metre
    expect(v.getUint32(4)).toBe(47244);
    expect(phys[0]!.data[8]).toBe(1);
    expect(chunks(out)[1]!.type).toBe('pHYs'); // right after IHDR
  });

  it('leaves the image itself intact and valid (CRCs checked on read)', () => {
    const back = PNG.sync.read(Buffer.from(pngWithDpi(plain, 1200)), { checkCRC: true } as never);
    expect(back.width).toBe(3);
    expect(back.height).toBe(2);
    expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
  });

  it('replaces an existing pHYs rather than adding a second', () => {
    const twice = pngWithDpi(pngWithDpi(plain, 300), 1200);
    expect(chunks(twice).filter((c) => c.type === 'pHYs')).toHaveLength(1);
  });
});
