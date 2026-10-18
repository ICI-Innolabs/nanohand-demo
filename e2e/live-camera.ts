import { expect, type Page } from '@playwright/test';
import { landmarkFrame, type LandmarkScenario } from '../tests/fixtures/landmarks';
import type { TrackingFrame } from '../src/lib/types';
import type { TrackerWorkerRequest } from '../src/lib/tracker';

interface LiveCameraHarness {
  frame: TrackingFrame | null;
  requests: number;
  detections: number;
  workersClosed: number;
  streams: MediaStream[];
}
declare global { interface Window { liveCamera: LiveCameraHarness } }

export async function openSettings(page: Page) {
  const closed = page.locator('details:not([open]) > summary');
  while (await closed.count()) await closed.first().click();
}

/** Intercept only the tracker worker transport; keep real camera capture, estimator, mapper and rig. */
export async function installLiveCamera(page: Page) {
  await page.addInitScript(initial => {
    const state: LiveCameraHarness = window.liveCamera = {
      frame: initial, requests: 0, detections: 0, workersClosed: 0, streams: [],
    };
    const NativeWorker = window.Worker;
    const info = { backend: 'CPU', execution: 'worker' };
    class TrackerWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      closed = false;
      postMessage(request: TrackerWorkerRequest) {
        if (this.closed || request.type === 'close') return;
        let reply;
        if (request.type === 'init') reply = { type: 'ready', id: request.id, info };
        else {
          request.bitmap.close();
          state.detections += 1;
          const frame = state.frame;
          reply = { type: 'result', id: request.id, info, timestampMs: request.timestampMs, inferenceMs: 1,
            result: frame ? { landmarks: [frame.landmarks], worldLandmarks: [frame.worldLandmarks!],
              handedness: [[{ categoryName: frame.handedness, score: 1 }]] } : null };
        }
        queueMicrotask(() => { if (!this.closed) this.onmessage?.(new MessageEvent('message', { data: reply })); });
      }
      terminate() {
        if (!this.closed) state.workersClosed += 1;
        this.closed = true;
      }
    }
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args: [string | URL, WorkerOptions?]) {
        if (String(args[0]).includes('tracker.worker')) return new TrackerWorker();
        return new Target(...args);
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [] });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        state.requests += 1;
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const drawing = canvas.getContext('2d')!;
        const stream = canvas.captureStream(30);
        state.streams.push(stream);
        let frame = 0;
        const timer = setInterval(() => {
          if (stream.getTracks().every(track => track.readyState === 'ended')) { clearInterval(timer); return; }
          drawing.fillStyle = ++frame % 2 ? '#161616' : '#171717';
          drawing.fillRect(0, 0, 320, 240);
        }, 33);
        drawing.fillRect(0, 0, 320, 240);
        return stream;
      },
    });
  }, landmarkFrame());
  await page.goto('/');
  await openSettings(page);
}

export async function observe(page: Page, scenario: LandmarkScenario | null, handedness: 'Left' | 'Right' = 'Right') {
  const frame = scenario === null ? null : landmarkFrame(0, scenario, handedness);
  const before = await page.evaluate(frame => {
    window.liveCamera.frame = frame;
    return window.liveCamera.detections;
  }, frame);
  await expect.poll(() => page.evaluate(() => window.liveCamera.detections)).toBeGreaterThan(before + 2);
}

export async function startLiveCamera(page: Page) {
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
  await expect(page.getByTestId('capture-neutral')).toBeEnabled();
}

export async function renderedAngle(page: Page, finger = 'index', joint = 'mcp') {
  const value = await page.getByTestId('rendered-pose').getAttribute(`data-${finger}-${joint}`);
  expect(value, 'Rendered telemetry must contain an actual joint rotation').not.toBeNull();
  const angle = Number(value);
  expect(Number.isFinite(angle)).toBe(true);
  return angle;
}
