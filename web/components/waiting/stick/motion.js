/**
 * Motion for stick figures: poses, keyframes and how to get from one pose to
 * the next. Two rules make it move well. Bodies follow a spline through their
 * key poses, so speed carries across a key instead of stopping at it. And
 * feet are pinned to the floor between steps, so a planted foot never slides:
 * the body moves over it, and a foot that has to move takes a step.
 *
 * An authoring pose gives `feet` as [forward, side, lift] from the spot under
 * the pelvis and `toes` as turn-out from the heading. `stand` turns that into
 * the world `plants` and `aim` the rig takes (see rig.js).
 */
import { heading } from './rig.js';
import { mix, mix3, smooth, span } from './vec.js';

const TAU = Math.PI * 2;
const SCALARS = ['x', 'z', 'yaw', 'hip', 'lean', 'sway', 'twist', 'headYaw', 'headPitch', 'headRoll'];
/** How much of the neighbouring keys' speed a spline carries through a key. */
const CARRY = 0.9;
/** A hand is kept at least this far from its shoulder, so the arm never folds flat. */
const ARM_ROOM = 0.5;

/** Standing at ease. */
export const NEUTRAL = Object.freeze({
  x: 0, z: 0, yaw: 0, hip: 3.2, lean: 0.05, sway: 0, twist: 0, headYaw: 0, headPitch: 0, headRoll: 0,
  feet: [[0, -0.33, 0], [0, 0.33, 0]], toes: [-0.14, 0.14], toeLift: [0, 0],
  hands: [[0.12, -0.14, -1.74], [0.12, 0.14, -1.74]],
});

/** Put an authoring pose on the floor: adds world `plants` and `aim`. */
export function stand(pose) {
  const { f, r } = heading(pose.yaw);
  return {
    ...pose,
    plants: pose.feet.map(([forward, side, lift]) => [pose.x + f[0] * forward + r[0] * side, lift, pose.z + f[2] * forward + r[2] * side]),
    aim: pose.toes.map(turnOut => pose.yaw + turnOut),
  };
}

/** A copy whose limb targets can be reassigned without touching the keyframe it came from. */
export const editable = pose => ({ ...pose, plants: pose.plants.map(plant => [...plant]), hands: [pose.hands[0], pose.hands[1]] });

/**
 * How far forward to carry a hand that is part-way (u) between two spots
 * given from its shoulder. A straight line that passes close to the shoulder
 * would fold the arm up and whip the elbow round, so those moves bow out in
 * front of the chest instead.
 */
function bow(a, b, u) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const along = Math.min(1, Math.max(0, -(a[0] * dx + a[1] * dy + a[2] * dz) / (dx * dx + dy * dy + dz * dz || 1)));
  const nearest = Math.hypot(a[0] + dx * along, a[1] + dy * along, a[2] + dz * along);
  return 1.1 * Math.min(1, Math.max(0, 1 - nearest)) * Math.sin(Math.PI * u);
}

function roomy(hand) {
  const far = Math.hypot(hand[0], hand[1], hand[2]);
  if (far >= ARM_ROOM) return hand;
  if (far < 1e-3) return [ARM_ROOM, 0, 0];
  return [hand[0] * ARM_ROOM / far, hand[1] * ARM_ROOM / far, hand[2] * ARM_ROOM / far];
}

/**
 * Keyframes from [time, changes, options] rows in time order. Each row
 * changes the pose before it, so a row lists only what moves. Options:
 *   stop   The body comes to rest at this key instead of flowing through it.
 *   keep   [left, right]: feet that stay where the previous key planted them.
 *   slide  [left, right]: feet that travel to this key along the floor
 *          instead of being picked up.
 */
export function keyframes(rows) {
  let pose = NEUTRAL;
  const keys = rows.map(([t, changes, options = {}]) => {
    pose = { ...pose, ...changes };
    return { t, pose: stand(pose), stop: !!options.stop, keep: options.keep || [false, false], slide: options.slide || [false, false] };
  });
  for (let i = 1; i < keys.length; i += 1) {
    const before = keys[i - 1].pose;
    const here = keys[i].pose;
    here.aim = [...here.aim];
    here.plants = here.plants.map((plant, foot) => {
      const was = before.plants[foot];
      // A foot asked to stay, or put down a hair from where it already was, has not moved.
      const settled = plant[1] === 0 && was[1] === 0 && Math.hypot(plant[0] - was[0], plant[2] - was[2]) < 0.35;
      if (!keys[i].keep[foot] && !settled) return plant;
      here.aim[foot] = before.aim[foot];
      return [was[0], plant[1], was[2]];
    });
  }
  keys.forEach((key, i) => {
    const before = keys[i - 1];
    const after = keys[i + 1];
    const flows = before && after && !key.stop;
    const rate = (from, to) => (flows ? CARRY * (to - from) / (after.t - before.t) : 0);
    key.rates = {};
    for (const name of SCALARS) key.rates[name] = flows ? rate(before.pose[name], after.pose[name]) : 0;
    key.handRates = key.pose.hands.map((hand, index) => hand.map((_, axis) => (flows ? rate(before.pose.hands[index][axis], after.pose.hands[index][axis]) : 0)));
  });
  return keys;
}

