import { type Finger, type Joint, type JointBinding, type JointId, type RobotPose } from './types';

export type MotionState = 'searching' | 'tracked' | 'holding' | 'lost' | 'recovering';
export interface MotionOptions {
  tauMs: number;
  maxVelocityRadS: number;
  holdMs: number;
  /** Exponential time constant for returning to neutral after the loss hold. */
  lossEaseMs: number;
  recoverFrames: number;
  staleMs: number;
}

const DEFAULTS: MotionOptions = { tauMs: 70, maxVelocityRadS: 5, holdMs: 250, lossEaseMs: 500, recoverFrames: 2, staleMs: 250 };
const LIMITS: Record<keyof MotionOptions, readonly [number, number]> = {
  tauMs: [0, 2000], maxVelocityRadS: [0.01, 50], holdMs: [0, 5000],
  lossEaseMs: [1, 10000], recoverFrames: [1, 30], staleMs: [1, 5000],
};
interface Channel {
  binding: JointBinding;
  finger: Finger;
  joint: Joint | 'spread' | 'opposition';
}
function angle(pose: RobotPose, channel: Channel): number {
  return channel.joint === 'opposition' ? pose.thumbOppositionRad : channel.joint === 'spread'
    ? pose.spreadRad[channel.finger] : pose.jointAnglesRad[channel.finger][channel.joint];
}
function assign(pose: RobotPose, channel: Channel, value: number): void {
  if (channel.joint === 'opposition') pose.thumbOppositionRad = value;
  else if (channel.joint === 'spread') pose.spreadRad[channel.finger] = value;
  else pose.jointAnglesRad[channel.finger][channel.joint] = value;
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

// Exact integration of a velocity-limited first-order response, including its linear/exponential transition.
function approach(current: number, target: number, dtMs: number, tauMs: number, velocity: number): number {
  const distance = Math.abs(target - current);
  if (!distance || dtMs <= 0) return current;
  const dt = dtMs / 1000;
  const tau = tauMs / 1000;
  const threshold = velocity * tau;
  const linearTime = Math.max(0, (distance - threshold) / velocity);
  const remaining = dt <= linearTime ? distance - velocity * dt : Math.min(distance, threshold) * Math.exp(-(dt - linearTime) / tau);
  return target + Math.sign(current - target) * Math.max(0, remaining);
}

export class PoseSynchronizer {
  private readonly channels: Channel[];
  private readonly current: Float64Array;
  private readonly target: Float64Array;
  private readonly fresh: Float64Array;
  private readonly lost: Float64Array;
  private settings = { ...DEFAULTS };
  private state: MotionState = 'searching';
  private clock = Number.NaN;
  private capture = -Infinity;
  private trackedAt = -Infinity;
  private observed = false;
  private lossAt = Infinity;
  private recovery = 0;
  private recoveryAt = -Infinity;

  constructor(manifest: JointBinding[], options: Partial<MotionOptions> = {}) {
    this.channels = manifest.map(binding => {
      const [finger, joint] = binding.id.split('.') as [Finger, Channel['joint']];
      return { binding, finger, joint };
    });
    this.current = new Float64Array(manifest.length);
    this.target = new Float64Array(manifest.length);
    this.fresh = new Float64Array(manifest.length);
    this.lost = new Float64Array(manifest.length);
    this.configure(options);
    this.reset();
  }

  get status(): MotionState { return this.state; }
  get options(): MotionOptions { return { ...this.settings }; }

  configure(options: Partial<MotionOptions>): void {
    for (const key of Object.keys(DEFAULTS) as (keyof MotionOptions)[]) {
      const value = options[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const [min, max] = LIMITS[key];
      this.settings[key] = clamp(key === 'recoverFrames' ? Math.round(value) : value, min, max);
    }
  }

  reset(nowMs?: number): void {
    this.current.fill(0);
    this.target.fill(0);
    this.fresh.fill(-Infinity);
    this.lost.fill(-Infinity);
    this.clock = Number.isFinite(nowMs) && nowMs! >= 0 ? nowMs! : Number.NaN;
    this.capture = this.trackedAt = this.recoveryAt = -Infinity;
    this.observed = false;
    this.lossAt = Infinity;
    this.recovery = 0;
    this.state = 'searching';
  }

  push(pose: RobotPose | null, nowMs: number, validJoints?: JointId[]): boolean {
    if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs < this.clock) return false;
    if (pose === null) {
      this.advance(nowMs);
      this.lossAt = Math.min(this.lossAt, nowMs);
      for (let i = 0; i < this.channels.length; i++) this.lost[i] = Math.min(this.lost[i], nowMs);
      this.recovery = 0;
      if (this.state === 'recovering') this.state = 'lost';
      this.refreshState(nowMs);
      return false;
    }
    const timestamp = pose.timestampMs;
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp <= this.capture || timestamp > nowMs || nowMs - timestamp > this.settings.staleMs) {
      return false;
    }
    let count = 0;
    for (const channel of this.channels) {
      if (validJoints && !validJoints.includes(channel.binding.id)) continue;
      if (!Number.isFinite(angle(pose, channel))) return false;
      count++;
    }
    if (!count) return false;
    this.advance(nowMs);
    const recovering = !this.observed || this.state === 'lost' || this.state === 'recovering';
    if (recovering) {
      this.recovery = timestamp - this.recoveryAt <= this.settings.staleMs ? this.recovery + 1 : 1;
      this.recoveryAt = timestamp;
    }
    this.capture = timestamp;
    this.observed = true;
    if (recovering && this.recovery < this.settings.recoverFrames) {
      this.state = 'recovering';
      return true;
    }
    this.lossAt = Infinity;
    this.recovery = 0;
    this.trackedAt = timestamp;
    this.state = 'tracked';
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      const valid = !validJoints || validJoints.includes(channel.binding.id);
      if (valid) {
        this.target[i] = angle(pose, channel);
        this.fresh[i] = timestamp;
        this.lost[i] = Infinity;
      } else {
        this.lost[i] = Math.min(this.lost[i], nowMs);
      }
    }
    return true;
  }

  sample(nowMs: number): RobotPose {
    const now = Number.isFinite(nowMs) && nowMs >= 0 && !(nowMs < this.clock) ? nowMs : Number.isFinite(this.clock) ? this.clock : 0;
    this.advance(now);
    const pose: RobotPose = {
      timestampMs: this.observed ? this.capture : 0,
      jointAnglesRad: {
        thumb: { MCP: 0, PIP: 0, DIP: 0 }, index: { MCP: 0, PIP: 0, DIP: 0 },
        middle: { MCP: 0, PIP: 0, DIP: 0 }, ring: { MCP: 0, PIP: 0, DIP: 0 }, pinky: { MCP: 0, PIP: 0, DIP: 0 },
      },
      spreadRad: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
      thumbOppositionRad: 0,
    };
    for (let i = 0; i < this.channels.length; i++) assign(pose, this.channels[i], this.current[i]);
    return pose;
  }

  private refreshState(nowMs: number): void {
    if (!this.observed) this.state = 'searching';
    else if (this.state === 'recovering') {
      if (nowMs - this.recoveryAt <= this.settings.staleMs) return;
      this.state = 'lost';
    } else if (!Number.isFinite(this.trackedAt) || nowMs - this.lossAt >= this.settings.holdMs) this.state = 'lost';
    else this.state = Number.isFinite(this.lossAt) ? 'holding' : 'tracked';
  }

  private advance(nowMs: number): void {
    // Suspension never turns into a large hidden catch-up movement on the next render.
    const start = Number.isFinite(this.clock) ? Math.max(this.clock, nowMs - 100) : nowMs;
    this.clock = nowMs;
    if (Number.isFinite(this.trackedAt) && nowMs > this.trackedAt + this.settings.staleMs) {
      this.lossAt = Math.min(this.lossAt, this.trackedAt + this.settings.staleMs);
    }
    for (let i = 0; i < this.channels.length; i++) {
      const { minRad, maxRad } = this.channels[i].binding;
      const a = Number.isFinite(minRad) ? minRad : 0;
      const b = Number.isFinite(maxRad) ? maxRad : 0;
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      const neutral = clamp(0, min, max);
      let current = clamp(this.current[i], min, max);
      const staleAt = this.fresh[i] + this.settings.staleMs;
      if (nowMs > staleAt) this.lost[i] = Math.min(this.lost[i], staleAt);
      const end = Math.min(nowMs, this.lost[i]);
      current = approach(current, clamp(this.target[i], min, max), end - start, this.settings.tauMs, this.settings.maxVelocityRadS);
      const expires = this.lost[i] + this.settings.holdMs;
      const easeDt = nowMs - Math.max(start, expires);
      current = approach(current, neutral, easeDt, this.settings.lossEaseMs, this.settings.maxVelocityRadS);
      this.current[i] = clamp(current, min, max);
    }
    this.refreshState(nowMs);
  }
}
