import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { Point, TrackingFrame } from './types';

export type BackendPreference = 'auto' | 'CPU' | 'GPU';
export interface TrackerInfo {
  backend: 'CPU' | 'GPU';
  execution: 'worker' | 'main';
  fallbackReason?: string;
}
export interface TrackingTiming {
  inferenceMs: number;
  captureToEstimateMs: number;
  receivedMs: number;
}
export interface TrackerResult extends TrackingTiming { frame: TrackingFrame | null }

export interface TrackerHandResult {
  landmarks: Point[][];
  worldLandmarks: Point[][];
  handedness: { categoryName: string; score: number }[][];
}
export type TrackerWorkerRequest =
  | { type: 'init'; id: number; preference: BackendPreference; wasmURL: string; modelURL: string }
  | { type: 'detect'; id: number; bitmap: ImageBitmap; timestampMs: number }
  | { type: 'close' };
export type TrackerWorkerReply =
  | { type: 'ready'; id: number; info: TrackerInfo }
  | { type: 'result'; id: number; info: TrackerInfo; timestampMs: number; inferenceMs: number; result: TrackerHandResult | null }
  | { type: 'error'; id: number; message: string };

type Pending = {
  id: number;
  type: 'ready' | 'result';
  resolve: (reply: Exclude<TrackerWorkerReply, { type: 'error' }>) => void;
  reject: (error: Error) => void;
  cancelTimeout: () => void;
};
class TransferError extends Error {}
const INIT_TIMEOUT_MS = 30_000;
const DETECT_TIMEOUT_MS = 30_000;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function validWorkerInfo(info: unknown): info is TrackerInfo {
  if (!info || typeof info !== 'object') return false;
  const value = info as TrackerInfo;
  return (value.backend === 'CPU' || value.backend === 'GPU') && value.execution === 'worker'
    && (value.fallbackReason === undefined || typeof value.fallbackReason === 'string');
}

function frameFromResult(result: unknown, timestampMs: number, aspectRatio: number): TrackingFrame | null {
  if (!result || typeof result !== 'object') throw new Error('Malformed tracking result');
  const { landmarks, worldLandmarks, handedness } = result as TrackerHandResult;
  const validPoints = (hands: unknown): hands is Point[][] => Array.isArray(hands) && hands.length <= 1
    && hands.every(hand => Array.isArray(hand) && hand.length === 21 && hand.every(point => point
      && ['x', 'y', 'z'].every(axis => typeof point[axis] === 'number' && Number.isFinite(point[axis]))));
  if (!validPoints(landmarks) || !validPoints(worldLandmarks) || !Array.isArray(handedness)
    || handedness.length > 1 || worldLandmarks.length > landmarks.length || handedness.length !== landmarks.length
    || !handedness.every(hand => Array.isArray(hand) && hand.every(category => category
      && typeof category.categoryName === 'string' && Number.isFinite(category.score)
      && category.score >= 0 && category.score <= 1))) throw new Error('Malformed tracking result');
  if (!landmarks.length) return null;
  const category = handedness[0][0]?.categoryName;
  return {
    timestampMs,
    handedness: category === 'Left' || category === 'Right' ? category : 'Unknown',
    landmarks: landmarks[0].map(({ x, y, z }) => ({ x, y, z })),
    ...(worldLandmarks.length ? { worldLandmarks: worldLandmarks[0].map(({ x, y, z }) => ({ x, y, z })) } : {}),
    aspectRatio,
    source: 'camera',
  };
}

export class MediaPipeTracker {
  private worker: Worker | null = null;
  private task: HandLandmarker | null = null;
  private pending: Pending | null = null;
  private cancelMainInit: ((error: Error) => void) | null = null;
  private currentInfo: TrackerInfo = { backend: 'CPU', execution: 'main' };
  private closed = false;
  private fatal: Error | null = null;
  private detecting = false;
  private initializing = false;
  private sequence = 0;
  private lastTimestamp = -Infinity;
  private readonly wasmURL: string;
  private readonly modelURL: string;

