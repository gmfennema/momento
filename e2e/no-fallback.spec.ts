import { expect, test } from '@playwright/test';
import { backReady, wavFixture } from './fixtures';

// Requests the service worker makes are invisible to page.route; vite preview
// already sends the isolation headers the worker would add.
test.use({ serviceWorkers: 'block' });

test('a voice card whose model fails gets no card — never a silent switch to the heartbeat codec', async ({ page }) => {
  await page.route('**/mimi/*.onnx', (route) => route.abort());
  await page.goto('/momento/create/');
  await page.setInputFiles('#file-input', { name: 'fixture.wav', mimeType: 'audio/wav', buffer: wavFixture() });

  await expect(page.locator('#error-box')).toContainText("The voice model didn't download", { timeout: 30_000 });
  await expect(page.locator('#dl-back-png')).toBeDisabled();
  await expect(page.locator('#card-preview')).toBeHidden();
  await expect(page.locator('.kind[data-kind="voice"]')).toHaveAttribute('aria-checked', 'true');

  // Making a heartbeat card on purpose still works without the model.
  await page.click('.kind[data-kind="heartbeat"]');
  await backReady(page, 10_000);
  await expect(page.locator('#stats-line')).toContainText('Pulse heartbeat codec');
  await expect(page.locator('#error-box')).toBeEmpty();
});
