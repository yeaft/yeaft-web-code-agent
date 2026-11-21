/**
 * Choreography of the basketball waiting animation: four possessions that
 * come round in turn — a crossover and a behind-the-back dribble into a
 * step-back three, a drive to a floater, a hesitation crossover into a long
 * two, and a drive to a layup off the glass — resolved as a pure function of
 * elapsed time. Nothing here keeps state, so any canvas reading the same
 * clock shows the same frame of the same play.
 *
 * The moves run at the speed they are played at, and are written foot by
 * foot: where each foot comes down, when, and what the ball is doing as it
 * does. The foot goes first and the ball follows it.
 *
 * Play space is in feet. The rim's centre is above the origin; +x runs from
 * the ball handler toward the hoop, y is up and +z is to his right. Every
 * possession is laid out along that axis. Where on the arc it happens is
 * `angle`, and the renderer turns the court under the play instead.
 */
import { blend, cycleLength, editable, gait, keyframes, sample } from '../stick/motion.js';
import { heading, solveFigure, torsoOf } from '../stick/rig.js';
import { clamp01, dot, mix, mix3, offset, smooth, span, sub, turn } from '../stick/vec.js';

export const RIM = Object.freeze({ y: 10, radius: 0.75 });
export const BALL_RADIUS = 0.42;
export const DEFENDER_SIZE = 1.05;

const PI = Math.PI;
const GRAVITY = 32.2;
const WALK_SPEED = 3.3;
const STROLL = 0.12;
/** The backboard's face, out from the rim's centre (see court.js). */
const BOARD = 1.25;
/** How long a celebration holds him, and how long the possession lasts after it. */
const PARTY = 1.75;
const OUTRO = 0.9;
/** Seconds he takes to settle from his walk into his stance. */
const SETTLE = 0.26;
const CELEBRATIONS = ['night', 'shimmy', 'point', 'stroll'];

const BOTH = [true, true];
const LEFT = [true, false];
const RIGHT = [false, true];
/** Hands with no ball in them, from the shoulder: the left out in front, the right at his side. */
const GUARD = [0.55, -0.5, -0.9];
const REST = [0.5, 0.45, -1.05];
const DOWN = [[0.2, -0.16, -1.62], [0.2, 0.16, -1.62]];
/** The shooting hand held high after the ball has gone. */
const FOLLOW = [0.98, -0.05, 1.5];
/** The arm on the far side of a stride, swung back and then through. */
const BACK = 0.5;
const swung = (side, back) => (back ? [-0.3, side * BACK, -1.0] : [0.6, side * 0.4, -0.8]);

/** Point a hand at a world position. */
function setHand(pose, index, point) {
  const { cf, cr, shoulders } = torsoOf(pose);
  const reach = sub(point, shoulders[index]);
  pose.hands[index] = [dot(reach, cf), dot(reach, cr), reach[1]];
}

/** A point given as [forward, side, height] from the spot under the pelvis. */
function fromFloor(pose, [forward, side, height]) {
  const { f, r } = heading(pose.yaw);
  return offset([pose.x, 0, pose.z], f, forward, r, side, height);
}

/** Turn his head toward a spot on the floor, as far as a neck turns. */
function look(pose, x, z, weight) {
  if (weight <= 0) return;
  const want = Math.atan2(z - pose.z, x - pose.x) - pose.yaw - pose.twist;
  const neck = Math.max(-1.15, Math.min(1.15, Math.atan2(Math.sin(want), Math.cos(want))));
  pose.headYaw = mix(pose.headYaw, neck, weight);
}

/** Height off the floor at `t` for jumps given as [takes off, lands, height]. */
function airborne(jumps, t) {
  let height = 0;
  for (const [from, to, peak] of jumps || []) {
    const u = span(t, from, to);
    height += peak * 4 * u * (1 - u);
  }
  return height;
}

function lifted(pose, air) {
  if (air <= 0) return;
  pose.hip += air * 0.94;
  for (const plant of pose.plants) plant[1] += air;
}

/**
 * Keyframes written by where the feet go. A row is [time, changes, options]
 * as `keyframes` takes them, except that a foot is put down with `L` or `R`
 * as world [x, z, lift]. A foot a row does not name stays where it is, so a
 * row reads as the step it is.
 */
function course(rows) {
  let at = { x: 0, z: 0, yaw: 0 };
  const plants = [[0, -0.33, 0], [0, 0.33, 0]];
  return keyframes(rows.map(([t, { L, R, ...changes }, options = {}]) => {
    at = { ...at, ...changes };
    [L, R].forEach((plant, foot) => {
      if (plant) plants[foot] = [plant[0], plant[1], plant[2] || 0];
    });
    const { f, r } = heading(at.yaw);
    const feet = plants.map(([x, z, lift]) => [(x - at.x) * f[0] + (z - at.z) * f[2], (x - at.x) * r[0] + (z - at.z) * r[2], lift]);
    return [t, { ...changes, feet }, { ...options, keep: options.keep || [!L, !R] }];
  }));
}

/** Rows for a figure facing straight up or down the court, swapped left for right. */
function mirrored(rows) {
  const swap = pair => [pair[1], pair[0]];
  return rows.map(([t, changes, options = {}]) => {
    const flipped = { ...changes };
    for (const name of ['z', 'sway', 'twist', 'headYaw', 'headRoll']) if (name in flipped) flipped[name] = -flipped[name];
    for (const name of ['feet', 'hands']) if (flipped[name]) flipped[name] = swap(flipped[name]).map(([forward, side, up]) => [forward, -side, up]);
    if (flipped.toeLift) flipped.toeLift = swap(flipped.toeLift);
    return [t, flipped, { ...options, ...(options.keep && { keep: swap(options.keep) }), ...(options.slide && { slide: swap(options.slide) }) }];
  });
}

/** A sprint along [time, x, z, heading] rows, with the distance run so far added to each. */
function trail(rows, pace = 0.9) {
  let run = 0;
  const path = rows.map((row, i) => {
    if (i > 0) run += Math.hypot(row[1] - rows[i - 1][1], row[2] - rows[i - 1][2]);
    return [...row, run];
  });
  return { path, pace, from: rows[0][0], to: rows[rows.length - 1][0] };
}

function sprint({ path, pace }, t) {
  let index = 1;
  while (index < path.length - 1 && t >= path[index][0]) index += 1;
  const a = path[index - 1];
  const b = path[index];
  const u = span(t, a[0], b[0]);
  return gait(mix(a[1], b[1], u), mix(a[2], b[2], u), mix(a[3], b[3], u), mix(a[4], b[4], u) / cycleLength(pace), pace);
}

// ── The four possessions ──────────────────────────────────────────────────
//
// Each is: where he brings the ball up from and to (`from`, `spot`), when he
// gets there (`sizeup`) and makes his move (`move`); his feet and body
// (`hero`) and jumps; the dribble as `touches`; where the held ball sits
// (`hold`, from his chest), which hand shoots it and when it leaves; and his
// defender. `side` is which sideline the camera watches the move from.
//
// A touch is when the ball is in which hand (0 left, 1 right) and where, as
// [forward, side, height] from the spot under his pelvis. Between two touches
// it bounces once off `floor`, or with `carry` stays in the hand. The last
// touch is where he picks it up.

