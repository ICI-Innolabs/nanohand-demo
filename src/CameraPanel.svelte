<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { MediaPipeTracker, type BackendPreference, type TrackerInfo } from './lib/tracker';
  import type { TrackingFrame } from './lib/types';

  let { onframe, onstatus, disabled = false, children }: {
    onframe?: (frame: TrackingFrame | null) => void;
    onstatus?: (status: string) => void;
    disabled?: boolean;
    children?: Snippet;
  } = $props();

  let video: HTMLVideoElement;
  let overlay: HTMLCanvasElement;
  let phase = $state<'idle' | 'starting' | 'running' | 'error'>('idle');
  let starting = $state(false);
  let status = $state('Camera off');
  let message = $state('');
  let preference = $state<BackendPreference>('auto');
  let cameraChoice = $state('user');
  let resolution = $state(640);
  let mirrored = $state(true);
  let devices = $state<MediaDeviceInfo[]>([]);
  let info = $state<TrackerInfo | null>(null);

  const connections = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
  ];
  let destroyed = false;
  let session = 0;
  let stream: MediaStream | null = null;
  let tracker: MediaPipeTracker | null = null;
  let animationFrame = 0;
  let removeTrackListeners: (() => void)[] = [];
  let capturing = false;
  let lastVideoTime = -1;
  let lastCaptureMs = 0;
  let lastUiMs = 0;
  let windowStartMs = 0;
  let sampleCount = 0;
  let inferenceTotalMs = 0;
  let slowWindows = 0;
  let reduced = $state(false);
  let seenHand = false;

  const current = (token: number) => !destroyed && session === token;

  function publishStatus(next: string) {
    if (destroyed || status === next) return;
    status = next;
    onstatus?.(next);
  }

  function clearOverlay() {
    overlay?.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
  }

  function release() {
    session += 1;
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    for (const remove of removeTrackListeners) remove();
    removeTrackListeners = [];
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    tracker?.close();
    tracker = null;
    clearOverlay();
  }

  function stop(next = 'Camera off', explanation = '', failed = false) {
    release();
    if (destroyed) return;
    phase = failed ? 'error' : 'idle';
    info = null;
    message = explanation;
    publishStatus(next);
  }

  function errorMessage(error: unknown): string {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was denied or blocked. Allow camera access in browser and system settings, then retry. Embedded pages also need camera permission from their host.';
    if (name === 'NotFoundError') return 'No camera is available. Connect a camera or choose another device, then retry.';
    if (name === 'NotReadableError') return 'The camera is busy or unavailable to the browser. Close other camera apps and check system permissions, then retry.';
    if (name === 'OverconstrainedError') return 'The selected camera or requested settings are unavailable. Choose another camera or a smaller processing size, then retry.';
    if (name === 'AbortError') return 'Camera startup was interrupted. Check the device connection, then retry.';
    return error instanceof Error ? `${error.message} Choose Start camera to retry.` : 'Camera or local tracking could not start. Check browser support and retry.';
  }

  async function refreshDevices(token: number) {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const available = await navigator.mediaDevices.enumerateDevices();
      if (current(token)) devices = available.filter(device => device.kind === 'videoinput' && device.deviceId);
    } catch {
      // Device labels are optional; camera permission and tracking errors are reported separately.
    }
  }

  function resetWindow(now: number) {
    windowStartMs = now;
    sampleCount = 0;
    inferenceTotalMs = 0;
  }

  function draw(frame: TrackingFrame | null) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (overlay.width !== width || overlay.height !== height) {
      overlay.width = width;
      overlay.height = height;
    }
    const context = overlay.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (!frame) return;
    context.strokeStyle = '#94d8e3';
    context.fillStyle = '#ffb49d';
    context.lineWidth = Math.max(2, width / 260);
    context.lineCap = 'round';
    context.beginPath();
    for (const [from, to] of connections) {
      const a = frame.landmarks[from];
      const b = frame.landmarks[to];
      if (!a || !b) continue;
      context.moveTo(a.x * width, a.y * height);
      context.lineTo(b.x * width, b.y * height);
    }
    context.stroke();
    for (const point of frame.landmarks) {
      context.beginPath();
      context.arc(point.x * width, point.y * height, Math.max(3, width / 180), 0, Math.PI * 2);
      context.fill();
    }
  }

  async function capture(token: number, activeTracker: MediaPipeTracker) {
    capturing = true;
    lastVideoTime = video.currentTime;
    const timestampMs = performance.now();
    lastCaptureMs = timestampMs;
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const scale = Math.min(1, (reduced ? 320 : resolution) / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    try {
      const bitmap = await createImageBitmap(video, { resizeWidth: width, resizeHeight: height });
      if (!current(token)) {
        bitmap.close();
        return;
      }
      const result = await activeTracker.detect(bitmap, timestampMs, bitmap.width / bitmap.height);
      if (!current(token)) return;
      draw(result.frame);
      onframe?.(result.frame);
      if (!current(token)) return;
      if (result.frame) seenHand = true;
      sampleCount += 1;
      inferenceTotalMs += result.inferenceMs;
      const elapsed = result.receivedMs - windowStartMs;
      const mean = inferenceTotalMs / sampleCount;
      if (result.receivedMs - lastUiMs >= 200) {
        info = activeTracker.info;
        publishStatus(result.frame ? 'Hand detected' : seenHand ? 'Hand lost' : 'Searching');
        lastUiMs = result.receivedMs;
      }
      if (elapsed >= 1000) {
        slowWindows = mean > 45 ? slowWindows + 1 : 0;
        if (slowWindows >= 2 && resolution > 320) reduced = true;
        resetWindow(result.receivedMs);
      }
    } catch (error) {
      if (current(token)) stop('Camera error', errorMessage(error), true);
    } finally {
      if (current(token)) capturing = false;
    }
  }

  function schedule(token: number, activeTracker: MediaPipeTracker) {
    const tick = (now: number) => {
      if (!current(token) || phase !== 'running') return;
      animationFrame = requestAnimationFrame(tick);
      const interval = activeTracker.info.execution === 'main' ? 1000 / 15 : 0;
      if (video.readyState < 2 || video.paused || video.ended || !video.videoWidth || !video.videoHeight) return;
      const decodedTime = video.currentTime;
      if (capturing || activeTracker.busy) {
        lastVideoTime = decodedTime;
        return;
      }
      if (decodedTime === lastVideoTime || now - lastCaptureMs < interval) return;
      void capture(token, activeTracker);
    };
    animationFrame = requestAnimationFrame(tick);
  }

  async function start() {
    if (destroyed || starting || phase === 'running') return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof createImageBitmap !== 'function' || !overlay.getContext('2d')) {
      stop('Camera error', 'Camera tracking needs HTTPS or localhost, camera access, Canvas, and ImageBitmap support. Open this page in a current supported browser on a secure address, then retry.', true);
      return;
    }
    if (document.hidden) {
      stop('Camera off', 'Return to this tab, then choose Start camera.');
      return;
    }
    release();
    const token = session;
    starting = true;
    phase = 'starting';
    message = 'Allow camera access in the browser prompt. You can cancel startup here; an unanswered browser prompt may remain open.';
    publishStatus('Requesting camera');
    try {
      const camera = cameraChoice === 'user' || cameraChoice === 'environment'
        ? { facingMode: { ideal: cameraChoice } }
        : { deviceId: { exact: cameraChoice } };
      const nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...camera, width: { ideal: resolution }, height: { ideal: Math.round(resolution * 0.75) } } });
      if (!current(token)) {
        for (const track of nextStream.getTracks()) track.stop();
        return;
      }
      stream = nextStream;
      video.srcObject = nextStream;
      for (const track of nextStream.getVideoTracks()) {
        const ended = () => {
          if (current(token)) stop('Camera error', 'The camera disconnected or permission was revoked. Check the device and browser permissions, then choose Start camera.', true);
        };
        const muted = () => {
          if (current(token)) stop('Camera error', 'The camera stopped supplying video. Tracking has been cleared and the camera released. Check other camera apps, then choose Start camera.', true);
        };
        track.addEventListener('ended', ended);
        track.addEventListener('mute', muted);
        removeTrackListeners.push(() => {
          track.removeEventListener('ended', ended);
          track.removeEventListener('mute', muted);
        });
      }
      void refreshDevices(token);
      publishStatus('Loading hand tracker');
      message = 'Loading the same-origin hand model and MediaPipe runtime. No frames are uploaded or recorded.';
      const nextTracker = await MediaPipeTracker.create(preference);
      if (!current(token)) {
        nextTracker.close();
        return;
      }
      tracker = nextTracker;
      info = nextTracker.info;
      await video.play();
      if (!current(token)) return;
      if (!nextStream.getVideoTracks().some(track => track.readyState === 'live' && !track.muted)) throw new Error('The selected camera is not supplying video.');
      capturing = false;
      lastVideoTime = -1;
      lastCaptureMs = 0;
      lastUiMs = 0;
      slowWindows = 0;
      reduced = false;
      seenHand = false;
      resetWindow(performance.now());
      phase = 'running';
      message = '';
      publishStatus('Searching');
      schedule(token, nextTracker);
    } catch (error) {
      if (current(token)) stop('Camera error', errorMessage(error), true);
    } finally {
      if (!destroyed) starting = false;
    }
  }

  function changeCamera(value: string) {
    stop('Camera off', 'Camera selection changed. Choose Start camera to connect; camera access never restarts automatically.');
    cameraChoice = value;
  }

  function changeBackend(value: BackendPreference) {
    stop('Camera off', 'Backend preference changed. Choose Start camera to load the selected backend.');
    preference = value;
  }

  function changeResolution(value: number) {
    resolution = value;
    reduced = false;
    slowWindows = 0;
    resetWindow(performance.now());
  }

  onMount(() => {
    const hidden = () => {
      if (document.hidden && (phase === 'running' || phase === 'starting')) stop('Camera off', 'Camera released because this tab was hidden. Choose Start camera to restart.');
    };
    const leaving = () => {
      if (phase === 'running' || phase === 'starting') stop('Camera off', 'Camera released when leaving the page. Choose Start camera to restart.');
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    void refreshDevices(session);
    onstatus?.('Camera off');
    return () => {
      destroyed = true;
      release();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
    };
  });
</script>

<div class="camera-panel">
  <section class="input-pane" aria-labelledby="input-heading">
    <div class="pane-header"><h2 id="input-heading">Your camera</h2><span class="quiet-label">Live preview</span></div>
    <div class="camera-viewport">
      <div class="camera-media" class:visible={phase === 'running'} class:mirrored>
        <video bind:this={video} autoplay playsinline muted aria-label="Local webcam preview"></video>
        <canvas bind:this={overlay} aria-hidden="true"></canvas>
      </div>
      {#if phase !== 'running'}
        <div class="camera-empty">
          <svg class="camera-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M7 14h23a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V14Zm26 7 8-5v17l-8-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
          <h3>{phase === 'starting' ? 'Connecting camera…' : phase === 'error' ? 'Camera unavailable' : 'Start with your camera'}</h3>
          <p>{phase === 'starting' ? 'Allow access in the browser prompt.' : phase === 'error' ? 'Check the message above, then retry.' : 'Use Start camera above to begin.'}</p>
        </div>
      {/if}
    </div>
  </section>

  <div class="camera-controls">
    {#if phase === 'starting' || phase === 'running'}
      <button class="secondary-button" onclick={() => stop()}>{phase === 'starting' ? 'Cancel startup' : 'Stop camera'}</button>
    {:else}
      <button class="primary-button" disabled={starting || disabled} onclick={start}>{phase === 'error' ? 'Retry camera' : 'Start camera'}</button>
    {/if}
    {#if message}<p class="camera-message" class:camera-error={phase === 'error'} role={phase === 'error' ? 'alert' : undefined}>{message}</p>{/if}
    {#if starting && phase !== 'starting'}<p class="camera-message">Dismiss the open browser permission prompt before starting again. Any late camera access will be released.</p>{/if}
  </div>

  <section class="settings-panel" aria-labelledby="settings-heading">
    <div class="settings-heading"><h2 id="settings-heading">Tracking settings</h2><span>Camera, smoothing & calibration</span></div>
    <div class="settings-grid">
      <fieldset>
        <legend>Camera</legend>
        <label>Camera<select value={cameraChoice} onchange={(event) => changeCamera(event.currentTarget.value)}><option value="user">Front / user-facing</option><option value="environment">Rear / environment</option>{#each devices as device, index}<option value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>{/each}</select></label>
        <label class="check-control"><input type="checkbox" bind:checked={mirrored} /><span>Selfie mirror<small>Preview only; tracking stays unchanged.</small></span></label>
        <details class="advanced-settings"><summary>Troubleshooting</summary>
          <label>Backend preference<select value={preference} onchange={(event) => changeBackend(event.currentTarget.value as BackendPreference)}><option value="auto">Auto · GPU with CPU fallback</option><option value="CPU">CPU</option><option value="GPU">GPU · with CPU fallback</option></select></label>
          <label>Processing long edge<select value={resolution} onchange={(event) => changeResolution(Number(event.currentTarget.value))}><option value={320}>320 px</option><option value={640}>640 px</option><option value={960}>960 px</option></select></label>
          <p class="field-help">{info ? `Using ${info.backend}${info.execution === 'main' ? ' · compatibility mode, up to 15 updates/sec' : ''}.` : 'Tracking starts with your camera.'}</p>
          {#if info?.fallbackReason}<p class="field-help">Compatibility fallback: {info.fallbackReason}</p>{/if}
        </details>
      </fieldset>
      {@render children?.()}
    </div>
    {#if reduced}<p class="field-help adaptive-note" role="status">Using a smaller image to keep tracking responsive. Restart the camera to try the original size.</p>{/if}
  </section>
</div>
