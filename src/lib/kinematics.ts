import { getAngle, neutralPose, setAngle, type Finger, type JointId, type Point, type RobotPose, type TrackingFrame } from './types';

export interface AngleEstimate {
  pose: RobotPose | null;
  quality: 'good' | 'reduced' | 'invalid';
  reasons: string[];
  basis: 'world' | 'normalized';
  validJoints: JointId[];
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (a: Point, n: number): Point => ({ x: a.x * n, y: a.y * n, z: a.z * n });
const cross = (a: Point, b: Point): Point => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (a: Point): number => Math.hypot(a.x, a.y, a.z);
const unit = (a: Point): Point => scale(a, 1 / length(a));
const finitePoint = (p: Point): boolean => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
const fingers: [Exclude<Finger, 'thumb'>, number][] = [['index', 5], ['middle', 9], ['ring', 13], ['pinky', 17]];

export function estimateAngles(frame: TrackingFrame, handSelection: 'auto' | 'Left' | 'Right' = 'auto'): AngleEstimate {
  const estimate = geometricAngles(frame, handSelection);
  if (!estimate.pose) return estimate;
  const image = estimate.basis === 'normalized' ? estimate : geometricAngles({ ...frame, worldLandmarks: undefined }, handSelection);
  if (!image.pose) return estimate;
  for (const id of estimate.validJoints) {
    if (id.endsWith('.spread') || id === 'thumb.opposition' || !image.validJoints.includes(id)) continue;
    // World-depth noise must not curl a finger that the image landmarks show extended.
    const angle = Math.min(getAngle(estimate.pose, id), getAngle(image.pose, id));
    // shortcut: measured open-palm noise tolerances, not anatomical zeros; tune against more camera data.
    const tolerance = id.startsWith('thumb.') ? 0.35 : 0.2;
    setAngle(estimate.pose, id, angle <= 0 ? angle : Math.min(angle, Math.max(0, (angle - tolerance) * (tolerance + 0.2) / 0.2)));
  }
  estimate.reasons.push('Camera flexion uses conservative image/world agreement with an extension deadband (0.2 rad fingers, 0.35 rad thumb), fading out over the next 0.2 rad.');
  return estimate;
}

function geometricAngles(frame: TrackingFrame, handSelection: 'auto' | 'Left' | 'Right'): AngleEstimate {
  const basis = frame.worldLandmarks === undefined ? 'normalized' : 'world';
  const reasons: string[] = [];
  const validJoints: JointId[] = [];
  const invalid = (reason: string): AngleEstimate => ({ pose: null, quality: 'invalid', reasons: [reason], basis, validJoints: [] });
  if (!Number.isFinite(frame.timestampMs)) return invalid('Invalid frame timestamp.');
  if (handSelection !== 'auto' && frame.handedness !== handSelection) return invalid(`Waiting for the anatomical ${handSelection} hand.`);
  const source = basis === 'world' ? frame.worldLandmarks! : frame.landmarks;
  if (!Array.isArray(source) || source.length !== 21) return invalid('Expected 21 finite hand landmarks.');
  for (let index = 0; index < 21; index++) {
    if (!finitePoint(source[index])) return invalid('Expected 21 finite hand landmarks.');
  }
  const aspect = frame.aspectRatio ?? 1;
  if (basis === 'normalized' && (!Number.isFinite(aspect) || aspect <= 0)) return invalid('Invalid image aspect ratio.');
  // Normalized z uses image-width units, so scale y, not z, to the same units as x.
  const points = basis === 'world' ? source : source.map(p => ({ x: p.x, y: p.y / aspect, z: p.z }));
  if (basis === 'normalized' && !points.every(finitePoint)) return invalid('Image coordinate scaling is nonfinite.');
  if (basis === 'normalized') reasons.push('Normalized fallback: aspect-correct image coordinates; depth is not metric and opposition is unavailable.');
  const wrist = points[0];
  const center = { x: 0, y: 0, z: 0 };
  for (const [, index] of fingers) {
    center.x += points[index].x / 4;
    center.y += points[index].y / 4;
    center.z += points[index].z / 4;
  }
  const longitudinal = sub(center, wrist);
  const transverse = sub(points[5], points[17]);
  const palmLength = length(longitudinal);
  const palmWidth = length(transverse);
  if (!Number.isFinite(palmLength) || !Number.isFinite(palmWidth) || palmLength < 1e-6 || palmWidth < 1e-6 || palmWidth / palmLength < 0.2 || palmWidth / palmLength > 3) return invalid('Palm geometry is too small or degenerate.');
  const forward = unit(longitudinal);
  const lateral = sub(transverse, scale(forward, dot(transverse, forward)));
  const lateralLength = length(lateral);
  if (!Number.isFinite(lateralLength) || lateralLength < palmWidth * 0.2) return invalid('Palm landmarks are nearly collinear.');
  const across = scale(lateral, 1 / lateralLength); // Anatomical pinky-to-index, independent of preview mirroring.
  const knownHand = frame.handedness === 'Left' || frame.handedness === 'Right';
  const normal = scale(cross(across, forward), frame.handedness === 'Left' ? -1 : 1);
  if (!knownHand) reasons.push('Unknown handedness: signed MCP, spread and opposition are held neutral.');
  const pose = neutralPose(frame.timestampMs);
  const minSegment = palmLength * 0.035;
  const segment = (a: number, b: number): Point | null => {
    const vector = sub(points[b], points[a]);
    const size = length(vector);
    return size >= minSegment && size <= palmLength * 1.5 ? vector : null;
  };
  const hinge = (a: Point | null, b: Point | null, id: JointId): number => {
    if (!a || !b) return 0;
    const first = unit(a);
    const second = unit(b);
    const angle = Math.atan2(length(cross(first, second)), dot(first, second));
    // A reversed/overlapping segment is an occlusion symptom, not a credible hinge measurement.
    if (angle > 2.8) return 0;
    validJoints.push(id);
    return angle;
  };
  for (const [finger, base] of fingers) {
    const proximal = segment(base, base + 1);
    const middle = segment(base + 1, base + 2);
    const distal = segment(base + 2, base + 3);
    pose.jointAnglesRad[finger].PIP = hinge(proximal, middle, `${finger}.PIP`);
    pose.jointAnglesRad[finger].DIP = hinge(middle, distal, `${finger}.DIP`);
    if (proximal && knownHand) {
      const elevation = Math.atan2(dot(proximal, normal), Math.hypot(dot(proximal, across), dot(proximal, forward)));
      pose.jointAnglesRad[finger].MCP = elevation;
      validJoints.push(`${finger}.MCP`);
      const projected = sub(proximal, scale(normal, dot(proximal, normal)));
      const neutral = sub(points[base], wrist);
      // Backward palm projections cannot establish anatomical spread, even with a measurable length.
      if (length(projected) > length(proximal) * 0.2 && dot(projected, neutral) > 0) {
        const spread = Math.atan2(dot(projected, across), dot(projected, forward)) - Math.atan2(dot(neutral, across), dot(neutral, forward));
        pose.spreadRad[finger] = Math.atan2(Math.sin(spread), Math.cos(spread));
        validJoints.push(`${finger}.spread`);
      }
    }
  }
  const metacarpal = segment(1, 2);
  const thumbProximal = segment(2, 3);
  const thumbDistal = segment(3, 4);
  pose.jointAnglesRad.thumb.MCP = hinge(metacarpal, thumbProximal, 'thumb.MCP');
  pose.jointAnglesRad.thumb.PIP = hinge(thumbProximal, thumbDistal, 'thumb.PIP');
  if (metacarpal && knownHand && basis === 'world') {
    const depth = dot(metacarpal, normal);
    const planarLength = Math.hypot(dot(metacarpal, across), dot(metacarpal, forward));
    if (planarLength > length(metacarpal) * 0.2) {
      pose.thumbOppositionRad = Math.max(0, Math.atan2(depth, planarLength));
      validJoints.push('thumb.opposition');
    }
  }
  reasons.push('Thumb opposition is a conservative palm-relative metacarpal elevation estimate, not a measured CMC rotation.');
  const expected = 19;
  if (validJoints.length < expected) reasons.push('Unobservable joint angles are unavailable; collapsed, reversed or foreshortened segments cannot establish their angles.');
  return { pose, quality: basis === 'world' && knownHand && validJoints.length === expected ? 'good' : 'reduced', reasons, basis, validJoints };
}
