import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { FINGERS, neutralPose, type Finger, type JointBinding, type JointId, type RobotPose } from './types';
import { FingerContacts } from './collision';

const LONG_FINGERS = FINGERS.filter(finger => finger !== 'thumb');
const binding = (id: JointId, axis: JointBinding['axis'], minRad: number, maxRad: number, neutralOffsetRad = 0): JointBinding => ({
  id, nodeName: id, axis, sign: 1, neutralOffsetRad, minRad, maxRad,
  label: id.replace('.', ' '),
});

// shortcut: estimated visual travel; replace with measured limits when hardware geometry exists.
export const RIG_MANIFEST: JointBinding[] = [
  binding('thumb.opposition', 'y', 0, 1.3),
  binding('thumb.MCP', 'x', 0, 0.85),
  binding('thumb.PIP', 'x', 0, 1.05),
  ...LONG_FINGERS.flatMap(finger => [
    binding(`${finger}.spread`, 'z', -0.14, 0.14),
    binding(`${finger}.MCP`, 'x', 0, 1.15),
    binding(`${finger}.PIP`, 'x', 0, 1.35),
    binding(`${finger}.DIP`, 'x', 0, 0.85),
  ]),
];

export class NanoHandController {
  readonly root = new THREE.Group();
  readonly bindings = new Map<JointId, THREE.Object3D>();
  readonly manifest = RIG_MANIFEST.map(joint => ({ ...joint }));
  private readonly wrist = new THREE.Group();
  private readonly hand = new THREE.Group();
  private readonly links: { mesh: THREE.Mesh; from: THREE.Object3D; to: THREE.Object3D }[] = [];
  private readonly contacts: FingerContacts;
  private readonly inverseHand = new THREE.Matrix4();
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly shell = new RoundedBoxGeometry(1, 1, 1, 3, 0.16);
  private readonly cylinder = new THREE.CylinderGeometry(1, 1, 1, 24);
  private readonly capsule = new THREE.CapsuleGeometry(0.5, 1, 6, 16);
  private readonly channel = this.fingerChannel();
  private readonly ivory = new THREE.MeshStandardMaterial({ color: 0xe4e1d7, roughness: 0.66, metalness: 0 });
  private readonly insert = new THREE.MeshStandardMaterial({ color: 0xc3c3b9, roughness: 0.74, metalness: 0 });
  private readonly dark = new THREE.MeshStandardMaterial({ color: 0x20272b, roughness: 0.64, metalness: 0.1 });
  private readonly metal = new THREE.MeshStandardMaterial({ color: 0x9fa9ad, roughness: 0.32, metalness: 0.82 });
  private disposed = false;

