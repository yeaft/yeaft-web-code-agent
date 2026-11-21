/**
 * Motion capture playback for the basketball waiting animation: the clips in
 * moves.js decoded once, sampled at any time, strung together into a
 * performance, mirrored for a defender, and turned into the figure the
 * renderer draws. Pure apart from the one-time decode.
 *
 * A pose is an array of [x, y, z] joint positions in feet, in the order of
 * JOINTS (moves.js). Its root is the pelvis on the floor plan with the
 * heading of the hips (yaw 0 faces +x and turns toward +z, as `turn` does).
 *
 * moves.js stores, per frame, the pelvis as three int16 (1/200 ft) and every
 * other joint as the direction from its parent as three int8 (x127),
 * little-endian and base64-encoded; each clip lists its bone lengths.
 */
import { CLIPS, JOINTS, PARENTS, RATE } from './moves.js';
import { cross, mix, smooth, turn, unit } from '../stick/vec.js';

const COUNT = JOINTS.length;
export const J = Object.freeze(Object.fromEntries(JOINTS.map((name, index) => [name, index])));
/** Each joint's counterpart on the other side of the body. */
const SWAP = JOINTS.map((name) => {
  const other = name[0] === 'l' ? `r${name.slice(1)}` : name[0] === 'r' ? `l${name.slice(1)}` : name;
  return JOINTS.includes(other) ? JOINTS.indexOf(other) : JOINTS.indexOf(name);
});

const decoded = new Map();

