export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type Finger = typeof FINGERS[number];
export const JOINTS = ['MCP', 'PIP', 'DIP'] as const;
export type Joint = typeof JOINTS[number];
export type Handedness = 'Left' | 'Right' | 'Unknown';
export interface Point { x: number; y: number; z: number }
export interface TrackingFrame {
  timestampMs: number;
  handedness: Handedness;
  landmarks: Point[];
  worldLandmarks?: Point[];
  aspectRatio?: number;
  source: 'camera';
}
export interface RobotPose {
  timestampMs: number;
  jointAnglesRad: Record<Finger, Record<Joint, number>>;
  spreadRad: Record<Finger, number>;
  thumbOppositionRad: number;
}
export type JointId = `${Finger}.${Joint | 'spread'}` | 'thumb.opposition';
export interface JointBinding {
  id: JointId;
  nodeName: string;
  axis: 'x' | 'y' | 'z';
  sign: 1 | -1;
  neutralOffsetRad: number;
  minRad: number;
  maxRad: number;
  label: string;
}
export function neutralPose(timestampMs = 0): RobotPose {
  return {
    timestampMs,
    jointAnglesRad: Object.fromEntries(FINGERS.map(f => [f, { MCP: 0, PIP: 0, DIP: 0 }])) as RobotPose['jointAnglesRad'],
    spreadRad: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
    thumbOppositionRad: 0,
  };
}
export function getAngle(pose: RobotPose, id: JointId): number {
  const [finger, joint] = id.split('.') as [Finger, Joint | 'spread' | 'opposition'];
  return joint === 'opposition' ? pose.thumbOppositionRad : joint === 'spread' ? pose.spreadRad[finger] : pose.jointAnglesRad[finger][joint];
}
export function setAngle(pose: RobotPose, id: JointId, value: number): void {
  const [finger, joint] = id.split('.') as [Finger, Joint | 'spread' | 'opposition'];
  if (joint === 'opposition') pose.thumbOppositionRad = value;
  else if (joint === 'spread') pose.spreadRad[finger] = value;
  else pose.jointAnglesRad[finger][joint] = value;
}
