// The site as GitHub Pages serves it: no isolation headers from the server, so
// the service worker has to add them (src/sw.ts). Mimi runs onnxruntime in a
// worker; an isolated page only starts a worker whose script carries COEP too,
// and a worker that added the headers to the page alone broke every Mimi
// encode and playback after the first visit. `vite preview` sends real headers
// everywhere, so only this server can catch that.
import { expect, test, type Page } from '@playwright/test';
import { wavFixture } from './fixtures';

const PAGES = 'http://localhost:4174/momento/';

async function isolated(page: Page): Promise<void> {
  // First visit: the worker installs, takes control and the page reloads once
  // into isolation (main.ts). Nothing here taps the page, so that reload runs.
  await expect
    .poll(() => page.evaluate(() => crossOriginIsolated).catch(() => false), { timeout: 30_000 })
    .toBe(true);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test('GitHub Pages: an isolated page still makes and plays a Mimi card', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(PAGES);
  await isolated(page);

  // Make a card: the generator encodes with Mimi in the onnxruntime worker.
  await page.setInputFiles('#file-input', { name: 'clip.wav', mimeType: 'audio/wav', buffer: wavFixture(3) });
  await expect(page.locator('#stats-line')).toContainText('Mimi', { timeout: 90_000 });
  const card = await page
    .locator('#card-preview')
    .evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png').split(',')[1]!);

  // Play it back on a fresh, already-controlled visit — every visit after the
  // first is one of these.
  await page.goto(`${PAGES}#p`);
  await page.reload();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page
    .locator('#stage input[type="file"]')
    .setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: Buffer.from(card, 'base64') });
  await expect(page.locator('#play')).toBeVisible({ timeout: 90_000 });
});