  constructor() {
    this.root.name = 'NanoHand.procedural';
    this.wrist.name = 'wrist.pitch';
    this.wrist.position.set(0, -0.75, 0);
    const hand = this.hand;
    hand.name = 'hand.assembly';
    hand.position.y = 0.75;
    this.root.add(this.wrist);
    this.wrist.add(hand);

    // Photo-derived topology, not imported CAD; dimensions remain scene-unit estimates.
    for (const x of [-1.04, 1.04]) {
      const top = x < 0 ? 1.16 : 0.9;
      this.mesh(hand, 'palm.sideFrame', this.shell, this.ivory, [0.13, top + 0.63, 0.7], [x, (top - 0.63) / 2, -0.06]);
      for (const y of [-0.5, top - 0.16]) {
        const pin = this.mesh(hand, 'palm.fastener', this.cylinder, this.metal, [0.03, 0.73, 0.03], [x, y, -0.06]);
        pin.rotation.x = Math.PI / 2;
      }
      this.mesh(this.root, 'wrist.yoke', this.shell, this.ivory, [0.14, 0.94, 0.78], [x * 0.79, -1.05, 0]);
    }
    this.mesh(hand, 'palm.crossFrame', this.shell, this.insert, [2.05, 0.12, 0.64], [0, -0.5, -0.06]);
    // Step the crown below the shorter pinky's hinge instead of burying its proximal shell in the frame.
    this.mesh(hand, 'palm.crossFrame', this.shell, this.insert, [1.5, 0.12, 0.64], [-0.275, 1.12, -0.06]);
    this.mesh(hand, 'palm.crossFrame', this.shell, this.insert, [0.55, 0.12, 0.64], [0.75, 0.82, -0.06]);
    this.mesh(hand, 'palm.crossFrame', this.shell, this.insert, [0.12, 0.42, 0.64], [0.475, 0.97, -0.06]);
    const cameraBridge = new THREE.Shape();
    cameraBridge.moveTo(-0.79, -0.12);
    cameraBridge.bezierCurveTo(-1.02, -0.08, -0.93, 0.21, -0.7, 0.26);
    cameraBridge.quadraticCurveTo(0, 0.57, 0.7, 0.26);
    cameraBridge.bezierCurveTo(0.98, 0.17, 0.92, -0.1, 0.72, -0.1);
    cameraBridge.quadraticCurveTo(0, 0.12, -0.55, -0.08);
    cameraBridge.quadraticCurveTo(-0.69, -0.18, -0.79, -0.12);
    const bridge = new THREE.ExtrudeGeometry(cameraBridge, { depth: 0.12, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 2, curveSegments: 16 });
    this.mesh(hand, 'palm.cameraBridge', bridge, this.ivory, [1, 1, 1], [-0.12, 0.33, 0.33]);
    const lens = this.mesh(hand, 'palm.cameraLens', this.cylinder, this.insert, [0.12, 0.055, 0.12], [-0.12, 0.59, 0.5]);
    lens.rotation.x = Math.PI / 2;
    const glass = this.mesh(hand, 'palm.cameraGlass', this.cylinder, this.dark, [0.085, 0.008, 0.085], [-0.12, 0.59, 0.532]);
    glass.rotation.x = Math.PI / 2;
    this.mesh(hand, 'palm.littleSupport', this.capsule, this.ivory, [0.35, 0.64, 0.2], [0.8, 0.12, 0.35]).rotation.z = 0.1;
    this.mesh(hand, 'palm.thumbSupport', this.capsule, this.ivory, [0.5, 0.44, 0.23], [-0.28, -0.06, 0.29]).rotation.z = -0.4;
    this.mesh(hand, 'thumb.rollServo', this.shell, this.dark, [0.64, 0.5, 0.6], [-0.61, -0.32, 0.03]);

    this.mesh(this.root, 'wrist.servo', this.shell, this.dark, [1.35, 0.63, 0.72], [0, -1.17, 0]);
    this.mesh(this.root, 'wrist.servoLabel', this.shell, this.insert, [0.55, 0.3, 0.018], [0, -1.17, 0.368]);
    const axle = this.mesh(this.root, 'wrist.axle', this.cylinder, this.metal, [0.18, 1.84, 0.18], [0, -0.75, 0]);
    axle.rotation.z = Math.PI / 2;
    const housing = new THREE.CylinderGeometry(0.66, 1.22, 1.32, 4, 1, false, Math.PI / 4);
    this.mesh(this.root, 'forearm.static', housing, this.ivory, [1, 1, 0.82], [0, -2.15, 0]);
    this.mesh(this.root, 'base.rim', this.shell, this.insert, [1.82, 0.15, 1.46], [0, -2.82, 0]);
    for (const side of [-1, 1]) {
      this.mesh(this.root, 'base.foot', this.shell, this.ivory, [1.15, 0.09, 0.48], [side * 1.13, -2.87, 0.27]).rotation.y = side * -0.25;
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(side * 0.44, -1.83, -0.38), new THREE.Vector3(side * 0.72, -1.35, -0.62), new THREE.Vector3(side * 0.45, -0.65, -0.35));
      this.mesh(this.root, 'wrist.servoCable', new THREE.TubeGeometry(curve, 16, 0.025, 6, false), this.dark, [1, 1, 1], [0, 0, 0]);
    }

