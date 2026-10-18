import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { TrackerHandResult, TrackerInfo, TrackerWorkerReply, TrackerWorkerRequest } from './tracker';

interface VisionFileset { wasmLoaderPath: string; wasmBinaryPath: string }
const scope = globalThis as unknown as {
  location: Location;
  onmessage: ((event: MessageEvent<TrackerWorkerRequest>) => void) | null;
  postMessage: (reply: TrackerWorkerReply) => void;
  close: () => void;
  ModuleFactory?: unknown;
};
let task: HandLandmarker | null = null;
let fileset: VisionFileset | null = null;
let moduleFactory: unknown;
let modelURL = '';
let backend: 'CPU' | 'GPU' = 'CPU';
let fallbackReason: string | undefined;
let busy = false;
let closed = false;
let lastTimestamp = -Infinity;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function createTask(delegate: 'CPU' | 'GPU'): Promise<void> {
  if (!fileset) throw new Error('Worker assets are not initialized');
  if (typeof moduleFactory !== 'function') throw new Error('Local WASM module factory is unavailable');
  // The pinned SDK clears this global; cached module imports do not run its assignment again.
  scope.ModuleFactory = moduleFactory;
  const created = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelURL, delegate },
    runningMode: 'VIDEO', numHands: 1,
  });
  if (closed) { created.close(); return; }
  task = created;
  backend = delegate;
}

function releaseTask(): void {
  const current = task;
  task = null;
  current?.close();
}

async function handle(request: Exclude<TrackerWorkerRequest, { type: 'close' }>): Promise<void> {
  if (request.type === 'init') {
    if (task || fileset) throw new Error('Tracker worker is already initialized');
    const wasmURL = new URL(request.wasmURL);
    const model = new URL(request.modelURL);
    if (wasmURL.origin !== scope.location.origin || model.origin !== scope.location.origin) {
      throw new Error('Tracking assets must be same-origin');
    }
    modelURL = model.href;
    fileset = await FilesetResolver.forVisionTasks(wasmURL.href, true);
    if (closed) return;
    const loader = await import(/* @vite-ignore */ fileset.wasmLoaderPath);
    moduleFactory = loader.default;
    if (closed) return;
    if (request.preference !== 'CPU') {
      try { await createTask('GPU'); }
      catch (error) {
        fallbackReason = `GPU initialization failed: ${errorMessage(error)}`;
        if (!closed) await createTask('CPU');
      }
    } else {
      await createTask('CPU');
    }
    if (!closed) scope.postMessage({ type: 'ready', id: request.id, info: { backend, execution: 'worker', ...(fallbackReason ? { fallbackReason } : {}) } });
    return;
  }

  let result: TrackerHandResult | null = null;
  let inferenceError: unknown;
  let failed = false;
  let inferenceMs = 0;
  try {
    if (!task) throw new Error('Tracker worker is not initialized');
    if (!Number.isFinite(request.timestampMs) || request.timestampMs <= lastTimestamp) {
      throw new Error('Worker inference requires increasing finite timestamps');
    }
    lastTimestamp = request.timestampMs;
    const started = performance.now();
    try {
      const detected = task.detectForVideo(request.bitmap, request.timestampMs);
      inferenceMs = performance.now() - started;
      // Copy task-owned arrays before the next inference can replace their buffers.
      result = {
        landmarks: detected.landmarks.map(hand => hand.map(({ x, y, z }) => ({ x, y, z }))),
        worldLandmarks: detected.worldLandmarks.map(hand => hand.map(({ x, y, z }) => ({ x, y, z }))),
        handedness: detected.handedness.map(hand => hand.map(({ categoryName, score }) => ({ categoryName, score }))),
      };
    } catch (error) {
      inferenceMs = performance.now() - started;
      inferenceError = error;
      failed = true;
    }
  } finally {
    request.bitmap.close();
  }
  if (failed) {
    if (backend !== 'GPU') throw new Error(`Worker CPU inference failed: ${errorMessage(inferenceError)}`);
    fallbackReason = `GPU inference failed: ${errorMessage(inferenceError)}`;
    releaseTask();
    try { await createTask('CPU'); }
    catch (error) { throw new Error(`Worker CPU recovery failed: ${errorMessage(error)}`); }
    // The failed bitmap is already closed: only the next fresh frame can be retried.
  }
  const info: TrackerInfo = { backend, execution: 'worker', ...(fallbackReason ? { fallbackReason } : {}) };
  if (!closed) scope.postMessage({ type: 'result', id: request.id, timestampMs: request.timestampMs, inferenceMs, result, info });
}

scope.onmessage = event => {
  const request = event.data;
  if (request.type === 'close') {
    if (closed) return;
    closed = true;
    releaseTask();
    scope.close();
    return;
  }
  if (closed || busy) {
    if (request.type === 'detect') request.bitmap.close();
    if (!closed) scope.postMessage({ type: 'error', id: request.id, message: 'Tracker worker is busy' });
    return;
  }
  busy = true;
  void handle(request).catch(error => {
    releaseTask();
    if (!closed) scope.postMessage({ type: 'error', id: request.id, message: errorMessage(error) });
  }).finally(() => { busy = false; });
};
