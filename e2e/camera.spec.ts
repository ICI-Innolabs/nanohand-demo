import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './live-camera';

interface CameraHarness {
  mode: 'allow' | 'deny' | 'pending';
  calls: number;
  streams: MediaStream[];
  resolvePending: (() => void) | null;
  animationFrames: Set<number>;
  videoCaptures: number;
  modelDraws: number;
}

declare global {
  interface Window { cameraHarness: CameraHarness }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state: CameraHarness = window.cameraHarness = {
      mode: 'allow', calls: 0, streams: [], resolvePending: null,
      animationFrames: new Set(), videoCaptures: 0, modelDraws: 0,
    };
    const makeStream = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#161616';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(30);
      state.streams.push(stream);
      let frame = 0;
      const timer = setInterval(() => {
        if (stream.getTracks().every(track => track.readyState === 'ended')) {
          clearInterval(timer);
          return;
        }
        // Repaint a blank image so the browser supplies real video frames, never a fabricated hand.
        context.fillStyle = ++frame % 2 ? '#161616' : '#171717';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 33);
      return stream;
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () => {
        state.calls += 1;
        if (state.mode === 'deny') return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
        if (state.mode === 'pending') return new Promise<MediaStream>(resolve => {
          state.resolvePending = () => {
            state.resolvePending = null;
            resolve(makeStream());
          };
        });
        return Promise.resolve(makeStream());
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true, value: async () => [],
    });

    const requestFrame = window.requestAnimationFrame.bind(window);
    const cancelFrame = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => {
      const id = requestFrame(time => {
        state.animationFrames.delete(id);
        callback(time);
      });
      state.animationFrames.add(id);
      return id;
    };
    window.cancelAnimationFrame = id => {
      state.animationFrames.delete(id);
      cancelFrame(id);
    };
    const createBitmap = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((...args: Parameters<typeof createBitmap>) => {
      if (args[0] instanceof HTMLVideoElement) state.videoCaptures += 1;
      return createBitmap(...args);
    }) as typeof window.createImageBitmap;
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const draw = prototype.drawElements;
      prototype.drawElements = function (...args: Parameters<typeof draw>) {
        if (this.canvas instanceof HTMLCanvasElement && this.canvas.closest('[role="img"]')) state.modelDraws += 1;
        draw.apply(this, args);
      };
    }
  });
  await page.goto('/');
});

async function liveMode(page: Page) {
  await openSettings(page);
  await page.getByLabel('Backend preference').selectOption('CPU');
  await page.getByLabel('Processing long edge').selectOption('320');
}

async function expectTracksEnded(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => window.cameraHarness.streams.length)).toBe(count);
  await expect.poll(() => page.evaluate(() => window.cameraHarness.streams.flatMap(stream => stream.getTracks().map(track => track.readyState))))
    .toEqual(Array(count).fill('ended'));
}

async function expectViewerRendering(page: Page) {
  const viewer = page.getByRole('img', { name: /interactive.*robotic hand/i });
  await expect(viewer.locator('canvas')).toBeVisible();
  const before = await page.evaluate(() => window.cameraHarness.modelDraws);
  await expect.poll(() => page.evaluate(() => window.cameraHarness.modelDraws)).toBeGreaterThan(before);
}

async function startTracking(page: Page) {
  const captures = await page.evaluate(() => window.cameraHarness.videoCaptures);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => window.cameraHarness.videoCaptures)).toBeGreaterThan(captures + 2);
  await expect(page.getByTestId('tracking-status')).toContainText('Show your hand');
  await expect(page.getByLabel('Local webcam preview')).toBeVisible();
}

test('camera stays private until Start, while the model keeps rendering', async ({ page }) => {
  await expectViewerRendering(page);
  await expect.poll(() => page.evaluate(() => window.cameraHarness.calls)).toBe(0);
  await liveMode(page);
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
  await expectViewerRendering(page);
  expect(await page.evaluate(() => window.cameraHarness.calls)).toBe(0);
});

