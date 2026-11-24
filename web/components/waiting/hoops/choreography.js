/**
 * Decodes and samples motion-captured basketball possessions onto the shared
 * 19-joint figure format (see hoops/tracks.js).
 *
 * Unlike the old hand-keyed IK puppetry, every play here carries stabilised
 * real-video joint tracks (LEB128 zigzag delta-varint + base64) in court units
 * where the right-hand rim is at HOOP = [286, -155] with HOOP_RADIUS = 12.
 */
import { createTrackSampler } from './tracks.js';

export const HOOP = [286, -155];
export const HOOP_RADIUS = 12;
const GRAVITY = 475;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mix = (a, b, t) => a + (b - a) * t;

/**
 * Prepare one motion-captured court possession for `play.js`.
 */
export function choreograph(spec) {
  const sampleTrack = createTrackSampler(spec);
  const frames = spec.at[spec.at.length - 1];
  const waypoints = spec.waypoints;
  const targets = waypoints.slice(1);

  const flight = (ms) => {
    const seg = waypoints.length > 2 && ms >= waypoints[1][0] ? 1 : 0;
    const a = waypoints[seg];
    const b = waypoints[seg + 1];
    const u = clamp((ms - a[0]) / (b[0] - a[0]), 0, 1);
    const seconds = (b[0] - a[0]) / 1000;
    return {
      x: mix(a[1], b[1], u),
      y: mix(a[2], b[2], u) - 0.5 * GRAVITY * seconds ** 2 * u * (1 - u),
      held: false,
    };
  };

  let spins = null;
  const spinAt = (ms) => {
    if (!spins) {
      spins = new Float32Array(frames + 2);
      for (let f = 0; f <= frames; f += 1) {
        const loose = !sampleTrack(f).ball.held;
        spins[f + 1] = spins[f] + (loose ? (f >= spec.release ? -(10.5 / spec.fps) : (9.0 / spec.fps)) : 0);
      }
    }
    if (ms > spec.duration) {
      return spins[frames] - 0.0105 * (ms - spec.duration);
    }
    const frame = clamp((ms / 1000) * spec.fps, 0, frames);
    const whole = Math.min(frames, Math.floor(frame));
    return spins[whole] + (spins[whole + 1] - spins[whole]) * (frame - whole);
  };

  return {
    ...spec,
    targets,
    flight,
    spinAt,
    sample(ms) {
      const frame = clamp((ms / 1000) * spec.fps, 0, frames);
      const capture = sampleTrack(frame);
      if (ms >= spec.fire) {
        const air = flight(ms);
        capture.ball.x = air.x;
        capture.ball.y = air.y;
        capture.ball.held = false;
      }
      const backMs = Math.max(0, ms - 14);
      const before = backMs >= spec.fire
        ? flight(backMs)
        : sampleTrack(clamp((backMs / 1000) * spec.fps, 0, frames)).ball;
      return {
        capture,
        trail: [capture.ball.x - before.x, capture.ball.y - before.y],
        spin: spinAt(ms),
      };
    },
  };
}