    const specs: Record<Exclude<Finger, 'thumb'>, { x: number; y: number; lengths: number[]; width: number; splay: number }> = {
      index: { x: -0.8, y: 1.38, lengths: [1.22, 0.88, 0.54], width: 0.4, splay: 0.025 },
      middle: { x: -0.27, y: 1.48, lengths: [1.28, 0.92, 0.57], width: 0.42, splay: 0 },
      ring: { x: 0.27, y: 1.4, lengths: [1.22, 0.88, 0.54], width: 0.4, splay: -0.025 },
      pinky: { x: 0.8, y: 1.12, lengths: [1.1, 0.79, 0.49], width: 0.36, splay: -0.055 },
    };
    for (const finger of LONG_FINGERS) {
      const spec = specs[finger];
      this.mesh(hand, `${finger}.dorsalCover`, this.capsule, this.ivory, [0.46, 0.955, 0.21], [spec.x, 0.43, -0.42]);
      for (const y of [0.03, finger === 'pinky' ? 0.6 : 0.79]) {
        this.mesh(hand, `${finger}.servo`, this.shell, this.dark, [0.38, 0.63, 0.56], [spec.x, y, -0.02]);
        const winch = this.mesh(hand, `${finger}.winch`, this.cylinder, this.insert, [0.16, 0.08, 0.16], [spec.x, y + 0.13, 0.3]);
        winch.rotation.x = Math.PI / 2;
      }
      const mount = new THREE.Group();
      mount.name = `${finger}.mount`;
      mount.position.set(spec.x, spec.y, 0);
      mount.rotation.z = spec.splay;
      hand.add(mount);
      const spread = this.pivot(`${finger}.spread`, mount);
      this.mesh(spread, `${finger}.knuckleCross`, this.capsule, this.ivory, [spec.width * 0.97, 0.24, 0.17], [0, -0.12, 0.25]);
      this.mesh(spread, `${finger}.knuckleLoop`, this.capsule, this.ivory, [spec.width * 0.4, 0.15, 0.14], [0, 0.09, 0.22]);
      const mcp = this.pivot(`${finger}.MCP`, spread);
      this.segment(mcp, `${finger}.proximal`, spec.lengths[0], spec.width);
      const pip = this.pivot(`${finger}.PIP`, mcp, spec.lengths[0]);
      this.segment(pip, `${finger}.middle`, spec.lengths[1], spec.width * 0.93);
      const dip = this.pivot(`${finger}.DIP`, pip, spec.lengths[1]);
      this.segment(dip, `${finger}.distal`, spec.lengths[2], spec.width * 0.9, true);
      this.linkage(`${finger}.longLink`, spread, pip, 0.08, 0.13, spec.width);
      this.linkage(`${finger}.shortLink`, mcp, dip, spec.lengths[0] - 0.1, 0.09, spec.width * 0.9);
      this.tip(dip, finger, spec.lengths[2]);
    }