/** Defender walking up into his stance, `x` feet out, by the time the ball arrives. */
const closeOut = (at, x) => [
  [0, { x: x + 2.8, z: -0.5, yaw: PI, hip: 2.95, lean: 0.2, feet: [[0.1, -0.6, 0], [-0.1, 0.6, 0]], hands: [[0.35, -0.35, -1.3], [0.35, 0.35, -1.3]] }],
  [at - 0.95, {}, { stop: true }],
  [at - 0.45, { x: x + 1.6, z: -0.25, hip: 2.9, lean: 0.28, feet: [[0.8, -0.8, 0], [-0.4, 0.6, 0]], hands: [[0.6, -0.6, -0.9], [0.6, 0.45, -0.7]] }, { keep: RIGHT }],
  [at, { x, z: 0, hip: 2.55, lean: 0.42, feet: [[0.12, -1.05, 0], [-0.12, 1.05, 0]], hands: [[0.75, -0.75, -0.55], [0.85, 0.45, -0.15]] }, { keep: LEFT }],
];

/**
 * Crossover, behind the back, step-back three: the possession the others are
 * measured against. He is low and wide the whole way, the ball below his
 * knees. A jab right and the ball back across; his man reaches, so he drops
 * a foot and takes it round behind his back, turning square to the sideline.
 * A beat with the ball in front of him. Then he sells it back toward the rim,
 * wraps it behind him again and is gone the other way: his man, on his heels,
 * sits down. Two long strides out past the line with the ball in his far
 * hand, the right foot brakes, he turns on it, and the shot is away almost
 * before the left foot is down.
 *
 * Timed from footage of him doing exactly this, at four-fifths speed: a
 * dribble every 0.36 s, and 0.4 s from picking the ball up to letting it go.
 */
