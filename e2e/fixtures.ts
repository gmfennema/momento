// Minimal WAV fixture: N seconds of 8kHz tone bursts, built in-test.
export function wavFixture(seconds = 3): Buffer {
  const sr = 8000;
  const n = sr * seconds;
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(sr, 24);
  data.writeUInt32LE(sr * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = Math.round(9000 * Math.sin(2 * Math.PI * 200 * t) * Math.max(0, Math.sin(2 * Math.PI * 2 * t)));
    data.writeInt16LE(v, 44 + i * 2);
  }
  return data;
}

type Page = import('@playwright/test').Page;

/** Wait until the back is built: its downloads unlock. */
export async function backReady(page: Page, timeout = 60_000): Promise<void> {
  const { expect } = await import('@playwright/test');
  await expect(page.locator('#dl-back-png')).toBeEnabled({ timeout });
}

/** Switch the card to light stock: the artwork then is exactly what a camera
 * sees on the finished card (dark marks on light), as the older tests assume. */
export async function lightCard(page: Page): Promise<void> {
  await page.click('button[data-stock="light"]');
}

/**
 * The back as a camera sees the finished card. On light stock that is the
 * artwork itself; on black metal the laser turns every dark mark of the
 * artwork light and leaves the rest black — i.e. the artwork inverted.
 */
export async function backPhoto(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const src = document.querySelector<HTMLCanvasElement>('#card-preview')!;
    const black = document.querySelector<HTMLElement>('#stage-card')!.dataset.stock === 'black';
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    if (black) {
      const img = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < img.data.length; i += 4) {
        // anodized black ≈ 20, engraved silver ≈ 212: a real card's contrast
        const v = img.data[i]! < 128 ? 212 : 20;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      }
      ctx.putImageData(img, 0, 0);
    }
    return c.toDataURL('image/png').split(',')[1]!;
  });
  return Buffer.from(b64, 'base64');
}
