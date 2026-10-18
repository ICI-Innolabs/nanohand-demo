import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { NanoHandController, RIG_MANIFEST } from '../src/lib/rig';
import { OBB } from 'three/addons/math/OBB.js';
import { FINGERS, getAngle, neutralPose, setAngle } from '../src/lib/types';

function position(rig: NanoHandController, name: string): THREE.Vector3 {
  rig.root.updateMatrixWorld(true);
  return rig.root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());
}

function matrix(rig: NanoHandController, name: string): number[] {
  rig.root.updateMatrixWorld(true);
  return [...rig.root.getObjectByName(name)!.matrixWorld.elements];
}

function fistPose() {
  const pose = neutralPose();
  for (const joint of RIG_MANIFEST) if (!joint.id.endsWith('spread')) setAngle(pose, joint.id, joint.maxRad);
  return pose;
}

function renderedBox(mesh: THREE.Mesh, mountCut = 0): OBB {
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox!.clone();
  if (mountCut) bounds.min.y = Math.max(bounds.min.y, (mountCut - mesh.position.y) / mesh.scale.y);
  const center = bounds.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
  const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const rotation = new THREE.Matrix4().extractRotation(mesh.matrixWorld);
  for (let axis = 0; axis < 3; axis++) half.setComponent(axis, half.getComponent(axis) * new THREE.Vector3().setFromMatrixColumn(mesh.matrixWorld, axis).length());
  return new OBB(center, half, new THREE.Matrix3().setFromMatrix4(rotation));
}

function expectRenderedClearance(rig: NanoHandController) {
  rig.root.updateMatrixWorld(true);
  const bodies: { mesh: THREE.Mesh; finger: string | null; segment: number; box: OBB; beyondMount: OBB | null }[] = [];
  rig.root.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const match = /^(thumb|index|middle|ring|pinky)\.(proximal|middle|distal)(\.tipShell)?$/.exec(node.name);
    const palm = /^palm\.(sideFrame|crossFrame|cameraBridge|cameraLens|cameraGlass|littleSupport|thumbSupport)$/.test(node.name)
      || /^(thumb|index|middle|ring|pinky)\.(rollServo|servo|dorsalCover|winch)$/.test(node.name);
    if (!match && !palm) return;
    bodies.push({
      mesh: node, finger: match?.[1] ?? null,
      segment: match ? (match[1] === 'thumb' && match[2] === 'distal' ? 1 : ['proximal', 'middle', 'distal'].indexOf(match[2])) : -1,
      box: renderedBox(node),
      beyondMount: match?.[1] === 'thumb' && match[2] === 'proximal' ? renderedBox(node, 0.4) : null,
    });
  });
  let checked = 0;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    for (const b of bodies.slice(i + 1)) {
      if (!a.finger && !b.finger) continue;
      if (a.finger && a.finger === b.finger && Math.abs(a.segment - b.segment) <= 1) continue;
      const digit = a.finger ? a : b;
      const obstacle = a.finger ? b : a;
      if (!obstacle.finger && digit.segment === 0) {
        const mount = digit.finger === 'thumb' && obstacle.mesh.name === 'palm.sideFrame' && obstacle.mesh.position.x < 0;
        if (mount) {
          expect(digit.beyondMount!.intersectsOBB(obstacle.box), `${digit.mesh.name} crosses its mount into ${obstacle.mesh.name}`).toBe(false);
          checked++;
          continue;
        }
      }
      expect(a.box.intersectsOBB(b.box), `${a.mesh.name} intersects ${b.mesh.name}`).toBe(false);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(100);
}

