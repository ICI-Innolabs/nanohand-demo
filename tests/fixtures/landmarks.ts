import { FINGERS, type Finger, type Point, type TrackingFrame } from '../../src/lib/types';

export type LandmarkScenario = 'open' | 'fist' | 'index' | 'spread';

/** Generated geometry for tests only; never a production input source. */
export function landmarkFrame(timestampMs = 0, scenario: LandmarkScenario = 'open', handedness: 'Left' | 'Right' = 'Right'): TrackingFrame {
  const curls: Record<Finger, number> = { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
  if (scenario === 'fist') for (const finger of FINGERS) curls[finger] = 1;
  if (scenario === 'index') curls.index = 1;
  const spread = scenario === 'spread' ? 1 : 0;
  const points: Point[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  points[0] = { x: 0, y: 0.04, z: 0 };
  const specs: [Exclude<Finger, 'thumb'>, number, number, number, number[]][] = [
    ['index', 5, -0.03, -0.03, [0.036, 0.025, 0.019]],
    ['middle', 9, -0.009, -0.039, [0.041, 0.028, 0.021]],
    ['ring', 13, 0.012, -0.034, [0.038, 0.026, 0.019]],
    ['pinky', 17, 0.031, -0.023, [0.029, 0.021, 0.017]],
  ];
  for (const [finger, base, x, y, lengths] of specs) {
    points[base] = { x, y, z: 0 };
    const radial = Math.atan2(-x, 0.04 - y);
    const splay = spread * ({ index: 0.13, middle: 0.05, ring: -0.05, pinky: -0.13 }[finger]);
    const direction = radial + splay;
    let flexion = 0;
    const bends = [1.05, 1.3, 0.7];
    for (let segment = 0; segment < 3; segment++) {
      flexion += bends[segment] * curls[finger];
      const previous = points[base + segment];
      points[base + segment + 1] = {
        x: previous.x - Math.sin(direction) * Math.cos(flexion) * lengths[segment],
        y: previous.y - Math.cos(direction) * Math.cos(flexion) * lengths[segment],
        z: previous.z + Math.sin(flexion) * lengths[segment],
      };
    }
  }
  points[1] = { x: -0.029, y: 0.018, z: 0 };
  const thumbDirection = 0.95;
  let thumbFlexion = curls.thumb * 0.65;
  for (let segment = 0; segment < 3; segment++) {
    if (segment === 1) thumbFlexion += curls.thumb * 0.65;
    if (segment === 2) thumbFlexion += curls.thumb * 0.9;
    const size = [0.035, 0.027, 0.022][segment];
    const previous = points[segment + 1];
    points[segment + 2] = {
      x: previous.x - Math.sin(thumbDirection) * Math.cos(thumbFlexion) * size,
      y: previous.y - Math.cos(thumbDirection) * Math.cos(thumbFlexion) * size,
      z: previous.z + Math.sin(thumbFlexion) * size,
    };
  }
  if (handedness === 'Left') for (const point of points) point.x *= -1;
  const aspectRatio = 4 / 3;
  return {
    timestampMs, handedness, source: 'camera', aspectRatio, worldLandmarks: points,
    landmarks: points.map(point => ({ x: 0.5 + point.x * 3, y: 0.66 + point.y * 3 * aspectRatio, z: point.z * 3 })),
  };
}

export function projectLandmarks(frame: TrackingFrame): void {
  frame.landmarks = frame.worldLandmarks!.map(point => ({
    x: 0.5 + point.x * 3, y: 0.66 + point.y * 3 * frame.aspectRatio!, z: point.z * 3,
  }));
}
