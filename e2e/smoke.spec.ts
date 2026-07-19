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

test('page is cross-origin isolated so the Lyra codec can run', async ({ page }) => {
  await page.goto('/momento/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

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
  // The default Auto tier resolves to the Lyra neural codec for a short clip…
  await expect(page.locator('#stats-line')).toContainText('Lyra 3.2 kbps');
  // …and manual tiers still use Codec 2.
  await page.click('.tier[data-key="compact"]');
  await expect(page.locator('#stats-line')).toContainText('Codec 2 700C', { timeout: 10_000 });
  await page.click('.tier[data-key="auto"]');
  await expect(page.locator('#stats-line')).toContainText('Lyra 3.2 kbps', { timeout: 10_000 });

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
  // Headless chromium without fake camera → denied path, which still offers photo upload.
  await expect(page.locator('.error')).toContainText('Camera access', { timeout: 10_000 });
  await expect(page.locator('#upload')).toBeVisible();
});

test('player: photo of a Lyra card → neural decode → ready to play', async ({ page }) => {
  // Generate a card (Auto resolves to Lyra for this clip) and capture its
  // preview as a PNG "photo" — this exercises the full neural codec round
  // trip: encode → QR card → scan → decode.
  await page.goto('/momento/');
  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#stats-line')).toContainText('Lyra 3.2 kbps');
  const dataUrl = await page
    .locator('#card-preview')
    .evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png'));
  const png = Buffer.from(dataUrl.split(',')[1]!, 'base64');

  // Feed that photo into the player's upload entry.
  await page.goto('/momento/#p');
  await expect(page.locator('#upload')).toBeVisible();
  await page.locator('#stage input[type="file"]').setInputFiles({
    name: 'card.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.locator('#play')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#stage')).toContainText('rebuilt entirely from the card');
  await expect(page.locator('#stage')).toContainText(/\d(\.\d)?s of audio/);
});

test('player: photo of a Codec 2 card still decodes (wire v0 back-compat)', async ({ page }) => {
  await page.goto('/momento/');
  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });
  await page.click('.tier[data-key="balanced"]');
  await expect(page.locator('#stats-line')).toContainText('Codec 2 1600', { timeout: 10_000 });
  const dataUrl = await page
    .locator('#card-preview')
    .evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png'));
  const png = Buffer.from(dataUrl.split(',')[1]!, 'base64');

  await page.goto('/momento/#p');
  await expect(page.locator('#upload')).toBeVisible();
  await page.locator('#stage input[type="file"]').setInputFiles({
    name: 'card.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.locator('#play')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#stage')).toContainText('rebuilt entirely from the card');
  await expect(page.locator('#stage')).toContainText(/\d(\.\d)?s of audio/);
});
