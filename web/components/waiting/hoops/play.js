/**
 * Choreography of the basketball waiting animation: one possession — bring
 * the ball up, size the defender up, cross him over until he falls, step back
 * behind the three-point line, shoot, and turn away before it drops —
 * resolved as a pure function of elapsed time. Nothing here keeps state, so
 * any canvas reading the same clock shows the same frame of the same play.
 *
 * Play space is in feet. The rim's centre is above the origin; +x runs from
 * the ball handler toward the hoop, y is up and +z is to his right. Every
 * possession is laid out along that axis. Where on the arc it happens is
 * `angle`, and the renderer turns the court under the play instead.
 */
import { blend, cycleLength, editable, gait, keyframes, sample } from '../stick/motion.js';
import { heading, solveFigure, torsoOf } from '../stick/rig.js';
import { clamp01, dot, mix, mix3, offset, smooth, span, sub } from '../stick/vec.js';

export const RIM = Object.freeze({ y: 10, radius: 0.75 });
/** Drawn a little larger than a real ball so it reads when the camera is wide. */
export const BALL_RADIUS = 0.45;
export const DEFENDER_SIZE = 1.05;

const GRAVITY = 32.2;
const FLIGHT = 1.35;
const WALK_SPEED = 3.3;
const STROLL = 0.12;

/** Beat starts in play seconds. */
const B = Object.freeze({
  bringup: 0, sizeup: 2.2, jab: 3.5, cross: 3.86, escape: 4.3, gather: 4.75, rise: 5.2,
  flight: 5.62, swish: 5.62 + FLIGHT, celebrate: 7.45, reset: 10.2,
});
export const HOOPS_BEATS = B;
const BEAT_ORDER = Object.keys(B);
const PLAY_SECONDS = 10.6;
const PARTY_FROM = B.celebrate + 0.15;
const PARTY_TO = PARTY_FROM + 1.75;

// The crossover and the fall play at half speed, like a replay. The clock
// eases into and out of it, so nothing lurches when it starts or ends.
const SLOW_FROM = 3.62;
const SLOW_HOLD = 5.38;
const SLOW_EASE = 0.25;
const SLOW_DEPTH = 0.5;
const SLOW_COST = SLOW_DEPTH * (SLOW_HOLD - SLOW_FROM);

