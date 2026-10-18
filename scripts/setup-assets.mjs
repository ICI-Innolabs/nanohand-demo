import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Small deterministic self-check; no network or asset publication is needed for this assertion.
assert.equal(hash(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

function verify(bytes, asset, label) {
  assert.equal(bytes.length, asset.bytes, `${label}: byte length mismatch`);
  assert.equal(hash(bytes), asset.sha256, `${label}: SHA256 mismatch; refusing to publish assets`);
}

async function setup() {
  const manifest = JSON.parse(await readFile(join(publicDir, 'models/manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.package.name, '@mediapipe/tasks-vision');
  assert.equal(manifest.package.version, '0.10.35');
  assert.equal(manifest.model.url, 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task');
  assert.equal(manifest.model.path, 'models/hand_landmarker.task');
  assert.equal(manifest.wasm.length, 6);
  const assets = [...manifest.wasm, manifest.model];
  assert.equal(manifest.model.name, 'hand_landmarker.task');
  assert.equal(new Set(assets.map((asset) => asset.path)).size, assets.length);
  for (const asset of assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
    if (asset !== manifest.model) {
      assert.match(asset.name, /^vision_wasm_(?:internal|module_internal|nosimd_internal)\.(?:js|wasm)$/);
      assert.equal(asset.path, `wasm/${asset.name}`);
    }
  }

  const packageDir = dirname(fileURLToPath(import.meta.resolve('@mediapipe/tasks-vision')));
  const installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(installed.version, manifest.package.version, 'Run npm ci to install the pinned MediaPipe package');
  // Verify the installed source too, even when public assets already exist.
  for (const asset of manifest.wasm) {
    verify(await readFile(join(packageDir, 'wasm', asset.name)), asset, `Installed ${asset.name}`);
  }

  const missing = [];
  for (const asset of assets) {
    let bytes;
    try {
      bytes = await readFile(join(publicDir, asset.path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (bytes) verify(bytes, asset, `Existing ${asset.path} (remove this file explicitly before retrying if corrupt)`);
    else missing.push(asset);
  }
  if (!missing.length) {
    console.log('All pinned model/WASM assets already exist and match SHA256.');
    return;
  }

  const staging = await mkdtemp(join(publicDir, '.assets-'));
  const published = [];
  try {
    for (const asset of missing) {
      const staged = join(staging, asset.name);
      if (asset === manifest.model) {
        const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
        if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        verify(bytes, asset, asset.url);
        await writeFile(staged, bytes, { flag: 'wx' });
      } else {
        await copyFile(join(packageDir, 'wasm', asset.name), staged);
      }
      verify(await readFile(staged), asset, `Staged ${asset.name}`);
    }
    // Stage and verify everything first. Hard links publish complete files atomically without overwriting.
    for (const asset of missing) {
      const destination = join(publicDir, asset.path);
      await mkdir(dirname(destination), { recursive: true });
      await link(join(staging, asset.name), destination);
      published.push(destination);
    }
    console.log(`Installed ${missing.length} verified same-origin assets. No runtime CDN is required.`);
  } catch (error) {
    // Roll back only files this invocation created; preserve existing files and the manifest.
    const cleanup = await Promise.allSettled(published.map((path) => unlink(path)));
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError([error, ...failures.map((result) => result.reason)], 'Asset setup failed and rollback was incomplete');
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

setup().catch((error) => {
  console.error('Asset setup failed:', error);
  process.exitCode = 1;
});
