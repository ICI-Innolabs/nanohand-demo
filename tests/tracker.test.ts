import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { MediaPipeTracker } from '../src/lib/tracker';
import type { TrackerHandResult, TrackerInfo, TrackerWorkerReply, TrackerWorkerRequest } from '../src/lib/tracker';

const sdk = vi.hoisted(() => ({ fileset: vi.fn(), create: vi.fn(), factory: vi.fn() }));
vi.mock('@mediapipe/tasks-vision', () => ({
  default: sdk.factory,
  FilesetResolver: { forVisionTasks: sdk.fileset },
  HandLandmarker: { createFromOptions: sdk.create },
}));

class Bitmap {
  close = vi.fn();
}
class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: Exclude<TrackerWorkerRequest, { type: 'close' }>[] = [];
  transferError = false;
  terminate = vi.fn();
  postMessage = vi.fn((request: TrackerWorkerRequest, transfer?: Transferable[]) => {
    if (request.type === 'close') return;
    if (request.type === 'detect') {
      expect(transfer).toEqual([request.bitmap]);
      if (this.transferError) throw new DOMException('Cannot transfer bitmap', 'DataCloneError');
    }
    this.requests.push(request);
  });
  constructor() { ControlledWorker.instances.push(this); }
  reply(reply: unknown) { this.onmessage?.({ data: reply } as MessageEvent); }
}

function handResult(): TrackerHandResult {
  return {
    landmarks: [Array.from({ length: 21 }, (_, index) => ({ x: index / 21, y: 0.5, z: -0.01 * index }))],
    worldLandmarks: [Array.from({ length: 21 }, (_, index) => ({ x: index * 0.01, y: 0.02, z: -0.03 }))],
    handedness: [[{ categoryName: 'Right', score: 0.97 }]],
  };
}
interface MockTask {
  detectForVideo: Mock<(bitmap: ImageBitmap, timestampMs: number) => TrackerHandResult>;
  close: Mock<() => void>;
}
function task(result = handResult()): MockTask {
  return { detectForVideo: vi.fn((_bitmap: ImageBitmap, _timestampMs: number) => result), close: vi.fn() };
}
const trackers: MediaPipeTracker[] = [];
const workerInfo: TrackerInfo = { backend: 'GPU', execution: 'worker' };

async function workerTracker() {
  const creating = MediaPipeTracker.create();
  const worker = ControlledWorker.instances.at(-1)!;
  expect(worker.requests[0]).toMatchObject({ type: 'init', preference: 'auto' });
  worker.reply({ type: 'ready', id: worker.requests[0].id, info: workerInfo });
  const tracker = await creating;
  trackers.push(tracker);
  return { tracker, worker };
}