/** Play seconds for real seconds into a possession. */
function playSeconds(real) {
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

export const HOOPS_POSSESSION_MS = Math.round((PLAY_SECONDS + SLOW_COST) * 1000);
/** A still for reduced motion and stalled connections: the ball just off his fingers. */
export const HOOPS_POSTER_MS = Math.round((B.flight + 0.07 + SLOW_COST) * 1000);

// Where on the arc the play happens and how he celebrates cycle with coprime
// lengths, so the same pairing comes round only every twelfth possession.
const ANGLES = [0, -0.5, 0.42];
const CELEBRATIONS = ['night', 'shimmy', 'point', 'stroll'];

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

// ── Ball handler ──────────────────────────────────────────────────────────

const START_X = -40;
const SPOT_X = -25.4;
const GUARD = [0.55, -0.5, -0.9];
const REST = [0.5, 0.45, -1.05];
const FOLLOW = [0.98, -0.05, 1.5];
const BOTH = [true, true];
const LEFT = [true, false];
const RIGHT = [false, true];

const bringUpPace = u => clamp01(Math.pow(1 - u, 0.6));

/** Gait phase after fraction `u` of the bring-up: the distance covered, in strides of the pace he had. */
function bringUpPhase(u) {
  const steps = 16;
  let phase = 0;
  for (let i = 0; i < steps; i += 1) {
    const s = u * (i + 0.5) / steps;
    phase += 1.6 * Math.pow(1 - s, 0.6) / cycleLength(bringUpPace(s));
  }
  return phase * (SPOT_X - START_X) * u / steps;
}

function bringUp(t) {
  const u = clamp01(t / B.sizeup);
  const x = START_X + (SPOT_X - START_X) * (1 - Math.pow(1 - u, 1.6));
  return gait(x, 0.7 * (1 - smooth(u)), 0, bringUpPhase(u), bringUpPace(u));
}

const HERO_KEYS = keyframes([
  // Size-up: rhythm dribbles, rocking from side to side over planted feet.
  [B.sizeup, { x: SPOT_X, z: 0, hip: 2.85, lean: 0.3, feet: [[0.5, -0.68, 0], [-0.35, 0.68, 0]], hands: [GUARD, REST] }],
  [2.5, { z: 0.3, hip: 2.66, lean: 0.36, sway: 0.16, twist: 0.12 }, { keep: BOTH }],
  [2.82, { z: -0.32, hip: 2.58, lean: 0.38, sway: -0.18, twist: -0.14 }, { keep: BOTH }],
  // A hop to switch his feet.
  [3.1, { x: -25.35, z: 0, hip: 2.86, lean: 0.3, sway: 0, twist: 0, feet: [[0.1, -0.68, 0.3], [0.08, 0.68, 0.3]] }],
  [3.3, { x: -25.3, z: 0.12, hip: 2.5, lean: 0.44, sway: 0.08, feet: [[-0.35, -0.7, 0], [0.5, 0.7, 0]] }],
  // Hesitation: he comes up as if to shoot.
  [B.jab, { z: 0.1, hip: 3.0, lean: 0.16, sway: 0, headPitch: -0.08 }, { keep: BOTH }],
  // Hard to his right off the left foot; the right foot plants far outside.
  [3.68, { x: -24.9, z: 1.2, yaw: 0.4, hip: 2.5, lean: 0.5, sway: 0.26, headYaw: -0.3, headPitch: 0.05, feet: [[-0.75, -0.5, 0], [0.75, 0.9, 0.4]] }, { keep: LEFT }],
  [B.cross, { x: -24.3, z: 2.3, yaw: 0.5, hip: 2.28, lean: 0.58, sway: 0.46, headYaw: -0.35, feet: [[-1.0, -0.45, 0], [0.9, 1.4, 0]] }, { stop: true, slide: LEFT }],
  // Off that foot and back to his left, the ball crossing low in front.
  [4.0, { z: 2.15, yaw: 0.25, hip: 2.24, lean: 0.5, sway: 0.12, headYaw: -0.2 }, { keep: BOTH }],
  // The left foot reaches out first; the right pushes off, leaves the floor and follows.
  [4.14, { x: -24.6, z: 1.35, yaw: -0.2, hip: 2.4, lean: 0.46, sway: -0.32, headYaw: 0.15, feet: [[0.3, -1.25, 0], [0.25, 1.15, 0.3]] }],
  [B.escape, { x: -25.3, z: -0.3, yaw: -0.5, hip: 2.5, lean: 0.45, sway: -0.42, headYaw: 0.4, feet: [[0.65, -0.85, 0], [-0.25, 0.5, 0.4]] }, { keep: LEFT }],
  [4.52, { x: -25.9, z: -1.8, yaw: -0.3, hip: 2.6, lean: 0.36, sway: -0.2, headYaw: 0.28, feet: [[-0.45, -0.55, 0.3], [0.5, 0.6, 0]] }],
  // Squares up and hops back behind the line.
  [B.gather, { x: -26.05, z: -2.35, yaw: 0, hip: 2.42, lean: 0.3, sway: 0, headYaw: 0, feet: [[0.3, -0.42, 0], [0.42, 0.42, 0]] }],
  [4.97, { x: -26.55, z: -2.4, hip: 2.72, lean: 0.06, feet: [[0.2, -0.38, 0], [0.38, 0.38, 0]] }],
  [B.rise, { x: -26.95, hip: 2.62, lean: 0.2, feet: [[-0.05, -0.36, 0], [0.15, 0.36, 0]], toes: [-0.32, -0.08] }],
  // Dip, up through the legs, release at the top, hold the follow-through.
  [5.34, { hip: 2.48, lean: 0.25 }, { keep: BOTH }],
  [5.5, { hip: 3.25, lean: 0.05, headPitch: -0.1 }, { keep: BOTH }],
  [5.76, { x: -26.8, lean: -0.05, hands: [[0.5, -0.1, 0.7], FOLLOW] }, { slide: BOTH }],
  [5.97, { x: -26.62, hip: 3.0, lean: 0.08, hands: [[0.35, -0.12, -0.7], FOLLOW] }, { slide: BOTH }],
  [6.12, { hip: 3.16, lean: 0.05, headPitch: 0, hands: [[0.2, -0.14, -1.6], [0.7, 0.1, 0.6]] }, { keep: BOTH }],
]);
const LANDING = HERO_KEYS[HERO_KEYS.length - 1].pose;

/** Height off the floor: the hop back behind the line, then the jump shot. */
function airborne(t) {
  const hop = span(t, B.gather + 0.03, B.rise - 0.04);
  const jump = span(t, 5.48, 5.98);
  return 0.55 * 4 * hop * (1 - hop) + 1.1 * 4 * jump * (1 - jump);
}

/**
 * The dribble as a list of touches: when the ball is in which hand (0 left,
 * 1 right) and where, as [forward, side, height] from the spot under his
 * pelvis. Between two touches it bounces once off `floor`, or with `carry`
 * stays in the hand.
 */
const TOUCHES = [
  // Bringing it up: a right-hand dribble every 0.4 s, timed to top out at the size-up.
  ...[-0.2, 0.2, 0.6, 1.0, 1.4, 1.8].map((t) => {
    const forward = mix(1.0, 1.55, bringUpPace(clamp01(t / B.sizeup)));
    return { t, hand: 1, at: [forward, 0.72, 2.55], floor: [forward + 0.4, 0.78] };
  }),
  { t: B.sizeup, hand: 1, at: [1.0, 0.72, 2.55], floor: [1.3, 0.78] },
  { t: 2.62, hand: 0, at: [-0.15, -0.75, 2.1], floor: [0.15, 0] },      // through the legs
  { t: 3.0, hand: 0, at: [0.4, -0.9, 2.3], floor: [0.3, -0.95] },
  { t: 3.38, hand: 1, at: [-0.1, 0.75, 2.1], floor: [0.2, 0.05] },      // and back
  { t: B.jab, hand: 1, at: [0.6, 0.75, 2.85], carry: true },             // the ball rides up with him
  { t: B.cross, hand: 1, at: [1.1, 1.3, 2.0], floor: [1.45, 1.25] },     // pounded out to the right
  { t: 4.14, hand: 0, at: [0.4, -1.0, 1.85], floor: [0.75, 0.15] },      // crossed over, low
  { t: 4.52, hand: 0, at: [0.35, -0.9, 2.3], floor: [0.3, -1.15] },
  { t: B.gather, hand: 0, at: [0.5, -0.45, 2.75], carry: true },         // picked up
];

function touchAt(t) {
  let index = 1;
  while (index < TOUCHES.length - 1 && t >= TOUCHES[index].t) index += 1;
  const from = TOUCHES[index - 1];
  const to = TOUCHES[index];
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
  const rest = [pose.hands[0], pose.hands[1]];
  setHand(pose, from.hand, ride);
  pose.hands[from.hand] = mix3(pose.hands[from.hand], rest[from.hand], smooth(span(q, 0.28, 0.6)));
  setHand(pose, to.hand, ride);
  pose.hands[to.hand] = mix3(rest[to.hand], pose.hands[to.hand], smooth(span(q, 0.5, 0.82)));
}

/** Where a held ball sits, as [forward, side, up] from the chest: pocket, dip, set point, release. */
const HOLD_KEYS = [
  [4.97, [0.72, 0.18, -0.62]], [B.rise, [0.74, 0.2, -0.7]], [5.34, [0.72, 0.22, -0.85]],
  [5.5, [0.5, 0.36, 0.78]], [B.flight, [0.82, 0.34, 1.55]],
];

function heldAt(pose, t) {
  let place = HOLD_KEYS[HOLD_KEYS.length - 1][1];
  if (t <= HOLD_KEYS[0][0]) place = HOLD_KEYS[0][1];
  else {
    for (let i = 1; i < HOLD_KEYS.length; i += 1) {
      if (t < HOLD_KEYS[i][0]) {
        place = mix3(HOLD_KEYS[i - 1][1], HOLD_KEYS[i][1], smooth((t - HOLD_KEYS[i - 1][0]) / (HOLD_KEYS[i][0] - HOLD_KEYS[i - 1][0])));
        break;
      }
    }
  }
  const { chest, cf, cr } = torsoOf(pose);
  return offset(chest, cf, place[0], cr, place[1], place[2]);
}

/** Shooting hand under and behind the ball, guide hand on its side. */
function holdHands(pose, ball) {
  const { cf, cr } = torsoOf(pose);
  setHand(pose, 1, offset(ball, cf, -0.2, cr, 0.02, -0.2));
  setHand(pose, 0, offset(ball, cf, 0.04, cr, -0.34, -0.02));
}

function celebrate(walk, t, plan) {
  const party = smooth(span(t, PARTY_FROM - 0.15, PARTY_FROM + 0.3)) * (1 - smooth(span(t, PARTY_TO - 0.3, PARTY_TO + 0.15)));
  if (party <= 0) return walk;
  const beat = t - PARTY_FROM;
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
    const shrug = Math.sin(Math.PI * span(beat, 0.2, 1.4));
    pose = {
      ...walk, headRoll: 0.16 * shrug,
      hands: [mix3(walk.hands[0], [0.5, -0.6, -0.78], shrug), mix3(walk.hands[1], [0.5, 0.6, -0.78], shrug)],
    };
  }
  return blend(walk, pose, party);
}

