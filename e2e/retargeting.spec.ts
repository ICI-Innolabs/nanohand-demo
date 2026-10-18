import { expect, test } from '@playwright/test';
import { installLiveCamera, observe, renderedAngle, startLiveCamera } from './live-camera';

const fingers = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;

test.beforeEach(async ({ page }) => { await installLiveCamera(page); });

test('live index landmarks move independent MCP, PIP and DIP joints without moving neighbors', async ({ page }) => {
  await startLiveCamera(page);
  const baseline = await Promise.all(fingers.map(finger => renderedAngle(page, finger)));
  await observe(page, 'index');
  for (const joint of ['mcp', 'pip', 'dip']) {
    await expect.poll(() => renderedAngle(page, 'index', joint)).toBeGreaterThan(0.5);
  }
  await expect.poll(async () => Math.abs(await renderedAngle(page, 'index', 'pip') - await renderedAngle(page, 'index', 'mcp'))).toBeGreaterThan(0.1);
  await expect.poll(async () => Math.abs(await renderedAngle(page, 'index', 'dip') - await renderedAngle(page, 'index', 'mcp'))).toBeGreaterThan(0.1);
  for (const finger of ['thumb', 'middle', 'ring', 'pinky'] as const) {
    expect(Math.abs(await renderedAngle(page, finger) - baseline[fingers.indexOf(finger)])).toBeLessThan(0.04);
  }
});

test('joint angles display rendered degrees live and reset when the camera stops', async ({ page }) => {
  const table = page.getByRole('table', { name: 'Model joint rotations in degrees' });
  const angle = (name: string) => table.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) }).getByRole('cell');
  await startLiveCamera(page);
  await observe(page, 'index');
  for (const joint of ['MCP', 'PIP', 'DIP']) {
    await expect.poll(async () => parseFloat(await angle(`Index ${joint}`).innerText())).toBeGreaterThan(25);
  }
  await expect(angle('Middle MCP')).toHaveText('0.0°');
  await observe(page, 'spread');
  await expect.poll(async () => parseFloat(await angle('Little spread').innerText())).toBeLessThan(-5);
  await expect.poll(async () => {
    const displayed = parseFloat(await angle('Little spread').innerText());
    return Math.abs(displayed - await renderedAngle(page, 'pinky', 'spread') * 180 / Math.PI);
  }).toBeLessThan(0.15);
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  for (const name of ['Index MCP', 'Index PIP', 'Index DIP', 'Little spread', 'Thumb IP', 'Wrist pitch']) {
    await expect(angle(name)).toHaveText('0.0°');
  }
});

test('camera calibration captures open and fist endpoints and resets without restarting camera', async ({ page }) => {
  await startLiveCamera(page);
  await page.getByTestId('capture-neutral').click();
  await observe(page, 'fist');
  for (const finger of fingers) await expect.poll(() => renderedAngle(page, finger)).toBeGreaterThan(0.35);
  await page.getByTestId('capture-fist').click();
  await observe(page, 'index');
  await expect.poll(() => renderedAngle(page)).toBeGreaterThan(1.1);
  await observe(page, 'open');
  for (const finger of fingers) await expect.poll(() => renderedAngle(page, finger)).toBeLessThan(0.04);
  await page.getByRole('button', { name: 'Reset calibration', exact: true }).click();
  await expect(page.getByTestId('capture-neutral')).toBeEnabled();
  expect(await page.evaluate(() => window.liveCamera.requests)).toBe(1);
  await observe(page, 'index');
  await expect.poll(() => renderedAngle(page)).toBeGreaterThan(0.7);
  await expect.poll(() => renderedAngle(page)).toBeLessThan(1.1);
  await expect.poll(() => renderedAngle(page, 'middle')).toBeLessThan(0.04);
});

test('anatomical Left and Right retain equivalent flexion independently of preview and model mirroring', async ({ page }) => {
  await startLiveCamera(page);
  await observe(page, 'index');
  await expect.poll(() => renderedAngle(page)).toBeGreaterThan(0.95);
  const right = await renderedAngle(page);
  await page.getByLabel('Track anatomical hand', { exact: true }).selectOption('Left');
  await expect(page.getByTestId('capture-neutral')).toBeDisabled();
  await expect.poll(() => renderedAngle(page)).toBeLessThan(0.04);
  await observe(page, 'index', 'Left');
  await expect(page.getByTestId('capture-neutral')).toBeEnabled();
  await expect.poll(async () => Math.abs(await renderedAngle(page) - right)).toBeLessThan(0.04);
  await page.getByLabel('Mirror model side').check();
  await page.getByRole('checkbox', { name: /Selfie mirror/ }).uncheck();
  await expect.poll(async () => Math.abs(await renderedAngle(page) - right)).toBeLessThan(0.04);
  await page.getByLabel('Track anatomical hand', { exact: true }).selectOption('Right');
  await expect(page.getByTestId('capture-neutral')).toBeDisabled();
  await expect.poll(() => renderedAngle(page)).toBeLessThan(0.04);
});