test('permission denial explains recovery and Retry requests camera again', async ({ page }) => {
  await page.evaluate(() => { window.cameraHarness.mode = 'deny'; });
  await liveMode(page);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText(/permission.*(?:denied|blocked)/i);
  await expect(alert).toContainText(/(?:allow|settings|retry)/i);
  await expect(page.getByRole('button', { name: 'Retry camera', exact: true })).toBeEnabled();
  await page.evaluate(() => { window.cameraHarness.mode = 'pending'; });
  await page.getByRole('button', { name: 'Retry camera', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.cameraHarness.calls)).toBe(2);
  await expect(alert).toHaveCount(0);
  await page.getByRole('button', { name: /cancel startup/i }).click();
  await page.evaluate(() => window.cameraHarness.resolvePending!());
  await expectTracksEnded(page, 1);
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
});

test('Cancel releases a stream arriving after an unanswered permission request', async ({ page }) => {
  await page.evaluate(() => { window.cameraHarness.mode = 'pending'; });
  await liveMode(page);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: /cancel startup/i })).toBeVisible();
  await page.getByRole('button', { name: /cancel startup/i }).click();
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeDisabled();
  await page.evaluate(() => window.cameraHarness.resolvePending!());
  await expectTracksEnded(page, 1);
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
  expect(await page.getByLabel('Local webcam preview').evaluate(video => (video as HTMLVideoElement).srcObject)).toBeNull();
  expect(await page.evaluate(() => window.cameraHarness.videoCaptures)).toBe(0);
  await expectViewerRendering(page);
});

test('Cancel during real tracker loading releases camera and ignores late initialization', async ({ page }) => {
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const loading = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/tracker.worker.ts*', async route => {
    requested();
    await held;
    await route.continue();
  });
  await liveMode(page);
  const baselineLoops = await page.evaluate(() => window.cameraHarness.animationFrames.size);
  try {
    await page.getByRole('button', { name: 'Start camera', exact: true }).click();
    await loading;
    await expect.poll(() => page.evaluate(() => window.cameraHarness.streams[0]?.getVideoTracks()[0]?.readyState)).toBe('live');
    await page.getByRole('button', { name: /cancel startup/i }).click();
    await expectTracksEnded(page, 1);
    release();
    await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled({ timeout: 90_000 });
    expect(await page.evaluate(() => window.cameraHarness.videoCaptures)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.cameraHarness.animationFrames.size)).toBe(baselineLoops);
    await expectViewerRendering(page);
  } finally {
    release();
  }
});

test('real blank-camera inference survives repeated start/stop and releases all resources', async ({ page }) => {
  test.setTimeout(240_000);
  await liveMode(page);
  await expectViewerRendering(page);
  const baselineLoops = await page.evaluate(() => window.cameraHarness.animationFrames.size);
  for (let session = 1; session <= 3; session += 1) {
    await startTracking(page);
    await expect.poll(() => page.evaluate(() => window.cameraHarness.animationFrames.size)).toBe(baselineLoops + 1);
    await expectViewerRendering(page);
    await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
    await expectTracksEnded(page, session);
    await expect.poll(() => page.evaluate(() => window.cameraHarness.animationFrames.size)).toBe(baselineLoops);
    const captures = await page.evaluate(() => window.cameraHarness.videoCaptures);
    await expectViewerRendering(page);
    expect(await page.evaluate(() => window.cameraHarness.videoCaptures)).toBe(captures);
    expect(await page.evaluate(() => window.cameraHarness.calls)).toBe(session);
  }
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.cameraHarness.calls)).toBe(3);
});

for (const policy of ['hidden', 'pagehide'] as const) {
  test(`${policy} releases an active camera without automatically restarting`, async ({ page }) => {
    await liveMode(page);
    const baselineLoops = await page.evaluate(() => window.cameraHarness.animationFrames.size);
    await startTracking(page);
    await page.evaluate(policy => {
      // Simulate the browser lifecycle signal; headless tabs do not reliably become hidden on focus changes.
      if (policy === 'hidden') {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      }
    }, policy);
    await expectTracksEnded(page, 1);
    await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
    await page.evaluate(policy => {
      if (policy === 'hidden') {
        Reflect.deleteProperty(document, 'hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      }
    }, policy);
    await expectViewerRendering(page);
    await expect.poll(() => page.evaluate(() => window.cameraHarness.animationFrames.size)).toBe(baselineLoops);
    expect(await page.evaluate(() => window.cameraHarness.calls)).toBe(1);
    await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
  });
}