/** Turns his back on the shot and walks off; some celebrations stop him for a moment. */
function walkOff(t, plan) {
  const stops = plan.celebration === 'night' || plan.celebration === 'point';
  const start = 6.2;
  const walked = WALK_SPEED * (stops
    ? Math.max(0, Math.min(t, PARTY_FROM) - start) + Math.max(0, t - PARTY_TO)
    : Math.max(0, t - start));
  return celebrate(gait(LANDING.x - walked, LANDING.z, Math.PI, walked / cycleLength(STROLL), STROLL), t, plan);
}

/** Pose and ball for the ball handler. `ball` is null once it has left his hand. */
function heroAt(t, plan) {
  if (t < B.sizeup) {
    const pose = editable(bringUp(t));
    const touch = touchAt(t);
    const ball = fromFloor(pose, dribbled(touch));
    dribbleHands(pose, ball, touch);
    return { pose, ball };
  }
  let base = blend(bringUp(B.sizeup), sample(HERO_KEYS, t), smooth(span(t, B.sizeup, B.sizeup + 0.28)));
  if (t > 6.05) base = blend(base, walkOff(t, plan), smooth(span(t, 6.05, 6.55)));
  const pose = editable(base);
  const air = airborne(t);
  if (air > 0) {
    pose.hip += air * 0.94;
    for (const plant of pose.plants) plant[1] += air;
  }
  if (t < B.gather) {
    const touch = touchAt(t);
    const ball = fromFloor(pose, dribbled(touch));
    dribbleHands(pose, ball, touch);
    return { pose, ball };
  }
  if (t < B.flight) {
    // The left hand brings it across; the right comes over to meet it.
    const joined = smooth(span(t, B.gather, 4.97));
    const ball = mix3(fromFloor(pose, TOUCHES[TOUCHES.length - 1].at), heldAt(pose, t), joined);
    const rest = pose.hands[1];
    setHand(pose, 0, [ball[0], ball[1] + BALL_RADIUS * 0.85, ball[2]]);
    const riding = pose.hands[0];
    holdHands(pose, ball);
    pose.hands = [mix3(riding, pose.hands[0], joined), mix3(rest, pose.hands[1], joined)];
    return { pose, ball };
  }
  // Released: the hands leave the ball's last spot for the follow-through.
  const released = smooth(span(t, B.flight, B.flight + 0.12));
  if (released < 1) {
    const after = [pose.hands[0], pose.hands[1]];
    holdHands(pose, heldAt(pose, B.flight));
    pose.hands = [mix3(pose.hands[0], after[0], released), mix3(pose.hands[1], after[1], released)];
  }
  return { pose, ball: null };
}