const STEPBACK = {
  name: 'stepback', worth: 3, angles: [0, -0.45, 0.4], side: 1,
  from: -28.4, spot: [-20.4, 0], sizeup: 1.5, move: 2.2,
  hero: course([
    [1.5, { x: -20.4, z: 0, yaw: 0, hip: 2.42, lean: 0.74, twist: 0.12, headPitch: 0.05, L: [-19.95, -1.0], R: [-20.85, 1.0], hands: [GUARD, REST] }],
    [1.86, { hip: 2.34, lean: 0.78 }],
    // The foot goes first: a jab out to his right, and the ball pounded outside it.
    [2.06, { x: -20.25, z: 0.5, yaw: 0.12, hip: 2.3, lean: 0.76, sway: 0.24, twist: 0.2, R: [-20.3, 1.6] }],
    [2.2, { z: 0.6, sway: 0.28 }],
    // Off that foot, and the ball comes back across below his knees.
    [2.36, { x: -20.2, z: -0.05, yaw: -0.08, hip: 2.26, lean: 0.8, sway: -0.04, twist: -0.1 }],
    [2.5, { x: -20.1, z: -0.65, yaw: -0.22, hip: 2.34, lean: 0.74, sway: -0.28, twist: -0.25, L: [-19.8, -1.9] }],
    // His man reaches. He drops the right foot back and takes the ball with him.
    [2.7, { x: -20.55, z: -0.8, yaw: -0.05, hip: 2.44, lean: 0.66, sway: -0.1, twist: 0, R: [-21.35, 0.15] }],
    [2.88, { x: -20.9, z: -0.65, yaw: 0.3, hip: 2.42, lean: 0.62, sway: 0, twist: 0.2, L: [-20.55, -1.55] }],
    // Behind the back: he turns on the left foot, square to the sideline, and the ball goes round behind his hips.
    [3.06, { x: -21.25, z: -1.0, yaw: 0.85, hip: 2.38, lean: 0.58, sway: 0.1, twist: 0.25, R: [-22.35, -1.3] }],
    [3.26, { x: -21.45, z: -1.25, yaw: 1.3, hip: 2.38, lean: 0.68, sway: 0, twist: 0.1, L: [-20.5, -1.15] }],
    // A beat, the ball low in front of him, and his man comes again.
    [3.44, { yaw: 1.4, hip: 2.5, lean: 0.6 }],
    [3.62, { x: -21.4, hip: 2.4, lean: 0.68 }],
    // Sells it back toward the rim: a step with the left foot, the ball across to his left hand...
    [3.8, { x: -21.05, z: -1.2, yaw: 1.25, hip: 2.3, lean: 0.74, sway: -0.26, twist: -0.2, L: [-19.85, -0.95] }],
    [3.98, { x: -20.9, sway: -0.3 }],
    // ...and round behind his back again as he pushes off it, away from everyone.
    [4.16, { x: -21.8, z: -1.15, yaw: 1.5, hip: 2.36, lean: 0.6, sway: 0.3, twist: 0.25, R: [-23.3, -1.1] }],
    [4.4, { x: -23.15, z: -1.0, yaw: 1.9, hip: 2.5, lean: 0.5, sway: 0.26, twist: -0.25, L: [-23.95, -0.55] }],
    // The right foot brakes and he turns on it to face the rim...
    [4.64, { x: -24.35, z: -0.95, yaw: 1.2, hip: 2.46, lean: 0.48, sway: 0.12, twist: -0.2, R: [-25.15, -0.9] }],
    // ...the left comes round under him, then the right is set: feet narrow, turned as he likes them.
    [4.86, { x: -24.95, z: -1.05, yaw: 0.15, hip: 2.56, lean: 0.38, sway: 0, twist: 0, toes: [-0.32, -0.1], L: [-25.25, -1.45] }],
    [5.0, { x: -25.02, yaw: 0, hip: 2.54, lean: 0.32, R: [-24.85, -0.6] }, { slide: RIGHT }],
    // A shallow dip and one motion up through the ball. It is gone on the way up, and he drifts back.
    [5.14, { hip: 2.48, lean: 0.28 }],
    [5.3, { hip: 3.22, lean: 0.06, headPitch: -0.12 }],
    [5.56, { x: -25.2, lean: -0.08, hands: [[0.55, -0.1, 0.9], FOLLOW] }],
    [5.8, { x: -25.45, hip: 3.0, lean: 0.06, L: [-25.7, -1.45], R: [-25.3, -0.6], hands: [[0.5, -0.12, 0.6], FOLLOW] }, { slide: BOTH }],
    [6.22, { hip: 3.16, lean: 0.05, headPitch: 0, hands: [[0.2, -0.14, -1.6], [0.7, 0.1, 0.6]] }],
  ]),
  jumps: [[5.28, 5.78, 1.0]],
  touches: [
    { t: 1.5, hand: 1, at: [0.8, 1.0, 1.55], floor: [0.95, 1.05] },
    { t: 1.86, hand: 1, at: [0.8, 1.0, 1.55], floor: [0.95, 1.05] },
    { t: 2.2, hand: 1, at: [0.9, 1.3, 1.45], floor: [1.0, 1.4] },       // pounded outside the right foot
    { t: 2.5, hand: 0, at: [0.75, -0.95, 1.4], floor: [1.0, 0.1] },     // crossed over, below the knees
    { t: 2.88, hand: 0, at: [0.25, -1.0, 1.7], floor: [0.45, -1.1] },   // pulled back with him
    { t: 3.26, hand: 1, at: [0.3, 0.95, 1.6], floor: [-0.85, 0] },      // round behind his back
    { t: 3.62, hand: 1, at: [0.85, 0.5, 1.55], floor: [0.9, 0.75] },    // low in front of him
    { t: 3.98, hand: 0, at: [0.8, -0.85, 1.45], floor: [1.05, -0.1] },  // across again, toward the rim
    { t: 4.34, hand: 1, at: [0.25, 1.15, 1.7], floor: [-0.8, 0.1] },    // behind his back as he goes
    { t: 4.7, hand: 1, at: [0.45, 1.2, 2.2], floor: [0.5, 1.5] },       // pushed out wide in his far hand
    { t: 5.0, hand: 1, at: [0.4, 0.55, 2.3], floor: [0.6, 0.9] },       // picked up at his right hip
  ],
  // From the hip, up past his chest to his forehead, and away.
  hold: [[5.0, [0.5, 0.5, -1.15]], [5.14, [0.7, 0.28, -0.8]], [5.3, [0.5, 0.36, 0.78]], [5.42, [0.82, 0.34, 1.55]]],
  shooter: 1, release: 5.42, flight: 1.35, walk: 6.08,
  defender: keyframes([
    ...closeOut(1.5, -16.0),
    [1.9, {}, { keep: BOTH }],
    // Slides with the jab, half a beat late.
    [2.24, { z: 0.6, sway: -0.14, feet: [[-0.05, -1.4, 0], [0.1, 0.7, 0]] }, { keep: RIGHT }],
    // The ball comes back across and he goes after it: back the other way, then a lunge with his right hand.
    [2.42, { z: 0.15, sway: 0.1, feet: [[0, -0.75, 0], [0.05, 1.2, 0]] }, { keep: RIGHT }],
    [2.6, { x: -16.35, z: -0.45, lean: 0.42, sway: 0.2, feet: [[0, -0.55, 0], [0.05, 1.3, 0]], hands: [[0.7, -0.6, -0.5], [0.95, 0.5, -0.5]] }, { keep: LEFT }],
    [2.82, { x: -17.0, z: -1.0, hip: 2.36, lean: 0.56, sway: 0.28, feet: [[-0.6, -0.9, 0], [0.95, 0.5, 0]], hands: [[0.4, -0.7, -0.7], [1.5, 0.25, -1.0]] }, { keep: LEFT }],
    // Nothing there. He stumbles on a step and pulls himself up.
    [3.1, { x: -17.6, z: -1.3, hip: 2.62, lean: 0.4, sway: 0.05, feet: [[0.55, -0.55, 0], [-0.35, 0.6, 0]], hands: [[0.7, -0.7, -0.3], [0.8, 0.5, -0.6]] }, { keep: RIGHT }],
    // Squares up again, a little closer than is wise.
    [3.5, { x: -17.85, z: -1.25, hip: 2.5, lean: 0.42, sway: 0, feet: [[0.1, -1.05, 0], [-0.1, 1.05, 0]], hands: [[0.75, -0.75, -0.55], [0.85, 0.45, -0.25]] }],
    // The ball is shown to him and he gives ground, onto his heels.
    [3.8, { x: -17.45, hip: 2.56, lean: 0.28, feet: [[-0.45, -0.8, 0], [0.25, 0.85, 0]], hands: [[0.8, -0.7, -0.2], [0.8, 0.6, -0.3]] }, { keep: RIGHT }],
    [3.98, { x: -17.15, hip: 2.6, lean: 0.16, feet: [[-0.15, -0.8, 0], [-0.5, 0.8, 0]] }, { keep: LEFT }],
    // It was never coming. Written with left and right swapped, as the fall was first drawn, then mirrored.
    ...mirrored([
      // He goes to come forward off his heels and the front foot skids out from under him.
      [4.1, { x: -17.15, z: 1.3, hip: 2.3, lean: 0.1, sway: 0.1, twist: 0.3, headYaw: 0.2, feet: [[1.0, -0.6, 0], [-0.35, 0.5, 0.15]], hands: [[0.3, -1.0, 0.7], [0.4, 1.2, 0.5]] }, { slide: LEFT }],
      [4.24, { x: -16.95, z: 1.35, hip: 2.05, lean: -0.22, sway: 0.15, twist: 0.4, headYaw: 0.3, feet: [[1.6, -0.6, 0], [0.1, 0.45, 0.3]], hands: [[0.2, -1.1, 1.25], [0.45, 1.15, 1.3]] }, { slide: LEFT }],
      [4.4, { x: -16.7, z: 1.4, hip: 1.45, lean: -0.6, sway: 0.1, twist: 0.3, headYaw: 0.2, headPitch: -0.2, feet: [[1.55, -0.6, 0.35], [1.2, 0.5, 0.95]], toeLift: [0.3, 0.5], hands: [[-0.5, -1.0, 0.3], [-0.6, 1.0, 0.5]] }],
      // Lands on his backside with his feet in the air.
      [4.58, { x: -16.45, z: 1.45, hip: 0.62, lean: -0.78, sway: 0, twist: 0, feet: [[1.7, -0.5, 1.25], [1.6, 0.5, 1.7]], toeLift: [0.6, 0.6], hands: [[-0.75, -0.7, -1.55], [-0.75, 0.7, -1.55]] }, { stop: true }],
      // Sits up, one hand out toward the shooter.
      [4.86, { x: -16.35, z: 1.5, hip: 0.6, lean: -0.5, headYaw: 0.1, headPitch: 0, feet: [[2.0, -0.55, 0.05], [1.55, 0.6, 0.5]], toeLift: [0.5, 0.2], hands: [[-0.7, -0.6, -1.4], [0.85, 0.2, 0.75]] }],
      [5.42, { hands: [[-0.7, -0.6, -1.4], [0.9, 0.1, 1.0]] }, { keep: BOTH }],
      // Watches it over his shoulder.
      [6.0, { twist: 0.55, headYaw: 1.45, headPitch: -0.38, hands: [[-0.7, -0.6, -1.4], [0.6, 0.4, -0.6]] }, { keep: BOTH }],
      [6.87, {}, { keep: BOTH, stop: true }],
      // Head in his hand.
      [7.42, { lean: -0.15, twist: 0, headYaw: 0.2, headPitch: 0.62, hands: [[-0.5, -0.5, -1.5], [0.3, -0.32, 0.74]] }, { keep: BOTH }],
    ]),
  ]),
  beaten: 4.0, skid: [4.1, 1], seat: 4.58,
  stills: [1.9, 2.5, 3.2, 4.45, 5.49, 7.02, 7.95],
};

/**
 * Drive and floater. A jab to his left, then past his man on the right with
 * the ball pushed out ahead: four long strides, two more with the ball in
 * his hands, and up off the left foot to float it high over the trailing hand.
 */
