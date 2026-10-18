<script lang="ts">
  import { onMount } from 'svelte';
  import CameraPanel from './CameraPanel.svelte';
  import { estimateAngles, type AngleEstimate } from './lib/kinematics';
  import { Retargeter } from './lib/retargeting';
  import { HandViewer } from './lib/viewer';
  import { PoseSynchronizer, type MotionState } from './lib/motion';
  import { RIG_MANIFEST } from './lib/rig';
  import type { Handedness, TrackingFrame } from './lib/types';

  let viewerHost: HTMLDivElement;
  let enlargeButton: HTMLButtonElement;
  let viewer: HandViewer | undefined;
  let retargeter: Retargeter | undefined;
  let synchronizer: PoseSynchronizer | undefined;
  let ready = $state(false);
  let viewerError = $state('');
  let cameraStatus = $state('Camera off');
  let handSelection = $state<'auto' | 'Left' | 'Right'>('auto');
  let modelMirrored = $state(false);
  let enlarged = $state(false);
  let smoothingMs = $state(70);
  let motionState = $state<MotionState>('searching');
  let estimate = $state.raw<AngleEstimate | null>(null);
  let observedHand = $state<Handedness>('Unknown');
  let observationCurrent = $state(false);
  let renderedAngles = $state.raw<Record<string, string>>({});
  let calibrationMessage = $state('Optional: capture an open hand, then a fist. Calibration is separate for each hand.');
  let pendingEstimate: AngleEstimate | null = null;
  let pendingHand: Handedness = 'Unknown';
  let pendingCurrent = false;

  const angleRows = [
    { key: 'data-wrist-pitch', label: 'Wrist pitch' },
    ...RIG_MANIFEST.map(binding => ({
      key: `data-${binding.id.replace('.', '-').toLowerCase()}`,
      label: binding.id === 'thumb.PIP' ? 'Thumb IP' : binding.label.replace('pinky', 'little').replace(/^./, letter => letter.toUpperCase()),
    })),
  ];

  const cameraRunning = $derived(['Searching', 'Hand detected', 'Hand lost'].includes(cameraStatus));
  const canCapture = $derived(cameraRunning && motionState === 'tracked' && observationCurrent && estimate?.quality === 'good' && observedHand !== 'Unknown');
  const trackingLabel = $derived(!cameraRunning ? cameraStatus : motionState === 'tracked' ? `Tracking${observedHand === 'Unknown' ? '' : ` · ${observedHand.toLowerCase()} hand`}` : motionState === 'recovering' ? 'Reconnecting' : motionState === 'holding' || motionState === 'lost' ? 'Hand lost' : 'Show your hand');
  const trackingHelp = $derived(!cameraRunning ? '' : motionState === 'holding' ? 'Holding briefly. Bring your hand back into view.' : motionState === 'lost' ? 'Returning to open. Keep your palm and fingertips visible.' : motionState === 'recovering' ? 'Keep your hand visible while tracking settles.' : motionState === 'tracked' ? 'The robot hand follows your fingers. Contact limits prevent fingers passing through each other.' : 'Hold one hand in view, with your palm and fingertips visible.');

  function refreshState() {
    estimate = pendingEstimate;
    observedHand = pendingHand;
    observationCurrent = pendingCurrent;
    motionState = synchronizer?.status ?? 'searching';
    if (!viewer) return;
    const angles: Record<string, string> = {};
    angles['data-wrist-pitch'] = String(viewer.controller.wristPitchRad);
    for (const binding of viewer.controller.manifest) {
      const rotation = viewer.controller.bindings.get(binding.id)!.rotation[binding.axis];
      angles[`data-${binding.id.replace('.', '-').toLowerCase()}`] = String((rotation - binding.neutralOffsetRad) / binding.sign);
    }
    renderedAngles = angles;
  }

  function formatAngle(value: string | undefined): string {
    if (value === undefined) return '—';
    const degrees = Number(value) * 180 / Math.PI;
    return `${(Math.abs(degrees) < 0.05 ? 0 : degrees).toFixed(1)}°`;
  }

  function clearObservation() {
    pendingEstimate = null;
    pendingHand = 'Unknown';
    pendingCurrent = false;
    synchronizer?.reset(performance.now());
    viewer?.controller.resetPose();
    refreshState();
  }

  function receiveFrame(frame: TrackingFrame | null) {
    if (document.hidden || !synchronizer || !retargeter) return;
    if (frame && pendingHand !== 'Unknown' && frame.handedness !== pendingHand) clearObservation();
    const result = frame ? estimateAngles(frame, handSelection) : null;
    pendingEstimate = result;
    pendingCurrent = false;
    const now = performance.now();
    if (frame && result?.pose && result.validJoints.length) {
      pendingHand = frame.handedness;
      pendingCurrent = synchronizer.push(retargeter.map(result.pose, frame.handedness).pose, now, result.validJoints);
      if (!pendingCurrent) synchronizer.push(null, now);
    } else {
      synchronizer.push(null, now);
    }
  }

  function cameraStateChanged(status: string) {
    cameraStatus = status;
    if (!['Searching', 'Hand detected', 'Hand lost'].includes(status)) clearObservation();
  }

  function selectHand(selection: 'auto' | 'Left' | 'Right') {
    handSelection = selection;
    clearObservation();
  }

  function calibrate(kind: 'neutral' | 'fist') {
    if (!canCapture || !pendingCurrent || pendingEstimate?.quality !== 'good' || !pendingEstimate.pose || !retargeter) return;
    const result = retargeter.calibrate(kind, pendingEstimate.pose, pendingHand);
    calibrationMessage = result.applied
      ? `${pendingHand} hand: ${kind === 'neutral' ? 'open hand' : 'fist'} captured.${result.rejected.length ? ' Some fingers need a clearer pose; capture again with every fingertip visible.' : ''}`
      : 'Could not capture a usable range. Keep your whole hand visible and try again.';
  }

  function resetCalibration() {
    retargeter?.resetCalibration();
    calibrationMessage = 'Calibration cleared for both hands.';
  }

  function closeEnlarged(event: KeyboardEvent) {
    if (event.key === 'Escape' && enlarged) {
      enlarged = false;
      enlargeButton?.focus();
    }
  }

  onMount(() => {
    let animationFrame = 0;
    let lastUiMs = 0;
    const hidden = () => { if (document.hidden) clearObservation(); };
    const leaving = () => clearObservation();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    try {
      viewer = new HandViewer(viewerHost);
      retargeter = new Retargeter(viewer.controller.manifest);
      synchronizer = new PoseSynchronizer(viewer.controller.manifest, { tauMs: smoothingMs });
      ready = true;
      const animate = (now: number) => {
        if (!document.hidden) {
          viewer!.controller.setPose(synchronizer!.sample(now));
          viewer!.render(now);
          if (now - lastUiMs >= 100) {
            refreshState();
            lastUiMs = now;
          }
        }
        animationFrame = requestAnimationFrame(animate);
      };
      animationFrame = requestAnimationFrame(animate);
    } catch (error) {
      viewerError = error instanceof Error ? error.message : 'The 3D viewer could not start.';
      viewer?.dispose();
      viewer = undefined;
    }
    return () => {
      cancelAnimationFrame(animationFrame);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
      viewer?.dispose();
      viewer = undefined;
    };
  });
