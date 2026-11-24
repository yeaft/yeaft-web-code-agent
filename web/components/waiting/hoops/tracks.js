/**
 * Reads a motion-captured possession (hoops/capture.js or any court play) and
 * answers where everything was at any moment of it.
 *
 * Every track lives in the flat space of the camera that filmed the play, with
 * that camera's pan, tilt and zoom taken out, so a planted foot stays where it
 * is.
 *
 * Format. Every track is a list of channels, each one integer per sample.
 * A channel is stored as its first value followed by the change from each
 * sample to the next, zigzag-encoded as LEB128 varints, and the channels of a
 * track follow one another in a single base64 string.
 *   player  19 joints as x, y (see JOINT), then stature, the floor under the
 *           left foot and under the right (y), and flags: bit 0 left arm in
 *           front of the body, bit 1 right arm in front, bit 2 left leg the
 *           nearer one.
 *   ball    x, y, the floor under it (y), flags: bit 0 in his hands, bit 1
 *           hidden behind a body.
 *   view    centre x, centre y and height of the stage's picture.
 * Positions are (value * unit + origin); stature and height are value * unit.
 */
import { CAPTURE } from './capture.js';

/** Index of each joint in a player's `points`. */
export const JOINT = {
  nose: 0, top: 1, neck: 2,
  shoulderL: 3, shoulderR: 4, elbowL: 5, elbowR: 6, wristL: 7, wristR: 8,
  hipL: 9, hipR: 10, kneeL: 11, kneeR: 12, ankleL: 13, ankleR: 14,
  toeL: 15, toeR: 16, heelL: 17, heelR: 18,
};
const JOINT_COUNT = 19;
const PLAYER_CHANNELS = JOINT_COUNT * 2 + 4;

/** @returns {Int32Array[]} `channels` arrays of one value per sample. */
function decode(text, channels, sampleCount) {
  const bytes = atob(text);
  const out = [];
  let at = 0;
  for (let c = 0; c < channels; c += 1) {
    const values = new Int32Array(sampleCount);
    let value = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      let raw = 0;
      let shift = 0;
      let byte;
      do {
        byte = bytes.charCodeAt(at);
        at += 1;
        raw |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      value += (raw >>> 1) ^ -(raw & 1);
      values[i] = value;
    }
    out.push(values);
  }
  return out;
}

/** Catmull-Rom through a channel's samples, so motion between them stays round. */
function smooth(values, sampleCount, index, mix) {
  const p1 = values[index];
  const p2 = values[Math.min(sampleCount - 1, index + 1)];
  const p0 = values[Math.max(0, index - 1)];
  const p3 = values[Math.min(sampleCount - 1, index + 2)];
  const u2 = mix * mix;
  return 0.5 * (2 * p1 + (p2 - p0) * mix + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (3 * p1 - p0 - 3 * p2 + p3) * u2 * mix);
}

/**
 * Builds a reusable, lazily-decoded sampler for any capture object.
 * @param {object} spec Capture specification (`at`, `unit`, `origin`, `players`, `ball`, `view`, optional `exits`).
 */
export function createTrackSampler(spec) {
  const at = spec.at;
  const sampleCount = at.length;
  const totalFrames = at[sampleCount - 1];
  const names = Object.keys(spec.players);
  const exits = spec.exits || {};
  let decoded = null;

  function load() {
    if (!decoded) {
      decoded = {
        players: names.map(name => decode(spec.players[name], PLAYER_CHANNELS, sampleCount)),
        ball: decode(spec.ball, 4, sampleCount),
        view: decode(spec.view, 3, sampleCount),
      };
    }
    return decoded;
  }

  function locate(frame) {
    const f = Math.min(totalFrames, Math.max(0, frame));
    let low = 0;
    let high = sampleCount - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (at[mid] <= f) low = mid; else high = mid;
    }
    return { index: low, mix: (f - at[low]) / (at[high] - at[low]) };
  }

  function presenceOf(name, frame) {
    const exit = exits[name];
    if (!exit) return 1;
    const u = Math.min(1, Math.max(0, (frame - exit[0]) / (exit[1] - exit[0])));
    return 1 - u * u * (3 - 2 * u);
  }

  return function sample(frame) {
    const data = load();
    const { index, mix } = locate(frame);
    const near = mix < 0.5 ? index : Math.min(sampleCount - 1, index + 1);
    const unit = spec.unit;
    const [ox, oy] = spec.origin;
    const x = values => smooth(values, sampleCount, index, mix) * unit + ox;
    const y = values => smooth(values, sampleCount, index, mix) * unit + oy;

    const players = {};
    names.forEach((name, p) => {
      const channels = data.players[p];
      const points = [];
      for (let j = 0; j < JOINT_COUNT; j += 1) points.push([x(channels[j * 2]), y(channels[j * 2 + 1])]);
      const flags = channels[JOINT_COUNT * 2 + 3][near];
      players[name] = {
        points,
        size: smooth(channels[JOINT_COUNT * 2], sampleCount, index, mix) * unit,
        floorL: y(channels[JOINT_COUNT * 2 + 1]),
        floorR: y(channels[JOINT_COUNT * 2 + 2]),
        armLFront: (flags & 1) !== 0,
        armRFront: (flags & 2) !== 0,
        legLNear: (flags & 4) !== 0,
        presence: presenceOf(name, frame),
      };
    });
    const ballFlags = data.ball[3][near];
    return {
      players,
      ball: { x: x(data.ball[0]), y: y(data.ball[1]), floor: y(data.ball[2]), held: (ballFlags & 1) !== 0, hidden: (ballFlags & 2) !== 0 },
      view: { x: x(data.view[0]), y: y(data.view[1]), height: smooth(data.view[2], sampleCount, index, mix) * unit },
    };
  };
}

export const CAPTURE_FRAMES = CAPTURE.at[CAPTURE.at.length - 1];
export const CAPTURE_FPS = CAPTURE.fps;
export const RELEASE_FRAME = CAPTURE.release;
export const PLAYERS = Object.keys(CAPTURE.players);
export const sampleCapture = createTrackSampler(CAPTURE);

/** The three-point line as it lies in the capture's space: an ellipse [cx, cy, a, b] sheared by `k`. */
export const ARC = CAPTURE.arc;
/** The far edge of the floor: y at x = 0 and its slope. */
export const FLOOR_EDGE = CAPTURE.edge;