const FLOATER = {
  name: 'floater', worth: 2, angles: [0.25, -0.3], side: 1,
  from: -32.5, spot: [-25, 0], sizeup: 1.4, move: 2.0,
  hero: course([
    [1.4, { x: -25, z: 0, yaw: 0, hip: 2.48, lean: 0.66, twist: 0.1, L: [-24.6, -0.95], R: [-25.4, 0.95], hands: [GUARD, REST] }],
    [1.8, { z: -0.1, hip: 2.4, lean: 0.7 }],
    // Jab left: head and shoulders go, the ball stays home.
    [2.04, { x: -24.85, z: -0.6, yaw: -0.2, hip: 2.36, lean: 0.7, sway: -0.3, twist: -0.25, L: [-24.4, -1.8] }],
    // Off that foot and past him on the right: a long first step, the ball pushed out ahead.
    [2.3, { x: -23.7, z: 0.85, yaw: 0.3, hip: 2.4, lean: 0.68, sway: 0.2, twist: 0.25, R: [-22.5, 1.85], L: [-24.2, -0.9, 0.3], hands: [swung(-1, true), REST] }],
    [2.56, { x: -21.1, z: 1.95, yaw: 0.12, hip: 2.5, lean: 0.64, sway: 0, twist: -0.15, L: [-19.7, 2.05], hands: [swung(-1, false), REST] }],
    [2.8, { x: -18.3, z: 2.3, yaw: 0, hip: 2.6, lean: 0.56, twist: 0.15, R: [-16.8, 2.75], hands: [swung(-1, true), REST] }],
    [3.04, { x: -15.4, z: 2.2, yaw: -0.08, hip: 2.62, lean: 0.5, twist: -0.12, L: [-13.9, 1.75], hands: [swung(-1, false), REST] }],
    // Two steps with the ball in his hands, and up off the left foot with the right knee driving.
    [3.28, { x: -12.7, z: 1.8, yaw: -0.12, hip: 2.6, lean: 0.4, twist: 0.1, R: [-11.4, 2.0] }],
    [3.5, { x: -10.5, z: 1.35, hip: 2.5, lean: 0.3, twist: 0, L: [-9.5, 0.85] }],
    [3.66, { x: -9.6, z: 1.15, hip: 2.95, lean: 0.16, headPitch: -0.15, R: [-9.0, 1.55, 1.0], hands: [[0.5, -0.6, -0.3], [0.7, 0.15, 1.7]] }],
    [3.92, { x: -8.5, z: 1.0, hip: 3.1, lean: 0.04, L: [-9.0, 0.7, 0.3], R: [-8.0, 1.35, 0.8] }],
    [4.26, { x: -7.2, z: 0.85, hip: 2.72, lean: 0.26, headPitch: 0, L: [-7.0, 0.45], R: [-7.45, 1.25], hands: [[0.45, -0.45, -0.7], [0.6, 0.3, 0.6]] }],
    [4.56, { x: -6.7, hip: 3.08, lean: 0.1, hands: DOWN }],
  ]),
  jumps: [[3.66, 4.26, 1.4]],
  touches: [
    { t: 1.4, hand: 1, at: [0.8, 1.0, 1.6], floor: [0.95, 1.05] },
    { t: 1.8, hand: 1, at: [0.8, 1.0, 1.6], floor: [0.95, 1.05] },
    { t: 2.16, hand: 1, at: [0.55, 1.0, 1.6], floor: [0.7, 1.1] },
    { t: 2.5, hand: 1, at: [1.3, 0.95, 2.0], floor: [2.2, 1.05] },      // pushed out ahead of the first step
    { t: 2.82, hand: 1, at: [1.2, 0.9, 2.2], floor: [2.2, 0.95] },
    { t: 3.14, hand: 1, at: [1.0, 0.7, 2.5], floor: [2.0, 0.9] },
  ],
  hold: [[3.34, [0.6, 0.3, -0.5]], [3.52, [0.55, 0.4, -0.15]], [3.72, [0.5, 0.5, 0.8]], [3.88, [0.72, 0.42, 1.75]]],
  shooter: 1, guideOff: 3.6, release: 3.88, flight: 0.98, walk: 4.6,
  defender: keyframes([
    ...closeOut(1.4, -20.9),
    [1.95, {}, { keep: BOTH }],
    // Bites on the jab.
    [2.14, { z: -0.6, sway: 0.15, feet: [[0.1, -0.8, 0], [-0.05, 1.4, 0]] }, { keep: LEFT }],
    // Beaten: opens up and reaches as the ball goes by, then turns and runs.
    [2.36, { x: -21.1, z: -0.3, yaw: PI - 0.7, hip: 2.7, lean: 0.3, sway: 0, twist: -0.4, feet: [[0.3, -0.9, 0.2], [-0.2, 0.7, 0]], hands: [[0.8, -0.9, -0.2], [0.4, 0.4, -0.9]] }],
    // Gets there late and goes up behind the shot.
    [3.7, { x: -11.4, z: 0.1, yaw: 0.05, hip: 2.85, lean: 0.28, twist: 0, feet: [[0.5, -0.3, 0], [-0.5, 0.3, 0]], hands: [[0.9, -0.2, 1.3], [0.3, 0.3, -0.8]] }],
    [3.98, { x: -10.6, z: -0.5, hip: 3.2, lean: 0.2, headPitch: -0.3, feet: [[0.2, -0.3, 0], [-0.3, 0.3, 0]], hands: [[0.9, -0.1, 1.85], [0.3, 0.3, -0.6]] }],
    [4.3, { x: -10.1, z: -1.4, hip: 2.8, lean: 0.3, feet: [[0.3, -0.35, 0], [-0.3, 0.35, 0]], hands: [[0.4, -0.3, -0.9], [0.4, 0.3, -0.9]] }],
    // Drifts out of the lane and watches it drop.
    [4.9, { x: -10.4, z: -2.7, hip: 3.12, lean: 0.1, feet: [[0.1, -0.35, 0], [-0.1, 0.35, 0]] }, { stop: true }],
    // Hands on his hips.
    [5.5, { headPitch: 0.5, hands: [[-0.1, -0.45, -1.1], [-0.1, 0.45, -1.1]] }, { keep: BOTH }],
  ]),
  chase: trail([[2.36, -21.1, -0.3, 1.9], [2.62, -20.3, 0.7, 0.6], [3.0, -18.2, 1.0, 0.1], [3.4, -13.9, 0.3, -0.05], [3.68, -11.6, 0.1, 0]]),
  leaps: [[3.74, 4.24, 0.85]], beaten: 2.3,
  stills: [2.7, 3.92, 4.98],
};

/**
 * Hesitation crossover, pull-up from the elbow. He comes up tall with the
 * ball riding up in his hand and his man leaves the floor; down and across
 * below the knees, two long strides left, a one-two stop and a quick shot
 * with both hands left up high after it.
 */
