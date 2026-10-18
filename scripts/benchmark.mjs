import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const origin = 'http://127.0.0.1:5173';
const fixtureURL = 'https://raw.githubusercontent.com/google-ai-edge/mediapipe-samples-web/main/public/hand_model.png';
const fixtureSHA256 = '416ec2bb41b1c7f07124fa971683f1835056afdc21b81f986c9a6aba6b7da34e';
const root = new URL('../', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const external = url => /^https?:$/.test(new URL(url).protocol) && new URL(url).origin !== origin;
function checkTiming(sample) {
  for (const key of ['inferenceMs', 'captureToEstimateMs', 'receivedMs']) {
    assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0, `Invalid ${key}`);
  }
}
// Deterministic self-checks exercise hashing, attempted-request classification and timing rejection.
assert.equal(hash(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
assert.equal(external(`${origin}/wasm/file.wasm`), false);
assert.equal(external('https://example.com/metrics'), true);
assert.equal(external('http://127.0.0.1:5174/metrics'), true);
assert.equal(external('blob:http://127.0.0.1:5173/worker'), false);
assert.throws(() => checkTiming({ inferenceMs: NaN }), /Invalid inferenceMs/);
assert.throws(() => checkTiming({ inferenceMs: 1, captureToEstimateMs: -1 }), /Invalid captureToEstimateMs/);
checkTiming({ inferenceMs: 1, captureToEstimateMs: 2, receivedMs: 3 });

async function measure(browserType, fixtureBase64) {
  let browser;
  let context;
  const requests = [];
  const seen = new WeakSet();
  let phase = 'startup';
  const observe = request => {
    if (seen.has(request) || !/^https?:/.test(request.url())) return;
    seen.add(request);
    requests.push({ url: request.url(), method: request.method(), type: request.resourceType(), phase,
      external: external(request.url()) });
  };
  try {
    try { browser = await browserType.launch({ headless: true }); }
    catch (error) { throw new Error(`${browserType.name()} could not launch. Run npx playwright install chromium webkit. ${error.message}`); }
    context = await browser.newContext({ serviceWorkers: 'block' });
    // Context scope includes dedicated-worker requests; register before opening any page.
    context.on('request', observe);
    await context.route('**/*', async route => {
      const request = route.request();
      observe(request);
      if (external(request.url())) await route.abort('blockedbyclient');
      else await route.continue();
    });
    const page = await context.newPage();
    const response = await page.goto(`${origin}/THIRD_PARTY_NOTICES.txt`, { waitUntil: 'load', timeout: 15_000 });
    assert.ok(response?.ok(), 'Vite must serve public/THIRD_PARTY_NOTICES.txt; run npm run assets and npm run dev');
    assert.ok((response.headers()['content-type'] ?? '').includes('text/plain'), 'Expected the static notices document, not the application HTML');
    const environment = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl ? gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return { userAgent: navigator.userAgent, renderer, rendererProbe: 'isolated document WebGL' };
    });
    const rows = [];
    for (const requested of ['CPU', 'GPU']) {
      phase = requested;
      try {
        rows.push(...await page.evaluate(async ({ requested, fixtureBase64 }) => {
          const ensure = (condition, message) => { if (!condition) throw new Error(message); };
          const { MediaPipeTracker } = await import('/src/lib/tracker.ts');
          const bytes = Uint8Array.from(atob(fixtureBase64), character => character.charCodeAt(0));
          const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          let tracker;
          try {
            ensure(image.width === 640 && image.height === 640, 'Official photo dimensions changed');
            const started = performance.now();
            tracker = await MediaPipeTracker.create(requested);
            const initializationMs = performance.now() - started;
            const checkBackend = () => ensure(tracker.info.backend === requested && tracker.info.execution === 'worker',
              `Requested ${requested} worker unavailable: ${JSON.stringify(tracker.info)}. No fallback numbers are accepted.`);
            checkBackend();
            const rows = [];
            for (const size of [320, 640, 960]) {
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = size;
              const drawing = canvas.getContext('2d');
              ensure(drawing, 'Canvas 2D is unavailable');
              drawing.drawImage(image, 0, 0, size, size);
              const warmups = [];
              const samples = [];
              let detected = 0;
              for (let index = 0; index < 23; index++) {
                // This proxy includes bitmap creation/transfer, not camera exposure or display latency.
                const timestampMs = performance.now();
                const bitmap = await createImageBitmap(canvas);
                const result = await tracker.detect(bitmap, timestampMs, 1);
                checkBackend();
                const frame = result.frame;
                if (frame) {
                  for (const points of [frame.landmarks, ...(frame.worldLandmarks ? [frame.worldLandmarks] : [])]) {
                    ensure(points.length === 21 && points.every(point => ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))),
                      'Inference returned malformed 21-point landmarks');
                  }
                  ensure(frame.timestampMs === timestampMs && frame.aspectRatio === 1, 'Inference frame metadata mismatch');
                }
                const sample = { inferenceMs: result.inferenceMs, captureToEstimateMs: result.captureToEstimateMs,
                  receivedMs: result.receivedMs, timestampMs, detected: Boolean(frame) };
                (index < 3 ? warmups : samples).push(sample);
                if (index >= 3 && frame) detected++;
              }
              ensure(detected > 0, `No hands detected for ${requested} at ${size}px`);
              rows.push({ requested, actual: tracker.info, size, initializationMs, warmups, samples, detected, outOf: 20 });
            }
            return rows;
          } finally {
            tracker?.close();
            image.close();
          }
        }, { requested, fixtureBase64 }));
      } finally {
        phase = `post-${requested}-close`;
        await sleep(5_000);
      }
    }
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(row.actual.backend, row.requested);
      assert.equal(row.actual.execution, 'worker');
      assert.ok(Number.isFinite(row.initializationMs) && row.initializationMs >= 0);
      assert.equal(row.warmups.length, 3);
      assert.equal(row.samples.length, 20);
      assert.equal(row.detected, row.samples.filter(sample => sample.detected).length);
      for (const sample of [...row.warmups, ...row.samples]) {
        checkTiming(sample);
        assert.ok(Number.isFinite(sample.timestampMs) && sample.receivedMs >= sample.timestampMs);
      }
    }
    return { ...environment, version: browser.version(), rows,
      networkAudit: { scope: 'context HTTP(S), including dedicated workers; startup through each tracker close + 5000ms',
        graceMs: 5_000, externalAttempts: requests.filter(request => request.external).length, requests } };
  } finally {
    await context?.close().finally(() => browser?.close());
    if (!context) await browser?.close();
    const blocked = requests.filter(request => request.external);
    assert.equal(blocked.length, 0, `External HTTP(S) attempts detected (aborted, still a failure): ${JSON.stringify(blocked)}`);
  }
}