describe('procedural NanoHand', () => {
  it('binds the 19 finger pivots independently without treating the wrist as an observed joint', () => {
    const rig = new NanoHandController();
    expect(rig.bindings.size).toBe(19);
    expect(new Set(rig.manifest.map(joint => joint.id)).size).toBe(19);
    expect(rig.bindings.has('thumb.DIP')).toBe(false);
    for (const joint of rig.manifest) {
      rig.resetPose();
      const pose = neutralPose();
      const angle = joint.id.endsWith('spread') ? 0.02 : 0.1;
      setAngle(pose, joint.id, angle);
      rig.setPose(pose);
      expect(rig.bindings.get(joint.id)!.rotation[joint.axis]).toBeCloseTo(joint.neutralOffsetRad + joint.sign * angle);
      for (const other of rig.manifest) {
        if (other.id !== joint.id) expect(rig.bindings.get(other.id)!.rotation[other.axis]).toBeCloseTo(other.neutralOffsetRad);
      }
    }
    rig.dispose();
  });

  it('rotates the index PIP at its base and moves only its descendant chain', () => {
    const rig = new NanoHandController();
    const pipBefore = position(rig, 'index.PIP');
    const tipBefore = position(rig, 'index.tip');
    const dipBefore = matrix(rig, 'index.DIP');
    const proximalBefore = matrix(rig, 'index.proximal');
    const middleBefore = matrix(rig, 'middle.distal');
    const pose = neutralPose();
    pose.jointAnglesRad.index.PIP = 0.8;
    rig.setPose(pose);
    expect(position(rig, 'index.PIP').distanceTo(pipBefore)).toBeCloseTo(0);
    expect(position(rig, 'index.tip').distanceTo(tipBefore)).toBeGreaterThan(0.5);
    expect(matrix(rig, 'index.DIP')).not.toEqual(dipBefore);
    expect(matrix(rig, 'index.proximal')).toEqual(proximalBefore);
    expect(matrix(rig, 'middle.distal')).toEqual(middleBefore);
    rig.dispose();
  });

  it('clamps bounds, rejects nonfinite input and keeps editable instance limits separate', () => {
    const rig = new NanoHandController();
    const pose = neutralPose();
    pose.jointAnglesRad.index.PIP = 100;
    pose.jointAnglesRad.middle.MCP = -100;
    pose.jointAnglesRad.ring.DIP = Number.NaN;
    pose.thumbOppositionRad = Number.POSITIVE_INFINITY;
    rig.manifest.find(joint => joint.id === 'index.PIP')!.maxRad = 0.4;
    rig.setPose(pose);
    expect(rig.bindings.get('index.PIP')!.rotation.x).toBeCloseTo(0.4);
    expect(rig.bindings.get('middle.MCP')!.rotation.x).toBe(0);
    expect(rig.bindings.get('ring.DIP')!.rotation.x).toBe(0);
    expect(rig.bindings.get('thumb.opposition')!.rotation.y).toBe(0);
    expect(RIG_MANIFEST.find(joint => joint.id === 'index.PIP')!.maxRad).toBe(1.35);
    rig.dispose();
  });
  it('pitches the palm and every digit around the wrist while leaving the forearm fixed', () => {
    const rig = new NanoHandController();
    const moving = ['palm.cameraBridge', 'palm.sideFrame', 'index.dorsalCover', 'palm.fastener', 'thumb.tip', 'index.tip', 'middle.tip', 'ring.tip', 'pinky.tip'];
    const fixed = ['forearm.static', 'wrist.servo', 'wrist.yoke', 'wrist.axle', 'base.foot', 'wrist.servoCable'];
    const before = moving.map(name => position(rig, name));
    const fixedBefore = fixed.map(name => matrix(rig, name));
    const pivot = new THREE.Vector3(0, -0.75, 0);
    expect(position(rig, 'wrist.pitch').distanceTo(pivot)).toBeCloseTo(0);
    const pose = neutralPose();
    pose.jointAnglesRad.index.PIP = 0.7;
    rig.setWristPitch(0.4);
    for (const [index, name] of moving.entries()) {
      const expected = before[index].clone().sub(pivot).applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.4).add(pivot);
      expect(position(rig, name).distanceTo(expected)).toBeCloseTo(0);
      expect(position(rig, name).distanceTo(before[index])).toBeGreaterThan(0.1);
    }
    expect(position(rig, 'wrist.pitch').distanceTo(pivot)).toBeCloseTo(0);
    rig.setPose(pose);
    expect(rig.root.getObjectByName('wrist.pitch')!.rotation.x).toBe(0.4);
    expect(rig.bindings.get('index.PIP')!.rotation.x).toBe(0.7);
    const bentTip = position(rig, 'index.tip');
    rig.setWristPitch(-0.3);
    expect(position(rig, 'index.tip').distanceTo(bentTip)).toBeGreaterThan(0.5);
    for (const joint of rig.manifest) {
      expect(rig.bindings.get(joint.id)!.rotation[joint.axis]).toBeCloseTo(joint.neutralOffsetRad + joint.sign * getAngle(pose, joint.id));
    }
    for (const [index, name] of fixed.entries()) expect(matrix(rig, name)).toEqual(fixedBefore[index]);
    rig.dispose();
  });

  it('keeps both ends of visible linkages pinned through flexion, spread, wrist pitch and reflection', () => {
    const rig = new NanoHandController();
    for (const [curl, mirrored] of [[0, false], [0.7, false], [1, true]] as const) {
      const pose = neutralPose();
      pose.jointAnglesRad.index.MCP = curl;
      pose.jointAnglesRad.index.PIP = curl * 1.2;
      pose.jointAnglesRad.index.DIP = curl * 0.8;
      pose.spreadRad.index = -0.1;
      pose.thumbOppositionRad = curl;
      pose.jointAnglesRad.thumb.MCP = curl * 0.8;
      pose.jointAnglesRad.thumb.PIP = curl;
      rig.setWristPitch(0.4);
      rig.setMirror(mirrored);
      rig.setPose(pose);
      rig.root.updateMatrixWorld(true);
      for (const name of ['index.longLink', 'index.shortLink', 'thumb.longLink']) {
        for (const side of [-1, 1]) {
          const rod = rig.root.getObjectByName(`${name}.${side}`)!;
          const start = new THREE.Vector3(0, -0.5, 0).applyMatrix4(rod.matrixWorld);
          const end = new THREE.Vector3(0, 0.5, 0).applyMatrix4(rod.matrixWorld);
          expect(start.distanceTo(position(rig, `${name}.${side}.start`))).toBeLessThan(1e-6);
          expect(end.distanceTo(position(rig, `${name}.${side}.end`))).toBeLessThan(1e-6);
        }
      }
    }
    rig.dispose();
  });

  it('clamps wrist travel and neutralizes nonfinite wrist input without changing finger commands', () => {
    const rig = new NanoHandController();
    const pose = neutralPose();
    pose.jointAnglesRad.index.PIP = 0.7;
    rig.setPose(pose);
    for (const [input, expected] of [[100, 0.6], [-100, -0.6], [0.25, 0.25], [Number.NaN, 0], [Number.POSITIVE_INFINITY, 0], [Number.NEGATIVE_INFINITY, 0]]) {
      rig.setWristPitch(input);
      expect(rig.wristPitchRad).toBe(expected);
      expect(matrix(rig, 'index.tip').every(Number.isFinite)).toBe(true);
      expect(rig.bindings.get('index.PIP')!.rotation.x).toBe(0.7);
    }
    rig.dispose();
  });


  it('restores every finger joint and the independent wrist to their open neutral transforms', () => {
    const rig = new NanoHandController();
    const before = matrix(rig, 'index.tip');
    const palmBefore = matrix(rig, 'palm.cameraBridge');
    rig.setPose(fistPose());
    rig.setWristPitch(0.5);
    expect(matrix(rig, 'index.tip')).not.toEqual(before);
    rig.resetPose();
    expect(matrix(rig, 'index.tip')).toEqual(before);
    expect(matrix(rig, 'palm.cameraBridge')).toEqual(palmBefore);
    expect(rig.root.getObjectByName('wrist.pitch')!.rotation.x).toBe(0);
    for (const joint of rig.manifest) expect(rig.bindings.get(joint.id)!.rotation[joint.axis]).toBe(joint.neutralOffsetRad);
    rig.dispose();
  });

  it('mirrors world X without changing local commands or Y/Z', () => {
    const rig = new NanoHandController();
    rig.setPose(fistPose());
    rig.setWristPitch(0.4);
    const before = position(rig, 'thumb.tip');
    const angle = rig.bindings.get('thumb.MCP')!.rotation.x;
    rig.setMirror(true);
    const mirrored = position(rig, 'thumb.tip');
    expect(mirrored.x).toBeCloseTo(-before.x);
    expect(mirrored.y).toBeCloseTo(before.y);
    expect(mirrored.z).toBeCloseTo(before.z);
    expect(rig.bindings.get('thumb.MCP')!.rotation.x).toBe(angle);
    expect(rig.root.getObjectByName('wrist.pitch')!.rotation.x).toBe(0.4);
    rig.setMirror(false);
    expect(position(rig, 'thumb.tip').distanceTo(before)).toBeCloseTo(0);
    rig.setMirror(true);
    rig.setWristPitch(-0.2);
    const pitchedMirror = position(rig, 'thumb.tip');
    rig.setMirror(false);
    const pitched = position(rig, 'thumb.tip');
    expect(pitchedMirror.x).toBeCloseTo(-pitched.x);
    expect(pitchedMirror.y).toBeCloseTo(pitched.y);
    expect(pitchedMirror.z).toBeCloseTo(pitched.z);
    expect(rig.root.getObjectByName('wrist.pitch')!.rotation.x).toBe(-0.2);
    expect(rig.bindings.get('thumb.MCP')!.rotation.x).toBe(angle);
    rig.dispose();
  });

  it('stops inward spread at rendered contact while an independent finger keeps curling, then releases', () => {
    const rig = new NanoHandController();
    const pose = neutralPose();
    pose.spreadRad.index = -0.14;
    pose.spreadRad.middle = 0.14;
    pose.jointAnglesRad.pinky.MCP = 0.6;
    rig.setPose(pose);
    expectRenderedClearance(rig);
    expect(position(rig, 'index.tip').x).toBeLessThan(position(rig, 'middle.tip').x);
    expect(Math.abs(rig.bindings.get('index.spread')!.rotation.z + 0.14) + Math.abs(rig.bindings.get('middle.spread')!.rotation.z - 0.14)).toBeGreaterThan(0.01);
    expect(rig.bindings.get('pinky.MCP')!.rotation.x).toBeCloseTo(0.6);
    const held = position(rig, 'index.tip');
    for (let frame = 0; frame < 5; frame++) rig.setPose(pose);
    expect(position(rig, 'index.tip').distanceTo(held)).toBeLessThan(1e-5);
    rig.setPose(neutralPose());
    expectRenderedClearance(rig);
    expect(rig.bindings.get('index.spread')!.rotation.z).toBeCloseTo(0);
    expect(rig.bindings.get('middle.spread')!.rotation.z).toBeCloseTo(0);
    pose.spreadRad.index = 0.1;
    pose.spreadRad.middle = 0;
    rig.setPose(pose);
    expect(rig.bindings.get('index.spread')!.rotation.z).toBeCloseTo(0.1);
    expectRenderedClearance(rig);
    rig.dispose();
  });
  it('constrains thumb contact with curled fingers using the rendered shells', () => {
    const rig = new NanoHandController();
    const pose = fistPose();
    pose.jointAnglesRad.thumb.MCP = 0.3;
    rig.setPose(pose);
    expectRenderedClearance(rig);
    let blockedTravel = 0;
    for (const joint of rig.manifest) {
      if (joint.id.startsWith('thumb.') || joint.id.startsWith('index.') || joint.id.startsWith('middle.')) {
        blockedTravel += Math.abs(rig.bindings.get(joint.id)!.rotation[joint.axis] - getAngle(pose, joint.id));
      }
    }
    expect(blockedTravel).toBeGreaterThan(0.01);
    rig.setPose(neutralPose());
    expectRenderedClearance(rig);
    for (const joint of rig.manifest) expect(rig.bindings.get(joint.id)!.rotation[joint.axis]).toBeCloseTo(0);
    rig.dispose();
  });


  it('keeps rendered links clear through fist/opposition jumps, alternating transitions and mirrored wrist transforms', () => {
    const rig = new NanoHandController();
    const targets = [fistPose(), neutralPose(), fistPose(), neutralPose()];
    targets[2].spreadRad.index = -0.14;
    targets[2].spreadRad.middle = 0.14;
    targets[2].spreadRad.ring = -0.14;
    targets[2].spreadRad.pinky = 0.14;
    for (const pose of targets) {
      rig.setPose(pose);
      expectRenderedClearance(rig);
      for (const pitch of [-0.6, 0.6]) {
        rig.setWristPitch(pitch);
        const before = FINGERS.map(finger => position(rig, `${finger}.tip`));
        rig.setMirror(true);
        expectRenderedClearance(rig);
        for (const [index, finger] of FINGERS.entries()) {
          const point = position(rig, `${finger}.tip`);
          expect(point.x).toBeCloseTo(-before[index].x);
          expect(point.y).toBeCloseTo(before[index].y);
          expect(point.z).toBeCloseTo(before[index].z);
        }
        rig.setPose(pose);
        expectRenderedClearance(rig);
        rig.setMirror(false);
      }
    }
    rig.dispose();
  });

  it('prevents nonadjacent link and palm penetration even when editable travel permits folding through them', () => {
    for (const id of ['index.PIP', 'middle.MCP'] as const) {
      const rig = new NanoHandController();
      rig.manifest.find(joint => joint.id === id)!.maxRad = Math.PI;
      const pose = neutralPose();
      setAngle(pose, id, Math.PI);
      rig.setPose(pose);
      expectRenderedClearance(rig);
      expect(rig.bindings.get(id)!.rotation.x).toBeLessThan(Math.PI - 0.05);
      rig.setPose(neutralPose());
      expectRenderedClearance(rig);
      expect(rig.bindings.get(id)!.rotation.x).toBeCloseTo(0);
      rig.dispose();
    }
  });

  it('uses finite ordered editable limits and leaves disposed transforms untouched', () => {
    const rig = new NanoHandController();
    const pip = rig.manifest.find(joint => joint.id === 'index.PIP')!;
    pip.minRad = 0.4;
    pip.maxRad = 0.2;
    const pose = neutralPose();
    pose.jointAnglesRad.index.PIP = 1;
    rig.setPose(pose);
    expect(rig.bindings.get('index.PIP')!.rotation.x).toBeCloseTo(0.4);
    pip.minRad = Number.NaN;
    pip.maxRad = Number.POSITIVE_INFINITY;
    rig.setPose(pose);
    expect(rig.bindings.get('index.PIP')!.rotation.x).toBe(0);
    const node = rig.bindings.get('index.PIP')!;
    rig.dispose();
    rig.setPose(fistPose());
    rig.setMirror(true);
    rig.setWristPitch(0.5);
    expect(node.rotation.x).toBe(0);
    expect(rig.root.scale.x).toBe(1);
    expect(rig.root.children).toHaveLength(0);
  });

  it('disposes shared geometry and material resources exactly once', () => {
    const rig = new NanoHandController();
    const scene = new THREE.Scene();
    scene.add(rig.root);
    rig.setWristPitch(0.4);
    const wrist = rig.root.getObjectByName('wrist.pitch')!;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    rig.root.traverse(node => {
      if (node instanceof THREE.Mesh) {
        geometries.add(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
      }
    });
    const spies = [...geometries, ...materials].map(resource => vi.spyOn(resource, 'dispose'));
    rig.dispose();
    rig.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(rig.root.parent).toBeNull();
    expect(rig.root.children).toHaveLength(0);
    expect(wrist.children).toHaveLength(0);
    expect(rig.bindings.size).toBe(0);
  });
});

