/**
 * Choreography of the Dragon Ball waiting animation: Goku and Vegeta square
 * off, trade blows, Vegeta is kicked into the sky and answers with an energy
 * wave, Goku gathers the Spirit Bomb, the two attacks grind against each
 * other, and the bomb wins. Resolved as a pure function of elapsed time, so
 * any canvas reading the same clock shows the same frame of the same fight.
 *
 * Fight space is in feet. The fight runs along x on the floor plane z = 0
 * and is watched from +z, so +x is screen right; y is up. Goku starts on the
 * left facing +x. Index 0 is a fighter's left limb and 1 the right.
 */
import { editable, keyframes, sample } from '../stick/motion.js';
import { BODY, heading, solveFigure, torsoOf } from '../stick/rig.js';
import { add, clamp01, dot, easeOut, mix, mix3, mul, smooth, span, sub, unit } from '../stick/vec.js';

const PI = Math.PI;
const BOTH = [true, true];
const LEFT = [true, false];
const RIGHT = [false, true];

/** Beat starts in fight seconds. */
const B = Object.freeze({ standoff: 0, clash: 1.0, wave: 3.3, bomb: 6.0, struggle: 8.6, finish: 10.78, aftermath: 12.2 });
export const DRAGON_BEATS = B;
const BEAT_ORDER = Object.keys(B);
const LOOP_SECONDS = 14.3;

// The exchange of blows plays a quarter slower than it was choreographed, so
// each blow can be read. The clock eases into and out of it, so nothing
// lurches when it starts or ends.
const SLOW_FROM = 1.3;
const SLOW_HOLD = 3.22;
const SLOW_EASE = 0.2;
const SLOW_DEPTH = 0.25;
const SLOW_COST = SLOW_DEPTH * (SLOW_HOLD - SLOW_FROM);

/** Fight seconds for real seconds into a round. */
function fightSeconds(real) {
  // Integral of an eased-in, eased-out dip in the clock's rate.
  const eased = s => s * s * s - (s * s * s * s) / 2;
  let lost = 0;
  if (real > SLOW_FROM) {
    const into = Math.min(1, (real - SLOW_FROM) / SLOW_EASE);
    lost = SLOW_EASE * eased(into) + Math.max(0, Math.min(real, SLOW_HOLD) - SLOW_FROM - SLOW_EASE);
    if (real > SLOW_HOLD) {
      const out = Math.min(1, (real - SLOW_HOLD) / SLOW_EASE);
      lost += SLOW_EASE * (out - eased(out));
    }
  }
  return real - SLOW_DEPTH * lost;
}

export const DRAGON_LOOP_MS = Math.round((LOOP_SECONDS + SLOW_COST) * 1000);
/** A still for reduced motion and stalled connections: wave against bomb, both fighters straining. */
export const DRAGON_POSTER_MS = Math.round((9.95 + SLOW_COST) * 1000);

/** The moments everything else is timed against. */
const T = Object.freeze({
  clash: 1.3, upper: 1.8, shin: 2.14, vanish: 2.5, boot: 2.76, brake: 3.65,
  fire: 5.2, crater: 5.33, gather: 6.45, release: 8.34, refire: 8.42, meet: 8.72, shove: 10.78, blast: 11.3, thud: 12.3,
});

// ── Tracks ──────────────────────────────────────────────────────────────

/** How much of the neighbouring keys' speed an airborne leg carries through a key (as the kit does for bodies). */
const CARRY = 0.9;
/** How hard a `hit` key is arrived at: 0 eases to rest, 1 arrives at three times the average speed. */
const SNAP = 0.7;

/** Legs of a figure off the floor: each ankle [forward, side, below the pelvis]. */
const fly = (hip, legs) => ({ air: 1, hip, feet: legs.map(([forward, side, below]) => [forward, side, Math.max(0, hip - below - BODY.ankle)]) });
/** Feet on the floor again. */
const land = (hip, feet) => ({ air: 0, hip, feet });

/**
 * Keyframes with three additions to the kit's. `look` is where the face
 * points from the heading, whatever the shoulders do. `air` keys hang the
 * legs from the pelvis instead of planting them, so a flying figure's legs
 * travel with it on their own spline. And the option `hit` makes the body
 * arrive at that key at speed and stop dead: a blow that lands.
 */
function track(rows) {
  let twist = 0;
  let look = 0;
  const keys = keyframes(rows.map(([t, changes, options = {}]) => {
    if ('twist' in changes) twist = changes.twist;
    if ('look' in changes) look = changes.look;
    return [t, { ...changes, headYaw: look - twist }, { ...options, stop: !!(options.stop || options.hit) }];
  }));
  keys.forEach((key, i) => {
    key.hit = !!(rows[i][2] && rows[i][2].hit);
    key.air = key.pose.air ? 1 : 0;
    key.hang = key.pose.feet.map(([forward, side, lift]) => [forward, side, lift - key.pose.hip]);
  });
  keys.forEach((key, i) => {
    const before = keys[i - 1];
    const after = keys[i + 1];
    const flows = before && after && !key.stop;
    key.hangRates = key.hang.map((foot, index) => foot.map((_, axis) => (flows ? CARRY * (after.hang[index][axis] - before.hang[index][axis]) / (after.t - before.t) : 0)));
  });
  return keys;
}