const LONG_TWO = {
  name: 'longtwo', worth: 2, angles: [-0.4, 0.35, 0], side: 1,
  from: -32.5, spot: [-25, 0], sizeup: 1.4, move: 2.2,
  hero: course([
    [1.4, { x: -25, z: 0, yaw: 0, hip: 2.56, lean: 0.58, twist: 0.1, L: [-24.65, -0.9], R: [-25.35, 0.9], hands: [GUARD, REST] }],
    [1.8, { z: 0.12, hip: 2.46, lean: 0.64 }],
    [2.2, { z: 0, hip: 2.52 }],
    // The hesitation: up tall, eyes on the rim.
    [2.44, { x: -24.9, hip: 3.04, lean: 0.12, headPitch: -0.12 }],
    // Drops and crosses over; the left foot reaches out wide.
    [2.62, { x: -24.55, z: -0.55, yaw: -0.25, hip: 2.4, lean: 0.62, sway: -0.26, twist: -0.2, headPitch: 0, L: [-23.7, -1.9] }],
    // Off the right foot: long and low.
    [2.88, { x: -22.75, z: -1.85, yaw: -0.28, hip: 2.5, lean: 0.56, sway: -0.08, twist: 0.15, R: [-21.45, -2.2], hands: [GUARD, swung(1, true)] }],
    // Up out of the drive into a one-two stop, left then right, feet turned as he likes them.
    [3.14, { x: -20.9, z: -2.55, yaw: -0.15, hip: 2.76, lean: 0.36, sway: 0, twist: -0.1, L: [-19.75, -3.05], hands: [GUARD, swung(1, false)] }],
    [3.36, { x: -19.68, z: -2.62, yaw: 0.08, hip: 2.6, lean: 0.28, twist: 0, toes: [-0.32, -0.1], R: [-19.5, -2.2] }],
    [3.5, { hip: 2.52, lean: 0.28 }],
    [3.66, { hip: 3.22, lean: 0.06, headPitch: -0.12 }],
    [3.92, { x: -19.58, lean: 0, L: [-19.65, -3.05], R: [-19.4, -2.2], hands: [[0.6, -0.12, 1.25], FOLLOW] }, { slide: BOTH }],
    [4.16, { x: -19.43, hip: 3.0, lean: 0.08, L: [-19.5, -3.05], R: [-19.25, -2.2], hands: [[0.55, -0.15, 1.0], FOLLOW] }, { slide: BOTH }],
    [4.36, { hip: 3.16, lean: 0.05, headPitch: 0, hands: [[0.3, -0.14, -1.2], [0.6, 0.1, 0.2]] }],
  ]),
  jumps: [[3.64, 4.14, 0.95]],
  touches: [
    { t: 1.4, hand: 1, at: [0.75, 0.95, 1.7], floor: [0.9, 1.0] },
    { t: 1.8, hand: 1, at: [0.75, 0.95, 1.7], floor: [0.9, 1.0] },
    { t: 2.2, hand: 1, at: [0.75, 0.95, 1.7], floor: [0.9, 1.0] },
    { t: 2.44, hand: 1, at: [0.65, 0.7, 3.05], carry: true },            // rides up with the hesitation
    { t: 2.74, hand: 0, at: [0.75, -0.9, 1.8], floor: [1.0, 0.1] },     // crossed over, low
    { t: 3.0, hand: 0, at: [1.1, -0.85, 2.2], floor: [2.1, -0.95] },
    { t: 3.24, hand: 0, at: [0.7, -0.6, 2.6], floor: [1.6, -0.8] },
  ],
  hold: [[3.42, [0.7, 0.12, -0.6]], [3.5, [0.72, 0.2, -0.78]], [3.66, [0.5, 0.36, 0.78]], [3.78, [0.82, 0.34, 1.55]]],
  shooter: 1, release: 3.78, flight: 1.15, walk: 4.4,
  defender: keyframes([
    ...closeOut(1.4, -21.0),
    [2.2, { hip: 2.45, lean: 0.45 }, { keep: BOTH }],
    // Bites on the hesitation: up off the floor with both arms.
    [2.42, { hip: 2.78, lean: 0.25, hands: [[0.7, -0.4, 0.6], [0.7, 0.4, 0.8]] }, { keep: BOTH }],
    [2.66, { x: -21.3, hip: 3.2, lean: 0.12, feet: [[0.1, -0.45, 0], [0, 0.45, 0]], hands: [[0.55, -0.35, 1.75], [0.55, 0.3, 1.85]] }],
    // Lands looking over his shoulder at where the ball went, turns and lunges after it.
    [3.0, { x: -21.5, z: -0.3, yaw: PI + 0.5, hip: 2.7, lean: 0.3, headYaw: 0.6, feet: [[0.1, -0.5, 0], [-0.1, 0.5, 0]], hands: [[0.5, -0.5, 0.2], [0.5, 0.5, 0.4]] }],
    [3.3, { x: -21.6, z: -1.9, yaw: PI + 1.5, hip: 2.8, lean: 0.4, headYaw: 0.3, feet: [[0.8, -0.3, 0], [-0.6, 0.3, 0.3]], hands: [[0.5, -0.3, -0.9], [-0.2, 0.4, -1.0]] }],
    [3.62, { x: -21.5, z: -3.6, yaw: 2 * PI - 0.1, lean: 0.42, headYaw: 0, feet: [[-0.6, -0.3, 0.2], [0.9, 0.3, 0]], hands: [[0.3, -0.3, -0.9], [0.9, 0.2, 1.3]] }],
    // Comes round behind him with a hand up, too late.
    [3.9, { x: -21.0, z: -4.3, yaw: 2 * PI + 0.75, hip: 3.0, lean: 0.3, headPitch: -0.3, feet: [[0.4, -0.3, 0], [-0.4, 0.3, 0]], hands: [[0.3, -0.3, -0.9], [0.85, 0.1, 1.75]] }],
    [4.4, { lean: 0.15, hands: [[0.3, -0.3, -1.3], [0.4, 0.3, -1.2]] }, { keep: BOTH, stop: true }],
    [5.5, { headPitch: 0.5, hands: [[-0.1, -0.45, -1.1], [-0.1, 0.45, -1.1]] }, { keep: BOTH }],
  ]),
  leaps: [[2.46, 2.9, 0.55]], beaten: 2.4,
  stills: [2.44, 3.83],
};

/**
 * Drive and layup. The same hesitation, the same crossover, but he keeps
 * going: two left-hand dribbles down the lane, the ball picked up, a step
 * and a long second step, and up off the right foot to lay it high off the
 * glass with his left hand.
 */
