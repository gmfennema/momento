import { expect, test } from '@playwright/test';

// Minimal WAV fixture: N seconds of 8kHz tone bursts, built in-test.
function wavFixture(seconds = 3): Buffer {
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

  // Named uploads report "<file> (<n>s)"; a mic recording reports "<n>s loaded".
  await expect(page.locator('#audio-status')).toContainText('fixture.wav (2.9s)', {
    timeout: 15_000,
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#stats-line')).toContainText('data codes');
  await expect(page.locator('#stats-line')).toContainText('mm modules');
  // The default Best preference fits this short clip, so it lands on Lyra…
  await expect(page.locator('#stats-line')).toContainText('Lyra 3.2 kbps');
  // …and the Codec 2 rungs are still selectable by hand.
  await page.click('.tier[data-key="basic"]');
  await expect(page.locator('#stats-line')).toContainText('Codec 2 1400', { timeout: 10_000 });
  await page.click('.tier[data-key="good"]');
  await expect(page.locator('#stats-line')).toContainText('Codec 2 2400', { timeout: 10_000 });
  await page.click('.tier[data-key="best"]');
  await expect(page.locator('#stats-line')).toContainText('Lyra 3.2 kbps', { timeout: 10_000 });

  // Preview canvases (front + back) actually have card pixels.
  for (const id of ['#card-preview', '#front-preview']) {
    const size = await page.locator(id).evaluate((c: HTMLCanvasElement) => ({
      w: c.width,
      h: c.height,
    }));
    expect(size.w).toBeGreaterThan(400);
    expect(Math.abs(size.w / size.h - 88.9 / 50.8)).toBeLessThan(0.05);
  }

  // SVG downloads produce real card SVGs for both faces.
  const [backDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dl-svg'),
  ]);
  expect(backDownload.suggestedFilename()).toBe('momento-card-back.svg');
  const [frontDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dl-front-svg'),
  ]);
  expect(frontDownload.suggestedFilename()).toBe('momento-card-front.svg');
});

/** Ink coverage of the back preview, plus how dark a band down the card's left
 * edge is — the edge only carries ink when the pixel field is on. */
const sampleBack = (page: import('@playwright/test').Page) =>
  page.locator('#card-preview').evaluate((c: HTMLCanvasElement) => {
    const { width, height } = c;
    const d = c.getContext('2d')!.getImageData(0, 0, width, height).data;
    let dark = 0;
    let total = 0;
    let edgeDark = 0;
    let edgeTotal = 0;
    const edgeCols = Math.round(width * 0.02);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x += 4) {
        const v = d[(y * width + x) * 4]!;
        total++;
        if (v < 128) dark++;
        if (x < edgeCols) {
          edgeTotal++;
          if (v < 128) edgeDark++;
        }
      }
    }
    return { darkFraction: dark / total, edgeFraction: edgeDark / edgeTotal };
  });

test('generator: invert toggle inverts the codes but keeps the background white', async ({ page }) => {
  await page.goto('/momento/');
  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });
  // Isolate the polarity change from the pixel field, which also adds ink.
  await page.uncheck('#texture-toggle');
  await page.waitForTimeout(700);

  const corner = () =>
    page.locator('#card-preview').evaluate(
      (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, 1, 1).data[0]!,
    );
  const plain = await sampleBack(page);
  expect(await corner()).toBeGreaterThan(200); // white background
  await page.check('#invert-toggle');
  await page.waitForTimeout(700); // debounce + re-render
  const inverted = await sampleBack(page);
  // Background stays white (only the marks get engraved)...
  expect(await corner()).toBeGreaterThan(200);
  // ...while each QR flips to a dark plate with white modules, so the card
  // gets substantially darker overall.
  expect(inverted.darkFraction).toBeGreaterThan(plain.darkFraction * 1.5);
});

test('generator: the pixel field fills the card edge to edge, and is optional', async ({ page }) => {
  await page.goto('/momento/');
  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });

  // On by default: the card reports its extra engraved area and the outer edge
  // (bare stock on a plain back) now carries ink.
  await expect(page.locator('#stats-line')).toContainText('engraved area');
  const textured = await sampleBack(page);
  expect(textured.edgeFraction).toBeGreaterThan(0.1);

  await page.uncheck('#texture-toggle');
  await page.waitForTimeout(700);
  await expect(page.locator('#stats-line')).not.toContainText('engraved area');
  const plain = await sampleBack(page);
  expect(plain.edgeFraction).toBeLessThan(0.01);
  expect(textured.darkFraction).toBeGreaterThan(plain.darkFraction * 1.15);
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
  // Generate a card (the default Best tier fits this clip) and capture its
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
  await page.click('.tier[data-key="basic"]');
  await expect(page.locator('#stats-line')).toContainText('Codec 2 1400', { timeout: 10_000 });
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

test('generator: previewing a tier plays the card through the player pipeline', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/momento/');
  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });

  // Codec 2 preview = encode → decode → neural restoration (27 MB model) →
  // play. Slow on a cold cache, hence the generous window.
  const tile = page.locator('.tier[data-key="good"]');
  await tile.locator('[data-preview]').click();
  await expect(tile.locator('[data-preview]')).toHaveText('■ Stop', { timeout: 40_000 });
  await expect(tile.locator('[data-status]')).toContainText('Playing');
});

test('generator: a tier too dense for the clip is unavailable until trimmed', async ({ page }) => {
  await page.goto('/momento/');
  await page.setInputFiles('#file-input', {
    name: 'long.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(6),
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });

  // ~5.9s is past Lyra's 4.4s ceiling at the 0.32mm floor, so Best is offered
  // only as something to trim into.
  const best = page.locator('.tier[data-key="best"]');
  await expect(best).toHaveClass(/unavailable/);
  await expect(page.locator('#stats-line')).toContainText('Codec 2');
  const trim = best.locator('[data-trim]');
  await expect(trim).toContainText('Trim to');

  await trim.click();
  await expect(best).not.toHaveClass(/unavailable/);
  await expect(page.locator('#stats-line')).toContainText('Lyra 3.2 kbps', { timeout: 20_000 });
});
