# NanoHand Mirror

Mirror individual finger movements from your webcam onto a 3D robotic hand. Tracking runs locally in your browser using MediaPipe, with a Svelte + TypeScript interface and Three.js rendering.

## Run locally

Requires **Node.js 24+**, a webcam, and a current browser with camera and WebGL support.

```sh
npm ci
npm run assets
npm run dev
```

Open the local URL printed by Vite. Camera access requires **localhost or HTTPS**, plus browser and OS camera permission.

Installation requires internet access. The asset setup command installs missing model/WASM files and verifies their sizes and SHA-256 hashes against the [asset manifest](public/models/manifest.json). Runtime inference uses assets served by the app.

## Use

1. Select **Start camera** and grant permission.
2. Hold one hand in view, keeping your palm and fingertips visible. The preview shows tracked landmarks while the robot hand follows your fingers.
3. Select **Stop camera** to release the camera. Hiding the tab or leaving the page also stops capture; returning requires starting it again.

In **Tracking settings**, choose a camera and anatomical hand, adjust preview/model mirroring, or change smoothing. Lower smoothing follows faster; higher smoothing steadies movement. Camera and backend changes require restarting capture.

For optional calibration, hold your hand steady until the capture controls enable, then select **Capture open hand**, followed by **Capture fist**. Calibration is separate for each hand; **Reset calibration** clears both.

Drag the model to orbit, scroll or pinch to zoom, and select **Enlarge** for a bigger view. Escape restores the comparison. **Joint angles · live model** shows the rendered wrist and finger angles in degrees.

## Checks

```sh
npm run check
npm test
```

For browser tests:

```sh
npx playwright install chromium
npm run test:e2e
```

Browser tests cover camera lifecycle, privacy, motion, and retargeting. They do not establish physical-camera accuracy or compatibility with every browser.

## Build and deploy

```sh
npm run build
npm run preview
```

Deploy the entire `dist/` directory to a static HTTPS host, including `models/`, `wasm/`, and `THIRD_PARTY_NOTICES.txt`. Serve `.wasm` files as `application/wasm`. Subpath hosting requires configuring Vite's base and checking model/WASM URLs; the default assumes the origin root.

## Privacy and limitations

- Camera frames, landmarks, and poses stay on your device. The app has no recording, uploads, analytics, or automatic storage. Your hosting provider may log normal page and asset requests.
- MediaPipe Tasks Vision is pinned to **0.10.35** with matching verified assets. Run the privacy tests, including shutdown behavior, before updating it.
- Tracking one hand from an RGB camera is approximate. Occlusion, poor lighting, and fast movement reduce accuracy. GPU failures fall back to CPU, which may be slower.
- The robotic hand is a visual model, not calibrated hardware control. Displayed joint angles describe the rendered model, not measured anatomical angles; wrist pitch stays neutral.

## License

Original project code is available under the [MIT License](LICENSE.md).

Bundled third-party assets retain their upstream licenses. Preserve [`THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt) when redistributing. The MediaPipe SDK declares Apache-2.0. The linked model card predates the versioned task bundle and does not bind its license statement to the exact bundled digest; review the license evidence in the [asset manifest](public/models/manifest.json) before redistribution/commercial deployment.
