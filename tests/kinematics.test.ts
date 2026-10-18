import { describe, expect, it } from 'vitest';
import { estimateAngles } from '../src/lib/kinematics';
import { landmarkFrame, projectLandmarks } from './fixtures/landmarks';
import { FINGERS, JOINTS, getAngle, type Finger, type JointId, type Point, type TrackingFrame } from '../src/lib/types';
import { RIG_MANIFEST } from '../src/lib/rig';
import { Retargeter } from '../src/lib/retargeting';

const frame = (scenario: Parameters<typeof landmarkFrame>[1] = 'open') => landmarkFrame(0, scenario);
const ids: JointId[] = [
  'thumb.MCP', 'thumb.PIP', 'thumb.opposition',
  ...(['index', 'middle', 'ring', 'pinky'] as const).flatMap(finger => [`${finger}.MCP`, `${finger}.PIP`, `${finger}.DIP`, `${finger}.spread`] as JointId[]),
];

function bendFinger(input: TrackingFrame, finger: Exclude<Finger, 'thumb'>, angles: number[]): void {
  const base = { index: 5, middle: 9, ring: 13, pinky: 17 }[finger];
  const points = input.worldLandmarks!;
  const original = points.slice(base, base + 4);
  const dx = original[1].x - original[0].x;
  const dy = original[1].y - original[0].y;
  const planar = Math.hypot(dx, dy);
  let angle = 0;
  for (let index = 0; index < 3; index++) {
    angle += angles[index];
    const size = Math.hypot(original[index + 1].x - original[index].x, original[index + 1].y - original[index].y);
    const previous = points[base + index];
    points[base + index + 1] = { x: previous.x + dx / planar * size * Math.cos(angle), y: previous.y + dy / planar * size * Math.cos(angle), z: previous.z + size * Math.sin(angle) };
  }
  projectLandmarks(input);
}

function transform(input: TrackingFrame, apply: (p: Point) => Point): TrackingFrame {
  const result = { ...input, worldLandmarks: input.worldLandmarks!.map(apply) };
  projectLandmarks(result);
  return result;
}