async function main() {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node.js 24+ and run npm ci');
  const { chromium, webkit } = await import('playwright').catch(error => {
    throw new Error(`Playwright is unavailable; run npm ci. ${error.message}`);
  });
  const manifest = JSON.parse(await readFile(new URL('public/models/manifest.json', root), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const installed = JSON.parse(await readFile(new URL('package.json', import.meta.resolve('@mediapipe/tasks-vision')), 'utf8'));
  assert.equal(pkg.dependencies[manifest.package.name], manifest.package.version, 'SDK pin/asset manifest mismatch');
  assert.equal(installed.version, manifest.package.version, 'Installed SDK mismatch; run npm ci');
  for (const asset of [manifest.model, ...manifest.wasm]) {
    const bytes = await readFile(new URL(`public/${asset.path}`, root)).catch(error => {
      throw new Error(`Missing local inference asset ${asset.path}; run npm run assets. ${error.message}`);
    });
    assert.equal(bytes.length, asset.bytes, `${asset.path}: wrong byte length; repair assets explicitly`);
    assert.equal(hash(bytes), asset.sha256, `${asset.path}: SHA-256 mismatch; repair assets explicitly`);
  }
  await fetch(`${origin}/THIRD_PARTY_NOTICES.txt`, { signal: AbortSignal.timeout(10_000) }).then(response => {
    assert.ok(response.ok, `Development server returned HTTP ${response.status}`);
    return response.body?.cancel();
  }).catch(error => { throw new Error(`Start npm run dev at ${origin} in another terminal. ${error.message}`); });
  const response = await fetch(fixtureURL, { signal: AbortSignal.timeout(30_000), redirect: 'error' }).catch(error => {
    throw new Error(`Official photo download needs setup-time internet access. ${error.message}`);
  });
  assert.ok(response.ok, `Official photo download failed: HTTP ${response.status}`);
  const fixture = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(fixture), fixtureSHA256, 'Official photo SHA-256 mismatch; refusing substituted benchmark input');
  const result = {
    schemaVersion: 1, runAt: new Date().toISOString(), sdk: manifest.package, model: manifest.model,
    hardware: { os: platform(), release: release(), arch: arch(), cpuModel: cpus()[0]?.model ?? null,
      cpuCount: cpus().length, memoryBytes: totalmem(), node: process.versions.node },
    fixture: { url: fixtureURL, sha256: fixtureSHA256, width: 640, height: 640 },
    method: 'Sequential real worker inference on a static photo; 3 warmups + 20 samples per CPU/GPU × 320/640/960px. 960px is upscaled. Isolated document; no application render, physical webcam or camera-to-photon measurement.',
  };
  for (const type of [chromium, webkit]) {
    console.log(`Measuring ${type.name()} CPU/GPU at 320, 640 and 960px…`);
    result[type.name()] = await measure(type, fixture.toString('base64'));
  }
  await writeFile(new URL('benchmark-result.json', root), `${JSON.stringify(result, null, 2)}\n`);
  console.log('Wrote benchmark-result.json (overwrites previous generated run; committed docs/benchmark-data.json is unchanged).');
}

main().catch(error => {
  console.error('Benchmark failed:', error);
  process.exitCode = 1;
});