    const opposition = this.pivot('thumb.opposition', hand);
    opposition.position.set(-0.88, -0.26, 0.24);
    this.mesh(opposition, 'thumb.rollCollar', this.cylinder, this.insert, [0.29, 0.2, 0.29], [0, 0, 0]);
    const thumbMount = new THREE.Group();
    thumbMount.name = 'thumb.mount';
    thumbMount.rotation.z = 1.12;
    opposition.add(thumbMount);
    this.mesh(thumbMount, 'thumb.knuckleCross', this.shell, this.ivory, [0.48, 0.36, 0.44], [0, 0.13, 0]);
    const thumbMcp = this.pivot('thumb.MCP', thumbMount, 0.28);
    this.segment(thumbMcp, 'thumb.proximal', 1.18, 0.48);
    const thumbIp = this.pivot('thumb.PIP', thumbMcp, 1.18);
    this.segment(thumbIp, 'thumb.distal', 0.72, 0.46, true);
    this.linkage('thumb.longLink', thumbMount, thumbIp, 0.29, 0.12, 0.48);
    this.tip(thumbIp, 'thumb', 0.72);
    this.contacts = new FingerContacts(hand, this.manifest, this.bindings);
    this.resetPose();
  }

  private mesh(parent: THREE.Object3D, name: string, geometry: THREE.BufferGeometry, material: THREE.Material, scale: [number, number, number], position: [number, number, number]): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.scale.set(...scale);
    mesh.position.set(...position);
    parent.add(mesh);
    return mesh;
  }

  private pivot(id: JointId, parent: THREE.Object3D, y = 0): THREE.Group {
    const pivot = new THREE.Group();
    pivot.name = id;
    pivot.position.y = y;
    parent.add(pivot);
    this.bindings.set(id, pivot);
    return pivot;
  }

  private fingerChannel(): THREE.ExtrudeGeometry {
    const section = new THREE.Shape();
    section.moveTo(-0.5, 0.4);
    section.lineTo(-0.5, -0.18);
    section.quadraticCurveTo(-0.5, -0.43, -0.24, -0.43);
    section.lineTo(0.24, -0.43);
    section.quadraticCurveTo(0.5, -0.43, 0.5, -0.18);
    section.lineTo(0.5, 0.4);
    section.lineTo(0.29, 0.4);
    section.lineTo(0.29, -0.12);
    section.lineTo(-0.29, -0.12);
    section.lineTo(-0.29, 0.4);
    section.closePath();
    const geometry = new THREE.ExtrudeGeometry(section, { depth: 1, bevelEnabled: false, curveSegments: 8 });
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 1, 0);
    return geometry;
  }

  private segment(parent: THREE.Object3D, name: string, length: number, width: number, tip = false): void {
    this.mesh(parent, name, this.channel, this.ivory, [width, length - 0.12, width], [0, 0.06, 0]);
    for (const side of [-1, 1]) {
      const ear = this.mesh(parent, `${name}.hingeEar`, this.cylinder, this.ivory, [width * 0.43, width * 0.2, width * 0.43], [side * width * 0.4, 0, 0]);
      ear.rotation.z = Math.PI / 2;
      const cap = this.mesh(parent, `${name}.pinCap`, this.cylinder, this.metal, [0.026, 0.012, 0.026], [side * width * 0.51, 0, 0]);
      cap.rotation.z = Math.PI / 2;
    }
    const pin = this.mesh(parent, `${name}.hinge`, this.cylinder, this.metal, [0.023, width, 0.023], [0, 0, 0]);
    pin.rotation.z = Math.PI / 2;
    this.mesh(parent, `${name}.tendon`, this.shell, this.insert, [0.012, length - 0.1, 0.012], [0, length / 2, width * 0.22]);
    if (tip) this.mesh(parent, `${name}.tipShell`, this.capsule, this.ivory, [width, length * 0.38, width * 0.85], [0, length * 0.65, 0]);
  }

  private linkage(name: string, from: THREE.Object3D, to: THREE.Object3D, fromY: number, toY: number, width: number): void {
    for (const side of [-1, 1]) {
      const start = new THREE.Object3D();
      const end = new THREE.Object3D();
      start.name = `${name}.${side}.start`;
      end.name = `${name}.${side}.end`;
      start.position.set(side * width * 0.17, fromY, width * 0.24);
      end.position.set(side * width * 0.17, toY, width * 0.24);
      from.add(start);
      to.add(end);
      const mesh = this.mesh(this.hand, `${name}.${side}`, this.shell, this.insert, [0.035, 1, 0.045], [0, 0, 0]);
      this.links.push({ mesh, from: start, to: end });
    }
  }

  private updateLinkages(): void {
    // shortcut: bars follow visual anchors, not a linkage solver; upgrade with calibrated CAD constraints.
    this.root.updateMatrixWorld(true);
    this.inverseHand.copy(this.hand.matrixWorld).invert();
    for (const link of this.links) {
      this.start.setFromMatrixPosition(link.from.matrixWorld).applyMatrix4(this.inverseHand);
      this.end.setFromMatrixPosition(link.to.matrixWorld).applyMatrix4(this.inverseHand);
      link.mesh.position.copy(this.start).add(this.end).multiplyScalar(0.5);
      this.direction.subVectors(this.end, this.start);
      link.mesh.scale.y = this.direction.length();
      link.mesh.quaternion.setFromUnitVectors(this.up, this.direction.normalize());
    }
  }
  private tip(parent: THREE.Object3D, finger: Finger, length: number): void {
    const tip = new THREE.Object3D();
    tip.name = `${finger}.tip`;
    tip.position.y = length;
    parent.add(tip);
  }
  setPose(pose: RobotPose): void {
    if (this.disposed) return;
    this.contacts.setPose(pose);
    this.updateLinkages();
  }

  setWristPitch(radians: number): void {
    if (this.disposed) return;
    // shortcut: visual wrist range, not measured hardware travel; replace when calibrated geometry exists.
    this.wrist.rotation.x = Math.max(-0.6, Math.min(0.6, Number.isFinite(radians) ? radians : 0));
  }

  get wristPitchRad(): number { return this.wrist.rotation.x; }

  resetPose(): void {
    this.setPose(neutralPose());
    this.setWristPitch(0);
  }
  setMirror(mirrored: boolean): void { if (!this.disposed) this.root.scale.x = mirrored ? -1 : 1; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.root.traverse(node => {
      if (node instanceof THREE.Mesh) {
        geometries.add(node.geometry);
        if (Array.isArray(node.material)) for (const material of node.material) materials.add(material);
        else materials.add(node.material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.root.removeFromParent();
    this.root.clear();
    this.wrist.clear();
    this.bindings.clear();
    this.links.length = 0;
    this.contacts.dispose();
  }
}
