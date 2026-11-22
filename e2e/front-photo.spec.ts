import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { wavFixture } from './fixtures';

/** A small grey gradient, standing in for an ultrasound photo. */
function photoFixture(): Buffer {
  const png = new PNG({ width: 220, height: 200 });
  for (let i = 0; i < png.width * png.height; i++) {
    const v = Math.round((i % png.width) / png.width * 120) + 40;
    png.data.set([v, v, v, 255], i * 4);
  }
  return PNG.sync.write(png);
}

test('photo front: pick the design, add a photo, download it with the photo embedded', async ({ page }) => {
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture() });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 30_000 });

  await page.selectOption('#front-design', 'photo');
  await expect(page.locator('#photo-opts')).toBeVisible();
  const photo = process.env.FRONT_PHOTO;
  await page.setInputFiles(
    '#photo-input',
    photo
      ? photo
      : { name: 'scan.png', mimeType: 'image/png', buffer: photoFixture() },
  );
  await expect(page.locator('#photo-status')).toContainText('kept in this tab only');
  await page.fill('#text-line', 'Baby Fennema');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dl-front-svg')]);
  const svg = fs.readFileSync(await download.path(), 'utf8');
  expect(svg).toContain('<image href="data:image/png;base64,');

  if (process.env.FRONT_SHOT) {
    await page.waitForTimeout(500);
    await page.locator('#front-preview').screenshot({ path: process.env.FRONT_SHOT });
    await page.uncheck('#photo-negative');
    await page.waitForTimeout(300);
    await page.locator('#front-preview').screenshot({ path: process.env.FRONT_SHOT.replace('.png', '-pos.png') });
  }
});
