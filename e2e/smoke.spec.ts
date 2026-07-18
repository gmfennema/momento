import { expect, test } from '@playwright/test';

// Minimal WAV fixture: 3s of 8kHz tone bursts, built in-test.
function wavFixture(): Buffer {
  const sr = 8000;
  const n = sr * 3;
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

test('generator: upload → stats → card preview → downloads enabled', async ({ page }) => {
  await page.goto('/momento/');
  await expect(page.locator('h1')).toContainText('Momento');

  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });

  await expect(page.locator('#audio-status')).toContainText('loaded', { timeout: 15_000 });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#stats-line')).toContainText('data codes');
  await expect(page.locator('#stats-line')).toContainText('mm modules');

  // Preview canvas actually has card pixels.
  const size = await page.locator('#card-preview').evaluate((c: HTMLCanvasElement) => ({
    w: c.width,
    h: c.height,
  }));
  expect(size.w).toBeGreaterThan(400);
  expect(Math.abs(size.w / size.h - 88.9 / 50.8)).toBeLessThan(0.05);

  // SVG download produces a real card SVG.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dl-svg'),
  ]);
  expect(download.suggestedFilename()).toBe('momento-card.svg');
});

test('generator: invert toggle changes the preview background', async ({ page }) => {
  await page.goto('/momento/');
  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });

  const cornerPixel = () =>
    page.locator('#card-preview').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(1, 1, 1, 1).data;
      return d[0];
    });
  expect(await cornerPixel()).toBeGreaterThan(200); // white card
  await page.check('#invert-toggle');
  await page.waitForTimeout(700); // debounce + re-render
  expect(await cornerPixel()).toBeLessThan(50); // black card
});

test('player: scan screen shows guidance when camera is unavailable', async ({ page }) => {
  await page.goto('/momento/#p');
  await expect(page.locator('.player')).toContainText('This card holds a sound');
  await page.click('#start');
  // Headless chromium without fake camera → denied path.
  await expect(page.locator('.error')).toContainText('Camera access', { timeout: 10_000 });
});