// ── Defender ──────────────────────────────────────────────────────────────

// He faces the ball handler, so his right is −z and his feet and hands are in that frame.
const DEFENDER_KEYS = keyframes([
  [0, { x: -18.8, z: 0.6, yaw: Math.PI, hip: 2.95, lean: 0.2, feet: [[0.1, -0.6, 0], [-0.1, 0.6, 0]], hands: [[0.35, -0.35, -1.3], [0.35, 0.35, -1.3]] }],
  [1.2, {}, { stop: true }],
  // Steps up into his stance.
  [1.7, { x: -20.3, z: 0.3, hip: 2.8, lean: 0.3, feet: [[0.5, -0.8, 0], [-0.4, 0.6, 0]], hands: [[0.6, -0.6, -0.9], [0.6, 0.45, -0.7]] }, { keep: RIGHT }],
  [B.sizeup, { x: -21.6, z: 0, hip: 2.62, lean: 0.38, feet: [[0.12, -1.0, 0], [-0.12, 1.0, 0]], hands: [[0.75, -0.75, -0.55], [0.85, 0.45, -0.15]] }, { keep: LEFT }],
  // Mirrors the rocking, a beat late, over planted feet.
  [2.55, { z: 0.28, sway: -0.1 }, { keep: BOTH }],
  [2.9, { z: -0.3, sway: 0.12 }, { keep: BOTH }],
  [3.2, { z: 0.05, sway: 0 }, { keep: BOTH }],
  [3.4, { z: 0.12, hip: 2.5, lean: 0.42 }, { keep: BOTH }],
  // Bites on the hesitation: up on his toes with a hand in the air.
  [3.56, { z: 0.1, hip: 2.92, lean: 0.24, hands: [[0.7, -0.5, 0.3], [0.8, 0.4, 0.95]] }, { keep: BOTH }],
  // Lunges to his left after the drive, all his weight over the outside foot.
  [3.72, { x: -21.5, z: 1.3, hip: 2.55, lean: 0.36, sway: -0.25, feet: [[0.05, -1.5, 0.25], [0, 0.55, 0]], hands: [[0.7, -1.0, -0.4], [0.9, 0.2, -0.1]] }, { keep: RIGHT }],
  [3.9, { x: -21.25, z: 2.75, hip: 2.38, sway: -0.42, feet: [[0.2, -1.6, 0], [0.1, 0.35, 0.25]], hands: [[0.65, -1.25, -0.35], [0.95, -0.1, 0.05]] }],
  // The ball goes back the other way. His foot does not: it skids out from under him.
  [4.04, { x: -21.05, z: 3.3, hip: 2.3, lean: 0.15, sway: 0.25, twist: 0.5, headYaw: 0.7, feet: [[0.35, -1.9, 0], [-0.2, 0.2, 0.2]], hands: [[0.3, -1.0, 0.7], [0.4, 1.2, 0.5]] }, { slide: LEFT }],
  [4.18, { x: -20.85, z: 3.6, hip: 2.15, lean: -0.2, sway: 0.3, twist: 0.6, headYaw: 0.8, feet: [[0.55, -1.75, 0], [-0.5, -0.35, 0.35]], hands: [[0.2, -1.1, 1.25], [0.45, 1.15, 1.3]] }, { slide: LEFT }],
  [4.34, { x: -20.55, z: 3.85, hip: 1.45, lean: -0.6, sway: 0.1, twist: 0.3, headYaw: 0.5, headPitch: -0.2, feet: [[1.35, -0.6, 0.35], [1.2, 0.5, 0.95]], toeLift: [0.3, 0.5], hands: [[-0.5, -1.0, 0.3], [-0.6, 1.0, 0.5]] }],
  // Lands on his backside with his feet in the air.
  [4.52, { x: -20.3, z: 3.95, hip: 0.62, lean: -0.78, sway: 0, twist: 0, feet: [[1.7, -0.5, 1.25], [1.6, 0.5, 1.7]], toeLift: [0.6, 0.6], hands: [[-0.75, -0.7, -1.55], [-0.75, 0.7, -1.55]] }, { stop: true }],
  // Sits up, one hand out toward the shooter.
  [4.8, { x: -20.2, z: 4.1, hip: 0.6, lean: -0.5, headYaw: 0.84, headPitch: 0, feet: [[2.0, -0.55, 0.05], [1.55, 0.6, 0.5]], toeLift: [0.5, 0.2], hands: [[-0.7, -0.6, -1.4], [0.85, 0.2, 0.75]] }],
  [B.flight, { hands: [[-0.7, -0.6, -1.4], [0.9, 0.1, 1.0]] }, { keep: BOTH }],
  // Watches it over his shoulder.
  [6.2, { twist: 0.55, headYaw: 1.45, headPitch: -0.38, hands: [[-0.7, -0.6, -1.4], [0.6, 0.4, -0.6]] }, { keep: BOTH }],
  [B.swish + 0.1, {}, { keep: BOTH, stop: true }],
  // Head in his hand.
  [B.swish + 0.65, { lean: -0.15, twist: 0, headYaw: 0.2, headPitch: 0.62, hands: [[-0.5, -0.5, -1.5], [0.3, -0.32, 0.74]] }, { keep: BOTH }],
]);

