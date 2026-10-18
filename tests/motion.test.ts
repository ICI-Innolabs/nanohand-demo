import { describe, expect, it } from 'vitest';
import { PoseSynchronizer } from '../src/lib/motion';
import { getAngle, neutralPose, type JointBinding, type JointId } from '../src/lib/types';

function manifest(): JointBinding[] {
  const ids: JointId[] = ['index.MCP', 'middle.MCP', 'index.spread', 'thumb.opposition'];
  return ids.map(id => ({ id, nodeName: id, axis: 'x', sign: 1, neutralOffsetRad: 0, label: id, minRad: id.endsWith('spread') ? -0.2 : 0, maxRad: id.endsWith('spread') ? 0.2 : 1 }));
}
function observation(timestampMs: number, index = 0.8, middle = index) {
  const pose = neutralPose(timestampMs);
  pose.jointAnglesRad.index.MCP = index;
  pose.jointAnglesRad.middle.MCP = middle;
  return pose;
}

describe('renderer-clock pose synchronization', () => {
  it('starts searching, copies inputs and outputs, and preserves capture rather than render timestamps', () => {
    const motion = new PoseSynchronizer(manifest());
    expect(motion.status).toBe('searching');
    motion.push(null, 0);
    expect(motion.status).toBe('searching');
    expect(motion.push(observation(0), 0)).toBe(true);
    expect(motion.status).toBe('recovering');
    expect(motion.sample(5)).toEqual(neutralPose());
    const input = observation(5);
    expect(motion.push(input, 10)).toBe(true);
    input.jointAnglesRad.index.MCP = -100;
    const first = motion.sample(30);
    expect(first.timestampMs).toBe(5);
    expect(first.jointAnglesRad.index.MCP).toBeGreaterThan(0);
    first.jointAnglesRad.index.MCP = 100;
    const next = motion.sample(60);
    expect(next.timestampMs).toBe(5);
    expect(next.jointAnglesRad.index.MCP).toBeLessThan(0.8);
    expect(motion.status).toBe('tracked');
    motion.reset(60);
    expect(motion.sample(60)).toEqual(neutralPose());
    expect(motion.status).toBe('searching');
    expect(motion.push(observation(0), 60)).toBe(true);
    expect(motion.status).toBe('recovering');
    expect(motion.push(observation(61), 61)).toBe(true);
    expect(motion.status).toBe('tracked');
  });

  it('is frame-rate independent across the velocity-limited/exponential transition', () => {
    const results = [30, 60, 120].map(hz => {
      const motion = new PoseSynchronizer(manifest(), { recoverFrames: 1, maxVelocityRadS: 1, staleMs: 5000, holdMs: 5000 });
      motion.push(observation(0, 1), 0);
      for (let frame = 1; frame <= hz * 1.5; frame++) motion.sample(frame * 1000 / hz);
      return motion.sample(1500).jointAnglesRad.index.MCP;
    });
    expect(results[0]).toBeGreaterThan(0.999);
    expect(results[0]).toBeCloseTo(results[1], 12);
    expect(results[0]).toBeCloseTo(results[2], 12);
  });

  it.each([0, 10, 250, 5000])('tracks healthy 30 Hz observations at 60 Hz with a %i ms loss hold', holdMs => {
    const motion = new PoseSynchronizer(manifest(), { holdMs });
    for (let frame = 0; frame <= 60; frame++) {
      const now = frame * 1000 / 60;
      if (frame % 2 === 0) motion.push(observation(now, 1), now);
      const value = motion.sample(now).jointAnglesRad.index.MCP;
      if (frame >= 3) {
        expect(value).toBeGreaterThan(0);
        expect(motion.status).toBe('tracked');
      }
    }
    expect(motion.sample(1000).jointAnglesRad.index.MCP).toBeGreaterThan(0.999);
  });

  it('starts exponential easing immediately on explicit loss with no hold', () => {
    const motion = new PoseSynchronizer(manifest(), { recoverFrames: 1, tauMs: 0, maxVelocityRadS: 50, holdMs: 0, lossEaseMs: 100 });
    motion.push(observation(0), 0);
    const held = motion.sample(100).jointAnglesRad.index.MCP;
    expect(held).toBe(0.8);
    expect(motion.status).toBe('tracked');
    motion.push(null, 100);
    expect(motion.status).toBe('lost');
    expect(motion.sample(100).jointAnglesRad.index.MCP).toBe(held);
    expect(motion.sample(110).jointAnglesRad.index.MCP).toBeCloseTo(held * Math.exp(-0.1), 12);
    motion.push(null, 150);
    expect(motion.sample(200).jointAnglesRad.index.MCP).toBeCloseTo(held * Math.exp(-1), 12);
  });

  it('limits angular speed in both directions, including zero smoothing', () => {
    const motion = new PoseSynchronizer(manifest(), { recoverFrames: 1, tauMs: 0, maxVelocityRadS: 1 });
    motion.push(observation(0, 1), 0);
    expect(motion.sample(20).jointAnglesRad.index.MCP).toBeCloseTo(0.02);
    expect(motion.sample(40).jointAnglesRad.index.MCP).toBeCloseTo(0.04);
    motion.push(observation(40, 0), 40);
    expect(motion.sample(50).jointAnglesRad.index.MCP).toBeCloseTo(0.03);
    expect(motion.sample(100).jointAnglesRad.index.MCP).toBe(0);
  });

  it('clamps every channel to the live manifest, including changed and malformed bounds', () => {
    const bindings = manifest();
    const motion = new PoseSynchronizer(bindings, { recoverFrames: 1, tauMs: 0, maxVelocityRadS: 50 });
    const pose = observation(0, 100, -100);
    pose.spreadRad.index = -100;
    pose.thumbOppositionRad = 100;
    motion.push(pose, 0);
    const result = motion.sample(100);
    for (const binding of bindings) {
      expect(getAngle(result, binding.id)).toBeGreaterThanOrEqual(binding.minRad);
      expect(getAngle(result, binding.id)).toBeLessThanOrEqual(binding.maxRad);
    }
    bindings[0].maxRad = 0.1;
    bindings[1].minRad = 0.2;
    bindings[1].maxRad = 0.1;
    bindings[2].minRad = Number.NaN;
    bindings[2].maxRad = Number.POSITIVE_INFINITY;
    const changed = motion.sample(100);
    expect(changed.jointAnglesRad.index.MCP).toBe(0.1);
    expect(changed.jointAnglesRad.middle.MCP).toBeGreaterThanOrEqual(0.1);
    expect(changed.jointAnglesRad.middle.MCP).toBeLessThanOrEqual(0.2);
    expect(changed.spreadRad.index).toBe(0);
  });

  it('holds from first explicit loss without repeated nulls refreshing its clock, then eases safely toward open', () => {
    const motion = new PoseSynchronizer(manifest(), { recoverFrames: 1, tauMs: 0, maxVelocityRadS: 50 });
    motion.push(observation(0), 0);
    const held = motion.sample(100).jointAnglesRad.index.MCP;
    motion.push(null, 100);
    expect(motion.status).toBe('holding');
    motion.push(null, 200);
    expect(motion.sample(350).jointAnglesRad.index.MCP).toBe(held);
    motion.push(null, 351);
    expect(motion.status).toBe('lost');
    const eased = motion.sample(400).jointAnglesRad.index.MCP;
    expect(eased).toBeLessThan(held);
    expect(eased).toBeGreaterThan(0);
    for (let now = 400; now <= 3000; now += 100) motion.sample(now);
    expect(motion.sample(3000).jointAnglesRad.index.MCP).toBeLessThan(0.004);
    expect(motion.sample(3000).timestampMs).toBe(0);
  });

  it('starts the stale hold at the capture freshness boundary, not a later sample or null', () => {
    const motion = new PoseSynchronizer(manifest(), { recoverFrames: 1, tauMs: 0, maxVelocityRadS: 50, staleMs: 100, holdMs: 50, lossEaseMs: 100 });
    motion.push(observation(0), 20);
    expect(motion.sample(80).jointAnglesRad.index.MCP).toBe(0.8);
    expect(motion.status).toBe('tracked');
    expect(motion.sample(110).jointAnglesRad.index.MCP).toBe(0.8);
    expect(motion.status).toBe('holding');
    motion.push(null, 120);
    expect(motion.sample(150).jointAnglesRad.index.MCP).toBe(0.8);
    expect(motion.status).toBe('lost');
    expect(motion.sample(200).jointAnglesRad.index.MCP).toBeCloseTo(0.8 * Math.exp(-0.5), 12);
    expect(motion.sample(200).timestampMs).toBe(0);
  });

  it('integrates loss hold and exponential easing independently of render rate', () => {
    const results = [30, 60, 120].map(hz => {
      const motion = new PoseSynchronizer(manifest(), { recoverFrames: 1, tauMs: 0, maxVelocityRadS: 50, holdMs: 75, lossEaseMs: 100 });
      motion.push(observation(0), 0);
      motion.sample(100);
      motion.push(null, 100);
      for (let frame = 1; frame <= hz; frame++) motion.sample(100 + frame * 1000 / hz);
      return motion.sample(1100).jointAnglesRad.index.MCP;
    });
    expect(results[0]).toBeCloseTo(0.8 * Math.exp(-9.25), 12);
    expect(results[0]).toBeCloseTo(results[1], 12);
    expect(results[0]).toBeCloseTo(results[2], 12);
  });

  it('starts each missing channel hold at invalidation without repeated bad observations extending it', () => {
    const motion = new PoseSynchronizer(manifest(), { recoverFrames: 1, tauMs: 0, maxVelocityRadS: 50 });
    motion.push(observation(0), 0);
    motion.sample(100);
    const partial = observation(100, Number.NaN, 0.3);
    expect(motion.push(partial, 100, ['middle.MCP'])).toBe(true);
    expect(motion.sample(150).jointAnglesRad.index.MCP).toBe(0.8);
    expect(motion.sample(150).jointAnglesRad.middle.MCP).toBe(0.3);
    motion.push(observation(200, 0, 0.4), 200, ['middle.MCP']);
    expect(motion.sample(250).jointAnglesRad.index.MCP).toBe(0.8);
    motion.push(observation(300, Number.NaN, 0.5), 300, ['middle.MCP']);
    expect(motion.sample(350).jointAnglesRad.index.MCP).toBe(0.8);
    const eased = motion.sample(400);
    expect(eased.jointAnglesRad.index.MCP).toBeLessThan(0.8);
    expect(eased.jointAnglesRad.index.MCP).toBeGreaterThan(0.6);
    expect(eased.jointAnglesRad.middle.MCP).toBe(0.5);
    expect(motion.status).toBe('tracked');
  });

  it('requires consecutive fresh observations after loss and cannot be kept recovering by nulls', () => {
    const motion = new PoseSynchronizer(manifest());
    motion.push(observation(0), 0);
    expect(motion.status).toBe('recovering');
    motion.push(observation(10), 10);
    expect(motion.status).toBe('tracked');
    motion.sample(100);
    motion.sample(600);
    expect(motion.status).toBe('lost');
    expect(motion.push(observation(610), 610)).toBe(true);
    expect(motion.status).toBe('recovering');
    motion.push(null, 620);
    expect(motion.status).toBe('lost');
    motion.push(observation(630), 630);
    expect(motion.status).toBe('recovering');
    motion.push(observation(650), 650);
    expect(motion.status).toBe('tracked');
    expect(motion.sample(660).timestampMs).toBe(650);
    motion.sample(1200);
    motion.push(observation(1210), 1210);
    motion.sample(1500);
    expect(motion.status).toBe('lost');
    motion.push(observation(1510), 1510);
    expect(motion.status).toBe('recovering');
    motion.push(observation(1530), 1530);
    expect(motion.status).toBe('tracked');
  });

  it('rejects stale, future, duplicate, out-of-order and nonfinite input without poisoning the last pose', () => {
    const motion = new PoseSynchronizer(manifest());
    expect(motion.push(observation(100), 100)).toBe(true);
    expect(motion.push(observation(100), 110)).toBe(false);
    expect(motion.push(observation(99), 120)).toBe(false);
    expect(motion.push(observation(500), 120)).toBe(false);
    expect(motion.push(observation(Number.NaN), 120)).toBe(false);
    expect(motion.push(observation(110, Number.NaN), 120)).toBe(false);
    expect(motion.push(observation(110), Number.NaN)).toBe(false);
    expect(motion.push(observation(110), 90)).toBe(false);
    expect(motion.push(observation(110), 500)).toBe(false);
    expect(motion.push(observation(120), 120, [])).toBe(false);
    expect(motion.status).toBe('recovering');
    const safe = motion.sample(Number.NaN);
    expect(safe.timestampMs).toBe(100);
    expect(Number.isFinite(safe.jointAnglesRad.index.MCP)).toBe(true);
    expect(motion.push(observation(130), 130)).toBe(true);
    expect(motion.status).toBe('tracked');
  });

  it('bounds catch-up after suspension and does not move backward on an old render clock', () => {
    const motion = new PoseSynchronizer(manifest(), { recoverFrames: 1, tauMs: 0, maxVelocityRadS: 1, holdMs: 5000, staleMs: 5000 });
    motion.push(observation(0, 1), 0);
    expect(motion.sample(3000).jointAnglesRad.index.MCP).toBeCloseTo(0.1);
    expect(motion.sample(2000).jointAnglesRad.index.MCP).toBeCloseTo(0.1);
    expect(motion.sample(3010).jointAnglesRad.index.MCP).toBeCloseTo(0.11);
  });

  it('guards finite configuration, rounds hysteresis and does not expose mutable options', () => {
    const motion = new PoseSynchronizer(manifest());
    expect(motion.options).toEqual({ tauMs: 70, maxVelocityRadS: 5, holdMs: 250, lossEaseMs: 500, recoverFrames: 2, staleMs: 250 });
    motion.configure({ tauMs: Number.NaN, maxVelocityRadS: -3, holdMs: Infinity, lossEaseMs: 0, recoverFrames: 2.7, staleMs: -1 });
    expect(motion.options).toEqual({ tauMs: 70, maxVelocityRadS: 0.01, holdMs: 250, lossEaseMs: 1, recoverFrames: 3, staleMs: 1 });
    motion.options.tauMs = Infinity;
    expect(motion.options.tauMs).toBe(70);
    motion.configure({ tauMs: 100000, maxVelocityRadS: 100000, holdMs: 100000, lossEaseMs: 100000, recoverFrames: 100000, staleMs: 100000 });
    expect(motion.options).toEqual({ tauMs: 2000, maxVelocityRadS: 50, holdMs: 5000, lossEaseMs: 10000, recoverFrames: 30, staleMs: 5000 });
  });

  it('reduces deterministic stationary noise rather than merely freezing movement', () => {
    const motion = new PoseSynchronizer(manifest());
    let inputSquaredError = 0;
    let outputSquaredError = 0;
    for (let frame = 0; frame < 120; frame++) {
      const now = frame * 1000 / 30;
      const value = 0.5 + (frame % 2 ? 0.08 : -0.08);
      motion.push(observation(now, value), now);
      const output = motion.sample(now + 25).jointAnglesRad.index.MCP;
      if (frame > 20) {
        inputSquaredError += (value - 0.5) ** 2;
        outputSquaredError += (output - 0.5) ** 2;
      }
    }
    expect(outputSquaredError).toBeLessThan(inputSquaredError * 0.1);
    expect(motion.sample(3995).jointAnglesRad.index.MCP).toBeGreaterThan(0.45);
  });

  it('settles a step with no overshoot and moves monotonically on a reverse step', () => {
    const motion = new PoseSynchronizer(manifest(), { recoverFrames: 1, staleMs: 2000, holdMs: 2000 });
    motion.push(observation(0), 0);
    let previous = 0;
    for (let now = 10; now <= 600; now += 10) {
      const value = motion.sample(now).jointAnglesRad.index.MCP;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(0.8);
      previous = value;
    }
    expect(previous).toBeGreaterThan(0.799);
    motion.push(observation(600, 0), 600);
    for (let now = 610; now <= 1200; now += 10) {
      const value = motion.sample(now).jointAnglesRad.index.MCP;
      expect(value).toBeLessThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      previous = value;
    }
    expect(previous).toBeLessThan(0.001);
  });
});
