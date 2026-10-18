# NanoHand Mirror

A browser-only Svelte + TypeScript + Three.js workspace that mirrors individual fingers from a live camera onto an ivory articulated robotic hand. Tracking uses continuous landmark geometry, not gesture classification. Camera frames, landmarks and poses stay on the device; no physical robot is connected.

## Run locally

Use Node.js 24+:

```sh
npm ci
npm run assets
npm run dev
```

Open the local URL Vite prints. Camera access requires localhost or HTTPS, browser permission and OS camera permission. A phone opening a computer’s plain HTTP LAN address does not receive localhost’s secure-context exemption.

`npm run assets` copies six pinned MediaPipe JS/WASM files and downloads the hand model if absent. Assets are verified against the byte lengths and SHA-256 values in [`public/models/manifest.json`](public/models/manifest.json). Existing mismatching files are rejected rather than overwritten. Installation requires internet access; runtime inference uses same-origin assets, not a CDN. After dependency changes, restart Vite with `npm run dev -- --force` once to clear its optimized-dependency cache.

## Use

1. Choose **Start camera** and grant access. Opening the page does not request permission or start tracking.
2. Keep one hand’s palm and fingertips visible. Compare the preview overlay with the robot hand. The status distinguishes camera startup, searching, tracking, recovery and loss.
3. Choose **Stop camera** to release the camera and tracker. Startup can be cancelled. Hiding the tab or leaving the page also releases capture; returning never restarts it automatically.

**Tracking settings** is always visible below the robot hand, with no collapse control. It contains camera selection, anatomical Left/Right/Auto selection, independent preview/model mirroring, smoothing and optional calibration. **Capture open hand**, then **Capture fist**, separately for each anatomical hand, when tracking has a current good-quality observation. **Reset calibration** clears both hands’ session captures. Lower smoothing follows faster; higher smoothing steadies noise. Troubleshooting contains backend and processing-size preferences; changing camera/backend requires an explicit restart.

Drag the model to orbit; scroll or pinch to zoom. Focus the canvas for arrow-key panning. **Enlarge** keeps camera controls accessible; Escape restores the comparison and button focus.

**Joint angles · live model**, expanded below the camera, shows wrist pitch and all 19 finger joints in degrees, refreshed at 10 Hz from the rendered rotations after smoothing and contact limits. Collapse it to reclaim space. These are visual model angles, not raw camera measurements or hardware feedback; wrist pitch is not camera-tracked and stays neutral. Stopping the camera resets the readings with the model.

There are no scripted gestures, synthetic input, actuator simulation, manual commands, diagnostic sweeps, recording, exports, imports or playback. Previously exported recording files are not modified, but the application no longer opens them. Generated landmark fixtures exist only in tests.

## Motion and geometry

Camera flexion cross-checks predicted world and aspect-corrected image landmarks, with a near-open noise deadband. Small real bends within that deadband can be suppressed. Per-hand calibration adjusts mapping without changing landmark data.

Independent joints pass through smoothing and velocity limits before the rig applies geometric contact constraints. Tracking loss briefly holds the last observation, then returns toward open; recovery needs consecutive fresh observations. Contact may limit a requested pose. This is a visual hand, not a calibrated motor model or hardware safety system. The procedural geometry is photo-referenced, not original CAD. See [architecture](docs/architecture.md) and the [rig audit](docs/rig-audit.md) for details and limits.

## Checks and production build

```sh
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright uses [`playwright.config.ts`](playwright.config.ts). Deterministic camera tests intercept worker responses and supply canvas video; privacy/lifecycle cases also exercise real MediaPipe inference. These are different evidence boundaries, not general physical-camera accuracy or browser-compatibility claims. See the [manual checklist](docs/manual-checklist.md).

Deploy the whole `dist/` directory, including `models/`, `wasm/` and `THIRD_PARTY_NOTICES.txt`, to a static HTTPS host. No inference backend is needed. The current configuration assumes the origin root; configure Vite’s base and validate asset URLs before subpath deployment. Serve `.wasm` as `application/wasm`, not an HTML fallback. `npm run preview` previews the production build locally.

## Privacy and limitations

- No analytics, automatic storage, uploads or recording. Static hosting still receives normal page/asset requests and may keep access logs.
- MediaPipe Tasks Vision is deliberately pinned to **0.10.35** with matching verified assets. The previously evaluated 1.1.1 emitted a post-Stop metrics request and was rejected. Re-run the full network privacy suite, including shutdown, before changing the pin; blocking requests is not proof of no telemetry.
- GPU initialization/inference failure falls back to CPU. If workers are unavailable, main-thread CPU capture is capped at 15 Hz and can affect responsiveness. Actual backend information is in Troubleshooting.
- Single RGB-camera tracking is approximate. Occlusion, low light, foreshortening, fast motion and handedness errors reduce quality. Thumb opposition is an approximation, not measured CMC rotation. No numerical joint-accuracy claim is made.
- Preserve [`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt). The SDK declares Apache-2.0. The linked model card predates the versioned task bundle and does not bind its license statement to this exact digest; review the [model-license provenance gap](docs/research.md) before redistribution/commercial deployment. No original Nano Hand mesh or third-party photograph is bundled.

## Historical evidence and standalone benchmark

[Benchmark results](docs/benchmark.md), [research](docs/research.md), the [former actuator simulation reference](docs/digital-twin.md), and [implementation history](docs/implementation-plan.md) retain their original evidence boundaries. They are not descriptions or measurements of the current camera-only UI or collision implementation.

The isolated inference benchmark remains available:

```sh
npx playwright install chromium webkit
npm run dev -- --port 5173 --strictPort
# In another terminal:
npm run benchmark
```

It downloads a digest-verified official sample photograph into memory and measures real CPU/GPU worker inference at 320/640/960 px, independently of the application viewer. The source image is 640 px, so 960 px is upscaled. This is not a physical-camera or camera-to-photon benchmark. A successful run overwrites ignored `benchmark-result.json`; it does not replace committed `docs/benchmark-data.json`.
