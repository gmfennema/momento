import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { backPhoto, backReady, lightCard, wavFixture } from './fixtures';

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
  await expect(page.locator('.st-mark')).toContainText('Kept');
  // A voice card is the default kind.
  await expect(page.locator('.kind[data-kind="voice"]')).toHaveAttribute('aria-checked', 'true');

  await page.setInputFiles('#file-input', {
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  });
  await expect(page.locator('#audio-status')).toContainText('fixture.wav, 2.9 s', { timeout: 15_000 });
  await backReady(page);
  await expect(page.locator('#stats-line')).toContainText('data codes');
  await expect(page.locator('#stats-line')).toContainText('mm modules');
  // A voice goes on Mimi, at the deepest code stack the card holds for a clip this short…
  await expect(page.locator('#stats-line')).toContainText('(20 codes/frame)', { timeout: 30_000 });
  // …and a heartbeat card goes on Pulse.
  await page.click('.kind[data-kind="heartbeat"]');
  await expect(page.locator('#stats-line')).toContainText('Pulse heartbeat codec', { timeout: 10_000 });
  await page.click('.kind[data-kind="voice"]');
  await expect(page.locator('#stats-line')).toContainText('Mimi', { timeout: 10_000 });

  // Preview canvases (front + back) actually have card pixels.
  for (const id of ['#card-preview', '#front-preview']) {
    const size = await page.locator(id).evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
    expect(size.w).toBeGreaterThan(400);
    // Metal blanks (85.6 × 54 mm) are the default shape.
    expect(Math.abs(size.w / size.h - 85.6 / 53.98)).toBeLessThan(0.01);
  }

  // The PNG is exactly card size at 1200 dpi, and says so, so laser software
  // imports it at 100% instead of guessing a DPI and leaving it to be scaled.
  const [pngDownload] = await Promise.all([page.waitForEvent('download'), page.click('#dl-back-png')]);
  const pngBytes = fs.readFileSync((await pngDownload.path())!);
  const png = PNG.sync.read(pngBytes);
  expect(png.width).toBe(Math.round((85.6 * 1200) / 25.4));
  expect(png.height).toBe(Math.round((53.98 * 1200) / 25.4));
  expect(pngBytes.subarray(37, 41).toString('latin1')).toBe('pHYs'); // right after IHDR
  expect(pngBytes.readUInt32BE(41)).toBe(47244); // px per metre = 1200 dpi

  const [frontPng] = await Promise.all([page.waitForEvent('download'), page.click('#dl-front-png')]);
  expect(frontPng.suggestedFilename()).toBe('kept-card-front.png');
  expect(PNG.sync.read(fs.readFileSync((await frontPng.path())!)).width).toBe(png.width);

  const [backDownload] = await Promise.all([page.waitForEvent('download'), page.click('#dl-svg')]);
  expect(backDownload.suggestedFilename()).toBe('kept-card-back.svg');
  const [frontDownload] = await Promise.all([page.waitForEvent('download'), page.click('#dl-front-svg')]);
  expect(frontDownload.suggestedFilename()).toBe('kept-card-front.svg');
});

test('generator: before any sound, the front is a live sample and nothing downloads', async ({ page }) => {
  await page.goto('/momento/create/');
  for (const id of ['#dl-front-png', '#dl-front-svg', '#dl-back-png', '#dl-svg', '#hear-card']) {
    await expect(page.locator(id)).toBeDisabled();
  }
  await expect(page.locator('#card-summary')).toContainText('sample');
  // Each kind offers its own two designs.
  await expect(page.locator('.design')).toHaveCount(2);
  await expect(page.locator('.design[data-design="wave"]')).toBeVisible();
  await expect(page.locator('.design[data-design="ring"]')).toBeVisible();
  await page.click('.kind[data-kind="heartbeat"]');
  await expect(page.locator('.design[data-design="framed"]')).toBeVisible();
  await expect(page.locator('.design[data-design="heartline"]')).toBeVisible();
  await expect(page.locator('#photo-field')).toBeVisible();
  await expect(page.locator('#voice-field')).toBeHidden();
});

test('generator: the card size setting reshapes both faces', async ({ page }) => {
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture() });
  await backReady(page);
  const aspect = (id: string) => page.locator(id).evaluate((c: HTMLCanvasElement) => c.width / c.height);
  await expect.poll(() => aspect('#card-preview'), { timeout: 30_000 }).toBeCloseTo(85.6 / 53.98, 2);
  await page.click('.settings summary');
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

test('generator: black metal inverts the codes (background stays white) together with the photo', async ({ page }) => {
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture() });
  await backReady(page);
  // Isolate the polarity change from the pixel field, which also adds ink.
  await page.click('.settings summary');
  await page.uncheck('#texture-toggle');
  await page.waitForTimeout(700);

  const corner = () =>
    page.locator('#card-preview').evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, 1, 1).data[0]!);
  // Black metal is the default: codes inverted, background white.
  const inverted = await sampleBack(page);
  expect(await corner()).toBeGreaterThan(200);
  await lightCard(page);
  await page.waitForTimeout(700);
  const plain = await sampleBack(page);
  expect(await corner()).toBeGreaterThan(200);
  // Each QR on black is a dark plate with white modules: substantially more ink.
  expect(inverted.darkFraction).toBeGreaterThan(plain.darkFraction * 1.5);
});

test('generator: the pixel field fills the card edge to edge, and is optional', async ({ page }) => {
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture() });
  await lightCard(page);
  await backReady(page);
  await page.waitForTimeout(700);

  // On by default: the card reports its extra engraved area and the outer edge
  // (bare stock on a plain back) now carries ink.
  await expect(page.locator('#stats-line')).toContainText('engraved area');
  const textured = await sampleBack(page);
  expect(textured.edgeFraction).toBeGreaterThan(0.1);

  await page.click('.settings summary');
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

test('player: photo of an engraved black-metal voice card → Mimi decode → says it is a voice', async ({ page }) => {
  test.setTimeout(120_000);
  // Black metal is the default stock. The artwork's codes are inverted, so the
  // photo is what the engraved card looks like: the artwork turned light-on-black.
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture() });
  await backReady(page);
  await expect(page.locator('#stats-line')).toContainText('Mimi');
  const png = await backPhoto(page);

  await page.goto('/momento/');
  await expect(page.locator('#upload')).toBeVisible();
  await page.locator('#stage input[type="file"]').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#play')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#stage')).toContainText('rebuilt entirely from the card');
  await expect(page.locator('#holds')).toContainText(/seconds of voice/);
});

test('player: photo of a heartbeat card → Pulse decode → says it is a heartbeat', async ({ page }) => {
  await page.goto('/momento/create/');
  await page.click('.kind[data-kind="heartbeat"]');
  await page.setInputFiles('#file-input', { name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture() });
  await backReady(page);
  await expect(page.locator('#stats-line')).toContainText('Pulse heartbeat codec');
  const png = await backPhoto(page);

  // Nothing tells the player what kind of card this is — it reads it off the codes.
  await page.goto('/momento/');
  await page.locator('#stage input[type="file"]').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#play')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#holds')).toContainText(/second heartbeat, rebuilt entirely from the card/);
});

test('generator: "Hear this card" plays the card through the player pipeline', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture() });
  await backReady(page);
  // Mimi decode (≈60 MB decoder on a cold cache) → play.
  await page.click('#hear-card');
  await expect(page.locator('#hear-card')).toHaveText('Playing…', { timeout: 40_000 });
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
