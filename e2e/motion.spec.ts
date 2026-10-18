import { expect, test } from '@playwright/test';
import { installLiveCamera, observe, renderedAngle, startLiveCamera } from './live-camera';

test.beforeEach(async ({ page }) => { await installLiveCamera(page); });

test('live flexion advances gradually with smoothing while the independent model keeps rendering', async ({ page }) => {
  await startLiveCamera(page);
  await page.getByRole('slider', { name: 'Smoothing / stability', exact: true }).evaluate(element => {
    (element as HTMLInputElement).value = '300';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await observe(page, 'index');
  const early = await renderedAngle(page);
  expect(early).toBeGreaterThan(0);
  expect(early).toBeLessThan(1);
  await expect.poll(() => renderedAngle(page)).toBeGreaterThan(1);
  await expect.poll(() => renderedAngle(page, 'middle')).toBeLessThan(0.04);
  await expect(page.getByRole('img', { name: /interactive.*robotic hand/i }).locator('canvas')).toBeVisible();
});

test('loss holds briefly, returns toward neutral and recovers only on fresh camera observations', async ({ page }) => {
  await startLiveCamera(page);
  await observe(page, 'index');
  await expect.poll(() => renderedAngle(page)).toBeGreaterThan(1);
  const bent = await renderedAngle(page);
  await observe(page, null);
  await expect(page.getByTestId('capture-neutral')).toBeDisabled();
  await expect(page.getByTestId('tracking-status')).toContainText('Hand lost');
  expect(await renderedAngle(page)).toBeGreaterThan(bent * 0.5);
  await expect.poll(() => renderedAngle(page)).toBeLessThan(0.04);
  await expect(page.getByTestId('capture-neutral')).toBeDisabled();
  await observe(page, 'index');
  await expect(page.getByTestId('capture-neutral')).toBeEnabled();
  await expect(page.getByTestId('tracking-status')).toContainText('Tracking');
  await expect.poll(() => renderedAngle(page)).toBeGreaterThan(1);
});

test('stop clears the old live pose, releases worker and stream, and restart waits for a fresh hand', async ({ page }) => {
  await startLiveCamera(page);
  await observe(page, 'index');
  await expect.poll(() => renderedAngle(page)).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await expect.poll(() => renderedAngle(page)).toBeLessThan(0.04);
  await expect(page.getByTestId('capture-neutral')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.liveCamera.workersClosed)).toBe(1);
  expect(await page.evaluate(() => window.liveCamera.streams.flatMap(stream => stream.getTracks().map(track => track.readyState)))).toEqual(['ended']);
  await page.evaluate(() => { window.liveCamera.frame = null; });
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
  await expect(page.getByTestId('tracking-status')).toContainText('Show your hand');
  await expect(page.getByTestId('capture-neutral')).toBeDisabled();
  expect(await renderedAngle(page)).toBeLessThan(0.04);
  await observe(page, 'index');
  await expect(page.getByTestId('capture-neutral')).toBeEnabled();
  await expect.poll(() => renderedAngle(page)).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.liveCamera.requests)).toBe(2);
});

test('camera settings do not request camera access until explicitly started', async ({ page }) => {
  await page.getByRole('combobox', { name: 'Camera', exact: true }).selectOption('environment');
  await page.getByRole('combobox', { name: 'Camera', exact: true }).selectOption('user');
  await page.getByLabel('Backend preference').selectOption('CPU');
  await page.getByLabel('Processing long edge').selectOption('320');
  await page.getByRole('checkbox', { name: /Selfie mirror/ }).uncheck();
  expect(await page.evaluate(() => window.liveCamera.requests)).toBe(0);
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
  expect(await renderedAngle(page)).toBeLessThan(0.04);
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`enlarged viewer preserves live independent control and camera ownership at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await startLiveCamera(page);
    await observe(page, 'index');
    await expect.poll(() => renderedAngle(page)).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Enlarge model viewer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
    await observe(page, 'open');
    await expect.poll(() => renderedAngle(page)).toBeLessThan(0.04);
    await observe(page, 'index');
    await expect.poll(() => renderedAngle(page)).toBeGreaterThan(1);
    await expect.poll(() => renderedAngle(page, 'middle')).toBeLessThan(0.04);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Enlarge model viewer', exact: true })).toBeFocused();
    expect(await page.evaluate(() => window.liveCamera.requests)).toBe(1);
    expect(await page.evaluate(() => window.liveCamera.streams[0].getVideoTracks()[0].readyState)).toBe('live');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.liveCamera.streams[0].getVideoTracks()[0].readyState)).toBe('ended');
  });
}