/** The pose of a track at time `t`, as a copy that can be edited. */
function poseAt(keys, time) {
  const last = keys.length - 1;
  const t = Math.min(keys[last].t, Math.max(keys[0].t, time));
  let index = 0;
  while (index < last - 1 && t >= keys[index + 1].t) index += 1;
  const from = keys[index];
  const to = keys[index + 1];
  const dt = to.t - from.t;
  let u = (t - from.t) / dt;
  if (to.hit) u += SNAP * (1 - Math.sqrt(1 - u) - u) * smooth(u);
  const pose = editable(sample(keys, from.t + dt * u));
  const air = mix(from.air, to.air, smooth(u));
  if (air > 0) {
    const u2 = u * u;
    const u3 = u2 * u;
    const { f, r } = heading(pose.yaw);
    pose.plants = pose.plants.map((plant, foot) => {
      const [forward, side, drop] = from.hang[foot].map((a, axis) => (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * dt * from.hangRates[foot][axis]
        + (3 * u2 - 2 * u3) * to.hang[foot][axis] + (u3 - u2) * dt * to.hangRates[foot][axis]);
      return mix3(plant, [pose.x + f[0] * forward + r[0] * side, Math.max(0, pose.hip + drop), pose.z + f[2] * forward + r[2] * side], air);
    });
  }
  return pose;
}

// ── Goku ────────────────────────────────────────────────────────────────

const GUARD = [[0.95, 0.15, 0.05], [0.5, -0.1, -0.4]];
const DOWN = [[0.1, -0.25, -1.75], [0.1, 0.25, -1.75]];

/** Up to the moment he vanishes: facing +x, his right side to the camera. */
const GOKU_OPENING = track([
  [0, { x: -4.6, z: 0.25, yaw: 0, hip: 2.7, lean: 0.16, twist: 0.5, feet: [[1.0, -0.35, 0], [-0.95, 0.4, 0]], toes: [0, 0.7], hands: GUARD, air: 0 }],
  [0.45, { hip: 2.76 }, { keep: BOTH }],
  // Sinks onto the back leg.
  [0.8, { x: -4.95, hip: 2.3, lean: 0.34, twist: 0.65, hands: [[0.8, 0.15, -0.05], [0.15, 0.25, -0.65]] }, { keep: BOTH }],
  [1.0, { x: -4.3, hip: 2.45, lean: 0.8, twist: 0.3, headPitch: -0.4 }, { keep: BOTH }],
  // Flat out, the right fist cocked.
  [1.15, { x: -3.7, ...fly(2.95, [[-1.3, -0.3, 2.2], [-2.4, 0.3, 1.5]]), lean: 1.0, twist: 0.35, headPitch: -0.7, hands: [[0.9, 0, 0.3], [0.05, 0.35, -0.55]] }],
  // Fist meets fist.
  [T.clash, { x: -3.0, ...land(2.7, [[1.35, -0.4, 0], [-1.75, 0.4, 0]]), lean: 0.55, twist: -0.75, headPitch: -0.25, toes: [0, 0.4], hands: [[0, -0.45, -0.6], [1.8, -0.2, 0.2]] }, { hit: true }],
  [1.44, { x: -2.9, lean: 0.62 }, { keep: BOTH }],
  // Thrown apart.
  [1.55, { x: -3.4, hip: 2.85, lean: 0.12, twist: 0.2, feet: [[0.9, -0.4, 0], [-1.0, 0.4, 0]], hands: [[0.75, 0.1, 0.1], [0.55, -0.1, -0.3]] }, { slide: BOTH }],
  // Under the hook, loading the uppercut.
  [1.67, { x: -1.9, hip: 1.95, lean: 0.8, twist: 0.45, headPitch: -0.6, hands: [[0.55, 0.1, -0.2], [0, 0.3, -1.0]] }, { keep: BOTH }],
  [T.upper, { x: -0.9, hip: 3.3, lean: 0.1, twist: -0.85, headPitch: -0.45, feet: [[0.3, -0.4, 0], [-1.0, 0.4, 0]], hands: [[-0.2, -0.5, -0.9], [1.0, -0.3, 1.5]] }, { hit: true, slide: RIGHT }],
  [1.93, { x: -0.8, hip: 3.34, hands: [[-0.2, -0.5, -0.9], [0.6, -0.3, 1.85]] }, { keep: BOTH }],
  // Arms up as the shin comes round.
  [2.06, { x: -1.0, hip: 2.8, lean: 0.05, twist: 0.25, headPitch: 0, hands: [[0.8, 0.3, 0.4], [0.7, -0.3, 0.15]] }, { keep: BOTH }],
  [T.shin, { x: -1.15, hip: 2.75, lean: -0.1 }, { keep: BOTH, stop: true }],
  // Driven back across the floor.
  [2.36, { x: -3.9, hip: 2.35, lean: 0.35, feet: [[1.1, -0.4, 0], [-1.0, 0.45, 0]], hands: [[0.75, 0.2, 0.1], [0.6, -0.3, -0.15]] }, { slide: BOTH }],
  [2.47, { x: -4.05, hip: 2.5, lean: 0.25, headPitch: -0.2 }, { keep: BOTH }],
]);

/** From his re-appearance: facing −x, his left side to the camera. */
const GOKU_KEYS = track([
  // Behind Vegeta, already in the air with the knee chambered.
  [T.vanish, { x: -0.3, z: 0.25, yaw: PI, ...fly(3.7, [[0.5, -0.3, 1.3], [-0.5, 0.3, 2.7]]), lean: -0.15, twist: 0.6, headPitch: 0.2, hands: [[0.5, -0.2, 0.2], [-0.3, 0.6, -0.4]] }],
  [2.64, { x: -0.5, ...fly(3.6, [[0.2, -0.3, 1.0], [-0.6, 0.3, 2.8]]), lean: -0.3, twist: 0.8 }],
  // The kick that sends him into the sky.
  [T.boot, { x: -0.8, ...fly(3.5, [[2.75, -0.1, -0.5], [-0.9, 0.3, 2.6]]), lean: -0.6, twist: -0.4, toeLift: [0.5, 0], hands: [[-0.4, -0.8, -0.3], [0.2, 0.9, 0.4]] }, { hit: true }],
  [2.9, { x: -0.5, ...fly(3.6, [[2.3, -0.2, 0.2], [-0.7, 0.3, 2.7]]), lean: -0.4 }],
  [3.22, { x: 2.4, ...land(2.6, [[0.8, -0.35, 0], [-0.8, 0.4, 0]]), lean: 0.2, twist: 0.3, toeLift: [0, 0], headPitch: -0.3, hands: [[0.7, 0.1, -0.2], [0.4, 0.2, -0.6]] }],
  [3.7, { x: 2.6, hip: 2.9, lean: 0.08, headPitch: -0.45, hands: [[0.6, 0.1, -0.5], [0.3, 0.2, -0.9]] }, { keep: BOTH }],
  // Braces as Vegeta powers up.
  [4.4, { hip: 2.6, lean: 0.2, twist: 0.45, feet: [[0.9, -0.4, 0], [-0.9, 0.45, 0]], hands: GUARD }, { keep: LEFT }],
  [5.0, { x: 2.5, hip: 2.1, lean: 0.42 }, { keep: BOTH }],
  // Springs back out of the wave's path, tucks, and lands in a skid.
  [T.fire + 0.03, { x: 3.4, hip: 3.3, lean: -0.15, twist: 0, hands: [[0.9, -0.4, 0.6], [0.9, 0.4, 0.6]] }, { keep: BOTH }],
  [5.46, { x: 6.2, ...fly(5.6, [[0.9, -0.35, 1.5], [0.5, 0.35, 1.9]]), lean: 0.45, headPitch: 0.3, hands: [[-0.2, -0.9, 0.5], [-0.2, 0.9, 0.5]] }],
  [5.72, { x: 8.2, ...land(2.3, [[1.3, -0.45, 0], [-0.7, 0.45, 0]]), lean: 0.6, headPitch: -0.3, hands: [[0.9, -0.2, -1.3], [-0.6, 0.7, 0.1]] }],
  [5.98, { x: 8.9, hip: 2.1, lean: 0.55 }, { slide: BOTH, stop: true }],
  // Stands, and raises both arms to the sky.
  [6.22, { hip: 3.0, lean: 0.05, headPitch: -0.2, hands: [[0.3, -0.4, -1.0], [0.3, 0.4, -1.0]] }, { keep: BOTH }],
  // He turns to face us for it: feet wide, arms in a V.
  [6.5, { x: 8.8, yaw: 1.95, hip: 3.0, lean: -0.06, feet: [[0.1, -1.0, 0], [-0.1, 1.0, 0]], toes: [-0.4, 0.4], headPitch: -0.55, hands: [[0.1, -0.95, 1.6], [0.1, 0.95, 1.6]] }],
  // The bomb grows heavy.
  [7.4, { hip: 2.9, lean: -0.1 }, { keep: BOTH }],
  [8.05, { hip: 2.72, lean: -0.12 }, { keep: BOTH }],
  // Rocks back, then throws it with his whole body.
  [8.22, { x: 9.25, yaw: 2.35, hip: 2.5, lean: -0.3, sway: -0.4, hands: [[-0.5, -0.5, 1.7], [-0.3, 1.0, 1.5]] }, { keep: BOTH }],
  [8.38, { x: 8.3, yaw: PI, hip: 2.5, lean: 0.7, sway: 0, feet: [[-1.4, -0.4, 0], [1.7, 0.45, 0]], toes: [-0.5, 0.1], headPitch: -0.3, hands: [[1.75, -0.25, 0.5], [1.75, 0.25, 0.5]] }, { keep: LEFT, hit: true }],
  [8.56, { hip: 2.35, lean: 0.8, hands: [[1.7, -0.3, 0.2], [1.7, 0.3, 0.2]] }, { keep: BOTH }],
  // Holds it against the wave: driven back, pushing in again.
  [8.76, { x: 8.4, hip: 2.5, lean: 0.5 }, { keep: BOTH }],
  [9.35, { x: 9.3, hip: 2.25, lean: 0.3 }, { slide: BOTH }],
  [9.95, { x: 8.9, hip: 2.5, lean: 0.6 }, { keep: BOTH }],
  [10.35, { x: 9.2, hip: 2.3, lean: 0.4 }, { keep: BOTH }],
  [10.6, { x: 9.5, hip: 2.1, lean: 0.25 }, { keep: BOTH }],
  // Everything he has left.
  [T.shove, { x: 8.3, hip: 2.6, lean: 0.9, feet: [[-1.6, -0.5, 0], [2.0, 0.45, 0]] }, { keep: LEFT, hit: true }],
  [11.3, { lean: 0.84 }, { keep: BOTH }],
  [11.55, { x: 8.2, hip: 2.2, lean: 0.5, headPitch: 0, hands: [[0.3, -0.5, -1.2], [0.3, 0.5, -1.2]] }, { keep: BOTH }],
  // Flies over and touches down beside what is left of Vegeta.
  [11.74, { x: 7.4, hip: 3.4, lean: 0.6 }, { keep: BOTH }],
  [12.1, { x: 3.2, ...fly(6.2, [[-1.4, -0.3, 2.4], [-2.2, 0.3, 1.8]]), lean: 0.85, headPitch: -0.3, hands: [[-0.9, -0.5, -0.6], [-0.9, 0.5, -0.6]] }],
  [12.5, { x: -2.2, ...fly(4.0, [[0.4, -0.3, 2.6], [-0.3, 0.3, 2.9]]), lean: 0.1, headPitch: 0.3, hands: [[0.2, -0.9, -0.6], [0.2, 0.9, -0.6]] }],
  [12.68, { x: -2.9, ...land(2.75, [[0.5, -0.35, 0], [-0.4, 0.4, 0]]), toes: [-0.14, 0.14], lean: 0.2, hands: [[0.3, -0.6, -1.1], [0.3, 0.6, -1.1]] }],
  [12.95, { hip: 3.2, lean: 0.02, headPitch: 0.1, hands: DOWN }, { keep: BOTH }],
  // Lets out a breath.
  [13.25, { hip: 3.04, lean: 0.14, headPitch: 0.35 }, { keep: BOTH }],
  // Turns to the viewer, a hand on his hip (the salute is added in `fightersAt`).
  [13.5, { yaw: 2.3, hip: 3.2, lean: 0, look: -0.5, headPitch: 0, hands: [DOWN[0], [0.25, 0.5, -1.3]] }, { keep: LEFT }],
  [LOOP_SECONDS, {}, { keep: BOTH, stop: true }],
]);

// ── Vegeta ──────────────────────────────────────────────────────────────

const CROSSED = [[0.42, 0.6, -0.55], [0.46, -0.6, -0.65]];
const CUPPED = [[0.8, 0.8, -0.9], [-0.2, 0.2, -1.0]];
const THRUST = [[1.8, 0.4, 0.05], [1.8, -0.4, 0.05]];
const HOVER = [[0.15, -0.3, 2.9], [-0.25, 0.3, 2.6]];
const COILED = [[0.7, -0.3, 2.2], [-0.6, 0.3, 2.5]];
const BRACED = [[-1.0, -0.4, 2.6], [-1.6, 0.4, 2.1]];

/** Until the bomb takes him. He starts facing −x and is spun round by the kick to face +x. */
const VEGETA_KEYS = track([
  // Hovering, arms crossed, looking down his nose.
  [0, { x: 4.4, z: -0.25, yaw: PI, ...fly(4.4, [[0.2, -0.2, 2.95], [-0.3, 0.25, 2.6]]), lean: -0.1, headPitch: 0.15, hands: CROSSED }],
  [0.5, {}, { stop: true }],
  [0.8, { hip: 4.55, lean: 0.12, hands: [[0.25, -0.45, -1.2], [0.25, 0.45, -1.2]] }],
  [1.0, { x: 4.7, ...fly(4.6, [[0.4, -0.25, 1.9], [-0.3, 0.25, 2.3]]), lean: 0.35, twist: -0.5, hands: [[0.05, -0.35, -0.5], [0.7, 0.1, 0]] }],
  [1.15, { x: 3.8, ...fly(3.7, [[-1.3, -0.3, 2.2], [-2.4, 0.3, 1.4]]), lean: 1.0, headPitch: -0.7 }],
  [T.clash, { x: 2.95, ...land(2.75, [[-1.75, -0.4, 0], [1.35, 0.4, 0]]), lean: 0.55, twist: 0.75, headPitch: -0.25, hands: [[1.8, 0.2, 0.2], [0, 0.45, -0.6]] }, { hit: true }],
  [1.44, { x: 2.85, lean: 0.62 }, { keep: BOTH }],
  [1.55, { x: 3.3, hip: 2.9, lean: 0.1, twist: -0.6, feet: [[-1.0, -0.4, 0], [0.9, 0.4, 0]], hands: [[0.1, -0.4, -0.45], [0.6, 0.2, -0.1]] }, { slide: BOTH }],
  // A hook that finds nothing.
  [1.67, { x: 1.7, hip: 2.8, lean: 0.45, twist: 0.9, hands: [[1.6, 0.45, 0.4], [0.2, 0.3, -0.5]] }, { keep: LEFT }],
  [1.74, { twist: 1.3, hands: [[0.9, 1.2, 0.2], [0.2, 0.3, -0.5]] }, { keep: BOTH }],
  // The uppercut takes him under the chin and off the floor.
  [T.upper, { x: 1.6, twist: 1.35 }, { keep: BOTH, stop: true }],
  [1.91, { x: 2.9, ...fly(4.3, [[0.9, -0.3, 2.5], [0.3, 0.3, 2.9]]), lean: -0.8, twist: -0.3, headPitch: -0.9, hands: [[0.5, -0.8, 0.5], [0.5, 0.8, 0.4]] }],
  // He turns the fall into a kick.
  [T.shin, { x: 2.5, ...fly(3.6, [[2.6, -0.1, -0.9], [-0.2, 0.3, 1.7]]), lean: -0.6, twist: 0.4, headPitch: 0.1, toeLift: [0.5, 0], hands: [[-0.2, -0.8, -0.3], [0.3, 0.8, 0.4]] }, { hit: true }],
  // Lands, winds up everything he has ...
  [2.3, { x: 2.1, ...land(2.55, [[-0.9, -0.4, 0], [0.9, 0.4, 0]]), lean: 0.3, twist: -0.8, toeLift: [0, 0], hands: [[0, -0.45, -0.4], [0.7, 0.1, -0.1]] }],
  [2.39, { x: 2.35, hip: 2.4, lean: 0.35, twist: -1.0 }, { keep: BOTH }],
  // ... and puts it through an after-image.
  [T.vanish, { x: -2.3, hip: 2.6, lean: 0.75, twist: 0.9, feet: [[-1.9, -0.4, 0], [1.5, 0.4, 0]], hands: [[1.85, 0.1, 0.15], [-0.6, 0.4, -0.6]] }],
  [2.6, { x: -2.65, hip: 2.5, lean: 0.9, hands: [[1.6, 0.1, -0.4], [-0.5, 0.4, -0.8]] }, { slide: BOTH }],
  [2.69, { x: -2.6, hip: 2.8, lean: 0.5, look: -1.3, hands: [[1.0, 0.1, -0.7], [-0.3, 0.4, -0.9]] }, { keep: BOTH }],
  // Booted in the back: spinning away and up.
  [T.boot, { hip: 2.95, lean: 0.3, twist: 0, look: 0, headPitch: -0.5 }, { keep: BOTH, stop: true }],
  [2.88, { x: -4.3, yaw: PI + 1.1, ...fly(4.5, [[-1.4, -0.4, 2.4], [-2.0, 0.4, 1.8]]), lean: 0.75, headPitch: -0.7, hands: [[-0.9, -0.9, -0.4], [-0.9, 0.9, -0.5]] }],
  [3.08, { x: -6.7, yaw: 2 * PI + 0.5, ...fly(6.6, [[-1.2, -0.5, 2.5], [-1.9, 0.5, 2.0]]), lean: 0.9 }],
  [3.36, { x: -8.9, yaw: 3 * PI + 0.4, ...fly(8.1, [[-0.6, -0.7, 2.7], [-1.0, 0.7, 2.5]]), lean: 0.5, hands: [[-0.6, -1.1, 0.4], [-0.6, 1.1, 0.4]] }],
  // Throws his limbs wide and stops himself. Now his right side is to the camera.
  [T.brake, { x: -9.7, yaw: 4 * PI, ...fly(7.8, [[0.2, -1.0, 2.6], [0, 1.0, 2.6]]), lean: -0.15, headPitch: 0.2, hands: [[0.1, -1.5, 0.5], [0.1, 1.5, 0.5]] }, { stop: true }],
  // Furious.
  [3.92, { x: -9.5, ...fly(7.5, HOVER), lean: 0.3, headPitch: 0.35, hands: [[0.3, -0.6, -1.1], [0.3, 0.6, -1.1]] }],
  // Hands cupped at his hip, the charge building.
  [4.25, { ...fly(7.5, COILED), lean: 0.25, twist: -0.9, hands: CUPPED }],
  [5.08, { x: -9.8, lean: 0.3, twist: -1.1 }],
  // Fires down at Goku; the recoil shoves him back.
  [T.fire, { x: -9.3, ...fly(7.6, BRACED), lean: 0.5, twist: 0, headPitch: 0.5, hands: [[1.45, 0.4, -0.95], [1.45, -0.4, -0.95]] }, { hit: true }],
  [5.34, { x: -10.0, ...fly(7.9, BRACED), lean: 0.38 }],
  [5.8, { x: -10.1, ...fly(7.85, BRACED) }],
  // Spent. Then he sees what Goku is holding.
  [6.15, { x: -9.8, ...fly(7.6, HOVER), lean: 0.3, headPitch: 0.4, hands: [[0.6, -0.3, -1.1], [0.6, 0.3, -1.1]] }],
  [6.7, { lean: -0.12, headPitch: 0, hands: [[0.3, -0.8, -0.8], [0.3, 0.8, -0.8]] }],
  // Charges again, harder.
  [7.2, { ...fly(7.6, COILED), lean: 0.25, twist: -0.9, headPitch: 0.1, hands: CUPPED }],
  [8.26, { x: -9.9, lean: 0.3, twist: -1.1 }],
  [T.refire, { x: -9.3, ...fly(7.6, BRACED), lean: 0.35, twist: 0, hands: THRUST }, { hit: true }],
  [8.56, { x: -9.9, lean: 0.25 }],
  // Arms locked through the struggle: gaining, losing.
  [9.35, { x: -9.4, lean: 0.5 }],
  [9.95, { x: -10.0, lean: 0.2 }],
  [10.35, { x: -9.7, lean: 0.4 }],
  [10.75, { x: -10.2, ...fly(7.7, BRACED), lean: 0.1 }],
  // It is coming through. He covers his face.
  [11.0, { x: -10.6, ...fly(7.7, [[0.5, -0.3, 2.0], [0.2, 0.3, 2.4]]), lean: -0.25, headPitch: -0.2 }],
  [11.25, { x: -10.9, lean: -0.5, hands: [[0.6, 0.35, 0.5], [0.6, -0.35, 0.3]] }],
  [11.5, {}, { stop: true }],
]);

/** What falls out of the smoke. */
const WRECK_KEYS = track([
  // Dropping on his back, limbs trailing above him.
  [11.82, { x: -9.6, z: -0.25, yaw: 0, ...fly(6.8, [[1.3, -0.4, -1.6], [1.0, 0.4, -1.2]]), lean: -1.15, headPitch: -1.0, hands: [[0.5, -0.7, 1.3], [0.3, 0.7, 1.2]] }],
  [T.thud, { x: -8.4, ...land(0.55, [[1.9, -0.5, 1.5], [1.7, 0.5, 1.9]]), lean: -1.42, headPitch: -1.3, toeLift: [0.5, 0.5], hands: [[-0.2, -1.3, -0.1], [-0.3, 1.3, 0]] }, { hit: true }],
  // One bounce.
  [12.45, { x: -8.2, hip: 0.95, feet: [[1.6, -0.5, 2.3], [1.4, 0.5, 2.6]] }],
  // Flat out: one leg left sticking up.
  [12.64, { x: -8.1, hip: 0.45, lean: -1.5, feet: [[2.7, -0.6, 0], [1.35, 0.5, 1.7]], toeLift: [0.6, 0.3], hands: [[-0.1, -1.4, -0.3], [-1.2, 0.9, -0.25]] }, { stop: true }],
  [LOOP_SECONDS, {}, { keep: BOTH, stop: true }],
]);

// ── Fighters ────────────────────────────────────────────────────────────

/** 0 → 1 over [a, b], held, and back to 0 over [c, d]. */
const during = (t, a, b, c, d) => smooth(span(t, a, b)) * (1 - smooth(span(t, c, d)));

/** Move a pose's hand toward a world position. */
function handTo(pose, index, point, weight = 1) {
  const { cf, cr, shoulders } = torsoOf(pose);
  const reach = sub(point, shoulders[index]);
  pose.hands[index] = mix3(pose.hands[index], [dot(reach, cf), dot(reach, cr), reach[1]], weight);
}

/** Move a pose's ankle toward a world position. */
function footTo(pose, index, point, weight = 1) {
  pose.plants[index] = mix3(pose.plants[index], [point[0], Math.max(0, point[1] - BODY.ankle), point[2]], weight);
}

/** Lift a flying pose, legs and all. */
function raise(pose, by) {
  pose.hip += by;
  for (const plant of pose.plants) plant[1] = Math.max(0, plant[1] + by);
}

const chestOf = pose => torsoOf(pose).chest;
/** Where the fists meet in the opening clash. */
const KNUCKLES = [0, 4.75, 0];
/** Where the first wave lands: the floor Goku has just left. */
const CRATER = [2.7, 0, 0];

/** Spirit Bomb: its radius, and how far along its path from Goku to Vegeta it has been pushed. */
const BOMB_RADIUS = 3.0;
const BOMB_PATH = [[T.release, 0], [T.meet, 0.36], [9.35, 0.21], [9.95, 0.47], [10.35, 0.31], [T.shove, 0.43], [T.blast, 1.1]];

function bombTravel(t) {
  if (t <= BOMB_PATH[0][0]) return 0;
  const last = BOMB_PATH.length - 1;
  if (t >= BOMB_PATH[last][0]) return BOMB_PATH[last][1];
  let index = 0;
  while (t >= BOMB_PATH[index + 1][0]) index += 1;
  const [t0, s0] = BOMB_PATH[index];
  const [t1, s1] = BOMB_PATH[index + 1];
  const u = (t - t0) / (t1 - t0);
  // Thrown at speed, shoved back and forth, then nothing holds it.
  if (index === 0) return mix(s0, s1, u);
  if (index === last - 1) return mix(s0, s1, Math.pow(u, 2.3));
  return mix(s0, s1, smooth(u));
}

const bombRadius = t => BOMB_RADIUS * (t < T.release
  ? Math.pow(smooth(span(t, T.gather, 8.0)), 0.8)
  : mix(1, 0.9, smooth(span(t, T.release, T.meet))) + 0.22 * smooth(span(t, T.shove, T.blast)));

/** Poses of both fighters at scene time `t`, with contacts and energy poses applied. */
function fightersAt(t) {
  const goku = t < T.vanish ? poseAt(GOKU_OPENING, t) : poseAt(GOKU_KEYS, t);
  const wrecked = t >= 11.6;
  const vegeta = wrecked ? poseAt(WRECK_KEYS, t) : poseAt(VEGETA_KEYS, t);

  // Small signs of life: Vegeta's hover, his rage, Goku's breathing and the bomb's weight.
  if (!wrecked) {
    raise(vegeta, 0.09 * Math.sin(t * 2.6) * (1 - smooth(span(t, 0.7, 1.0)) + smooth(span(t, 3.7, 4.0))));
    const rage = during(t, 3.7, 3.95, 5.1, 5.2) + during(t, 7.0, 7.3, 8.3, 8.4) + during(t, T.meet, T.meet + 0.2, 10.9, 11.1);
    vegeta.x += 0.035 * rage * Math.sin(t * 61);
    vegeta.twist += 0.03 * rage * Math.sin(t * 47);
  } else if (t > 12.7) {
    // The leg in the air twitches in fits.
    const fit = Math.pow(Math.max(0, Math.sin((t - 12.7) * 3.3)), 6);
    vegeta.plants[1][1] += 0.5 * fit * Math.sin(t * 38);
    vegeta.plants[1][0] += 0.2 * fit * Math.sin(t * 38 + 1);
  }
  const strain = during(t, 6.6, 7.6, 8.05, 8.2) + during(t, T.meet, T.meet + 0.2, 11.2, 11.4);
  goku.x += 0.03 * strain * Math.sin(t * 53);
  goku.hip += 0.02 * Math.sin(t * 3.1) * (1 - smooth(span(t, 0.6, 0.9)) + smooth(span(t, 13.9, 14.2)));

  // Two fingers to the brow, then flicked out and held: see you.
  const salute = smooth(span(t, 13.12, 13.52));
  if (salute > 0) {
    const head = solveFigure(goku).head;
    const out = smooth(span(t, 13.64, 13.76));
    handTo(goku, 0, add(head, mix3([0.5, 0.15, 0.45], [1.35, 0.75, 0.5], out)), salute);
    // On the way up the hand swings out in front, so the elbow never folds through the shoulder.
    goku.hands[0][0] += 0.9 * Math.sin(Math.PI * salute);
  }

  // Contact frames: for a moment the striking limb is exactly on its target.
  const fists = during(t, 1.2, T.clash, 1.44, 1.55);
  if (fists > 0) {
    handTo(goku, 1, [KNUCKLES[0] - 0.12, KNUCKLES[1], KNUCKLES[2] + 0.1], fists);
    handTo(vegeta, 0, [KNUCKLES[0] + 0.12, KNUCKLES[1], KNUCKLES[2] - 0.1], fists);
  }
  const upper = during(t, T.upper - 0.07, T.upper, T.upper, T.upper + 0.07);
  if (upper > 0) handTo(goku, 1, add(solveFigure(vegeta).head, [-0.4, -0.35, 0.1]), upper);
  const shin = during(t, T.shin - 0.08, T.shin, T.shin, T.shin + 0.07);
  if (shin > 0) {
    const guard = solveFigure(goku).arms;
    footTo(vegeta, 0, add(mix3(guard[0].hand, guard[1].hand, 0.5), [0.25, 0, 0]), shin);
  }
  const boot = during(t, T.boot - 0.08, T.boot, T.boot, T.boot + 0.07);
  if (boot > 0) footTo(goku, 0, add(chestOf(vegeta), [0.55, -0.3, 0]), boot);

  // Vegeta: both hands round the charge at his hip, then locked along the wave.
  const cup = during(t, 4.02, 4.3, 5.1, T.fire) + during(t, 7.0, 7.3, 8.27, T.refire);
  if (cup > 0) {
    const { f, r } = heading(vegeta.yaw);
    const at = [vegeta.x - 0.6 * f[0] + 0.55 * r[0], vegeta.hip + 0.95, vegeta.z - 0.6 * f[2] + 0.55 * r[2]];
    handTo(vegeta, 1, add(at, mul(f, -0.14)), cup);
    handTo(vegeta, 0, add(at, mul(f, 0.14)), cup);
  }
  return { goku, vegeta, wrecked };
}

/** Lock a pose's arms out along `aim` from the chest, `reach` feet long. */
function lockArms(pose, aim, reach, weight) {
  const { cr, shoulders } = torsoOf(pose);
  for (const index of [0, 1]) {
    const inward = index === 0 ? 0.32 : -0.32;
    handTo(pose, index, add(add(shoulders[index], mul(aim, reach)), mul(cr, inward)), weight);
  }
}

/**
 * The energy in play at `t`, and the arms that hold it. The wave leaves
 * Vegeta's palms along his aim; the bomb hangs over Goku's hands until he
 * throws it, then rides a line between the two of them.
 */
function energyAt(t, goku, vegeta) {
  const energy = { beam: null, bomb: null, orb: null, front: null };
  const chest = chestOf(vegeta);

  // Bomb: over his raised hands, then on its way.
  let bomb = null;
  if (t >= T.gather && t < T.blast) {
    const radius = bombRadius(t);
    const hands = solveFigure(t < T.release ? goku : poseAt(GOKU_KEYS, T.release)).arms;
    const held = add(mix3(hands[0].hand, hands[1].hand, 0.5), [0, radius + 0.55, 0]);
    const away = add(chestOf(poseAt(VEGETA_KEYS, Math.max(t, T.refire))), [1.6, 0.2, 0.25]);
    bomb = { at: mix3(held, away, bombTravel(t)), radius, thrown: t >= T.release };
    energy.bomb = { ...bomb, gather: during(t, T.gather - 0.2, T.gather + 0.3, 7.9, 8.2), age: t - T.gather };
  }

  // First wave: down into the floor where Goku was.
  const first = during(t, T.fire - 0.02, T.fire + 0.02, 5.72, 5.95);
  if (t >= T.fire - 0.12 && t < 6.1) {
    const aim = unit(sub(CRATER, chest));
    lockArms(vegeta, aim, 1.75, during(t, 5.1, T.fire, 5.85, 6.12));
    if (first > 0) {
      const from = add(chest, mul(aim, 2.1));
      energy.beam = { from, to: mix3(from, CRATER, clamp01((t - T.fire) / 0.13)), power: first, width: 1.9, splash: t >= T.crater ? 1 : 0, age: t - T.fire };
    }
  }

  // Second wave: at the bomb, and it stops where the bomb is.
  if (t >= T.refire - 0.12 && t < T.blast + 0.2 && bomb) {
    const aim = unit(sub(bomb.at, chest));
    lockArms(vegeta, aim, mix(1.75, 1.3, smooth(span(t, 10.85, 11.1))), during(t, 8.27, T.refire, 10.95, 11.2));
    if (t >= T.refire) {
      const from = add(chest, mul(aim, 2.1));
      const face = add(bomb.at, mul(unit(sub(from, bomb.at)), bomb.radius * 0.92));
      const met = t >= T.meet;
      energy.beam = {
        from, to: met ? face : mix3(from, face, easeOut(span(t, T.refire, T.meet)) * 0.98),
        power: 1 - smooth(span(t, T.blast - 0.1, T.blast)), width: 2.0 + 0.3 * Math.sin(t * 23), splash: 0, age: t - T.refire,
      };
      if (met) energy.front = { at: face, heat: 0.45 + 0.55 * span(t, T.meet, T.shove), age: t - T.meet };
    }
  }

  // Goku keeps pushing it after it has left his hands.
  const push = during(t, 8.6, 8.8, 11.3, 11.55);
  if (push > 0 && bomb) lockArms(goku, unit(sub(bomb.at, chestOf(goku))), 1.78, push);

  // The charge between Vegeta's palms.
  const charge = Math.max(during(t, 4.2, 5.1, T.fire, T.fire + 0.04), during(t, 7.2, 8.3, T.refire, T.refire + 0.04));
  if (charge > 0) {
    const arms = solveFigure(vegeta).arms;
    energy.orb = { at: mix3(arms[0].hand, arms[1].hand, 0.5), size: charge };
  }
  return energy;
}

/** Both fighters at `t`, posed and holding their energy. */
function stageAt(t) {
  const { goku, vegeta, wrecked } = fightersAt(t);
  const energy = energyAt(t, goku, vegeta);
  return { goku, vegeta, wrecked, energy };
}

// ── Effects timed against the fight ─────────────────────────────────────

const joint = (t, pick) => pick(solveFigure(fightersAt(t).goku), solveFigure(fightersAt(t).vegeta));
/** Star-bursts: [time, where, size in feet]. Never more than three in any second. */
const HITS = [
  [T.clash, KNUCKLES, 1.5],
  [T.upper, joint(T.upper, (g, v) => add(v.head, [-0.3, -0.3, 0.3])), 1.25],
  [T.shin, joint(T.shin, (g, v) => add(v.legs[0].ankle, [-0.2, 0, 0.3])), 0.95],
  [T.boot, joint(T.boot, (g, v) => add(v.chest, [0.4, -0.2, 0.3])), 1.6],
  [T.fire, joint(T.fire, (g, v) => add(v.chest, [1.9, -1.2, 0.3])), 1.5],
  [T.refire, joint(T.refire, (g, v) => add(v.chest, [2.2, 0, 0.3])), 1.4],
];
const HIT_SECONDS = 0.24;

/** Camera shake: [time, strength in px on a 352 px picture, how fast it dies]. */
const JOLTS = [
  [T.clash, 3.2, 9], [T.upper, 2.6, 10], [T.shin, 1.6, 12], [T.boot, 5, 7], [T.brake, 1.4, 9],
  [T.fire, 3.4, 8], [T.crater, 5, 4.5], [T.refire, 3, 8], [T.meet, 4, 6], [T.blast, 8.5, 2.4], [T.thud, 2.6, 9],
];

/** Dust: [from, to, where on the floor, size in feet]. */
const DUST = [
  [T.shin + 0.02, 2.6, [-1.7, 0, 0.3], 0.7], [2.24, 2.8, [-3.3, 0, 0.3], 0.9],
  [5.7, 6.3, [7.4, 0, 0.3], 1.0], [5.82, 6.5, [8.3, 0, 0.3], 1.1],
  [9.0, 9.6, [9.9, 0, 0.3], 0.7], [10.0, 10.6, [9.7, 0, 0.3], 0.6], [T.shove, 11.4, [9.8, 0, 0.3], 0.9],
  [T.thud, 13.1, [-8.6, 0, -0.2], 1.9], [12.66, 13.2, [-2.9, 0, 0.3], 0.6],
];

/** Blasts: [time, where, size in feet, seconds it lasts, which energy it is made of]. */
const BLASTS = [
  [T.crater, CRATER, 3.4, 1.15, 'beam'],
  [T.blast, chestOf(fightersAt(T.blast).vegeta), 5.8, 1.6, 'bomb'],
];

/** "!!" over Vegeta: when he sees the bomb, and when it comes through. */
const ALARMS = [[6.62, 7.15], [10.86, 11.28]];

function shakeAt(t) {
  let shake = 0;
  for (const [at, strength, decay] of JOLTS) if (t >= at) shake += strength * Math.exp(-(t - at) * decay);
  // The struggle rattles harder the longer it lasts.
  shake += during(t, T.meet, T.meet + 0.3, T.blast, T.blast + 0.01) * (0.7 + 2.3 * span(t, T.meet, T.blast));
  return shake;
}

function beatAt(t) {
  let beat = BEAT_ORDER[0];
  for (const name of BEAT_ORDER) if (t >= B[name]) beat = name;
  return beat;
}

/** How fast a pose's pelvis is moving, in feet per second. */
const velocity = (now, before, dt) => [(now.x - before.x) / dt, (now.hip - before.hip) / dt, (now.z - before.z) / dt];
const STEP = 1 / 60;
/** After-images trail a fighter moving faster than this many feet per second. */
const BLUR_FROM = 15;

/**
 * @param {number} elapsedMs Milliseconds since the scene began.
 * @returns Frame of the fight in fight space: solved figures, energy and effects. Pure.
 */
export function resolveDragonPlay(elapsedMs) {
  const elapsed = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : 0;
  const loop = Math.floor(elapsed / DRAGON_LOOP_MS);
  const t = fightSeconds((elapsed - loop * DRAGON_LOOP_MS) / 1000);
  const now = stageAt(t);
  const before = fightersAt(Math.max(0, t - STEP));

  // Speed, for hair, speed lines and after-images. The vanish and the swap to
  // the wreck are jumps, not speed.
  const jumped = (t >= T.vanish && t - STEP < T.vanish) || (now.wrecked !== before.wrecked);
  const speeds = {
    goku: jumped || t < STEP ? [0, 0, 0] : velocity(now.goku, before.goku, STEP),
    vegeta: jumped || t < STEP ? [0, 0, 0] : velocity(now.vegeta, before.vegeta, STEP),
  };
  const shown = {
    goku: 1 - during(t, T.vanish - 0.06, T.vanish - 0.03, T.vanish + 0.03, T.vanish + 0.08),
    vegeta: 1 - during(t, T.blast, T.blast + 0.06, 11.84, 11.94),
  };
  const ghosts = [];
  for (const who of ['goku', 'vegeta']) {
    const blur = clamp01((Math.hypot(...speeds[who]) - BLUR_FROM) / 14) * shown[who];
    if (blur <= 0.02) continue;
    for (const [back, strength] of [[0.035, 0.34], [0.07, 0.17]]) {
      const earlier = t - back;
      if (earlier < 0 || (who === 'goku' && earlier < T.vanish && t >= T.vanish) || (who === 'vegeta' && earlier < 11.6 && t >= 11.6)) continue;
      ghosts.push({ who, fig: solveFigure(fightersAt(earlier)[who]), strength: strength * blur });
    }
  }
  // The after-image Vegeta punches: Goku as he stood, flickering out.
  if (t >= T.vanish - 0.05 && t < T.vanish + 0.2) {
    const fade = 1 - span(t, T.vanish - 0.02, T.vanish + 0.2);
    ghosts.push({ who: 'goku', fig: solveFigure(poseAt(GOKU_OPENING, T.vanish - 0.05)), strength: 0.5 * fade * (0.7 + 0.3 * Math.sin(t * 75)) });
  }

  const goku = solveFigure(now.goku);
  const vegeta = solveFigure(now.vegeta);
  const charging = during(t, T.brake - 0.02, T.brake + 0.1, 5.95, 6.4) + 0.35 * during(t, 5.95, 6.4, 7.0, 7.3) + 1.15 * during(t, 7.0, 7.3, 10.9, 11.2);
  return {
    loop, time: t, beat: beatAt(t), goku, vegeta, speeds, shown, ghosts,
    wrecked: now.wrecked,
    beam: now.energy.beam, bomb: now.energy.bomb, orb: now.energy.orb, front: now.energy.front,
    /** Vegeta's aura, with the burst as it lights. */
    aura: charging, flare: t >= T.brake ? Math.exp(-(t - T.brake) * 5) : 0,
    hits: HITS.filter(([at]) => t >= at && t < at + HIT_SECONDS).map(([at, where, size]) => ({ at: where, size, age: (t - at) / HIT_SECONDS, seed: at })),
    blasts: BLASTS.filter(([at, , , lasts]) => t >= at && t < at + lasts).map(([at, where, size, lasts, kind]) => ({ at: where, size, kind, age: t - at, life: (t - at) / lasts })),
    dust: DUST.filter(([from, to]) => t >= from && t < to).map(([from, to, at, size]) => ({ at, size, age: span(t, from, to) })),
    /** The floor the first wave tore up stays torn. */
    crater: t >= T.crater ? { at: CRATER, age: t - T.crater } : null,
    /** The streak between where Goku vanished and where he is next. */
    zip: t >= T.vanish - 0.04 && t < T.vanish + 0.16 ? { from: [-3.8, 4.2, 0.25], to: [-0.6, 4.8, 0.25], age: span(t, T.vanish - 0.04, T.vanish + 0.16) } : null,
    smoke: now.wrecked && t > T.thud ? t - T.thud : -1,
    sigh: t > 13.05 && t < 13.75 ? span(t, 13.05, 13.75) : -1,
    alarm: ALARMS.some(([from, to]) => t >= from && t < to) ? Math.max(...ALARMS.map(([from, to]) => during(t, from, from + 0.08, to - 0.12, to))) : 0,
    shake: shakeAt(t),
    // Later rounds fade in; the first one opens on the stand-off as the scene cuts in.
    fade: Math.min(loop > 0 ? smooth(span(t, 0, 0.22)) : 1, 1 - smooth(span(t, LOOP_SECONDS - 0.32, LOOP_SECONDS - 0.02))),
  };
}
