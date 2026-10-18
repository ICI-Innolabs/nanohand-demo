import * as THREE from 'three';
import { FINGERS, type Finger, type JointBinding, type JointId, type RobotPose } from './types';

const SKIN = 0.02;
// shortcut: bounds the authored digit lengths only; recompute reach if externally rescaling the rig hierarchy.
const REACH = 3.8;

type Body = {
  node: THREE.Object3D;
  mesh: THREE.Mesh;
  finger: Finger | null;
  segment: number;
  localCenter: THREE.Vector3;
  half: THREE.Vector3;
  center: THREE.Vector3;
  axes: THREE.Vector3[];
  radius: number;
  beyondMount?: Body;
};
type Transform = { node: THREE.Object3D; parent: THREE.Matrix4; matrix: THREE.Matrix4 };
type Channel = { binding: JointBinding; node: THREE.Object3D; finger: Finger; key: string };

// Conservative solid envelopes of the rendered channels/tip shells, not their hollow interiors.
export class FingerContacts {
  private readonly bodies: Body[] = [];
  private readonly pairs: [Body, Body][] = [];
  private readonly transforms: Transform[] = [];
  private readonly channels: Channel[];
  private readonly groups: number[][];
  private readonly current: Float64Array;
  private readonly target: Float64Array;
  private readonly origin: Float64Array;
  private readonly delta = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly identity = new THREE.Matrix4();
  private readonly matrices = new Map<THREE.Object3D, THREE.Matrix4>();