/** The pose at time `t`: the body on its spline, each foot planted or mid-step. */
export function sample(keys, t) {
  const last = keys.length - 1;
  if (t <= keys[0].t) return keys[0].pose;
  if (t >= keys[last].t) return keys[last].pose;
  let index = 0;
  while (t >= keys[index + 1].t) index += 1;
  const from = keys[index];
  const to = keys[index + 1];
  const dt = to.t - from.t;
  const u = (t - from.t) / dt;
  const u2 = u * u;
  const u3 = u2 * u;
  // Cubic Hermite: through both poses, leaving and arriving at the keys' rates.
  const curve = (a, b, rateA, rateB) => (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * dt * rateA + (3 * u2 - 2 * u3) * b + (u3 - u2) * dt * rateB;
  const pose = {};
  for (const name of SCALARS) pose[name] = curve(from.pose[name], to.pose[name], from.rates[name], to.rates[name]);
  pose.hands = from.pose.hands.map((hand, i) => {
    const at = hand.map((value, axis) => curve(value, to.pose.hands[i][axis], from.handRates[i][axis], to.handRates[i][axis]));
    at[0] += bow(hand, to.pose.hands[i], u);
    return roomy(at);
  });
  pose.toeLift = [mix(from.pose.toeLift[0], to.pose.toeLift[0], u), mix(from.pose.toeLift[1], to.pose.toeLift[1], u)];
  // A step leaves a moment after the key and lands a moment before the next.
  const stride = smooth(span(u, 0.06, 0.94));
  pose.aim = [0, 1].map(foot => mix(from.pose.aim[foot], to.pose.aim[foot], stride));
  pose.plants = [0, 1].map((foot) => {
    const a = from.pose.plants[foot];
    const b = to.pose.plants[foot];
    const far = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (far < 1e-6) return [a[0], mix(a[1], b[1], smooth(u)), a[2]];
    // Picked up in an arc that grows with the length of the step; a foot
    // already in the air, or one that slides, just travels.
    const grounded = a[1] < 0.05 && b[1] < 0.05;
    const arc = to.slide[foot] ? 0 : Math.min(0.5, 0.08 + 0.16 * far) * (grounded ? 1 : 0.35);
    return [mix(a[0], b[0], stride), mix(a[1], b[1], stride) + arc * Math.sin(Math.PI * stride), mix(a[2], b[2], stride)];
  });
  return pose;
}

/** Cross-fade between two poses, for handing over from one piece of motion to another. */
export function blend(a, b, u) {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const pose = {};
  for (const name of SCALARS) pose[name] = mix(a[name], b[name], u);
  pose.toeLift = [mix(a.toeLift[0], b.toeLift[0], u), mix(a.toeLift[1], b.toeLift[1], u)];
  pose.aim = [mix(a.aim[0], b.aim[0], u), mix(a.aim[1], b.aim[1], u)];
  pose.plants = [mix3(a.plants[0], b.plants[0], u), mix3(a.plants[1], b.plants[1], u)];
  pose.hands = [0, 1].map((hand) => {
    const at = mix3(a.hands[hand], b.hands[hand], u);
    at[0] += bow(a.hands[hand], b.hands[hand], u);
    return roomy(at);
  });
  return pose;
}

/** How far each foot reaches ahead of and behind the pelvis at a pace. */
const strideAt = pace => mix(0.75, 1.45, pace);
/** Floor covered by one full walk or run cycle: a step with each foot. */
export const cycleLength = pace => 4 * strideAt(pace);

/**
 * Walk or run cycle. `pace` 0 is a stroll and 1 a run; `phase` counts cycles.
 * Advance `phase` by distance / cycleLength(pace) and the foot on the floor
 * stays exactly where it was planted.
 */
export function gait(x, z, yaw, phase, pace) {
  const stride = strideAt(pace);
  const lift = mix(0.22, 0.8, pace);
  const foot = (shift, side) => {
    const part = (((phase + shift) % 1) + 1) % 1 * 2;
    // First half on the floor, passing under the body; second half swinging through.
    if (part < 1) return [stride * (1 - 2 * part), side, 0];
    return [-stride * Math.cos(Math.PI * (part - 1)), side, Math.sin(Math.PI * (part - 1)) * lift];
  };
  const cycle = phase * TAU;
  const swing = Math.cos(cycle);
  // Arms hang and sway at a walk, and pump with bent elbows at a run; each
  // swings against the leg on its own side.
  const armReach = mix(0.4, 0.78, pace);
  const hang = mix(-1.72, -1.15, pace);
  return stand({
    ...NEUTRAL, x, z, yaw,
    hip: mix(3.12, 2.92, pace) - 0.05 * Math.cos(2 * cycle),
    lean: mix(0.06, 0.26, pace), twist: 0.1 * swing,
    feet: [foot(0, -0.3), foot(0.5, 0.3)],
    hands: [[-armReach * swing, -0.2, hang - 0.22 * pace * swing], [armReach * swing, 0.2, hang + 0.22 * pace * swing]],
  });
}