  private constructor() {
    const base = new URL(import.meta.env.BASE_URL, location.href);
    if (base.origin !== location.origin) throw new Error('Tracking assets must be same-origin');
    this.wasmURL = new URL('wasm', base).href;
    // The asset manifest pins this local file to the official float16/1 model.
    this.modelURL = new URL('models/hand_landmarker.task?v=float16-1', base).href;
  }

  static async create(preference: BackendPreference = 'auto'): Promise<MediaPipeTracker> {
    const tracker = new MediaPipeTracker();
    try {
      await tracker.initialize(preference);
      return tracker;
    } catch (error) {
      tracker.close();
      throw error;
    }
  }

  get info(): TrackerInfo { return { ...this.currentInfo }; }
  get busy(): boolean { return this.detecting || this.initializing; }

  private async initialize(preference: BackendPreference): Promise<void> {
    this.initializing = true;
    try {
      if (typeof Worker === 'undefined' || typeof ImageBitmap === 'undefined') {
        throw new Error('Module workers or ImageBitmap transfer are unavailable');
      }
      const worker = new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onmessage = event => {
        if (this.closed || this.worker !== worker || !this.pending) return;
        const reply = event.data as TrackerWorkerReply;
        if (!reply || typeof reply !== 'object' || !Number.isInteger(reply.id)) {
          this.failWorker(new Error('Malformed tracker worker response'));
          return;
        }
        const pending = this.pending;
        if (reply.id !== pending.id) return;
        if (reply.type === 'error' && typeof reply.message === 'string') {
          this.settlePending(new Error(reply.message));
        } else if (reply.type === pending.type && 'info' in reply && validWorkerInfo(reply.info)) {
          pending.cancelTimeout();
          this.pending = null;
          pending.resolve(reply);
        } else {
          this.failWorker(new Error('Malformed tracker worker response'));
        }
      };
      worker.onerror = event => {
        if (this.worker !== worker || this.closed) return;
        event.preventDefault();
        this.failWorker(new Error(`Tracker worker failed: ${event.message || 'unknown error'}`));
      };
      worker.onmessageerror = () => {
        if (this.worker === worker && !this.closed) this.failWorker(new Error('Tracker worker response could not be decoded'));
      };
      const reply = await this.request({ type: 'init', id: ++this.sequence, preference, wasmURL: this.wasmURL, modelURL: this.modelURL }, 'ready');
      this.currentInfo = reply.info;
    } catch (error) {
      if (this.closed) throw new Error('Tracker is closed');
      this.stopWorker();
      this.fatal = null;
      await this.initializeMain(`Worker unavailable: ${message(error)}`);
    } finally {
      this.initializing = false;
    }
  }

