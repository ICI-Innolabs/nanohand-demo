import { expect, test, type Request } from '@playwright/test';
import { openSettings } from './live-camera';

interface PrivacyCameraHarness {
  streams: MediaStream[];
  captures: number;
  workerInfo: Array<{ backend: string; execution: string; fallbackReason?: string }>;
}

declare global {
  interface Window { privacyCameraHarness: PrivacyCameraHarness }
}

// Context request events include dedicated workers; disallow service workers so they cannot hide requests.
test.use({ serviceWorkers: 'block' });

for (const scenario of [
  { name: 'worker CPU', preference: 'CPU', mainThread: false },
  { name: 'worker auto / GPU when available', preference: 'auto', mainThread: false },
  { name: 'main-thread CPU without Worker', preference: 'CPU', mainThread: true },
] as const) {
  test(`${scenario.name} keeps real inference and shutdown entirely same-origin`, async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const origin = new URL(baseURL!).origin;
    let phase = 'page load';
    const attempts: { phase: string; method: string; url: string }[] = [];
    const seen = new Set<Request>();
    const loaded = new Set<string>();
    const workerURLs: string[] = [];
    const observe = (request: Request) => {
      if (seen.has(request)) return;
      seen.add(request);
      const url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return;
      if (url.origin !== origin || request.method() === 'POST') {
        attempts.push({ phase, method: request.method(), url: request.url() });
      }
    };
    context.on('request', observe);
    context.on('response', response => {
      if (response.ok()) loaded.add(response.url());
    });
    page.on('worker', worker => { workerURLs.push(worker.url()); });
    await context.route('**/*', async route => {
      const request = route.request();
      observe(request);
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && (url.origin !== origin || request.method() === 'POST')) {
        // Prevent a privacy regression from reaching the network, but still fail on the attempted request.
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    });

    await page.addInitScript(({ mainThread }) => {
      if (mainThread) Object.defineProperty(window, 'Worker', { configurable: true, value: undefined });
      const state: PrivacyCameraHarness = window.privacyCameraHarness = { streams: [], captures: 0, workerInfo: [] };
      const createBitmap = window.createImageBitmap.bind(window);
      window.createImageBitmap = ((...args: Parameters<typeof createBitmap>) => {
        if (args[0] instanceof HTMLVideoElement) state.captures += 1;
        return createBitmap(...args);
      }) as typeof window.createImageBitmap;
      if (!mainThread) {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.addEventListener('message', event => {
              if (event.data?.info) state.workerInfo.push(event.data.info);
            });
          }
        };
      }
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          const drawing = canvas.getContext('2d')!;
          drawing.fillStyle = '#161616';
          drawing.fillRect(0, 0, canvas.width, canvas.height);
          const stream = canvas.captureStream(30);
          state.streams.push(stream);
          let frame = 0;
          const timer = setInterval(() => {
            if (stream.getTracks().every(track => track.readyState === 'ended')) {
              clearInterval(timer);
              return;
            }
            // Supply real changing video frames, but no hand fixture or fabricated inference result.
            drawing.fillStyle = ++frame % 2 ? '#161616' : '#171717';
            drawing.fillRect(0, 0, canvas.width, canvas.height);
          }, 33);
          return stream;
        },
      });
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [] });
    }, { mainThread: scenario.mainThread });

    await page.goto('/');
    expect(await page.evaluate(() => window.privacyCameraHarness.streams.length)).toBe(0);
    await openSettings(page);
    await page.getByLabel('Backend preference').selectOption(scenario.preference);
    await page.getByLabel('Processing long edge').selectOption('320');
    phase = 'camera start and inference';
    await page.getByRole('button', { name: 'Start camera', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible({ timeout: 90_000 });

    await expect.poll(() => page.evaluate(() => window.privacyCameraHarness.captures)).toBeGreaterThan(3);
    await expect(page.getByTestId('tracking-status')).toContainText('Show your hand');

    if (scenario.mainThread) {
      expect(workerURLs).toEqual([]);
    } else {
      await expect.poll(() => page.evaluate(() => window.privacyCameraHarness.workerInfo.length)).toBeGreaterThan(0);
      const info = await page.evaluate(() => window.privacyCameraHarness.workerInfo.at(-1)!);
      expect(info.execution).toBe('worker');
      if (scenario.preference === 'CPU') expect(info.backend).toBe('CPU');
      else {
        expect(['CPU', 'GPU']).toContain(info.backend);
        testInfo.annotations.push({ type: 'actual auto backend', description: JSON.stringify(info) });
        if (info.backend === 'CPU') expect(info.fallbackReason).toMatch(/GPU (?:initialization|inference) failed:/);
      }
      await expect.poll(() => workerURLs.filter(url => loaded.has(url)).length).toBeGreaterThan(0);
    }
    const assetPaths = [...loaded]
      .filter(url => new URL(url).origin === origin)
      .map(url => new URL(url).pathname);
    expect(assetPaths.some(path => /\/models\/hand_landmarker\.task$/.test(path))).toBe(true);
    expect(assetPaths.some(path => /\/wasm\/[^/]+\.wasm$/.test(path))).toBe(true);
    expect(assetPaths.some(path => /\/wasm\/[^/]+\.m?js$/.test(path))).toBe(true);

    phase = 'local selfie mirroring';
    const preview = page.getByLabel('Local webcam preview');
    const mirror = page.getByRole('checkbox', { name: /Selfie mirror/ });
    await expect(preview).toBeVisible();
    await expect(mirror).toBeChecked();
    await expect(preview).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
    await mirror.uncheck();
    await expect(preview).toHaveCSS('transform', 'none');
    await mirror.check();
    await expect(preview).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
    const beforeMirror = await page.evaluate(() => window.privacyCameraHarness.captures);
    await expect.poll(() => page.evaluate(() => window.privacyCameraHarness.captures)).toBeGreaterThan(beforeMirror + 2);
    await expect(page.getByTestId('tracking-status')).toContainText('Show your hand');

    phase = 'stop and post-stop grace';
    await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.privacyCameraHarness.streams.flatMap(stream => stream.getTracks().map(track => track.readyState))))
      .toEqual(['ended']);
    expect(await preview.evaluate(video => (video as HTMLVideoElement).srcObject)).toBeNull();
    // SDK 1.1.1 emitted its logging POST after Stop; keep observing teardown rather than ending at inference.
    await page.waitForTimeout(5_000);
    expect(attempts, 'No external HTTP(S) requests or POST uploads, including worker requests and shutdown telemetry').toEqual([]);
  });
}