function defenderAt(t) {
  const pose = editable(sample(DEFENDER_KEYS, t));
  // Light on his feet until he is beaten.
  pose.hip += 0.04 * Math.sin(t * 7) * (1 - span(t, B.jab, B.cross));
  return pose;
}

const skid = solveFigure(defenderAt(4.04), DEFENDER_SIZE).legs[0].ankle;
const seat = sample(DEFENDER_KEYS, 4.52);
/** Floor dust: where his outside foot skids out, then where he lands. */
const DUST = [
  { from: 3.98, to: 4.62, at: [skid[0], 0, skid[2]], size: 0.8 },
  { from: 4.5, to: 5.2, at: [seat.x + 0.3, 0, seat.z], size: 1.3 },
];
const IMPACT = 4.5;

// ── Ball in the air ───────────────────────────────────────────────────────

const RELEASE = heroAt(B.flight - 1e-6, { celebration: 'stroll' }).ball;

function flightAt(t) {
  const dt = t - B.flight;
  const u = dt / FLIGHT;
  const lift = (RIM.y - RELEASE[1] + 0.5 * GRAVITY * FLIGHT * FLIGHT) / FLIGHT;
  return [mix(RELEASE[0], 0, u), RELEASE[1] + lift * dt - 0.5 * GRAVITY * dt * dt, mix(RELEASE[2], 0, u)];
}