beforeEach(() => {
  vi.clearAllMocks();
  ControlledWorker.instances = [];
  vi.stubGlobal('location', new URL('https://nanohand.test/workspace/'));
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('ImageBitmap', Bitmap);
  sdk.fileset.mockReset().mockResolvedValue({ wasmLoaderPath: '@mediapipe/tasks-vision', wasmBinaryPath: '/wasm/test.wasm' });
  sdk.create.mockReset().mockResolvedValue(task());
});
afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tracker transport and ownership', () => {
  it('owns overlapping/repeated input without growing a queue and copies accepted result points', async () => {
    const { tracker, worker } = await workerTracker();
    const bitmap = new Bitmap();
    const pending = tracker.detect(bitmap as unknown as ImageBitmap, 10, 4 / 3);
    const extra = new Bitmap();
    await expect(tracker.detect(extra as unknown as ImageBitmap, 11, 4 / 3)).rejects.toThrow('busy');
    expect(extra.close).toHaveBeenCalledOnce();
    expect(worker.requests).toHaveLength(2);
    expect(tracker.busy).toBe(true);
    const result = handResult();
    const id = worker.requests[1].id;
    worker.reply({ type: 'ready', id: id - 1, info: workerInfo });
    worker.reply({ type: 'result', id: id + 1, timestampMs: 10, inferenceMs: 2, info: workerInfo, result });
    expect(tracker.busy).toBe(true);
    worker.reply({ type: 'result', id, timestampMs: 10, inferenceMs: 2, info: workerInfo, result });
    const accepted = await pending;
    expect(accepted.frame).toMatchObject({ timestampMs: 10, handedness: 'Right', source: 'camera', aspectRatio: 4 / 3 });
    expect(accepted.inferenceMs).toBe(2);
    result.landmarks[0][0].x = 999;
    expect(accepted.frame!.landmarks[0].x).toBe(0);
    expect(bitmap.close).not.toHaveBeenCalled(); // Ownership was transferred to the worker.
    const repeated = new Bitmap();
    await expect(tracker.detect(repeated as unknown as ImageBitmap, 10, 1)).rejects.toThrow('increasing');
    expect(repeated.close).toHaveBeenCalledOnce();
    expect(worker.requests).toHaveLength(2);
  });

  it('rejects pending inference on idempotent close and ignores late replies', async () => {
    const { tracker, worker } = await workerTracker();
    const lateHandler = worker.onmessage!;
    const pending = tracker.detect(new Bitmap() as unknown as ImageBitmap, 1, 1);
    const rejected = expect(pending).rejects.toThrow('closed');
    tracker.close();
    tracker.close();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(tracker.busy).toBe(false);
    lateHandler({ data: { type: 'result', id: 2, timestampMs: 1, inferenceMs: 1, info: workerInfo, result: handResult() } } as MessageEvent);
    const afterClose = new Bitmap();
    await expect(tracker.detect(afterClose as unknown as ImageBitmap, 2, 1)).rejects.toThrow('closed');
    expect(afterClose.close).toHaveBeenCalledOnce();
  });

  it.each(['timestamp', 'points', 'envelope'])('rejects malformed %s responses rather than emitting a stale frame', async kind => {
    const { tracker, worker } = await workerTracker();
    const pending = tracker.detect(new Bitmap() as unknown as ImageBitmap, 20, 1);
    const rejected = expect(pending).rejects.toThrow('Malformed');
    const result = handResult();
    if (kind === 'points') result.landmarks[0][3].z = NaN;
    worker.reply(kind === 'envelope' ? { type: 'result', info: workerInfo } : {
      type: 'result', id: 2, timestampMs: kind === 'timestamp' ? 19 : 20, inferenceMs: 3, info: workerInfo, result,
    });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(tracker.busy).toBe(false);
  });

  it('times out worker startup, labels real main CPU fallback and ignores stale ready', async () => {
    vi.useFakeTimers();
    const creating = MediaPipeTracker.create('GPU');
    const worker = ControlledWorker.instances[0];
    const lateHandler = worker.onmessage!;
    await vi.advanceTimersByTimeAsync(30_000);
    const tracker = await creating;
    trackers.push(tracker);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(tracker.info).toMatchObject({ backend: 'CPU', execution: 'main', fallbackReason: expect.stringContaining('timed out') });
    lateHandler({ data: { type: 'ready', id: 1, info: workerInfo } } as MessageEvent);
    expect(tracker.info.execution).toBe('main');
    expect(sdk.fileset).toHaveBeenCalledWith('https://nanohand.test/wasm', false);
    expect(sdk.create).toHaveBeenCalledWith(expect.anything(), {
      baseOptions: { modelAssetPath: 'https://nanohand.test/models/hand_landmarker.task?v=float16-1', delegate: 'CPU' },
      runningMode: 'VIDEO', numHands: 1,
    });
  });

  it('bounds worker inference and makes timeout fatal without leaving the pending promise', async () => {
    vi.useFakeTimers();
    const { tracker, worker } = await workerTracker();
    const pending = tracker.detect(new Bitmap() as unknown as ImageBitmap, 1, 1);
    const rejected = expect(pending).rejects.toThrow('inference timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(tracker.busy).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('cancels CPU initialization after a transfer failure and closes any late-created task', async () => {
    const { tracker, worker } = await workerTracker();
    worker.transferError = true;
    let resolveTask!: (value: MockTask) => void;
    sdk.create.mockReturnValueOnce(new Promise(resolve => { resolveTask = resolve; }));
    const bitmap = new Bitmap();
    const pending = tracker.detect(bitmap as unknown as ImageBitmap, 1, 1);
    const rejected = expect(pending).rejects.toThrow('closed');
    await vi.waitFor(() => expect(sdk.create).toHaveBeenCalledOnce());
    tracker.close();
    await rejected;
    expect(bitmap.close).toHaveBeenCalledOnce();
    const lateTask = task();
    resolveTask(lateTask);
    await vi.waitFor(() => expect(lateTask.close).toHaveBeenCalledOnce());
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('continues with the next fresh bitmap on main CPU after a transfer failure', async () => {
    const { tracker, worker } = await workerTracker();
    worker.transferError = true;
    const cpu = task();
    sdk.create.mockResolvedValueOnce(cpu);
    const failed = new Bitmap();
    expect((await tracker.detect(failed as unknown as ImageBitmap, 1, 1)).frame).toBeNull();
    expect(failed.close).toHaveBeenCalledOnce();
    expect(cpu.detectForVideo).not.toHaveBeenCalled();
    expect(tracker.info).toMatchObject({ backend: 'CPU', execution: 'main', fallbackReason: expect.stringContaining('transfer failed') });
    const next = new Bitmap();
    const result = await tracker.detect(next as unknown as ImageBitmap, 2, 1);
    expect(cpu.detectForVideo).toHaveBeenCalledWith(next, 2);
    expect(result.frame!.landmarks).toHaveLength(21);
    expect(next.close).toHaveBeenCalledOnce();
    tracker.close();
    expect(cpu.close).toHaveBeenCalledOnce();
  });

  it('clones main CPU buffers, measures local timings, and treats CPU inference failure as fatal', async () => {
    vi.stubGlobal('Worker', undefined);
    const raw = handResult();
    const cpu = task(raw);
    sdk.create.mockResolvedValueOnce(cpu);
    const tracker = await MediaPipeTracker.create('CPU');
    trackers.push(tracker);
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(103).mockReturnValueOnce(104);
    const bitmap = new Bitmap();
    const result = await tracker.detect(bitmap as unknown as ImageBitmap, 90, 1.5);
    expect(result).toMatchObject({ inferenceMs: 3, receivedMs: 104, captureToEstimateMs: 14 });
    expect(bitmap.close).toHaveBeenCalledOnce();
    raw.worldLandmarks[0][0].x = 99;
    expect(result.frame!.worldLandmarks![0].x).toBe(0);
    cpu.detectForVideo.mockImplementationOnce(() => { throw new Error('broken CPU graph'); });
    const failed = new Bitmap();
    await expect(tracker.detect(failed as unknown as ImageBitmap, 105, 1)).rejects.toThrow('Main-thread CPU inference failed: broken CPU graph');
    expect(failed.close).toHaveBeenCalledOnce();
    expect(cpu.close).toHaveBeenCalledOnce();
    tracker.close();
    expect(cpu.close).toHaveBeenCalledOnce();
  });
});

type WorkerScope = {
  onmessage: ((event: MessageEvent<TrackerWorkerRequest>) => void) | null;
  ModuleFactory?: unknown;
};
async function loadWorker() {
  vi.resetModules();
  const replies = vi.fn<(reply: TrackerWorkerReply) => void>();
  const close = vi.fn();
  vi.stubGlobal('postMessage', replies);
  vi.stubGlobal('close', close);
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('ModuleFactory', undefined);
  // A fresh module evaluation is the worker lifecycle boundary under test.
  await import('../src/lib/tracker.worker');
  const scope = globalThis as unknown as WorkerScope;
  const send = (request: TrackerWorkerRequest) => new Promise<void>(resolve => {
    // Deliver an event task, not a synchronous call that can precede worker cleanup microtasks.
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      port2.close();
      scope.onmessage!({ data: request } as MessageEvent<TrackerWorkerRequest>);
      resolve();
    };
    port2.postMessage(null);
  });
  return { scope, replies, close, send };
}
const initRequest: TrackerWorkerRequest = {
  type: 'init', id: 1, preference: 'auto',
  wasmURL: 'https://nanohand.test/wasm', modelURL: 'https://nanohand.test/models/hand_landmarker.task?v=float16-1',
};

