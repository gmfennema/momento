import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { backReady, wavFixture } from './fixtures';

/** A stand-in ultrasound: mostly black, like a real scan, with a bright arc. */
function scanFixture(): Buffer {
  const png = new PNG({ width: 220, height: 200 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const r = Math.hypot(x - 110, y - 100);
      const v = Math.abs(r - 60) < 6 ? 230 : 18;
      png.data.set([v, v, v, 255], (y * png.width + x) * 4);
    }
  }
  return PNG.sync.write(png);
}

/** Mean brightness of a region of a canvas, given as fractions of its size. */
const meanIn = (page: Page, id: string, x0: number, y0: number, x1: number, y1: number) =>
  page.locator(id).evaluate(
    (c: HTMLCanvasElement, [a, b, cc, d]) => {
      const x = Math.round(a! * c.width);
      const y = Math.round(b! * c.height);
      const w = Math.round((cc! - a!) * c.width);
      const h = Math.round((d! - b!) * c.height);
      const px = c.getContext('2d')!.getImageData(x, y, w, h).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += px[i]!;
      return sum / (px.length / 4);
    },
    [x0, y0, x1, y1],
  );

/** Share of dark pixels on the back artwork. */
const backInk = (page: Page) =>
  page.locator('#card-preview').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i]! < 128) dark++;
    return dark / (d.length / 16);
  });

test('heartbeat card: the scan and the codes follow the card stock together', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/momento/create/');
  await page.click('.kind[data-kind="heartbeat"]');
  await page.setInputFiles('#file-input', process.env.FRONT_AUDIO ?? { name: 'beat.wav', mimeType: 'audio/wav', buffer: wavFixture(4) });
  await backReady(page);
  // The pixel field adds ink on either stock; take it out to see the inversion.
  await page.click('.settings summary');
  await page.uncheck('#texture-toggle');
  await page.waitForTimeout(700);
  // No scan yet: the back can download, the front can't.
  await expect(page.locator('#dl-front-png')).toBeDisabled();
  await expect(page.locator('#download-note')).toContainText('ultrasound scan');

  await page.setInputFiles('#photo-input', process.env.FRONT_PHOTO ?? { name: 'scan.png', mimeType: 'image/png', buffer: scanFixture() });
  await expect(page.locator('#photo-status')).toContainText('stays in this tab');
  await expect(page.locator('#dl-front-png')).toBeEnabled();

  // The Framed design's photo sits in the left ~45% of the card.
  const photoMean = () => meanIn(page, '#front-preview', 0.15, 0.2, 0.45, 0.8);

  // Black metal (the default): the scan is a negative — its black background
  // becomes white (unengraved, so it stays black metal) — and the codes are
  // inverted (heavily inked). Both, together.
  const blackPhoto = await photoMean();
  const blackInk = await backInk(page);
  expect(blackPhoto).toBeGreaterThan(160);

  await page.click('button[data-stock="light"]');
  await page.waitForTimeout(800);
  const lightPhoto = await photoMean();
  const lightInk = await backInk(page);
  expect(lightPhoto).toBeLessThan(100); // a positive scan: mostly dark
  expect(blackInk).toBeGreaterThan(lightInk * 1.5); // codes no longer inverted

  // Back to black: both faces flip back.
  await page.click('button[data-stock="black"]');
  await page.waitForTimeout(800);
  expect(await photoMean()).toBeGreaterThan(160);
  expect(await backInk(page)).toBeGreaterThan(lightInk * 1.5);

  if (process.env.FRONT_SHOT) await page.locator('#stage-card').screenshot({ path: process.env.FRONT_SHOT });
});

test('every design renders, downloads, and the heartbeat ones embed the scan', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'voice.wav', mimeType: 'audio/wav', buffer: wavFixture(3) });
  await page.fill('#text-line', 'For Mom');
  await page.fill('#voice-line', 'Emma');
  await backReady(page);
  const designs: Array<[string, string]> = [
    ['voice', 'wave'],
    ['voice', 'ring'],
    ['heartbeat', 'framed'],
    ['heartbeat', 'heartline'],
  ];
  for (const [kind, design] of designs) {
    if (kind === 'heartbeat' && design === 'framed') {
      await page.click('.kind[data-kind="heartbeat"]');
      await page.setInputFiles('#photo-input', { name: 'scan.png', mimeType: 'image/png', buffer: scanFixture() });
      await backReady(page);
    }
    await page.click(`.design[data-design="${design}"]`);
    await expect(page.locator(`.design[data-design="${design}"]`)).toHaveAttribute('aria-checked', 'true');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-front-svg')]);
    const svg = fs.readFileSync((await dl.path())!, 'utf8');
    expect(svg).toContain('width="85.6mm"');
    if (kind === 'heartbeat') {
      expect(svg).toContain('<image href="data:image/png;base64,');
      expect(svg).toContain('<polyline'); // the heart-monitor trace
      expect(svg).not.toContain('stroke-dasharray'); // no placeholder left in
    } else {
      expect(svg).not.toContain('<image');
      expect(svg).toContain(design === 'ring' ? 'transform="rotate(' : 'For Mom');
    }
  }
});
