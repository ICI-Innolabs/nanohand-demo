import { getAngle, neutralPose, setAngle, type Handedness, type JointBinding, type JointId, type RobotPose } from './types';

type Capture = Partial<Record<JointId, number>>;
type Calibration = { neutral: Capture; fist: Capture };
const flexion = (id: JointId): boolean => id.endsWith('.MCP') || id.endsWith('.PIP') || id.endsWith('.DIP');
const credibleRange = (neutral: number, fist: number): boolean => Number.isFinite(neutral) && Number.isFinite(fist) && fist >= 0.25 && fist <= 2.8 && fist - neutral >= 0.15;

export class Retargeter {
  private readonly calibration: Record<'Left' | 'Right', Calibration> = {
    Left: { neutral: {}, fist: {} },
    Right: { neutral: {}, fist: {} },
  };

  constructor(private readonly manifest: JointBinding[]) {}

  map(raw: RobotPose, handedness: Handedness): { pose: RobotPose; saturated: number } {
    const pose = neutralPose(Number.isFinite(raw.timestampMs) ? raw.timestampMs : 0);
    const calibration = handedness === 'Unknown' ? undefined : this.calibration[handedness];
    let saturated = 0;
    for (const joint of this.manifest) {
      const observed = getAngle(raw, joint.id);
      const neutral = calibration?.neutral[joint.id] ?? 0;
      const fist = calibration?.fist[joint.id];
      let value = Number.isFinite(observed) ? observed - neutral : 0;
      if (flexion(joint.id) && fist !== undefined && credibleRange(neutral, fist)) {
        value *= Math.max(0, joint.maxRad) / (fist - neutral);
      }
      const a = Number.isFinite(joint.minRad) ? joint.minRad : 0;
      const b = Number.isFinite(joint.maxRad) ? joint.maxRad : 0;
      const clamped = Math.max(Math.min(a, b), Math.min(Math.max(a, b), Number.isFinite(value) ? value : 0));
      if (!Number.isFinite(observed) || !Number.isFinite(value) || Math.abs(value - clamped) > 1e-9) saturated++;
      setAngle(pose, joint.id, clamped);
    }
    return { pose, saturated };
  }

  calibrate(kind: 'neutral' | 'fist', raw: RobotPose, handedness: Handedness): { applied: number; rejected: JointId[] } {
    if (handedness === 'Unknown') return { applied: 0, rejected: this.manifest.map(joint => joint.id) };
    const calibration = this.calibration[handedness];
    const rejected: JointId[] = [];
    let applied = 0;
    for (const joint of this.manifest) {
      if (kind === 'fist' && !flexion(joint.id)) continue;
      const value = getAngle(raw, joint.id);
      if (!Number.isFinite(value) || (kind === 'fist' && !credibleRange(calibration.neutral[joint.id] ?? 0, value))) {
        rejected.push(joint.id);
        continue;
      }
      calibration[kind][joint.id] = value;
      // A changed neutral invalidates its old fist scale; capture fist again explicitly.
      if (kind === 'neutral') delete calibration.fist[joint.id];
      applied++;
    }
    return { applied, rejected };
  }

  resetCalibration(): void {
    for (const hand of ['Left', 'Right'] as const) {
      this.calibration[hand].neutral = {};
      this.calibration[hand].fist = {};
    }
  }
}