const LAYUP = {
  name: 'layup', worth: 2, angles: [-0.55, 0.55], side: -1,
  from: -31.5, spot: [-24.2, 0], sizeup: 1.4, move: 2.0,
  hero: course([
    [1.4, { x: -24.2, z: 0, yaw: 0, hip: 2.48, lean: 0.66, twist: 0.1, L: [-23.8, -0.95], R: [-24.6, 0.95], hands: [GUARD, REST] }],
    [1.8, { hip: 2.4, lean: 0.7 }],
    [2.1, { x: -24.1, hip: 3.0, lean: 0.14, headPitch: -0.1 }],
    [2.32, { x: -23.8, z: -0.6, yaw: -0.28, hip: 2.38, lean: 0.62, sway: -0.26, twist: -0.2, headPitch: 0, L: [-22.9, -1.95] }],
    [2.58, { x: -21.6, z: -1.9, yaw: -0.2, hip: 2.45, lean: 0.66, sway: -0.08, twist: 0.15, R: [-19.9, -2.2], hands: [GUARD, swung(1, true)] }],
    [2.82, { x: -18.3, z: -2.5, yaw: -0.06, hip: 2.55, lean: 0.6, sway: 0, twist: -0.15, L: [-16.6, -2.95], hands: [GUARD, swung(1, false)] }],
    [3.06, { x: -15.0, z: -2.65, yaw: 0, hip: 2.6, lean: 0.55, twist: 0.15, R: [-13.3, -2.35], hands: [GUARD, swung(1, true)] }],
    // The ball is in his hands: a step, a long second step, and up off the right foot.
    [3.3, { x: -11.7, z: -2.6, hip: 2.6, lean: 0.45, twist: -0.1, L: [-10.0, -2.9], hands: [GUARD, swung(1, false)] }],
    [3.54, { x: -8.3, z: -2.45, hip: 2.5, lean: 0.34, twist: 0.1, R: [-6.6, -2.15] }],
    [3.68, { x: -6.9, z: -2.3, hip: 3.0, lean: 0.18, headPitch: -0.2, L: [-6.9, -2.7, 1.3], hands: [[0.65, -0.1, 1.8], [0.45, 0.6, -0.3]] }],
    [3.98, { x: -4.6, z: -2.05, hip: 3.2, lean: 0.02, L: [-4.2, -2.4, 0.4], R: [-5.3, -1.75, 0.5] }],
    [4.36, { x: -1.9, z: -1.95, hip: 2.7, lean: 0.25, headPitch: 0, L: [-1.5, -2.3], R: [-2.7, -1.6], hands: [[0.6, -0.3, 0.5], [0.45, 0.45, -0.7]] }],
    [4.66, { x: -0.9, z: -2.1, hip: 3.06, lean: 0.12, R: [-0.5, -1.8], hands: DOWN }],
  ]),
  jumps: [[3.66, 4.36, 2.0]],
  touches: [
    { t: 1.4, hand: 1, at: [0.8, 1.0, 1.6], floor: [0.95, 1.05] },
    { t: 1.8, hand: 1, at: [0.8, 1.0, 1.6], floor: [0.95, 1.05] },
    { t: 2.1, hand: 1, at: [0.65, 0.75, 2.95], carry: true },            // rides up with the hesitation
    { t: 2.4, hand: 0, at: [0.8, -0.9, 1.8], floor: [1.0, 0.1] },       // crossed over, low
    { t: 2.76, hand: 0, at: [1.3, -0.9, 2.0], floor: [2.3, -1.0] },
    { t: 3.16, hand: 0, at: [1.0, -0.7, 2.5], floor: [2.1, -0.9] },
  ],
  hold: [[3.36, [0.6, -0.25, -0.5]], [3.54, [0.6, -0.35, -0.25]], [3.74, [0.5, -0.5, 0.8]], [3.96, [0.75, -0.38, 1.8]]],
  shooter: 0, guideOff: 3.6, release: 3.96, flight: 0.6, bank: true, walk: 4.75,
  defender: keyframes([
    ...closeOut(1.4, -20.1),
    [1.85, {}, { keep: BOTH }],
    // Comes up with the hesitation.
    [2.1, { x: -20.25, hip: 2.86, lean: 0.25, hands: [[0.7, -0.4, 0.2], [0.7, 0.4, 0.5]] }, { keep: BOTH }],
    // Beaten: opens up and reaches as the ball goes by, then turns and runs.
    [2.38, { x: -20.4, z: 0.2, yaw: PI + 0.7, hip: 2.7, lean: 0.3, twist: 0.4, feet: [[-0.2, -0.7, 0], [0.3, 0.9, 0.2]], hands: [[0.4, -0.4, -0.9], [0.8, 0.9, -0.2]] }],
    // Goes up with him at the rim, a step behind.
    [3.68, { x: -9.4, z: -0.7, yaw: 2 * PI, hip: 2.85, lean: 0.28, twist: 0, feet: [[0.5, -0.3, 0], [-0.5, 0.3, 0]], hands: [[0.3, -0.3, -0.8], [0.9, 0.2, 1.3]] }],
    [4.0, { x: -7.6, z: -0.3, hip: 3.2, lean: 0.2, headPitch: -0.3, feet: [[0.2, -0.3, 0], [-0.3, 0.3, 0]], hands: [[0.3, -0.3, -0.6], [0.9, 0.1, 1.85]] }],
    [4.36, { x: -6.4, z: 0.3, hip: 2.8, lean: 0.3, feet: [[0.3, -0.35, 0], [-0.3, 0.35, 0]], hands: [[0.4, -0.3, -0.9], [0.4, 0.3, -0.9]] }],
    [4.9, { x: -6.8, z: 1.3, hip: 3.12, lean: 0.1, feet: [[0.1, -0.35, 0], [-0.1, 0.35, 0]] }, { stop: true }],
    [5.4, { headPitch: 0.5, hands: [[-0.1, -0.45, -1.1], [-0.1, 0.45, -1.1]] }, { keep: BOTH }],
  ]),
  chase: trail([[2.38, -20.4, 0.2, PI + 1.2], [2.64, -19.6, -0.8, 5.7], [3.0, -17.0, -1.2, 6.2], [3.4, -12.6, -1.0, 2 * PI], [3.66, -9.6, -0.7, 2 * PI]]),
  leaps: [[3.72, 4.3, 1.05]], beaten: 2.3,
  stills: [2.9, 3.98, 4.75],
};

// ── Ball handler ──────────────────────────────────────────────────────────

const bringUpPace = u => clamp01(Math.pow(1 - u, 0.6));

/** Walks the ball up to his spot, slowing as he gets there. */
function bringUp(play, t) {
  const u = clamp01(t / play.sizeup);
  const far = play.spot[0] - play.from;
  // Gait phase: the distance covered, in strides of the pace he had while covering it.
  const steps = 16;
  let phase = 0;
  for (let i = 0; i < steps; i += 1) {
    const s = u * (i + 0.5) / steps;
    phase += 1.6 * Math.pow(1 - s, 0.6) / cycleLength(bringUpPace(s));
  }
  return gait(play.from + far * (1 - Math.pow(1 - u, 1.6)), play.spot[1] + 0.7 * (1 - smooth(u)), 0, phase * far * u / steps, bringUpPace(u));
}

function touchAt(touches, t) {
  let index = 1;
  while (index < touches.length - 1 && t >= touches[index].t) index += 1;
  const from = touches[index - 1];
  const to = touches[index];
  return { from, to, q: span(t, from.t, to.t) };
}

function dribbled({ from, to, q }) {
  if (to.carry) return mix3(from.at, to.at, smooth(q));
  const floor = to.floor || [(from.at[0] + to.at[0]) / 2, (from.at[1] + to.at[1]) / 2];
  // Pushed down fast, and slowing as it comes back up to the hand.
  const down = 0.46;
  if (q < down) {
    const s = q / down;
    return [mix(from.at[0], floor[0], s), mix(from.at[1], floor[1], s), mix(from.at[2], BALL_RADIUS, Math.pow(s, 1.7))];
  }
  const s = (q - down) / (1 - down);
  return [mix(floor[0], to.at[0], s), mix(floor[1], to.at[1], s), mix(BALL_RADIUS, to.at[2], 1 - Math.pow(1 - s, 1.9))];
}

/**
 * The dribbling hand rides the ball near the top of its bounce and waits
 * above it otherwise. On a change of hands the giver lets go and the taker
 * leaves its resting spot to meet the ball on the way up.
 */
function dribbleHands(pose, ball, { from, to, q }) {
  const top = Math.min(from.at[2], to.at[2]);
  const ride = [ball[0], Math.max(ball[1] + BALL_RADIUS * 0.85, top - 0.5), ball[2]];
  if (from.hand === to.hand) {
    setHand(pose, to.hand, ride);
    return;
  }
  // The giver follows the ball down and comes away slowly; the taker is on its way before the bounce.
  const rest = [pose.hands[0], pose.hands[1]];
  setHand(pose, from.hand, ride);
  pose.hands[from.hand] = mix3(pose.hands[from.hand], rest[from.hand], smooth(span(q, 0.24, 0.82)));
  setHand(pose, to.hand, ride);
  pose.hands[to.hand] = mix3(rest[to.hand], pose.hands[to.hand], smooth(span(q, 0.38, 0.84)));
}

/** Where a held ball sits at `t`, from the keys in `play.hold`: pocket, dip, set point, release. */
function heldAt(play, pose, t) {
  const keys = play.hold;
  let place = keys[keys.length - 1][1];
  if (t <= keys[0][0]) place = keys[0][1];
  else {
    for (let i = 1; i < keys.length; i += 1) {
      if (t < keys[i][0]) {
        place = mix3(keys[i - 1][1], keys[i][1], smooth((t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0])));
        break;
      }
    }
  }
  const { chest, cf, cr } = torsoOf(pose);
  return offset(chest, cf, place[0], cr, place[1], place[2]);
}