function decode(name) {
  if (decoded.has(name)) return decoded.get(name);
  const clip = CLIPS[name];
  const binary = atob(clip.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const stride = 6 + (COUNT - 1) * 3;
  const frames = new Float32Array(clip.frames * COUNT * 3);
  for (let f = 0; f < clip.frames; f += 1) {
    const at = f * stride;
    const out = f * COUNT * 3;
    for (let axis = 0; axis < 3; axis += 1) frames[out + axis] = view.getInt16(at + axis * 2, true) / 200;
    for (let joint = 1; joint < COUNT; joint += 1) {
      const read = at + 6 + (joint - 1) * 3;
      const dx = view.getInt8(read);
      const dy = view.getInt8(read + 1);
      const dz = view.getInt8(read + 2);
      const k = clip.lengths[joint - 1] / (Math.hypot(dx, dy, dz) || 1);
      const parent = out + PARENTS[joint] * 3;
      frames[out + joint * 3] = frames[parent] + dx * k;
      frames[out + joint * 3 + 1] = frames[parent + 1] + dy * k;
      frames[out + joint * 3 + 2] = frames[parent + 2] + dz * k;
    }
  }
  const result = { ...clip, name, count: clip.frames, frames, seconds: clip.frames / RATE };
  decoded.set(name, result);
  return result;
}

/** A clip's facts without its frames: length in seconds, events, loop stride. */
export function clipInfo(name) {
  const clip = CLIPS[name];
  return { ...clip, data: undefined, seconds: clip.frames / RATE };
}

/** Joint `joint` of frame `index`; a looping clip carries on stride after stride. */
function joint(clip, index, joint, out) {
  let frame = index;
  let shift = 0;
  if (clip.loop) {
    const laps = Math.floor(index / clip.count);
    frame = index - laps * clip.count;
    shift = laps;
  } else {
    frame = Math.max(0, Math.min(clip.count - 1, index));
  }
  const at = (frame * COUNT + joint) * 3;
  out[0] = clip.frames[at] + (clip.loop ? shift * clip.loop[0] : 0);
  out[1] = clip.frames[at + 1];
  out[2] = clip.frames[at + 2] + (clip.loop ? shift * clip.loop[1] : 0);
  return out;
}

const a = [0, 0, 0];
const b = [0, 0, 0];
const c = [0, 0, 0];
const d = [0, 0, 0];

/**
 * The clip's pose at `t` seconds (Catmull-Rom between frames). A looping clip
 * plays for ever; any other holds its first and last frames.
 */
export function clipPose(name, t) {
  const clip = decode(name);
  const x = t * RATE;
  const i = Math.floor(x);
  const u = x - i;
  const u2 = u * u;
  const u3 = u2 * u;
  const pose = new Array(COUNT);
  for (let n = 0; n < COUNT; n += 1) {
    joint(clip, i - 1, n, a);
    joint(clip, i, n, b);
    joint(clip, i + 1, n, c);
    joint(clip, i + 2, n, d);
    const p = [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      p[axis] = 0.5 * ((2 * b[axis]) + (-a[axis] + c[axis]) * u + (2 * a[axis] - 5 * b[axis] + 4 * c[axis] - d[axis]) * u2
        + (-a[axis] + 3 * b[axis] - 3 * c[axis] + d[axis]) * u3);
    }
    pose[n] = p;
  }
  return pose;
}

/** Heading of a pose's hips: yaw 0 faces +x. */
export function yawOf(pose) {
  const rx = pose[J.rhip][0] - pose[J.lhip][0];
  const rz = pose[J.rhip][2] - pose[J.lhip][2];
  // Forward is up x right.
  return Math.atan2(-rx, rz);
}

const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

/** A pose turned by `angle` about the vertical and then moved by (dx, dz). */
export function moved(pose, angle, dx, dz) {
  return pose.map((p) => {
    const q = turn(p, angle);
    return [q[0] + dx, q[1], q[2] + dz];
  });
}

/** Root and the pose relative to it: { x, z, yaw, rel }. */
function split(pose) {
  const yaw = yawOf(pose);
  const x = pose[J.pelvis][0];
  const z = pose[J.pelvis][2];
  return { x, z, yaw, rel: pose.map(p => turn([p[0] - x, p[1], p[2] - z], -yaw)) };
}

function join({ x, z, yaw, rel }) {
  return rel.map((p) => {
    const q = turn(p, yaw);
    return [q[0] + x, q[1], q[2] + z];
  });
}

/**
 * Part-way from pose `p` to pose `q`: the body blended in its own frame, the
 * root moved and turned the short way round, so a figure turning while it
 * blends keeps its shape.
 */
export function blendPoses(p, q, u) {
  if (u <= 0) return p;
  if (u >= 1) return q;
  const from = split(p);
  const to = split(q);
  return join({
    x: mix(from.x, to.x, u),
    z: mix(from.z, to.z, u),
    yaw: from.yaw + wrap(to.yaw - from.yaw) * u,
    rel: from.rel.map((r, n) => [mix(r[0], to.rel[n][0], u), mix(r[1], to.rel[n][1], u), mix(r[2], to.rel[n][2], u)]),
  });
}

/** The pose seen in a mirror standing along its own heading: left for right. */
export function mirrored(pose) {
  const { x, z, yaw, rel } = split(pose);
  return join({ x, z, yaw, rel: rel.map((_, n) => [rel[SWAP[n]][0], rel[SWAP[n]][1], -rel[SWAP[n]][2]]) });
}

/** The pose with its root moved to (x, z) and turned to `yaw`, its body as it was. */
export function rerooted(pose, x, z, yaw) {
  return join({ ...split(pose), x, z, yaw });
}

/**
 * The pose with its back no further forward than `most` radians from
 * upright. Past `from` the trunk, head and arms turn back about the pelvis,
 * easing toward `most` so the turn never kinks; the legs stay as captured.
 */
export function upright(pose, from, most) {
  const { x, z, yaw, rel } = split(pose);
  const p = rel[J.pelvis];
  const c = rel[J.chest];
  const lean = Math.atan2(c[0] - p[0], c[1] - p[1]);
  if (lean <= from) return pose;
  const room = most - from;
  const back = lean - from - room * Math.tanh((lean - from) / room);
  const cos = Math.cos(back);
  const sin = Math.sin(back);
  // Forward is +x in the body's own frame: turning back takes x into y.
  return join({
    x, z, yaw,
    rel: rel.map((q, n) => {
      if (n < J.waist) return q;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      return [p[0] + dx * cos - dy * sin, p[1] + dx * sin + dy * cos, q[2]];
    }),
  });
}

/**
 * Clips strung together. Each entry is { clip, from, to, blend, turn }: the
 * clip from `from` to `to` seconds, faded in over the last `blend` seconds of
 * the entry before (0.3 by default), and picked up where that one is at the
 * start of the fade, turned `turn` radians further. Returns
 * { duration, at(t) } with `at` the pose at `t` seconds into the whole, and
 * `local(t)` which entry and clip time that is.
 */
export function perform(entries) {
  const parts = [];
  let start = 0;
  for (const entry of entries) {
    const from = entry.from || 0;
    const to = entry.to ?? decode(entry.clip).seconds;
    const blend = parts.length ? entry.blend ?? 0.3 : 0;
    start = parts.length ? parts[parts.length - 1].end - blend : 0;
    const part = { clip: entry.clip, from, to, blend, start, end: start + (to - from), angle: 0, dx: 0, dz: 0 };
    if (parts.length) {
      const here = split(sampleParts(parts, start));
      const there = split(clipPose(entry.clip, from));
      part.angle = wrap(here.yaw - there.yaw + (entry.turn || 0));
      const spun = turn([there.x, 0, there.z], part.angle);
      part.dx = here.x - spun[0];
      part.dz = here.z - spun[2];
    }
    parts.push(part);
  }
  return {
    parts,
    duration: parts[parts.length - 1].end,
    at: t => sampleParts(parts, t),
    /** Clip time of entry `index` at performance time `t`, and back. */
    clipTime: (index, t) => parts[index].from + (t - parts[index].start),
    time: (index, clipT) => parts[index].start + (clipT - parts[index].from),
  };
}

function partPose(part, t) {
  return moved(clipPose(part.clip, part.from + (t - part.start)), part.angle, part.dx, part.dz);
}

function sampleParts(parts, t) {
  let index = 0;
  while (index < parts.length - 1 && t >= parts[index + 1].start) index += 1;
  const part = parts[index];
  const pose = partPose(part, t);
  if (index === 0 || t >= part.start + part.blend) return pose;
  return blendPoses(partPose(parts[index - 1], t), pose, smooth((t - part.start) / part.blend));
}

/**
 * The figure the renderer draws, from a pose: the joints it names, with the
 * body's and the head's directions.
 * @param {number[][]} pose
 * @param {number} size Scale of the body's girth (1 for the ball handler).
 */
export function figureOf(pose, size = 1) {
  const P = name => pose[J[name]];
  const shoulders = [P('lshoulder'), P('rshoulder')];
  const across = unit([shoulders[1][0] - shoulders[0][0], 0, shoulders[1][2] - shoulders[0][2]]);
  const hipsAcross = unit([P('rhip')[0] - P('lhip')[0], 0, P('rhip')[2] - P('lhip')[2]]);
  const spine = unit([P('chest')[0] - P('pelvis')[0], P('chest')[1] - P('pelvis')[1], P('chest')[2] - P('pelvis')[2]]);
  const forward = unit(cross(spine, across));
  const right = unit(cross(forward, spine));
  const headUp = unit([P('crown')[0] - P('neck')[0], P('crown')[1] - P('neck')[1], P('crown')[2] - P('neck')[2]]);
  const face = unit(cross(headUp, unit(cross(forward, headUp))));
  const neck = P('neck');
  const crown = P('crown');
  // The head's centre: a little above CMU's crown point and forward of the neck.
  const head = [
    neck[0] + (crown[0] - neck[0]) * 0.95 + face[0] * 0.08,
    neck[1] + (crown[1] - neck[1]) * 0.95 + face[1] * 0.08,
    neck[2] + (crown[2] - neck[2]) * 0.95 + face[2] * 0.08,
  ];
  return {
    size,
    ground: [P('pelvis')[0], 0, P('pelvis')[2]],
    pelvis: P('pelvis'), waist: P('waist'), chest: P('chest'), neck, head, crown, face, headUp,
    forward, right, hipsRight: unit(cross(forward, [0, 1, 0])), hipsAcross,
    shoulders, hips: [P('lhip'), P('rhip')],
    legs: [0, 1].map(side => ({
      hip: P(side ? 'rhip' : 'lhip'), knee: P(side ? 'rknee' : 'lknee'), ankle: P(side ? 'rankle' : 'lankle'), toe: P(side ? 'rtoe' : 'ltoe'),
    })),
    arms: [0, 1].map(side => ({
      root: P(side ? 'rshoulder' : 'lshoulder'), elbow: P(side ? 'relbow' : 'lelbow'), wrist: P(side ? 'rwrist' : 'lwrist'), hand: P(side ? 'rhand' : 'lhand'),
    })),
  };
}