describe('landmark angle geometry', () => {
  it.each(['Right', 'Left'] as const)('fully opens all finger joints for a photographed open %s palm despite world-depth noise', handedness => {
    // Local inference on the reported screenshot; numeric landmarks only, no camera pixels.
    const input: TrackingFrame = {
      timestampMs: 0, source: 'camera', handedness: 'Right', aspectRatio: 670 / 509,
      landmarks: [
        [0.2501433, 0.9145764, 0.0000005], [0.3140678, 0.8881012, -0.0364986],
        [0.3666794, 0.8348753, -0.0554889], [0.4178714, 0.7975121, -0.0731318],
        [0.4670837, 0.7768996, -0.0909531], [0.3511123, 0.6760446, -0.0337943],
        [0.3874272, 0.5823640, -0.0524223], [0.4101631, 0.5271519, -0.0674712],
        [0.4274642, 0.4766917, -0.0806726], [0.3084636, 0.6538304, -0.0378582],
        [0.3271930, 0.5451163, -0.0537935], [0.3408282, 0.4782557, -0.0700251],
        [0.3491853, 0.4194380, -0.0833765], [0.2630221, 0.6651306, -0.0464549],
        [0.2512068, 0.5601030, -0.0681763], [0.2490106, 0.4905298, -0.0878039],
        [0.2482076, 0.4299794, -0.1023178], [0.2174508, 0.7029787, -0.0586731],
        [0.1833956, 0.6230481, -0.0848477], [0.1646854, 0.5682500, -0.1006442],
        [0.1516036, 0.5167686, -0.1108905],
      ].map(([x, y, z]) => ({ x, y, z })),
      worldLandmarks: [
        [-0.0296503, 0.0833085, 0.0503809], [0.0006616, 0.0698352, 0.0311133],
        [0.0265308, 0.0579566, 0.0072833], [0.0517508, 0.0456281, -0.0198241],
        [0.0750826, 0.0318227, -0.0418741], [0.0230957, -0.0006568, 0.0002142],
        [0.0370199, -0.0229635, -0.0116571], [0.0465401, -0.0393396, -0.0169250],
        [0.0530436, -0.0523929, -0.0427479], [0.0034679, -0.0065360, 0.0034877],
        [0.0159855, -0.0390607, -0.0114547], [0.0177651, -0.0600457, -0.0297664],
        [0.0256217, -0.0751399, -0.0535990], [-0.0151128, -0.0019826, -0.0012008],
        [-0.0175662, -0.0340418, -0.0153207], [-0.0172064, -0.0526985, -0.0334065],
        [-0.0137252, -0.0693423, -0.0545144], [-0.0376308, 0.0110620, 0.0002186],
        [-0.0448876, -0.0108490, -0.0064783], [-0.0519929, -0.0320879, -0.0179227],
        [-0.0519051, -0.0471544, -0.0344297],
      ].map(([x, y, z]) => ({ x, y, z })),
    };
    const tracked = structuredClone(input);
    tracked.landmarks.splice(1, 4, ...[
      [0.3147722, 0.8920422, -0.0308614], [0.3688615, 0.8360486, -0.0507718],
      [0.4178008, 0.7950561, -0.0703500], [0.4681330, 0.7789691, -0.0895408],
    ].map(([x, y, z]) => ({ x, y, z })));
    tracked.worldLandmarks!.splice(1, 4, ...[
      [0.0072496, 0.0690819, 0.0253098], [0.0316963, 0.0578176, 0.0034492],
      [0.0520096, 0.0439516, -0.0306488], [0.0699781, 0.0302395, -0.0458281],
    ].map(([x, y, z]) => ({ x, y, z })));
    for (let observation of [input, tracked]) {
      if (handedness === 'Left') observation = {
        ...observation, handedness,
        landmarks: observation.landmarks.map(p => ({ ...p, x: -p.x })),
        worldLandmarks: observation.worldLandmarks!.map(p => ({ ...p, x: -p.x })),
      };
      const before = structuredClone(observation);
      const estimate = estimateAngles(observation);
      const mapped = new Retargeter(RIG_MANIFEST).map(estimate.pose!, handedness).pose;
      for (const finger of FINGERS) {
        expect(mapped.jointAnglesRad[finger]).toEqual({ MCP: 0, PIP: 0, DIP: 0 });
      }
      expect(observation).toEqual(before);
    }
  });

  it.each([false, true])('keeps camera flexion continuous, isolated and signed with normalized fallback %s', fallback => {
    const samples = [-0.25, 0.1, 0.1999, 0.2001, 0.3, 0.3999, 0.4001, 0.72];
    const measured: number[] = [];
    for (const angle of samples) {
      const input = frame();
      bendFinger(input, 'index', [angle, Math.max(0, angle), 0]);
      input.landmarks = input.worldLandmarks!.map(p => ({ x: 0.5 + p.x * 3, y: 0.66 + p.y * 3 * input.aspectRatio!, z: p.z * 3 }));
      if (fallback) delete input.worldLandmarks;
      const pose = estimateAngles(input).pose!;
      measured.push(pose.jointAnglesRad.index.MCP);
      expect(pose.jointAnglesRad.middle).toEqual({ MCP: 0, PIP: 0, DIP: 0 });
      if (angle >= 0.4) {
        expect(pose.jointAnglesRad.index.MCP).toBeCloseTo(angle);
        expect(pose.jointAnglesRad.index.PIP).toBeCloseTo(angle);
      }
    }
    expect(measured[0]).toBeCloseTo(-0.25);
    expect(measured[1]).toBe(0);
    expect(measured[2]).toBe(0);
    expect(measured[3] - measured[2]).toBeGreaterThan(0);
    expect(measured[3] - measured[2]).toBeLessThan(0.001);
    expect(measured[4]).toBeCloseTo(0.2);
    expect(measured[6] - measured[5]).toBeGreaterThan(0);
    expect(measured[6] - measured[5]).toBeLessThan(0.001);
  });

  it('preserves the camera fist range and does not infer an angle from collapsed world segments', () => {
    const input = frame('fist');
    const camera = estimateAngles(input);
    expect(camera.pose!.jointAnglesRad.index).toEqual({
      MCP: expect.closeTo(1.05), PIP: expect.closeTo(1.3), DIP: expect.closeTo(0.7),
    });
    input.worldLandmarks![6] = { ...input.worldLandmarks![5] };
    const occluded = estimateAngles(input);
    expect(occluded.validJoints).not.toContain('index.MCP');
    expect(occluded.validJoints).not.toContain('index.PIP');
    expect(occluded.pose!.jointAnglesRad.index.MCP).toBe(0);
    expect(occluded.pose!.jointAnglesRad.index.PIP).toBe(0);
  });

  it('maps geometric open and fist chains without classifying a gesture', () => {
    const open = estimateAngles(frame());
    const fist = estimateAngles(frame('fist'));
    expect(open.quality).toBe('good');
    expect(fist.quality).toBe('good');
    for (const id of ids) expect(getAngle(open.pose!, id)).toBeCloseTo(0, 8);
    for (const finger of FINGERS) {
      expect(fist.pose!.jointAnglesRad[finger].MCP).toBeCloseTo(finger === 'thumb' ? 0.65 : 1.05);
      expect(fist.pose!.jointAnglesRad[finger].PIP).toBeCloseTo(finger === 'thumb' ? 0.9 : 1.3);
      if (finger !== 'thumb') expect(fist.pose!.jointAnglesRad[finger].DIP).toBeCloseTo(0.7);
    }
    expect(fist.pose!.thumbOppositionRad).toBeCloseTo(0.65);
  });

  it.each(['index', 'middle', 'ring', 'pinky'] as const)('resolves isolated %s hinge motion without moving its neighbors', finger => {
    const input = frame();
    bendFinger(input, finger, [0.63, 0.72, 0.61]);
    const result = estimateAngles(input);
    expect(result.quality).toBe('good');
    for (const other of FINGERS) {
      for (const [index, joint] of JOINTS.entries()) expect(result.pose!.jointAnglesRad[other][joint]).toBeCloseTo(other === finger ? [0.63, 0.72, 0.61][index] : 0);
    }
  });

  it('uses anatomical thumb MCP point 2 and IP point 3, with no invented DIP', () => {
    const input = frame();
    const points = input.worldLandmarks!;
    const direction = { x: -Math.sin(0.95), y: -Math.cos(0.95) };
    points[3] = { x: points[2].x + direction.x * 0.027 * Math.cos(0.6), y: points[2].y + direction.y * 0.027 * Math.cos(0.6), z: 0.027 * Math.sin(0.6) };
    points[4] = { x: points[3].x + direction.x * 0.022 * Math.cos(1.3), y: points[3].y + direction.y * 0.022 * Math.cos(1.3), z: points[3].z + 0.022 * Math.sin(1.3) };
    projectLandmarks(input);
    const result = estimateAngles(input);
    expect(result.pose!.jointAnglesRad.thumb.MCP).toBeCloseTo(0.6);
    expect(result.pose!.jointAnglesRad.thumb.PIP).toBeCloseTo(0.7);
    expect(result.pose!.jointAnglesRad.thumb.DIP).toBe(0);
    expect(result.validJoints).not.toContain('thumb.DIP');
    expect(result.pose!.jointAnglesRad.index.MCP).toBeCloseTo(0);
  });

  it.each(['fist', 'spread'] as const)('is invariant under rigid 3D rotation, translation and uniform scale for %s', scenario => {
    const input = frame(scenario);
    const moved = transform(input, p => {
      const x = p.x;
      const y = Math.cos(0.8) * p.y - Math.sin(0.8) * p.z;
      const z = Math.sin(0.8) * p.y + Math.cos(0.8) * p.z;
      return { x: 1 + 2 * (Math.cos(1.1) * x - Math.sin(1.1) * y), y: -3 + 2 * (Math.sin(1.1) * x + Math.cos(1.1) * y), z: 0.7 + 2 * z };
    });
    const a = estimateAngles(input);
    const b = estimateAngles(moved);
    expect(b.quality).toBe('good');
    for (const id of ids) expect(getAngle(b.pose!, id)).toBeCloseTo(getAngle(a.pose!, id), 8);
    expect(b.validJoints).toEqual(a.validJoints);
  });

  it.each(['fist', 'spread'] as const)('keeps reflected anatomical Left %s equivalent to Right', scenario => {
    const right = estimateAngles(landmarkFrame(0, scenario, 'Right'));
    const left = estimateAngles(landmarkFrame(0, scenario, 'Left'));
    for (const id of ids) expect(getAngle(left.pose!, id)).toBeCloseTo(getAngle(right.pose!, id), 8);
    expect(left.validJoints).toEqual(right.validJoints);
  });

  it.each([0, 0.65])('projects spread against each neutral radial direction with MCP flexion %s', flexion => {
    const input = frame('spread');
    for (const finger of ['index', 'middle', 'ring', 'pinky'] as const) bendFinger(input, finger, [flexion, 0, 0]);
    const spread = estimateAngles(input);
    expect(spread.pose!.spreadRad.index).toBeCloseTo(0.13);
    expect(spread.pose!.spreadRad.pinky).toBeCloseTo(-0.13);
    for (const finger of ['index', 'middle', 'ring', 'pinky'] as const) {
      expect(spread.validJoints).toContain(`${finger}.spread`);
      expect(spread.pose!.jointAnglesRad[finger].MCP).toBeCloseTo(flexion);
    }
  });

  it('keeps signed extension distinct from flexion', () => {
    const input = frame();
    bendFinger(input, 'index', [-0.25, 0, 0]);
    expect(estimateAngles(input).pose!.jointAnglesRad.index.MCP).toBeCloseTo(-0.25);
  });

  it('aspect-corrects normalized fallback and labels its depth and opposition limits', () => {
    const input = frame('fist');
    const expected = estimateAngles(input).pose!;
    delete input.worldLandmarks;
    const fallback = estimateAngles(input);
    expect(fallback.basis).toBe('normalized');
    expect(fallback.quality).toBe('reduced');
    expect(fallback.validJoints).not.toContain('thumb.opposition');
    expect(fallback.pose!.thumbOppositionRad).toBe(0);
    for (const id of ids.filter(id => id !== 'thumb.opposition')) expect(getAngle(fallback.pose!, id)).toBeCloseTo(getAngle(expected, id), 8);
    expect(fallback.reasons.join(' ')).toContain('not metric');
    input.aspectRatio = 0;
    expect(estimateAngles(input).pose).toBeNull();
  });

  it('rejects malformed, nonfinite, tiny and near-collinear geometry', () => {
    const malformed = frame();
    malformed.worldLandmarks!.pop();
    expect(estimateAngles(malformed).quality).toBe('invalid');
    const nan = frame();
    nan.worldLandmarks![8].z = Number.NaN;
    expect(estimateAngles(nan).pose).toBeNull();
    const tiny = transform(frame(), p => ({ x: p.x * 1e-9, y: p.y * 1e-9, z: 0 }));
    expect(estimateAngles(tiny).pose).toBeNull();
    const collinear = frame();
    for (const base of [5, 9, 13, 17]) collinear.worldLandmarks![base].x = 1e-8 * base;
    expect(estimateAngles(collinear).pose).toBeNull();
    const sparse = frame();
    sparse.worldLandmarks = new Array<Point>(21);
    expect(estimateAngles(sparse).pose).toBeNull();
    const overflow = frame();
    overflow.worldLandmarks![5].x = Number.MAX_VALUE;
    overflow.worldLandmarks![17].x = -Number.MAX_VALUE;
    expect(estimateAngles(overflow).pose).toBeNull();
  });

  it('neutralizes locally collapsed segments without extreme commands or losing other fingers', () => {
    const input = frame('fist');
    input.worldLandmarks![6] = { ...input.worldLandmarks![5] };
    const result = estimateAngles(input);
    expect(result.quality).toBe('reduced');
    expect(result.pose!.jointAnglesRad.index.MCP).toBe(0);
    expect(result.pose!.jointAnglesRad.index.PIP).toBe(0);
    expect(result.validJoints).not.toContain('index.MCP');
    expect(result.pose!.jointAnglesRad.middle.MCP).toBeCloseTo(1.05);
    for (const id of ids) expect(Number.isFinite(getAngle(result.pose!, id))).toBe(true);
  });

  it.each(['index', 'middle', 'ring', 'pinky'] as const)('rejects reversed %s proximal spread without an extreme new command', finger => {
    const base = { index: 5, middle: 9, ring: 13, pinky: 17 }[finger];
    for (const handedness of ['Right', 'Left'] as const) {
      const input = landmarkFrame(0, 'open', handedness);
      const points = input.worldLandmarks!;
      points[base + 1] = {
        x: 2 * points[base].x - points[base + 1].x,
        y: 2 * points[base].y - points[base + 1].y,
        z: 2 * points[base].z - points[base + 1].z,
      };
      const result = estimateAngles(input);
      expect(result.quality).toBe('reduced');
      expect(result.validJoints).not.toContain(`${finger}.PIP`);
      expect(result.validJoints).not.toContain(`${finger}.spread`);
      expect(result.pose!.spreadRad[finger]).toBe(0);
      expect(result.pose!.jointAnglesRad[finger].MCP).toBeCloseTo(0);
      for (const id of ids) expect(getAngle(result.pose!, id)).toBeCloseTo(0);
    }
  });

  it('does not claim opposition from a metacarpal perpendicular to the palm', () => {
    const input = frame();
    const cmc = input.worldLandmarks![1];
    input.worldLandmarks![2] = { ...cmc, z: cmc.z + 0.035 };
    const result = estimateAngles(input);
    expect(result.validJoints).not.toContain('thumb.opposition');
    expect(result.pose!.thumbOppositionRad).toBe(0);
    expect(result.quality).toBe('reduced');
  });

  it('selects anatomical handedness explicitly and handles unknown sign conservatively', () => {
    const input = frame('fist');
    expect(estimateAngles(input, 'Left').pose).toBeNull();
    expect(estimateAngles(input, 'Right').pose).not.toBeNull();
    input.handedness = 'Unknown';
    const result = estimateAngles(input);
    expect(result.quality).toBe('reduced');
    expect(result.pose!.jointAnglesRad.index.MCP).toBe(0);
    expect(result.pose!.spreadRad.index).toBe(0);
    expect(result.pose!.jointAnglesRad.index.PIP).toBeCloseTo(1.3);
    expect(result.validJoints).not.toContain('index.MCP');
    expect(estimateAngles(input, 'Right').pose).toBeNull();
  });
});