/** Through the net, then a few dying bounces under the hoop. */
function dropAt(t) {
  let dt = t - B.swish;
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

function beatAt(t) {
  let beat = BEAT_ORDER[0];
  for (const name of BEAT_ORDER) if (t >= B[name]) beat = name;
  return beat;
}

/**
 * @param {number} elapsedMs Milliseconds since the scene began.
 * @returns Frame of the play in play space: solved figures, ball, net and effects. Pure.
 */
export function resolveHoopsPlay(elapsedMs) {
  const elapsed = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : 0;
  const possession = Math.floor(elapsed / HOOPS_POSSESSION_MS);
  const t = playSeconds((elapsed - possession * HOOPS_POSSESSION_MS) / 1000);
  const plan = { angle: ANGLES[possession % ANGLES.length], celebration: CELEBRATIONS[possession % CELEBRATIONS.length] };

  const hero = heroAt(t, plan);
  let ball;
  if (hero.ball) {
    ball = { at: hero.ball, loose: false, trail: [], spin: t * 5 };
  } else {
    const inAir = t < B.swish;
    const trail = [];
    if (inAir) {
      for (let i = 1; i <= 4; i += 1) {
        const earlier = t - i * 0.035;
        if (earlier > B.flight) trail.push(flightAt(earlier));
      }
    }
    ball = { at: inAir ? flightAt(t) : dropAt(t), loose: true, trail, spin: -(t - B.flight) * 9 };
  }

  const made = t >= B.swish;
  const sinceMake = t - B.swish;
  const napping = plan.celebration === 'night' && t > PARTY_FROM + 0.15 && t < PARTY_TO - 0.1;
  return {
    possession, time: t, beat: beatAt(t), angle: plan.angle, celebration: plan.celebration,
    hero: solveFigure(hero.pose), defender: solveFigure(defenderAt(t), DEFENDER_SIZE), ball,
    // Three for every make of this wait, counting this one once it drops.
    points: 3 * (possession + (made ? 1 : 0)),
    net: made ? Math.exp(-sinceMake * 4.2) : 0, netAge: made ? sinceMake : 0,
    pop: made && sinceMake < 1.3 ? sinceMake / 1.3 : -1,
    dust: DUST.filter(puff => t >= puff.from && t < puff.to).map(puff => ({ at: puff.at, size: puff.size, age: span(t, puff.from, puff.to) })),
    shake: t >= IMPACT ? Math.exp(-(t - IMPACT) * 9) : 0,
    doze: napping ? t - PARTY_FROM - 0.15 : -1,
    // The first possession is visible immediately; later possessions fade in.
    fade: Math.min(possession > 0 ? smooth(span(t, 0, 0.25)) : 1, 1 - smooth(span(t, PLAY_SECONDS - 0.4, PLAY_SECONDS - 0.05))),
  };
}