describe('actual worker controller with SDK boundary substituted', () => {
  it('tries GPU first, retains actual initialization failure, then runs and clones CPU result', async () => {
    const raw = handResult();
    const cpu = task(raw);
    const { send, replies, scope } = await loadWorker();
    sdk.create.mockImplementationOnce(async () => {
      expect(scope.ModuleFactory).toBe(sdk.factory);
      scope.ModuleFactory = undefined;
      throw new Error('WebGL context unavailable');
    }).mockImplementationOnce(async () => {
      expect(scope.ModuleFactory).toBe(sdk.factory);
      return cpu;
    });
    await send(initRequest);
    await vi.waitFor(() => expect(replies).toHaveBeenCalledWith({ type: 'ready', id: 1, info: { backend: 'CPU', execution: 'worker', fallbackReason: 'GPU initialization failed: WebGL context unavailable' } }));
    expect(sdk.fileset).toHaveBeenCalledWith('https://nanohand.test/wasm', true);
    expect(sdk.create.mock.calls.map(call => call[1].baseOptions.delegate)).toEqual(['GPU', 'CPU']);
    const bitmap = new Bitmap();
    await send({ type: 'detect', id: 2, bitmap: bitmap as unknown as ImageBitmap, timestampMs: 10 });
    await vi.waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', id: 2, result: expect.objectContaining({ landmarks: raw.landmarks }) })));
    expect(cpu.detectForVideo).toHaveBeenCalledWith(bitmap, 10);
    expect(bitmap.close).toHaveBeenCalledOnce();
    const reply = replies.mock.calls.at(-1)![0];
    raw.landmarks[0][0].x = 99;
    expect(reply.type === 'result' && reply.result!.landmarks[0][0].x).toBe(0);
    await send({ type: 'close' });
    expect(cpu.close).toHaveBeenCalledOnce();
  });

  it('recovers runtime GPU failure without reusing its bitmap and makes CPU failure explicit', async () => {
    const gpu = task();
    gpu.detectForVideo.mockImplementation(() => { throw new Error('GPU context lost'); });
    const cpu = task();
    const { send, replies, scope } = await loadWorker();
    sdk.create.mockImplementationOnce(async () => {
      expect(scope.ModuleFactory).toBe(sdk.factory);
      scope.ModuleFactory = undefined;
      return gpu;
    }).mockImplementationOnce(async () => {
      expect(scope.ModuleFactory).toBe(sdk.factory);
      return cpu;
    });
    await send(initRequest);
    await vi.waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' })));
    const failed = new Bitmap();
    await send({ type: 'detect', id: 2, bitmap: failed as unknown as ImageBitmap, timestampMs: 1 });
    await vi.waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', id: 2, result: null, info: { backend: 'CPU', execution: 'worker', fallbackReason: 'GPU inference failed: GPU context lost' } })));
    expect(failed.close).toHaveBeenCalledOnce();
    expect(gpu.close).toHaveBeenCalledOnce();
    expect(cpu.detectForVideo).not.toHaveBeenCalled();
    const fresh = new Bitmap();
    await send({ type: 'detect', id: 3, bitmap: fresh as unknown as ImageBitmap, timestampMs: 2 });
    await vi.waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', id: 3, result: expect.any(Object) })));
    expect(cpu.detectForVideo).toHaveBeenCalledWith(fresh, 2);
    expect(fresh.close).toHaveBeenCalledOnce();
    cpu.detectForVideo.mockImplementationOnce(() => { throw new Error('CPU graph failed'); });
    const fatal = new Bitmap();
    await send({ type: 'detect', id: 4, bitmap: fatal as unknown as ImageBitmap, timestampMs: 3 });
    await vi.waitFor(() => expect(replies).toHaveBeenCalledWith({ type: 'error', id: 4, message: expect.stringContaining('CPU graph failed') }));
    expect(fatal.close).toHaveBeenCalledOnce();
    expect(cpu.close).toHaveBeenCalledOnce();
    expect(cpu.detectForVideo).toHaveBeenCalledTimes(2);
    expect(replies.mock.calls.some(([reply]) => reply.type === 'result' && reply.id === 4)).toBe(false);
  });

  it('rejects a duplicate timestamp before inference and closes the rejected bitmap', async () => {
    const cpu = task();
    sdk.create.mockResolvedValueOnce(cpu);
    const { send, replies } = await loadWorker();
    await send({ ...initRequest, preference: 'CPU' });
    await vi.waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' })));
    await send({ type: 'detect', id: 2, bitmap: new Bitmap() as unknown as ImageBitmap, timestampMs: 1 });
    await vi.waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', id: 2 })));
    const duplicate = new Bitmap();
    await send({ type: 'detect', id: 3, bitmap: duplicate as unknown as ImageBitmap, timestampMs: 1 });
    await vi.waitFor(() => expect(replies).toHaveBeenCalledWith({ type: 'error', id: 3, message: expect.any(String) }));
    expect(cpu.detectForVideo).toHaveBeenCalledOnce();
    expect(duplicate.close).toHaveBeenCalledOnce();
    expect(cpu.close).toHaveBeenCalledOnce();
    expect(replies.mock.calls.some(([reply]) => reply.type === 'result' && reply.id === 3)).toBe(false);
  });

  it('closes late initialization, blocks overlapping work, and never sends stale ready after close', async () => {
    let resolveTask!: (value: MockTask) => void;
    sdk.create.mockReturnValueOnce(new Promise(resolve => { resolveTask = resolve; }));
    const { send, replies, close } = await loadWorker();
    await send(initRequest);
    await vi.waitFor(() => expect(sdk.create).toHaveBeenCalledOnce());
    const overlap = new Bitmap();
    await send({ type: 'detect', id: 2, bitmap: overlap as unknown as ImageBitmap, timestampMs: 1 });
    expect(overlap.close).toHaveBeenCalledOnce();
    expect(replies).toHaveBeenCalledWith({ type: 'error', id: 2, message: expect.any(String) });
    expect(sdk.create).toHaveBeenCalledOnce();
    await send({ type: 'close' });
    await send({ type: 'close' });
    const lateTask = task();
    resolveTask(lateTask);
    await vi.waitFor(() => expect(lateTask.close).toHaveBeenCalledOnce());
    expect(close).toHaveBeenCalledOnce();
    expect(replies.mock.calls.some(([reply]) => reply.type === 'ready')).toBe(false);
  });
});
