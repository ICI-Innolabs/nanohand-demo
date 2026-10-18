import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { NanoHandController } from './rig';

export class HandViewer {
  readonly controller: NanoHandController;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private readonly cameraOffset = new THREE.Vector3();
  private lastMs: number | undefined;
  private disposed = false;

  constructor(private readonly container: HTMLElement) {
    // Let the UI report WebGL initialization failure rather than show a fake model.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.scene.background = new THREE.Color(0x16232c);
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Procedural articulated robotic hand. Drag to orbit, scroll to zoom; arrow keys pan.');
    container.append(canvas);

    this.controller = new NanoHandController();
    this.scene.add(this.controller.root);
    this.scene.add(new THREE.HemisphereLight(0xe4eff5, 0x475450, 2));
    const key = new THREE.DirectionalLight(0xffefcf, 2.8);
    key.position.set(-4, 7, 8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xabcddd, 1.5);
    fill.position.set(5, 1, -4);
    this.scene.add(fill);
    this.camera.position.set(2.4, 1.9, 12);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(-0.48, 0.65, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = Math.PI * 0.94;
    this.controls.minPolarAngle = Math.PI * 0.06;
    this.controls.listenToKeyEvents(canvas);
    this.controls.update();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Fit the photo-proportioned fingers, offset thumb and wider stand in portrait too.
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const distance = Math.max(4.35 / Math.tan(halfFov), 2.9 / (Math.tan(halfFov) * this.camera.aspect));
    this.cameraOffset.copy(this.camera.position).sub(this.controls.target).normalize().multiplyScalar(distance);
    this.camera.position.copy(this.controls.target).add(this.cameraOffset);
    this.controls.minDistance = distance * 0.46;
    this.controls.maxDistance = distance * 2.6;
    this.renderer.setSize(width, height, false);
    this.controls.update();
  }

  render(nowMs: number): void {
    if (this.disposed) return;
    const deltaSeconds = this.lastMs === undefined ? 0 : Math.max(0, Math.min(0.1, (nowMs - this.lastMs) / 1000));
    this.lastMs = nowMs;
    this.controls.update(deltaSeconds);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.controls.dispose();
    this.controller.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
