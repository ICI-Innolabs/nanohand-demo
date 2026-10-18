import { describe, expect, it } from 'vitest';
import { Retargeter } from '../src/lib/retargeting';
import { getAngle, neutralPose, setAngle, type JointBinding, type JointId } from '../src/lib/types';

function manifest(): JointBinding[] {
  const ids: JointId[] = ['thumb.MCP', 'thumb.PIP', 'thumb.opposition'];
  for (const finger of ['index', 'middle', 'ring', 'pinky'] as const) ids.push(`${finger}.MCP`, `${finger}.PIP`, `${finger}.DIP`, `${finger}.spread`);
  return ids.map(id => ({ id, label: id, nodeName: id, axis: 'x', sign: 1, neutralOffsetRad: 0, minRad: id.endsWith('.spread') ? -0.14 : 0, maxRad: id.endsWith('.spread') ? 0.14 : id === 'thumb.opposition' ? 1.3 : 1 }));
}

describe('continuous retargeting and calibration', () => {
  it('needs no calibration and preserves neutral rather than adding manifest offsets', () => {
    const bindings = manifest();
    bindings[0].neutralOffsetRad = 0.4;
    bindings[0].sign = -1;
    const retargeter = new Retargeter(bindings);
    const raw = neutralPose(41);
    raw.jointAnglesRad.index.MCP = 0.45;
    raw.spreadRad.pinky = -0.1;
    const result = retargeter.map(raw, 'Right');
    expect(result.pose).toEqual(raw);
    expect(result.pose).not.toBe(raw);
    expect(result.saturated).toBe(0);
    expect(retargeter.map(neutralPose(), 'Unknown').pose).toEqual(neutralPose());
  });

  it('keeps independent immutable Left and Right neutral and fist snapshots', () => {
    const retargeter = new Retargeter(manifest());
    const rightNeutral = neutralPose();
    rightNeutral.jointAnglesRad.index.MCP = 0.1;
    const rightFist = neutralPose();
    rightFist.jointAnglesRad.index.MCP = 0.9;
    retargeter.calibrate('neutral', rightNeutral, 'Right');
    retargeter.calibrate('fist', rightFist, 'Right');
    const leftNeutral = neutralPose();
    leftNeutral.jointAnglesRad.index.MCP = 0.2;
    const leftFist = neutralPose();
    leftFist.jointAnglesRad.index.MCP = 0.6;
    retargeter.calibrate('neutral', leftNeutral, 'Left');
    retargeter.calibrate('fist', leftFist, 'Left');
    rightNeutral.jointAnglesRad.index.MCP = 200;
    rightFist.jointAnglesRad.index.MCP = 200;
    leftNeutral.jointAnglesRad.index.MCP = 200;
    leftFist.jointAnglesRad.index.MCP = 200;
    const raw = neutralPose();
    raw.jointAnglesRad.index.MCP = 0.5;
    expect(retargeter.map(raw, 'Right').pose.jointAnglesRad.index.MCP).toBeCloseTo(0.5);
    expect(retargeter.map(raw, 'Left').pose.jointAnglesRad.index.MCP).toBeCloseTo(0.75);
    expect(retargeter.map(raw, 'Unknown').pose.jointAnglesRad.index.MCP).toBeCloseTo(0.5);
    raw.jointAnglesRad.index.MCP = 0.1;
    expect(retargeter.map(raw, 'Right').pose.jointAnglesRad.index.MCP).toBe(0);
    retargeter.resetCalibration();
    expect(retargeter.map(raw, 'Right').pose.jointAnglesRad.index.MCP).toBeCloseTo(0.1);
    expect(retargeter.map(raw, 'Left').pose.jointAnglesRad.index.MCP).toBeCloseTo(0.1);
  });

  it('rejects unknown hand capture and tiny, reversed or nonfinite closed ranges', () => {
    const bindings = manifest();
    const retargeter = new Retargeter(bindings);
    expect(retargeter.calibrate('neutral', neutralPose(), 'Unknown')).toEqual({ applied: 0, rejected: bindings.map(joint => joint.id) });
    const open = neutralPose();
    open.jointAnglesRad.index.MCP = 0.3;
    expect(retargeter.calibrate('neutral', open, 'Right').applied).toBe(19);
    const tiny = neutralPose();
    tiny.jointAnglesRad.index.MCP = 0.3 + 1e-10;
    tiny.jointAnglesRad.middle.MCP = -0.4;
    tiny.jointAnglesRad.ring.PIP = Number.NaN;
    const capture = retargeter.calibrate('fist', tiny, 'Right');
    expect(capture.applied).toBe(0);
    expect(capture.rejected).toContain('index.MCP');
    expect(capture.rejected).toContain('middle.MCP');
    expect(capture.rejected).toContain('ring.PIP');
    const raw = neutralPose();
    raw.jointAnglesRad.index.MCP = 0.4;
    const result = retargeter.map(raw, 'Right');
    expect(result.pose.jointAnglesRad.index.MCP).toBeCloseTo(0.1);
    for (const joint of bindings) expect(Number.isFinite(getAngle(result.pose, joint.id))).toBe(true);
  });

  it('scales only credible flexion and never scales spread or opposition from a fist', () => {
    const retargeter = new Retargeter(manifest());
    const open = neutralPose();
    open.spreadRad.index = 0.02;
    open.thumbOppositionRad = 0.1;
    retargeter.calibrate('neutral', open, 'Right');
    const fist = neutralPose();
    fist.jointAnglesRad.index.MCP = 0.5;
    fist.spreadRad.index = 0.13;
    fist.thumbOppositionRad = 0.8;
    expect(retargeter.calibrate('fist', fist, 'Right').applied).toBe(1);
    const raw = neutralPose();
    raw.jointAnglesRad.index.MCP = 0.25;
    raw.jointAnglesRad.middle.MCP = 0.25;
    raw.spreadRad.index = 0.08;
    raw.thumbOppositionRad = 0.5;
    const result = retargeter.map(raw, 'Right');
    expect(result.pose.jointAnglesRad.index.MCP).toBeCloseTo(0.5);
    expect(result.pose.jointAnglesRad.middle.MCP).toBeCloseTo(0.25);
    expect(result.pose.spreadRad.index).toBeCloseTo(0.06);
    expect(result.pose.thumbOppositionRad).toBeCloseTo(0.4);
    expect(result.saturated).toBe(0);
  });

  it('reads edited instance limits on each map including the calibrated scale', () => {
    const bindings = manifest();
    const retargeter = new Retargeter(bindings);
    const fist = neutralPose();
    fist.jointAnglesRad.index.PIP = 0.8;
    retargeter.calibrate('fist', fist, 'Right');
    const raw = neutralPose();
    raw.jointAnglesRad.index.PIP = 0.4;
    expect(retargeter.map(raw, 'Right').pose.jointAnglesRad.index.PIP).toBeCloseTo(0.5);
    bindings.find(joint => joint.id === 'index.PIP')!.maxRad = 0.4;
    expect(retargeter.map(raw, 'Right').pose.jointAnglesRad.index.PIP).toBeCloseTo(0.2);
    bindings.find(joint => joint.id === 'index.spread')!.minRad = -0.03;
    raw.spreadRad.index = -0.1;
    expect(retargeter.map(raw, 'Right').pose.spreadRad.index).toBeCloseTo(-0.03);
    expect(retargeter.map(raw, 'Right').saturated).toBe(1);
  });

  it('clamps every manifest channel and counts invalid and saturated commands', () => {
    const bindings = manifest();
    const retargeter = new Retargeter(bindings);
    const raw = neutralPose();
    raw.jointAnglesRad.index.MCP = 9;
    raw.jointAnglesRad.middle.PIP = -1;
    raw.jointAnglesRad.ring.DIP = Number.NaN;
    raw.spreadRad.pinky = -10;
    raw.thumbOppositionRad = Number.POSITIVE_INFINITY;
    const result = retargeter.map(raw, 'Right');
    expect(result.saturated).toBe(5);
    expect(result.pose.jointAnglesRad.index.MCP).toBe(1);
    expect(result.pose.spreadRad.pinky).toBe(-0.14);
    expect(result.pose.thumbOppositionRad).toBe(0);
    for (const joint of bindings) {
      expect(getAngle(result.pose, joint.id)).toBeGreaterThanOrEqual(joint.minRad);
      expect(getAngle(result.pose, joint.id)).toBeLessThanOrEqual(joint.maxRad);
    }
  });

  it('does not mutate raw observations and invalidates a stale scale after a new neutral', () => {
    const retargeter = new Retargeter(manifest());
    const raw = neutralPose(10);
    setAngle(raw, 'index.MCP', 0.5);
    const before = structuredClone(raw);
    retargeter.calibrate('fist', raw, 'Right');
    retargeter.map(raw, 'Right');
    expect(raw).toEqual(before);
    const neutral = neutralPose();
    neutral.jointAnglesRad.index.MCP = 0.2;
    retargeter.calibrate('neutral', neutral, 'Right');
    expect(retargeter.map(raw, 'Right').pose.jointAnglesRad.index.MCP).toBeCloseTo(0.3);
    neutral.jointAnglesRad.index.MCP = Number.NaN;
    expect(retargeter.calibrate('neutral', neutral, 'Right').rejected).toContain('index.MCP');
  });
});