  constructor(hand: THREE.Object3D, manifest: JointBinding[], bindings: Map<JointId, THREE.Object3D>) {
    this.channels = manifest.map(binding => {
      const [finger, key] = binding.id.split('.') as [Finger, string];
      return { binding, node: bindings.get(binding.id)!, finger, key };
    });
    this.groups = FINGERS.map(finger => this.channels.flatMap((channel, index) => channel.finger === finger ? [index] : []));
    this.current = new Float64Array(manifest.length);
    this.target = new Float64Array(manifest.length);
    this.origin = new Float64Array(manifest.length);
    this.matrices.set(hand, this.identity);
    const bounds = new THREE.Box3();
    const extra = new THREE.Box3();
    hand.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const match = /^(thumb|index|middle|ring|pinky)\.(proximal|middle|distal)$/.exec(node.name);
      const palm = node.parent === hand && (/^palm\./.test(node.name) || /\.(servo|dorsalCover|winch)$/.test(node.name) || node.name === 'thumb.rollServo');
      if (!match && !palm) return;
      if (node.name === 'palm.fastener') return;
      node.geometry.computeBoundingBox();
      bounds.copy(node.geometry.boundingBox!);
      node.updateMatrix();
      bounds.applyMatrix4(node.matrix);
      if (match) {
        const tip = node.parent!.children.find(child => child.name === `${node.name}.tipShell`) as THREE.Mesh | undefined;
        if (tip) {
          tip.geometry.computeBoundingBox();
          tip.updateMatrix();
          extra.copy(tip.geometry.boundingBox!).applyMatrix4(tip.matrix);
          bounds.union(extra);
        }
      }
      const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      const parent = node.parent!;
      this.transform(parent);
      this.bodies.push({
        node: parent, mesh: node, finger: match ? match[1] as Finger : null,
        segment: match ? (match[1] === 'thumb' && match[2] === 'distal' ? 1 : ['proximal', 'middle', 'distal'].indexOf(match[2])) : -1,
        localCenter: bounds.getCenter(new THREE.Vector3()), half,
        center: new THREE.Vector3(), axes: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
        radius: half.length(),
      });
    });
    const candidates = this.bodies.slice();
    for (const body of candidates) {
      if (body.finger !== 'thumb' || body.segment !== 0) continue;
      const cut = 0.4;
      const top = body.localCenter.y + body.half.y;
      const half = body.half.clone();
      half.y = (top - cut) * 0.5;
      body.beyondMount = {
        ...body, half, localCenter: body.localCenter.clone().setY((top + cut) * 0.5),
        center: new THREE.Vector3(), axes: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
        radius: half.length(),
      };
      this.bodies.push(body.beyondMount);
    }
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j];
        if (!a.finger && !b.finger) continue;
        if (a.finger && a.finger === b.finger && Math.abs(a.segment - b.segment) <= 1) continue;
        const digit = a.finger ? a : b;
        const obstacle = a.finger ? b : a;
        if (!obstacle.finger && digit.segment === 0) {
          const mesh = obstacle.mesh;
          // Only the thumb's authored roll mount joins a palm frame; finger mounts have geometric clearance.
          const mount = digit.finger === 'thumb' && mesh.name === 'palm.sideFrame' && mesh.position.x < 0;
          if (mount) {
            this.pairs.push([digit.beyondMount!, obstacle]);
            continue;
          }
        }
        this.pairs.push([a, b]);
      }
    }
  }

  private transform(node: THREE.Object3D): THREE.Matrix4 {
    const found = this.matrices.get(node);
    if (found) return found;
    const parent = this.transform(node.parent!);
    const matrix = new THREE.Matrix4();
    this.matrices.set(node, matrix);
    this.transforms.push({ node, parent, matrix });
    return matrix;
  }

  private updateBodies(): void {
    for (const transform of this.transforms) {
      transform.node.updateMatrix();
      transform.matrix.multiplyMatrices(transform.parent, transform.node.matrix);
    }
    for (const body of this.bodies) {
      const matrix = this.matrices.get(body.node)!;
      body.center.copy(body.localCenter).applyMatrix4(matrix);
      for (let i = 0; i < 3; i++) body.axes[i].setFromMatrixColumn(matrix, i);
    }
  }

  private separated(a: Body, b: Body, axis: THREE.Vector3): boolean {
    const length = axis.length();
    if (length < 1e-8) return false;
    let radius = SKIN * length;
    for (let i = 0; i < 3; i++) radius += a.half.getComponent(i) * Math.abs(axis.dot(a.axes[i])) + b.half.getComponent(i) * Math.abs(axis.dot(b.axes[i]));
    return Math.abs(this.delta.dot(axis)) >= radius;
  }

  private clear(finger: Finger): boolean {
    this.updateBodies();
    for (const [a, b] of this.pairs) {
      if (a.finger !== finger && b.finger !== finger) continue;
      this.delta.subVectors(b.center, a.center);
      if (this.delta.lengthSq() >= (a.radius + b.radius + SKIN) ** 2) continue;
      let separated = false;
      for (let i = 0; i < 3 && !separated; i++) separated = this.separated(a, b, a.axes[i]) || this.separated(a, b, b.axes[i]);
      for (let i = 0; i < 3 && !separated; i++) {
        for (let j = 0; j < 3 && !separated; j++) separated = this.separated(a, b, this.axis.crossVectors(a.axes[i], b.axes[j]));
      }
      if (!separated) return false;
    }
    return true;
  }

  private apply(indices: number[], fraction: number): void {
    for (const index of indices) {
      const channel = this.channels[index];
      channel.node.rotation[channel.binding.axis] = fraction === 1 ? this.target[index] : this.origin[index] + (this.target[index] - this.origin[index]) * fraction;
    }
  }

  private sweep(indices: number[], finger: Finger): boolean {
    let travel = 0;
    for (const index of indices) {
      this.origin[index] = this.current[index];
      travel += Math.abs(this.target[index] - this.current[index]);
    }
    if (travel < 1e-12) return true;
    // A point travels less than half the contact skin between samples, including combined joint arcs.
    const steps = Math.max(1, Math.ceil(travel * REACH / (SKIN * 0.4)));
    let safe = 0;
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps;
      this.apply(indices, fraction);
      if (!this.clear(finger)) {
        let blocked = fraction;
        for (let iteration = 0; iteration < 10; iteration++) {
          const middle = (safe + blocked) * 0.5;
          this.apply(indices, middle);
          if (this.clear(finger)) safe = middle;
          else blocked = middle;
        }
        this.apply(indices, safe);
        for (const index of indices) this.current[index] = this.channels[index].node.rotation[this.channels[index].binding.axis];
        return false;
      }
      safe = fraction;
    }
    for (const index of indices) this.current[index] = this.target[index];
    return true;
  }

  private readonly single = [0];

  setPose(pose: RobotPose): void {
    for (let index = 0; index < this.channels.length; index++) {
      const { binding, node, finger, key } = this.channels[index];
      const value = key === 'opposition' ? pose.thumbOppositionRad : key === 'spread' ? pose.spreadRad[finger] : pose.jointAnglesRad[finger][key as 'MCP' | 'PIP' | 'DIP'];
      const min = Number.isFinite(binding.minRad) ? binding.minRad : 0;
      const max = Number.isFinite(binding.maxRad) ? binding.maxRad : 0;
      const angle = Math.max(Math.min(min, max), Math.min(Math.max(min, max), Number.isFinite(value) ? value : 0));
      this.target[index] = (Number.isFinite(binding.neutralOffsetRad) ? binding.neutralOffsetRad : 0) + (binding.sign === -1 ? -angle : angle);
      this.current[index] = node.rotation[binding.axis];
    }
    for (let pass = 0; pass < this.groups.length; pass++) {
      let before = 0;
      for (let index = 0; index < this.current.length; index++) before += Math.abs(this.target[index] - this.current[index]);
      for (const indices of this.groups) {
        const finger = this.channels[indices[0]].finger;
        if (this.sweep(indices, finger)) continue;
        // A contacting channel must not freeze an opening joint or another channel of this digit.
        for (const index of indices) {
          this.single[0] = index;
          this.sweep(this.single, finger);
        }
      }
      let after = 0;
      for (let index = 0; index < this.current.length; index++) after += Math.abs(this.target[index] - this.current[index]);
      // Retry contacts released by a later digit, but do not iterate a resting contact indefinitely.
      if (after < 1e-12 || before - after < 1e-7) break;
    }
  }

  dispose(): void {
    this.bodies.length = 0;
    this.pairs.length = 0;
    this.transforms.length = 0;
    this.channels.length = 0;
    this.groups.length = 0;
    this.matrices.clear();
  }
}