/** The shooting hand under and behind the ball, the other on its side. */
function grip(pose, ball, shooter) {
  const { cf, cr } = torsoOf(pose);
  const out = shooter === 1 ? 1 : -1;
  setHand(pose, shooter, offset(ball, cf, -0.2, cr, 0.02 * out, -0.2));
  setHand(pose, 1 - shooter, offset(ball, cf, 0.04, cr, -0.34 * out, -0.02));
}

function celebrate(walk, t, play, plan) {
  const from = play.party;
  const to = from + PARTY;
  const party = smooth(span(t, from - 0.15, from + 0.3)) * (1 - smooth(span(t, to - 0.3, to + 0.15)));
  if (party <= 0) return walk;
  const beat = t - from;
  let pose;
  if (plan.celebration === 'night') {
    // Palms pressed together against one cheek, head resting on them.
    pose = {
      ...walk, hip: 3.12 + 0.03 * Math.sin(beat * 3), lean: 0.04, twist: 0, headRoll: -0.55, headPitch: 0.1,
      hands: [[0.2, -0.16, 0.36], [0.3, -1.08, 0.3]],
    };
  } else if (plan.celebration === 'point') {
    // One finger to the sky, the other hand on his chest.
    pose = { ...walk, hip: 3.2, lean: -0.04, twist: 0, headPitch: -0.4, hands: [[0.4, 0.4, -0.35], [0.18, 0.08, 1.86]] };
  } else if (plan.celebration === 'shimmy') {
    const shake = Math.sin(beat * 19);
    pose = {
      ...walk, twist: 0.34 * shake, sway: 0.07 * Math.sin(beat * 19 + 1.2), headYaw: -0.3 * shake,
      hands: [[0.4, -0.22, -0.72 + 0.14 * shake], [0.4, 0.22, -0.72 - 0.14 * shake]],
    };
  } else {
    // Keeps walking, with a shrug: what did you expect?
    const shrug = Math.sin(PI * span(beat, 0.2, 1.4));
    pose = {
      ...walk, headRoll: 0.16 * shrug,
      hands: [mix3(walk.hands[0], [0.5, -0.6, -0.78], shrug), mix3(walk.hands[1], [0.5, 0.6, -0.78], shrug)],
    };
  }
  return blend(walk, pose, party);
}

/** Turns his back on the hoop and walks off; some celebrations stop him for a moment. */
function walkOff(play, t, plan) {
  const stops = plan.celebration === 'night' || plan.celebration === 'point';
  const start = play.walk + 0.15;
  const walked = WALK_SPEED * (stops
    ? Math.max(0, Math.min(t, play.party) - start) + Math.max(0, t - play.party - PARTY)
    : Math.max(0, t - start));
  return celebrate(gait(play.landing.x - walked, play.landing.z, PI, walked / cycleLength(STROLL), STROLL), t, play, plan);
}

/** Pose and ball for the ball handler. `ball` is null once it has left his hand. */
function heroAt(play, t, plan) {
  let base = t < play.sizeup
    ? bringUp(play, t)
    : blend(bringUp(play, play.sizeup), sample(play.hero, t), smooth(span(t, play.sizeup, play.sizeup + SETTLE)));
  if (t > play.walk) base = blend(base, walkOff(play, t, plan), smooth(span(t, play.walk, play.walk + 0.5)));
  const pose = editable(base);
  // He arrives with a hop into his stance: both feet leave the floor rather than slide across it.
  const settle = span(t, play.sizeup, play.sizeup + SETTLE);
  if (settle > 0 && settle < 1) for (const plant of pose.plants) plant[1] += 0.2 * Math.sin(PI * settle);
  lifted(pose, airborne(play.jumps, t));
  // His eyes stay on the rim whatever his hips and shoulders are doing.
  look(pose, 0, 0, 1 - smooth(span(t, play.walk, play.walk + 0.3)));
  if (t < play.pickup) {
    const touch = touchAt(play.touches, t);
    const ball = fromFloor(pose, dribbled(touch));
    dribbleHands(pose, ball, touch);
    return { pose, ball };
  }
  const guide = 1 - play.shooter;
  if (t < play.release) {
    // The hand that had the dribble brings the ball in; the other comes over to meet it.
    const last = play.touches[play.touches.length - 1];
    const joined = smooth(span(t, play.pickup, play.pickup + 0.2));
    const ball = mix3(fromFloor(pose, last.at), heldAt(play, pose, t), joined);
    const free = [pose.hands[0], pose.hands[1]];
    setHand(pose, last.hand, [ball[0], ball[1] + BALL_RADIUS * 0.85, ball[2]]);
    const riding = pose.hands[last.hand];
    grip(pose, ball, play.shooter);
    const other = 1 - last.hand;
    pose.hands[last.hand] = mix3(riding, pose.hands[last.hand], joined);
    pose.hands[other] = mix3(free[other], pose.hands[other], joined);
    // A one-handed finish: the other hand comes off on the way up.
    if (play.guideOff) pose.hands[guide] = mix3(pose.hands[guide], free[guide], smooth(span(t, play.guideOff, play.guideOff + 0.16)));
    return { pose, ball };
  }
  // Released: the hands leave the ball's last spot for the follow-through.
  const released = smooth(span(t, play.release, play.release + 0.12));
  if (released < 1) {
    const after = [pose.hands[0], pose.hands[1]];
    grip(pose, heldAt(play, pose, play.release), play.shooter);
    if (play.guideOff) pose.hands[guide] = after[guide];
    pose.hands = [mix3(pose.hands[0], after[0], released), mix3(pose.hands[1], after[1], released)];
  }
  return { pose, ball: null };
}

// ── Defender ──────────────────────────────────────────────────────────────

function defenderAt(play, t) {
  let base = sample(play.defender, t);
  if (play.chase) {
    const running = smooth(span(t, play.chase.from, play.chase.from + 0.2)) * (1 - smooth(span(t, play.chase.to, play.chase.to + 0.26)));
    if (running > 0) base = blend(base, sprint(play.chase, t), running);
  }
  const pose = editable(base);
  lifted(pose, airborne(play.leaps, t));
  // Light on his feet until he is beaten.
  pose.hip += 0.04 * Math.sin(t * 7) * (1 - span(t, play.beaten - 0.3, play.beaten));
  return pose;
}

// ── Ball in the air ───────────────────────────────────────────────────────

/** The shot as arcs of [from, to, seconds]: straight in, or off the glass on his side of the rim. */
function routeOf(play, angle) {
  const from = play.releasePoint;
  const rim = [0, RIM.y, 0];
  if (!play.bank) return [[from, rim, play.flight]];
  const side = turn(from, angle)[2] < 0 ? -1 : 1;
  const glass = turn([BOARD - BALL_RADIUS * 0.9, RIM.y + 1.25, 0.55 * side], -angle);
  return [[from, glass, play.flight / 2], [glass, rim, play.flight / 2]];
}

function flightAt(route, since) {
  let dt = since;
  let arc = route[0];
  for (let i = 0; i < route.length; i += 1) {
    arc = route[i];
    if (dt <= arc[2] || i === route.length - 1) break;
    dt -= arc[2];
  }
  const [from, to, seconds] = arc;
  const u = dt / seconds;
  const lift = (to[1] - from[1] + 0.5 * GRAVITY * seconds * seconds) / seconds;
  return [mix(from[0], to[0], u), from[1] + lift * dt - 0.5 * GRAVITY * dt * dt, mix(from[2], to[2], u)];
}

