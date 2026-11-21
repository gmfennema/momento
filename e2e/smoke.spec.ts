import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { wavFixture } from './fixtures';

test('both pages are cross-origin isolated so threaded wasm (Lyra playback, ort) can run', async ({ page }) => {
  for (const path of ['/momento/', '/momento/create/']) {
    await page.goto(path);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  }
});

test('the scanner is the home page, the maker lives at create/, and neither links to the other', async ({ page }) => {
  await page.goto('/momento/');
  await expect(page.locator('#stage')).toBeVisible();
  await expect(page.locator('#file-input')).toHaveCount(0);
  expect(await page.locator('a[href*="create"]').count()).toBe(0);

  await page.goto('/momento/create/');
  await expect(page.locator('#file-input')).toBeAttached();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  // No link back to the scanner: every link on the page leaves the site or
  // opens a licence notice.
  const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
  for (const href of hrefs) expect(href).toMatch(/^https?:|NOTICE\.md$/);
});

test('generator: upload → stats → card preview → downloads enabled', async ({ page }) => {
  await page.goto('/momento/create/');
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
  // The default Best preference lands on Mimi, at the deepest code stack the
  // card holds for a clip this short…
  await expect(page.locator('#stats-line')).toContainText('(20 codes/frame)', { timeout: 30_000 });
  // …and the Codec 2 rung is still selectable by hand.
  await page.click('.tier[data-key="basic"]');
  await expect(page.locator('#stats-line')).toContainText('Codec 2 1400', { timeout: 10_000 });
  await page.click('.tier[data-key="best"]');
  await expect(page.locator('#stats-line')).toContainText('Mimi', { timeout: 10_000 });

  // Preview canvases (front + back) actually have card pixels.
  for (const id of ['#card-preview', '#front-preview']) {
    const size = await page.locator(id).evaluate((c: HTMLCanvasElement) => ({
      w: c.width,
      h: c.height,
    }));
    expect(size.w).toBeGreaterThan(400);
    // Metal blanks (85.6 × 54 mm) are the default shape.
    expect(Math.abs(size.w / size.h - 85.6 / 53.98)).toBeLessThan(0.01);
  }

  // The PNG is exactly card size at 1200 dpi, and says so, so laser software
  // imports it at 100% instead of guessing a DPI and leaving it to be scaled.
  const [pngDownload] = await Promise.all([page.waitForEvent('download'), page.click('#dl-png')]);
  const pngBytes = fs.readFileSync((await pngDownload.path())!);
  const png = PNG.sync.read(pngBytes);
  expect(png.width).toBe(Math.round((85.6 * 1200) / 25.4));
  expect(png.height).toBe(Math.round((53.98 * 1200) / 25.4));
  expect(pngBytes.subarray(37, 41).toString('latin1')).toBe('pHYs'); // right after IHDR
  expect(pngBytes.readUInt32BE(41)).toBe(47244); // px per metre = 1200 dpi

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

test('generator: the card size setting reshapes both faces', async ({ page }) => {
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture() });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });
  const aspect = (id: string) => page.locator(id).evaluate((c: HTMLCanvasElement) => c.width / c.height);
  await expect.poll(() => aspect('#card-preview'), { timeout: 30_000 }).toBeCloseTo(85.6 / 53.98, 2);
  await page.selectOption('#size-select', 'paper');
  await expect.poll(() => aspect('#card-preview'), { timeout: 30_000 }).toBeCloseTo(88.9 / 50.8, 2);
  await expect.poll(() => aspect('#front-preview')).toBeCloseTo(88.9 / 50.8, 2);
  const [svg] = await Promise.all([page.waitForEvent('download'), page.click('#dl-svg')]);
  const text = fs.readFileSync((await svg.path())!, 'utf8');
  expect(text).toContain('width="88.9mm" height="50.8mm"');
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
  await page.goto('/momento/create/');
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
  await page.goto('/momento/create/');
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
  await page.goto('/momento/');
  await expect(page.locator('.player')).toContainText('This card holds a sound');
  await page.click('#start');
  // Headless chromium without fake camera → denied path, which still offers photo upload.
  await expect(page.locator('.error')).toContainText('Camera access', { timeout: 10_000 });
  await expect(page.locator('#upload')).toBeVisible();
});

test('player: photo of a Mimi card → neural decode → ready to play', async ({ page }) => {
  test.setTimeout(120_000);
  // Generate a card (the default Best tier fits this clip) and capture its
  // preview as a PNG "photo" — this exercises the full neural codec round
  // trip: encode → QR card → scan → decode.
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#stats-line')).toContainText('Mimi');
  const dataUrl = await page
    .locator('#card-preview')
    .evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png'));
  const png = Buffer.from(dataUrl.split(',')[1]!, 'base64');

  // Feed that photo into the player's upload entry.
  await page.goto('/momento/');
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
  await page.goto('/momento/create/');
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

  await page.goto('/momento/');
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
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await expect(page.locator('#card-wrap')).toBeVisible({ timeout: 20_000 });

  // Mimi preview = encode → decode (≈130 MB of models on a cold cache) →
  // play, hence the generous window.
  const tile = page.locator('.tier[data-key="best"]');
  await tile.locator('[data-preview]').click();
  await expect(tile.locator('[data-preview]')).toHaveText('■ Stop', { timeout: 40_000 });
  await expect(tile.locator('[data-status]')).toContainText('Playing');
});

test('generator: a shorter clip gets a deeper Mimi code stack', async ({ page }) => {
  test.setTimeout(120_000);
  const depthFor = async (seconds: number): Promise<number> => {
    await page.goto('/momento/create/');
    await page.setInputFiles('#file-input', {
      name: 'clip.wav',
      mimeType: 'audio/wav',
      buffer: wavFixture(seconds),
    });
    await expect(page.locator('#stats-line')).toContainText('codes/frame', { timeout: 60_000 });
    const text = await page.locator('#stats-line').textContent();
    return Number(/\((\d+) codes\/frame\)/.exec(text ?? '')![1]);
  };
  const short = await depthFor(3);
  const long = await depthFor(10);
  expect(short).toBe(20);
  expect(long).toBeGreaterThanOrEqual(10);
  expect(long).toBeLessThan(short);
});
