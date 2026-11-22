import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { lightCard, wavFixture } from './fixtures';

// The live-camera path, driven by Chromium's fake camera: a feed that only
// ever shows ONE of the card's codes (a listener holding the phone too close,
// or a camera that can't resolve the rest). The scan must read that code, say
// so, coach the listener when it stalls, and let a photo finish the card
// without losing the square already read.

const BASE = 'http://localhost:4173/momento/';

/** A looping grey-scale Y4M (what Chromium's fake camera plays) of one window
 * of a PNG. */
function y4mOfWindow(png: PNG, x0: number, y0: number, w: number, h: number): Buffer {
  const luma = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * png.width + x0 + x) * 4;
      luma[y * w + x] = Math.round(0.299 * png.data[i]! + 0.587 * png.data[i + 1]! + 0.114 * png.data[i + 2]!);
    }
  }
  const chroma = Buffer.alloc((w * h) / 2, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, chroma]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`), frame, frame, frame]);
}

test('player: live scan reads a code, coaches a stalled scan, and a photo finishes the card', async ({ page }) => {
  test.setTimeout(180_000);
  // A full-length card on a metal blank: five data codes in a 3 × 2 grid.
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'clip.wav', mimeType: 'audio/wav', buffer: wavFixture(10) });
  await lightCard(page);
  await expect(page.locator('#stats-line')).toContainText('5 data codes', { timeout: 60_000 });
  const dataUrl = await page.locator('#card-preview').evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png'));
  const cardPng = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  const card = PNG.sync.read(cardPng);

  // The bottom-right 36% × 52% of the card holds exactly one whole data code.
  const w = Math.floor((card.width * 0.36) / 2) * 2;
  const h = Math.floor((card.height * 0.52) / 2) * 2;
  const feed = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momento-cam-')), 'one-code.y4m');
  fs.writeFileSync(feed, y4mOfWindow(card, card.width - w, card.height - h, w, h));

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${feed}`,
    ],
  });
  try {
    const cam = await browser.newPage();
    await cam.goto(BASE);
    await cam.click('#start');
    await expect(cam.locator('#count')).toHaveText('1 of 5', { timeout: 30_000 });
    // Nothing else is ever in view — the coach changes its advice.
    await expect(cam.locator('#coach')).toContainText('take a photo', { timeout: 20_000 });

    // The photo route keeps the square already read and opens the picker.
    const chooser = cam.waitForEvent('filechooser');
    await cam.click('#photo');
    await expect(cam.locator('#count')).toHaveText('1 of 5');
    await (await chooser).setFiles({ name: 'card.png', mimeType: 'image/png', buffer: cardPng });
    await expect(cam.locator('#play')).toBeVisible({ timeout: 60_000 });
    await expect(cam.locator('#stage')).toContainText('rebuilt entirely from the card');
  } finally {
    await browser.close();
    fs.rmSync(path.dirname(feed), { recursive: true, force: true });
  }
});
