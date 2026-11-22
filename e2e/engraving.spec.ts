import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { lightCard, wavFixture } from './fixtures';

// A laser that burns wide leaves every dark dot thin. This is the card that
// came back from a real engraver: the reader finds each code and fails its
// checksum. The player has to read it anyway.

const wasm = fs.readFileSync('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');
prepareZXingModule({
  overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) },
});

/**
 * A phone's view of the card after an engraver that burns 0.11 mm wide: the
 * 18 px/mm preview is enlarged ×3, every dark shape thinned by 6 px per edge
 * (a max filter), then box-filtered down to a 1200 px frame. Read the plain
 * way this gives 1 code of 7 — the same symptom as the real card.
 */
function engravedShot(card: PNG): PNG {
  const UP = 3;
  const BURN = 6;
  const DOWN = 4;
  const W = card.width * UP;
  const H = card.height * UP;
  const big = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) big[y * W + x] = card.data[(Math.floor(y / UP) * card.width + Math.floor(x / UP)) * 4]!;
  }
  const rows = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let d = -BURN; d <= BURN; d++) m = Math.max(m, big[y * W + Math.min(W - 1, Math.max(0, x + d))]!);
      rows[y * W + x] = m;
    }
  }
  const burned = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let d = -BURN; d <= BURN; d++) m = Math.max(m, rows[Math.min(H - 1, Math.max(0, y + d)) * W + x]!);
      burned[y * W + x] = m;
    }
  }
  const out = new PNG({ width: Math.floor(W / DOWN), height: Math.floor(H / DOWN) });
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      let sum = 0;
      for (let dy = 0; dy < DOWN; dy++) for (let dx = 0; dx < DOWN; dx++) sum += burned[(y * DOWN + dy) * W + x * DOWN + dx]!;
      const o = (y * out.width + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = sum / (DOWN * DOWN);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

test('player: reads a card whose dots the laser burned thin', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'clip.wav', mimeType: 'audio/wav', buffer: wavFixture(10) });
  await lightCard(page);
  await expect(page.locator('#stats-line')).toContainText('5 data codes', { timeout: 60_000 });
  const preview = (): Promise<string> =>
    page.locator('#card-preview').evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png'));

  // Artwork with no compensation — what every card before this option was.
  const compensated = await preview();
  await page.click('.settings summary');
  await page.selectOption('#burn-select', '0');
  await expect.poll(preview, { timeout: 15_000 }).not.toBe(compensated);
  const shot = engravedShot(PNG.sync.read(Buffer.from((await preview()).split(',')[1]!, 'base64')));

  // Read the plain way, the card is lost…
  const plain = await readBarcodes(
    { data: new Uint8ClampedArray(shot.data), width: shot.width, height: shot.height } as ImageData,
    { formats: ['QRCode'], tryHarder: true, tryInvert: true, maxNumberOfSymbols: 24 },
  );
  expect(plain.filter((r) => r.bytes[0] === 0x4d).length).toBeLessThan(4);

  // …but the player still gets every code out of the same photo.
  await page.goto('/momento/');
  await page.locator('#stage input[type="file"]').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: PNG.sync.write(shot) });
  await expect(page.locator('#play')).toBeVisible({ timeout: 60_000 });
});