</script>

<svelte:window onkeydown={closeEnlarged} />

<div class="app-shell">
  <header class="app-header">
    <a class="brand" href="#workspace" aria-label="NanoHand Mirror workspace">
      <svg class="brand-mark" viewBox="0 0 28 32" fill="none" aria-hidden="true"><path d="M7 21V10a2 2 0 0 1 4 0v6-10a2 2 0 0 1 4 0v10-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 5-3 8-8 8h-1c-3 0-5-1-7-4l-4-5a2 2 0 0 1 3-3l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <span>NanoHand <strong>Mirror</strong></span>
    </a>
    <a class="icon-button github-link" href="https://github.com/ICI-Innolabs/nanohand-demo" target="_blank" rel="noopener noreferrer" aria-label="View source on GitHub (opens in a new tab)" title="View source on GitHub">
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>
    </a>
  </header>

  <main id="workspace">
    <div class="workspace-heading">
      <div><h1>Live mirror</h1><p>Keep your palm and fingertips in view.</p></div>
      <span class="connection-status" role="status" data-testid="tracking-status"><span class="status-dot" class:status-active={cameraRunning && motionState === 'tracked'}></span>{trackingLabel}</span>
    </div>

    <div class="comparison" class:enlarged>
      <CameraPanel onframe={receiveFrame} onstatus={cameraStateChanged} disabled={!ready}>
        <fieldset>
          <legend>Hand tracking</legend>
          <label>Track anatomical hand<select aria-label="Track anatomical hand" value={handSelection} onchange={(event) => selectHand(event.currentTarget.value as 'auto' | 'Left' | 'Right')}><option value="auto">Auto · detected hand</option><option value="Left">Left only</option><option value="Right">Right only</option></select></label>
          <label class="check-control"><input type="checkbox" bind:checked={modelMirrored} onchange={(event) => viewer?.controller.setMirror(event.currentTarget.checked)} /><span>Mirror model side<small>Display only; does not change the hand being tracked.</small></span></label>
          <div class="stability-field"><div class="range-heading"><label for="smoothing">Smoothing / stability</label><output for="smoothing">{smoothingMs} ms</output></div><input id="smoothing" type="range" min="0" max="300" step="10" value={smoothingMs} oninput={(event) => { smoothingMs = Number(event.currentTarget.value); synchronizer?.configure({ tauMs: smoothingMs }); }} /><p class="field-help">Lower follows faster. Higher steadies a shaky pose.</p></div>
        </fieldset>
        <fieldset class="calibration-controls">
          <legend>Calibrate your hand</legend>
          <p class="field-help">If the hand doesn’t open or close fully, capture these two poses with your whole hand in view.</p>
          <div class="calibration-actions"><button class="secondary-button" data-testid="capture-neutral" disabled={!canCapture} onclick={() => calibrate('neutral')}>Capture open hand</button><button class="secondary-button" data-testid="capture-fist" disabled={!canCapture} onclick={() => calibrate('fist')}>Capture fist</button><button class="text-button" onclick={resetCalibration}>Reset calibration</button></div>
          <p class="field-help" role="status">{calibrationMessage}</p>
          {#if !canCapture}<p class="field-help">{cameraRunning ? 'Hold a clearly visible hand steady to enable capture.' : 'Start the camera to calibrate.'}</p>{/if}
        </fieldset>
      </CameraPanel>

      <details class="joint-angles" open>
        <summary>Joint angles <span>· live model</span></summary>
        <table aria-label="Model joint rotations in degrees">
          <thead><tr><th scope="col">Joint</th><th scope="col">Angle</th></tr></thead>
          <tbody>
            {#each angleRows as joint (joint.key)}
              <tr><th scope="row">{joint.label}</th><td>{formatAngle(renderedAngles[joint.key])}</td></tr>
            {/each}
          </tbody>
        </table>
      </details>

      <section class="output-pane" aria-labelledby="output-heading">
        <div class="pane-header"><h2 id="output-heading">Robot hand</h2><button class="icon-button" bind:this={enlargeButton} aria-label={enlarged ? 'Restore side-by-side view' : 'Enlarge model viewer'} aria-pressed={enlarged} onclick={() => enlarged = !enlarged}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true">{#if enlarged}<path d="M3 7h4V3m6 0v4h4M3 13h4v4m6 0v-4h4" />{:else}<path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />{/if}</svg><span>{enlarged ? 'Restore' : 'Enlarge'}</span></button></div>
        <div class="model-viewport">
          {#if viewerError}<div class="viewer-error" role="alert"><h3>3D viewer unavailable</h3><p>{viewerError}</p><p>Enable WebGL in your browser, then reload.</p></div>{/if}
          <div class="viewer-host" bind:this={viewerHost} role="img" aria-label="Interactive ivory robotic hand. Drag to orbit and scroll or pinch to zoom." data-testid="rendered-pose" {...renderedAngles}></div>
          <p class="viewer-help">Drag to orbit · Scroll or pinch to zoom{#if enlarged} · Esc to restore{/if}</p>
        </div>
      </section>
      {#if trackingHelp}<p class="tracking-help" data-testid="tracking-help">{trackingHelp}</p>{/if}
    </div>
    <footer class="workspace-footer"><span>Live visualization. No physical hand connected.</span><span>© <a href="https://innolabs.ro">ICI Innolabs</a></span></footer>
  </main>
</div>