  private request(request: Exclude<TrackerWorkerRequest, { type: 'close' }>, type: Pending['type']): Promise<Exclude<TrackerWorkerReply, { type: 'error' }>> {
    // Keep the ES2022 fallback usable without requiring Promise.withResolvers.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failWorker(new Error(`Tracker worker ${type === 'ready' ? 'initialization' : 'inference'} timed out`)), type === 'ready' ? INIT_TIMEOUT_MS : DETECT_TIMEOUT_MS);
      this.pending = { id: request.id, type, resolve, reject, cancelTimeout: () => clearTimeout(timer) };
      try {
        if (!this.worker) throw new Error('Tracker worker is unavailable');
        this.worker.postMessage(request, request.type === 'detect' ? [request.bitmap] : []);
      } catch (error) {
        this.settlePending(request.type === 'detect'
          ? new TransferError(`ImageBitmap transfer failed: ${message(error)}`)
          : new Error(message(error)));
      }
    });
  }

  private settlePending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      pending.cancelTimeout();
      pending.reject(error);
    }
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      try { worker.postMessage({ type: 'close' } satisfies TrackerWorkerRequest); } catch { /* The worker may already have failed. */ }
      worker.terminate();
    }
  }

  private failWorker(error: Error): void {
    this.fatal = error;
    this.settlePending(error);
    this.stopWorker();
  }

  private async initializeMain(reason: string): Promise<void> {
    this.initializing = true;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, task?: HandLandmarker) => {
          if (settled) { task?.close(); return; }
          settled = true;
          clearTimeout(timer);
          this.cancelMainInit = null;
          if (error || this.closed) {
            task?.close();
            reject(error ?? new Error('Tracker is closed'));
          } else {
            this.task = task!;
            this.currentInfo = { backend: 'CPU', execution: 'main', fallbackReason: reason };
            resolve();
          }
        };
        const timer = setTimeout(() => finish(new Error('Main-thread CPU initialization timed out')), INIT_TIMEOUT_MS);
        this.cancelMainInit = error => finish(error);
        void (async () => {
          // The pinned SDK injects classic script tags on the main thread, not module scripts.
          const fileset = await FilesetResolver.forVisionTasks(this.wasmURL, false);
          if (settled) return;
          const task = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: this.modelURL, delegate: 'CPU' },
            runningMode: 'VIDEO', numHands: 1,
          });
          finish(undefined, task);
        })().catch(error => finish(new Error(`Main-thread CPU initialization failed: ${message(error)}`)));
      });
    } finally {
      this.initializing = false;
    }
  }

  async detect(bitmap: ImageBitmap, timestampMs: number, aspectRatio: number): Promise<TrackerResult> {
    let transferred = false;
    if (this.closed || this.fatal || this.busy || !Number.isFinite(timestampMs) || timestampMs <= this.lastTimestamp
      || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
      bitmap.close();
      throw this.fatal ?? new Error(this.closed ? 'Tracker is closed' : this.busy ? 'Tracker is busy' : 'Tracking needs increasing finite timestamps and a positive aspect ratio');
    }
    this.detecting = true;
    this.lastTimestamp = timestampMs;
    try {
      let frame: TrackingFrame | null;
      let inferenceMs: number;
      if (this.worker) {
        try {
          const response = this.request({ type: 'detect', id: ++this.sequence, bitmap, timestampMs }, 'result');
          // postMessage transfers synchronously; a transfer error retains local ownership.
          transferred = this.pending !== null;
          const reply = await response;
          if (reply.type !== 'result' || reply.timestampMs !== timestampMs || !Number.isFinite(reply.inferenceMs) || reply.inferenceMs < 0) {
            throw new Error('Malformed tracker worker result timing');
          }
          frame = reply.result === null ? null : frameFromResult(reply.result, timestampMs, aspectRatio);
          inferenceMs = reply.inferenceMs;
          this.currentInfo = reply.info;
        } catch (error) {
          if (!(error instanceof TransferError) || this.closed) throw error;
          this.stopWorker();
          await this.initializeMain(error.message);
          frame = null;
          inferenceMs = 0;
        }
      } else {
        if (!this.task) throw new Error('Tracker is not initialized');
        const started = performance.now();
        let result;
        try { result = this.task.detectForVideo(bitmap, timestampMs); }
        catch (error) { throw new Error(`Main-thread CPU inference failed: ${message(error)}`); }
        inferenceMs = performance.now() - started;
        frame = frameFromResult(result, timestampMs, aspectRatio);
      }
      if (this.closed) throw new Error('Tracker is closed');
      const receivedMs = performance.now();
      return { frame, inferenceMs, receivedMs, captureToEstimateMs: Math.max(0, receivedMs - timestampMs) };
    } catch (error) {
      if (!this.closed) {
        this.fatal = error instanceof Error ? error : new Error(message(error));
        this.stopWorker();
        this.task?.close();
        this.task = null;
      }
      throw error;
    } finally {
      if (!transferred) bitmap.close();
      this.detecting = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('Tracker is closed');
    this.settlePending(error);
    this.cancelMainInit?.(error);
    this.stopWorker();
    this.task?.close();
    this.task = null;
  }
}