/** Through the net, then a few dying bounces under the hoop. */
function dropAt(since) {
  let dt = since;
  const x = 1.9 * (1 - Math.exp(-1.1 * dt));
  let y = RIM.y;
  let speed = -11;
  for (let bounce = 0; bounce < 5; bounce += 1) {
    const hit = (speed + Math.sqrt(speed * speed + 2 * GRAVITY * (y - BALL_RADIUS))) / GRAVITY;
    if (dt <= hit) return [x, y + speed * dt - 0.5 * GRAVITY * dt * dt, 0];
    dt -= hit;
    speed = -(speed - GRAVITY * hit) * 0.52;
    y = BALL_RADIUS;
    if (speed < 2.5) break;
  }
  return [x, BALL_RADIUS, 0];
}

// ── Putting a possession together ─────────────────────────────────────────

const STROLLING = { celebration: 'stroll' };

function staged(play) {
  // Bringing it up: a right-hand dribble every 0.4 s, timed to top out as he arrives.
  const lead = [];
  for (let t = play.sizeup - 1.6; t < play.sizeup - 0.01; t += 0.4) {
    const forward = mix(1.0, 1.55, bringUpPace(clamp01(t / play.sizeup)));
    lead.push({ t, hand: 1, at: [forward, 0.72, 2.55], floor: [forward + 0.4, 0.78] });
  }
  const touches = [...lead, ...play.touches];
  const made = play.release + play.flight;
  const party = made + 0.5;
  const whole = {
    ...play, touches, made, party,
    pickup: touches[touches.length - 1].t,
    landing: play.hero[play.hero.length - 1].pose,
    seconds: party + PARTY + OUTRO,
  };
  whole.ms = Math.round(whole.seconds * 1000);
  const shooting = heroAt(whole, play.release - 1e-6, STROLLING);
  whole.releasePoint = shooting.ball;
  // Where he shoots from, for the camera behind him.
  whole.stand = [shooting.pose.x, shooting.pose.z];
  whole.routes = play.angles.map(angle => routeOf(whole, angle));
  // What the stage reports as the beat, and the camera cuts on.
  whole.marks = {
    bringup: 0, sizeup: play.sizeup, move: play.move, gather: whole.pickup, flight: play.release,
    swish: made, celebrate: party, reset: whole.seconds - 0.4,
  };
  // Floor dust: where the defender's foot skids out, then where he lands.
  whole.dust = [];
  if (play.skid) {
    const [at, foot] = play.skid;
    const skid = solveFigure(defenderAt(whole, at), DEFENDER_SIZE).legs[foot].ankle;
    const seat = sample(play.defender, play.seat);
    whole.dust = [
      { from: at - 0.06, to: at + 0.58, at: [skid[0], 0, skid[2]], size: 0.8 },
      { from: play.seat - 0.02, to: play.seat + 0.68, at: [seat.x + 0.3, 0, seat.z], size: 1.3 },
    ];
  }
  return whole;
}

const PLAYS = [STEPBACK, FLOATER, LONG_TWO, LAYUP].map(staged);
const ROUND_MS = PLAYS.reduce((total, play) => total + play.ms, 0);
const ROUND_POINTS = PLAYS.reduce((total, play) => total + play.worth, 0);
const STARTS = PLAYS.map((_, index) => PLAYS.slice(0, index).reduce((total, play) => total + play.ms, 0));

/** A still for stalled connections: the first shot, just off his fingers. */
export const HOOPS_POSTER_MS = Math.round((PLAYS[0].release + 0.07) * 1000);
/** With motion reduced: the moments that tell each possession, in order. */
export const HOOPS_STILLS = PLAYS.flatMap((play, index) => play.stills.map(t => STARTS[index] + Math.round(t * 1000)));

function beatAt(marks, t) {
  let beat = 'bringup';
  for (const name of Object.keys(marks)) if (t >= marks[name]) beat = name;
  return beat;
}

/**
 * @param {number} elapsedMs Milliseconds since the scene began.
 * @returns Frame of the play in play space: solved figures, ball, net and effects. Pure.
 */
export function resolveHoopsPlay(elapsedMs) {
  const elapsed = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : 0;
  const round = Math.floor(elapsed / ROUND_MS);
  const into = elapsed - round * ROUND_MS;
  let index = PLAYS.length - 1;
  while (index > 0 && into < STARTS[index]) index -= 1;
  const play = PLAYS[index];
  const t = (into - STARTS[index]) / 1000;
  const possession = round * PLAYS.length + index;
  // Where on the arc and how he celebrates shift every round, so a possession
  // comes back the same only after several.
  const turnOf = round % play.angles.length;
  const plan = { celebration: CELEBRATIONS[(possession + round) % CELEBRATIONS.length] };

  const hero = heroAt(play, t, plan);
  const made = t >= play.made;
  const sinceMake = t - play.made;
  let ball;
  if (hero.ball) {
    // In his hands it turns with the dribble, about the line across his body.
    ball = { at: hero.ball, loose: false, trail: [], axis: heading(hero.pose.yaw).r, spin: t * 5 };
  } else {
    const route = play.routes[turnOf];
    const since = t - play.release;
    const trail = [];
    if (!made) {
      for (let i = 1; i <= 4; i += 1) if (since - i * 0.035 > 0) trail.push(flightAt(route, since - i * 0.035));
    }
    // Backspin: the top of the ball turning back toward the shooter.
    const [from] = route[0];
    const far = Math.hypot(from[0], from[2]) || 1;
    ball = { at: made ? dropAt(sinceMake) : flightAt(route, since), loose: true, trail, axis: [from[2] / far, 0, -from[0] / far], spin: since * 13 };
  }

  const napping = plan.celebration === 'night' && t > play.party + 0.15 && t < play.party + PARTY - 0.1;
  const before = PLAYS.slice(0, index).reduce((total, earlier) => total + earlier.worth, 0);
  return {
    possession, name: play.name, time: t, beat: beatAt(play.marks, t), marks: play.marks,
    angle: play.angles[turnOf], side: play.side, spot: play.spot, stand: play.stand, celebration: plan.celebration,
    hero: solveFigure(hero.pose), defender: solveFigure(defenderAt(play, t), DEFENDER_SIZE), ball,
    // His points for this wait, counting this shot once it drops.
    worth: play.worth, points: round * ROUND_POINTS + before + (made ? play.worth : 0),
    net: made ? Math.exp(-sinceMake * 4.2) : 0, netAge: made ? sinceMake : 0,
    pop: made && sinceMake < 1.3 ? sinceMake / 1.3 : -1,
    dust: play.dust.filter(puff => t >= puff.from && t < puff.to).map(puff => ({ at: puff.at, size: puff.size, age: span(t, puff.from, puff.to) })),
    shake: play.seat && t >= play.seat ? Math.exp(-(t - play.seat) * 9) : 0,
    // Headroom the camera should leave: up before his defender jumps, and down again well after he lands.
    room: (play.leaps || []).reduce((most, [from, to]) => Math.max(most, smooth(span(t, from - 0.3, from)) * (1 - smooth(span(t, to, to + 0.45)))), 0),
    doze: napping ? t - play.party - 0.15 : -1,
    // The first possession is visible immediately; later possessions fade in.
    fade: Math.min(possession > 0 ? smooth(span(t, 0, 0.25)) : 1, 1 - smooth(span(t, play.seconds - 0.4, play.seconds - 0.05))),
  };
}
