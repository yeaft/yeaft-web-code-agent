/**
 * Waiting-scene choreography: one basketball possession — bring the ball up,
 * shake the defender, step back, shoot from deep and walk away before it
 * drops — resolved as a pure function of elapsed time. Views keep no animation
 * state of their own, so every canvas reading the same clock shows the same
 * frame of the same play.
 *
 * World units are feet. x grows toward the hoop (rim centre at x = 0), y is
 * height above the floor, z is the lane toward (+) or away from (−) the viewer.
 */

export const RIM = Object.freeze({ x: 0, y: 10, radius: 0.75 });
/** Drawn larger than a real ball so it still reads at three pixels per foot. */
export const BALL_RADIUS = 0.58;
export const BODY = Object.freeze({ torso: 2.0, neck: 0.2, head: 0.52, upperArm: 1.05, foreArm: 1.0, thigh: 1.62, shin: 1.63 });

const TAU = Math.PI * 2;
const GRAVITY = 32.2;
const START_X = -72;
const DRIVE_REACH = 3.8;
const JUMP = 1.45;
const FLIGHT_SECONDS = 1.35;
const WALK_SPEED = 3.1;

/** Beat starts in play seconds. */
const B = Object.freeze({
  bringup: 0, sizeup: 3.1, drive: 4.3, snatch: 4.85, stepback: 5.4, rise: 5.95,
  flight: 6.5, swish: 6.5 + FLIGHT_SECONDS, celebrate: 8.3, reset: 10.1,
});
const BEAT_ORDER = Object.keys(B);
const PLAY_SECONDS = 10.7;
const AWAY = B.rise + 1.2;
const PARTY_FROM = B.celebrate + 0.05;
const PARTY_TO = PARTY_FROM + 1.45;

// The shake and the fall play at roughly half speed, like a broadcast replay.
const SLOW_FROM = 4.72;
const SLOW_TO = B.rise;
const SLOW_RATE = 0.55;
const SLOW_REAL = (SLOW_TO - SLOW_FROM) / SLOW_RATE;

export const HOOPS_POSSESSION_MS = Math.round((PLAY_SECONDS - (SLOW_TO - SLOW_FROM) + SLOW_REAL) * 1000);
/** A calm frame for reduced motion and stalled connections: the two players squared up. */
export const HOOPS_POSTER_MS = 3050;
export const HOOPS_BEATS = B;

// Shot spots and celebrations cycle with coprime lengths, so the same pairing
// comes round no sooner than eight possessions (about a minute and a half) later.
const SPOTS = [-28.6, -30.4, -27.6, -29.5];
const CELEBRATIONS = ['night', 'stroll', 'point', 'night', 'shimmy'];

const clamp01 = value => Math.min(1, Math.max(0, value));
const mix = (a, b, u) => a + (b - a) * u;
const span = (t, from, to) => clamp01((t - from) / (to - from));
const smooth = u => u * u * (3 - 2 * u);
const easeOut = u => 1 - (1 - u) * (1 - u);
const easeIn = u => u * u;
const frac = value => value - Math.floor(value);
const mixPair = (a, b, u) => [mix(a[0], b[0], u), mix(a[1], b[1], u)];

function playSeconds(realSeconds) {
  if (realSeconds <= SLOW_FROM) return realSeconds;
  if (realSeconds <= SLOW_FROM + SLOW_REAL) return SLOW_FROM + (realSeconds - SLOW_FROM) * SLOW_RATE;
  return SLOW_TO + (realSeconds - SLOW_FROM - SLOW_REAL);
}

function beatAt(t) {
  let beat = BEAT_ORDER[0];
  for (const name of BEAT_ORDER) if (t >= B[name]) beat = name;
  return beat;
}

/**
 * Move a hand between two shoulder-relative spots. A straight line that cuts
 * through the shoulder would fold the arm onto itself, so those moves swing
 * round the front of the shoulder instead.
 */
function swingPair(a, b, u) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const along = clamp01(-(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy || 1));
  const clearance = Math.hypot(a[0] + dx * along, a[1] + dy * along);
  const round = smooth(clamp01((0.75 - clearance) / 0.35));
  const straight = mixPair(a, b, u);
  if (round <= 0) return straight;
  const radius = mix(Math.hypot(a[0], a[1]), Math.hypot(b[0], b[1]), u);
  const angle = mix(Math.atan2(a[1], a[0]), Math.atan2(b[1], b[0]), u);
  return mixPair(straight, [radius * Math.cos(angle), radius * Math.sin(angle)], round);
}

function blendSpec(a, b, u) {
  if (u <= 0) return a;
  if (u >= 1) return b;
  return {
    x: mix(a.x, b.x, u), z: mix(a.z, b.z, u), face: mix(a.face, b.face, u),
    hip: mix(a.hip, b.hip, u), lean: mix(a.lean, b.lean, u), tilt: mix(a.tilt, b.tilt, u),
    feet: [mixPair(a.feet[0], b.feet[0], u), mixPair(a.feet[1], b.feet[1], u)],
    hands: [swingPair(a.hands[0], b.hands[0], u), swingPair(a.hands[1], b.hands[1], u)],
  };
}

/** Two-bone IK. `side` picks which way the middle joint bends. */
function bend(root, target, upper, lower, side) {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const reach = Math.hypot(dx, dy) || 1e-6;
  const length = Math.min(upper + lower - 1e-3, Math.max(Math.abs(upper - lower) + 1e-3, reach));
  const inner = Math.acos(Math.min(1, Math.max(-1, (upper * upper + length * length - lower * lower) / (2 * upper * length))));
  const angle = Math.atan2(dy, dx) + inner * side;
  return {
    joint: { x: root.x + Math.cos(angle) * upper, y: root.y + Math.sin(angle) * upper },
    end: { x: root.x + (dx / reach) * length, y: root.y + (dy / reach) * length },
  };
}

const shoulderOf = spec => ({
  x: spec.x + Math.sin(spec.lean) * BODY.torso * spec.face,
  y: spec.hip + Math.cos(spec.lean) * BODY.torso,
});

/**
 * Pose spec → joints. Feet are offsets from the pelvis and hands offsets from
 * the shoulder, both in the facing frame, so one spec works for either facing
 * and a turn is just `face` crossing zero.
 */
function solveFigure(spec) {
  const face = spec.face;
  // Knees and elbows straighten as the figure turns through the camera axis
  // instead of snapping from one side to the other.
  const side = Math.max(-1, Math.min(1, face * 3));
  const hip = { x: spec.x, y: spec.hip };
  const shoulder = shoulderOf(spec);
  const headAngle = spec.lean + spec.tilt;
  const head = {
    x: shoulder.x + Math.sin(headAngle) * (BODY.neck + BODY.head) * face,
    y: shoulder.y + Math.cos(headAngle) * (BODY.neck + BODY.head),
  };
  const legs = spec.feet.map(([dx, y]) => {
    const { joint, end } = bend(hip, { x: hip.x + dx * face, y }, BODY.thigh, BODY.shin, side);
    return { knee: joint, foot: end };
  });
  const arms = spec.hands.map(([dx, dy]) => {
    const { joint, end } = bend(shoulder, { x: shoulder.x + dx * face, y: shoulder.y + dy }, BODY.upperArm, BODY.foreArm, -side);
    return { elbow: joint, hand: end };
  });
  return { x: spec.x, z: spec.z, face, side, lean: spec.lean, hip, shoulder, head, legs, arms };
}

function gaitSpec(x, phase, pace, face) {
  const cycle = phase * TAU;
  const stride = mix(0.8, 1.5, pace);
  const lift = mix(0.28, 0.95, pace);
  const foot = offset => [stride * Math.cos(cycle + offset), Math.max(0, -Math.sin(cycle + offset)) * lift];
  const swing = Math.cos(cycle);
  // Arms hang and sway at a walk, and pump with bent elbows at a sprint.
  const reach = mix(0.38, 0.8, pace);
  const hang = mix(-1.88, -1.2, pace);
  return {
    x, z: 0, face,
    hip: mix(3.14, 2.9, pace) + 0.07 * Math.cos(2 * cycle),
    lean: mix(0.06, 0.3, pace), tilt: -mix(0.03, 0.16, pace),
    feet: [foot(0), foot(Math.PI)],
    hands: [[-reach * swing, hang + 0.25 * pace * swing], [reach * swing, hang - 0.25 * pace * swing]],
  };
}

/** Put a hand on a world point. Only for specs facing squarely left or right. */
function setHand(spec, index, point) {
  const shoulder = shoulderOf(spec);
  spec.hands[index] = [(point.x - shoulder.x) * spec.face, point.y - shoulder.y];
}

/** The dribbling hand rides the ball near the top of its bounce and waits above it otherwise. */
function dribbleHand(spec, index, ball, top) {
  setHand(spec, index, { x: ball.x, y: Math.max(ball.y + BALL_RADIUS * 0.85, top - 0.45) });
}

/** Ball path from one hand to the other with a single bounce off the floor in between. */
function through(from, floor, to, q) {
  if (q <= 0) return { x: from.x, y: from.y };
  if (q >= 1) return { x: to.x, y: to.y };
  if (q < 0.5) {
    const s = q / 0.5;
    return { x: mix(from.x, floor.x, s), y: mix(from.y, floor.y, easeIn(s)) };
  }
  const s = (q - 0.5) / 0.5;
  return { x: mix(floor.x, to.x, s), y: mix(floor.y, to.y, easeOut(s)) };
}

/**
 * The giving hand pushes the ball down and lets go; the taking hand leaves its
 * resting spot to meet it on the way up. Resting spots are the spec's own hands.
 */
function passHands(spec, ball, q, giver, taker) {
  const shoulder = shoulderOf(spec);
  const above = lift => [(ball.x - shoulder.x) * spec.face, Math.max(ball.y + lift, 1.55) - shoulder.y];
  spec.hands[giver] = mixPair(above(0.45), spec.hands[giver], smooth(span(q, 0.35, 0.62)));
  spec.hands[taker] = mixPair(spec.hands[taker], above(0.4), smooth(span(q, 0.42, 0.7)));
}

// ── Ball handler ──────────────────────────────────────────────────────────

const bringUpPace = u => clamp01(Math.pow(1 - u, 0.6));

/**
 * Gait phase after fraction `u` of the bring-up. A sprint covers far more
 * floor per stride than a walk, so phase is the distance integrated over the
 * stride length at each pace; that keeps the planted foot from sliding as he slows.
 */
function bringUpPhase(u, distance) {
  const steps = 16;
  let phase = 0;
  for (let i = 0; i < steps; i += 1) {
    const s = u * (i + 0.5) / steps;
    phase += 1.7 * Math.pow(1 - s, 0.7) / mix(3.4, 10, bringUpPace(s));
  }
  return phase * distance * u / steps;
}

function bringUp(t, plan) {
  const u = clamp01(t / B.sizeup);
  const setX = plan.spot + 0.4;
  const x = START_X + (setX - START_X) * (1 - Math.pow(1 - u, 1.7));
  const pace = bringUpPace(u);
  const spec = gaitSpec(x, bringUpPhase(u, setX - START_X), pace, 1);
  const top = spec.hip * 0.93;
  const bounce = frac(t / 0.44);
  const ball = { x: x + mix(1.15, 1.85, pace), y: BALL_RADIUS + (top - BALL_RADIUS) * 4 * bounce * (1 - bounce), depth: 'near' };
  dribbleHand(spec, 0, ball, top);
  return { spec, ball };
}

function sizeUp(t, plan) {
  const local = t - B.sizeup;
  const x = plan.spot + 0.4;
  const front = { x: x + 1.2, y: 2.35 };
  const back = { x: x - 1.0, y: 2.3 };
  const floor = { x: x + 0.12, y: BALL_RADIUS };
  // Two rhythm dribbles between the legs: front to back, then back to front.
  const first = local < 0.58;
  const q = first ? span(local, 0.1, 0.5) : span(local, 0.66, 1.06);
  const ball = first ? through(front, floor, back, q) : through(back, floor, front, q);
  const dip = Math.sin(Math.PI * q);
  const spec = {
    x, z: 0.12 * Math.sin(local * 5.2), face: 1,
    hip: 2.74 - 0.12 * dip, lean: 0.3 + 0.05 * dip, tilt: -0.12,
    feet: [[1.1, 0], [-0.95, 0]], hands: [[0.85, -1.45], [-0.5, -1.25]],
  };
  if (first) passHands(spec, ball, q, 0, 1);
  else passHands(spec, ball, q, 1, 0);
  ball.depth = q > 0 && q < 1 ? 'mid' : ball.x > x ? 'near' : 'far';
  return { spec, ball };
}

function drive(t, plan) {
  const u = span(t, B.drive, B.snatch);
  const x = plan.spot + 0.4 + DRIVE_REACH * easeOut(u);
  const spec = gaitSpec(x, 0.15 + u * 0.95, 1, 1);
  spec.hip = 2.58;
  spec.lean = mix(0.3, 0.58, easeOut(u));
  spec.tilt = -0.25;
  spec.z = mix(0.1, 0.5, u);
  // One hard dribble out in front.
  const down = span(u, 0, 0.45);
  const up = span(u, 0.45, 0.9);
  const ball = u < 0.45
    ? { x: x + mix(1.3, 1.95, down), y: mix(2.15, BALL_RADIUS, easeIn(down)) }
    : { x: x + mix(1.95, 1.5, up), y: mix(BALL_RADIUS, 2.05, easeOut(up)) };
  ball.depth = 'near';
  dribbleHand(spec, 0, ball, 2.45);
  return { spec, ball };
}

function snatch(t, plan) {
  const u = span(t, B.snatch, B.stepback);
  const s = smooth(u);
  const from = plan.spot + 0.4 + DRIVE_REACH;
  const x = from - s;
  // The lead foot stays planted while the hips recoil and the ball comes back through the legs.
  const spec = {
    x, z: mix(0.5, 0.2, s), face: 1,
    hip: mix(2.58, 2.32, s), lean: mix(0.58, 0.02, s), tilt: mix(-0.25, 0.05, s),
    feet: [[1.21 + (from - x), 0], [mix(-1.21, -0.85, s), 0.56 * (1 - span(u, 0, 0.35))]],
    hands: [[0.9, -1.4], [-0.45, -1.2]],
  };
  const q = span(u, 0.05, 0.9);
  const ball = through({ x: from + 1.5, y: 2.05 }, { x: x + 0.45, y: BALL_RADIUS }, { x: x - 1.0, y: 2.25 }, q);
  passHands(spec, ball, q, 0, 1);
  ball.depth = q <= 0 ? 'near' : q < 1 ? 'mid' : 'far';
  return { spec, ball };
}

function stepBack(t, plan) {
  const u = span(t, B.stepback, B.rise);
  const s = smooth(u);
  const x = mix(plan.spot + 0.4 + DRIVE_REACH - 1, plan.spot, s);
  const spec = {
    x, z: mix(0.2, 0, s), face: 1,
    hip: mix(2.32, 2.95, s) + 0.45 * Math.sin(Math.PI * span(u, 0.1, 0.85)),
    lean: -0.16 * Math.sin(Math.PI * u) + 0.04 * u, tilt: 0.05,
    feet: [
      [mix(2.21, 0.32, s), 0.6 * Math.sin(Math.PI * span(u, 0.15, 0.9))],
      [mix(-0.85, -0.32, s), 0.65 * Math.sin(Math.PI * span(u, 0.05, 0.72))],
    ],
    hands: [[0.9, -1.4], [-0.45, -1.2]],
  };
  // The back hand carries the ball round to the shooting pocket; the lead hand meets it there.
  const shoulder = shoulderOf(spec);
  const gather = smooth(span(u, 0.1, 0.8));
  const ball = {
    x: mix(x - 1.0, shoulder.x + 0.88, gather),
    y: mix(2.25, shoulder.y - 0.3, gather),
    depth: gather < 0.45 ? 'far' : 'near',
  };
  setHand(spec, 1, { x: ball.x - 0.2 * gather, y: ball.y - 0.1 + 0.3 * (1 - gather) });
  const join = smooth(span(u, 0.35, 0.8));
  spec.hands[0] = mixPair([0.9, -1.4], [0.62, -0.72], join);
  return { spec, ball };
}

function shoot(t, plan) {
  const local = t - B.rise;
  const dip = smooth(span(local, 0, 0.25));
  const extend = smooth(span(local, 0.25, 0.37));
  const air = span(local, 0.37, 0.97);
  const jump = JUMP * 4 * air * (1 - air);
  const land = Math.sin(Math.PI * span(local, 0.97, 1.3));
  const set = smooth(span(local, 0.04, 0.3));
  const release = smooth(span(local, 0.3, 0.55));
  const snap = smooth(span(local, 0.55, 0.68));
  const lower = smooth(span(local, 0.95, 1.2));
  const sweep = Math.sin(Math.PI * air);
  // Pocket → set point above the brow → full extension → wrist snap → arms down.
  const near = swingPair(mixPair(mixPair(swingPair([0.62, -0.72], [0.48, 0.72], set), [0.55, 1.97], release), [1.0, 1.66], snap), [0.3, -1.45], lower);
  const far = swingPair(mixPair(swingPair([0.5, -0.8], [0.35, 0.62], set), [0.42, 1.3], release), [0.1, -1.45], smooth(span(local, 0.55, 0.9)));
  const spec = {
    x: plan.spot + 0.3 * smooth(air), z: 0, face: 1,
    hip: mix(mix(2.95, 2.56, dip), 3.2, extend) + jump - 0.28 * land,
    lean: 0.04 + 0.08 * dip - 0.15 * extend + 0.07 * lower, tilt: -0.12 * release * (1 - lower),
    feet: [[0.32 + 0.3 * sweep, jump * 0.9], [-0.32 + 0.26 * sweep, jump * 0.9]],
    hands: [near, far],
  };
  const hand = solveFigure(spec).arms[0].hand;
  return { spec, ball: { x: hand.x + 0.26, y: hand.y + 0.44, depth: 'near' } };
}

function walkAway(t, plan) {
  const holds = plan.celebration === 'night' || plan.celebration === 'point';
  const start = AWAY + 0.15;
  const walked = WALK_SPEED * (holds
    ? Math.max(0, Math.min(t, PARTY_FROM) - start) + Math.max(0, t - PARTY_TO)
    : Math.max(0, t - start));
  const x = plan.spot + 0.3 - walked;
  const walk = gaitSpec(x, walked / 4.4, 0.1, 1 - 2 * smooth(span(t, AWAY, AWAY + 0.32)));
  const party = smooth(span(t, PARTY_FROM - 0.1, PARTY_FROM + 0.25)) * (1 - smooth(span(t, PARTY_TO - 0.25, PARTY_TO + 0.1)));
  if (party <= 0 || plan.celebration === 'stroll') return { spec: walk, ball: null };

  const beat = t - PARTY_FROM;
  let pose;
  if (plan.celebration === 'night') {
    // Hands pressed together under a tilted head.
    pose = {
      ...walk, hip: 3.08 + 0.03 * Math.sin(beat * 3), lean: 0.03 + 0.03 * Math.sin(beat * 3), tilt: 0.46,
      feet: [[0.28, 0], [-0.3, 0]], hands: [[0.66, 0.6], [0.52, 0.48]],
    };
  } else if (plan.celebration === 'point') {
    pose = {
      ...walk, hip: 3.18, lean: -0.05, tilt: -0.3,
      feet: [[0.3, 0], [-0.3, 0]], hands: [[0.18, 2.0], [-0.15, -1.5]],
    };
  } else {
    const shake = Math.sin(beat * 19);
    pose = {
      ...walk, lean: walk.lean + 0.13 * shake,
      hands: [[0.5, -0.62 + 0.14 * shake], [0.36, -0.7 - 0.14 * shake]],
    };
  }
  return { spec: blendSpec(walk, pose, party), ball: null };
}

const HERO_TRACK = [
  [B.bringup, bringUp, 0], [B.sizeup, sizeUp, 0.28], [B.drive, drive, 0.16], [B.snatch, snatch, 0.08],
  [B.stepback, stepBack, 0.08], [B.rise, shoot, 0.12], [AWAY, walkAway, 0.3],
];

// ── Defender ──────────────────────────────────────────────────────────────

// An arm's length off the ball handler, so the two silhouettes never merge.
const guardX = plan => plan.spot + 5.1;
const beatenX = plan => guardX(plan) + 3.7;

function guard(t, plan) {
  const approach = smooth(span(t, 2.0, B.sizeup));
  const mirror = 0.22 * Math.sin((t - B.sizeup) * 5.2) * span(t, B.sizeup, B.sizeup + 0.3);
  const shuffle = approach > 0 && approach < 1 ? 0.16 : 0.05;
  return {
    x: mix(plan.spot + 6.6, guardX(plan), approach) + mirror, z: 0, face: -1,
    hip: 2.6 + 0.05 * Math.sin(t * 8), lean: 0.34, tilt: -0.2,
    feet: [[0.75, shuffle * Math.max(0, Math.sin(t * 11))], [-0.7, shuffle * Math.max(0, -Math.sin(t * 11))]],
    hands: [[0.95, -0.35 + 0.14 * Math.sin(t * 6)], [0.62, -1.15 + 0.1 * Math.sin(t * 6 + 1.6)]],
  };
}

function retreat(t, plan) {
  const u = span(t, B.drive, B.snatch);
  const spec = gaitSpec(guardX(plan) + 3.7 * easeOut(u), 0.5 - u * 1.15, 0.7, -1);
  spec.hip = 2.75;
  spec.lean = mix(0.34, -0.08, u);
  spec.tilt = -0.1;
  spec.z = mix(0, -0.45, u);
  spec.hands = [[0.75, -0.85], [0.5, -1.25]];
  return spec;
}

function stumble(t, plan) {
  const u = span(t, B.snatch, B.stepback);
  // Momentum carries him back while he tries to plant; the lead foot slides out.
  const x = beatenX(plan) + 0.55 * easeOut(span(u, 0, 0.5)) - 0.5 * smooth(span(u, 0.45, 1));
  return {
    x, z: mix(-0.45, -0.3, u), face: -1,
    hip: mix(2.75, 2.2, smooth(u)), lean: mix(-0.08, 0.28, smooth(span(u, 0.2, 1))), tilt: -0.15,
    feet: [[mix(-0.4, 1.9, smooth(span(u, 0.3, 1))), 0.25 * Math.sin(Math.PI * span(u, 0.3, 0.7))], [mix(0.5, -0.9, smooth(u)), 0]],
    hands: [[mix(0.75, 1.1, u), mix(-0.85, 0.25, u)], [mix(0.5, -0.6, u), mix(-1.25, 0.45, u)]],
  };
}

function fall(t, plan) {
  const u = span(t, B.stepback, B.rise);
  const drop = easeIn(span(u, 0, 0.78));
  const back = smooth(span(u, 0, 0.8));
  return {
    x: beatenX(plan) + 0.05 + 0.5 * u, z: -0.3, face: -1,
    hip: mix(2.2, 0.55, drop) + 0.12 * Math.sin(Math.PI * span(u, 0.78, 1)),
    lean: mix(0.28, -0.85, back), tilt: mix(-0.15, 0.3, u),
    feet: [[mix(1.9, 2.35, u), 1.0 * Math.sin(Math.PI * span(u, 0.1, 0.8))], [mix(-0.9, 1.7, smooth(u)), 0.4 * Math.sin(Math.PI * u)]],
    // Arms windmill out and away from the body before the hands find the floor.
    hands: [[mix(1.1, -0.45, back) + 0.9 * Math.sin(Math.PI * back), mix(0.25, -1.8, back) + 0.5 * Math.sin(Math.PI * back)],
      [mix(-0.6, -0.5, back) - 0.5 * Math.sin(Math.PI * back), mix(0.45, -1.8, back) + 0.5 * Math.sin(Math.PI * back)]],
  };
}

function seated(t, plan) {
  const reach = Math.sin(Math.PI * span(t, B.rise + 0.1, B.rise + 0.75));
  const watch = smooth(span(t, B.flight, B.flight + 0.5)) * (1 - smooth(span(t, B.swish + 0.15, B.swish + 0.6)));
  const slump = smooth(span(t, B.swish + 0.15, B.swish + 0.7));
  const rise = smooth(span(t, 9.2, 10.4));
  return {
    x: beatenX(plan) + 0.55, z: -0.3, face: -1,
    hip: 0.55 + 0.6 * rise, lean: -0.85 + 0.3 * slump + 0.2 * rise, tilt: 0.3 - 0.75 * watch + 0.45 * slump,
    feet: [[2.35 - 0.3 * rise, 0.02], [1.7, 0]],
    hands: [mixPair(swingPair([-0.45, -1.8], [0.75, 1.15], reach), [0.9, -0.95], slump), mixPair([-0.5, -1.8], [-0.4, -1.75], slump)],
  };
}

const DEFENDER_TRACK = [
  [B.bringup, guard, 0], [B.drive, retreat, 0.1], [B.snatch, stumble, 0.08], [B.stepback, fall, 0.08], [B.rise, seated, 0.1],
];

/**
 * Evaluate the active segment. For `fade` seconds after it starts, `previous`
 * carries the outgoing segment (held at its last pose) so callers can crossfade.
 */
function runTrack(track, t, plan) {
  let index = 0;
  for (let i = 1; i < track.length; i += 1) if (t >= track[i][0]) index = i;
  const [from, segment, fade] = track[index];
  const fading = index > 0 && t - from < fade;
  return {
    current: segment(t, plan),
    previous: fading ? track[index - 1][1](t, plan) : null,
    weight: fading ? smooth((t - from) / fade) : 1,
  };
}

// ── Ball in the air ───────────────────────────────────────────────────────

function flightAt(release, t) {
  const dt = t - B.flight;
  const vy = (RIM.y - release.y + 0.5 * GRAVITY * FLIGHT_SECONDS * FLIGHT_SECONDS) / FLIGHT_SECONDS;
  return {
    x: mix(release.x, RIM.x, dt / FLIGHT_SECONDS),
    y: release.y + vy * dt - 0.5 * GRAVITY * dt * dt,
  };
}

/** Through the net, then a few dying bounces under the hoop. */
function dropAt(t) {
  let dt = t - B.swish;
  const x = RIM.x + 0.2 + 1.9 * (1 - Math.exp(-1.1 * dt));
  let y = RIM.y;
  let speed = -11;
  for (let bounce = 0; bounce < 5; bounce += 1) {
    const hit = (speed + Math.sqrt(speed * speed + 2 * GRAVITY * (y - BALL_RADIUS))) / GRAVITY;
    if (dt <= hit) return { x, y: y + speed * dt - 0.5 * GRAVITY * dt * dt };
    dt -= hit;
    speed = -(speed - GRAVITY * hit) * 0.52;
    y = BALL_RADIUS;
    if (speed < 2.5) break;
  }
  return { x, y: BALL_RADIUS };
}

function planFor(possession) {
  return {
    spot: SPOTS[possession % SPOTS.length],
    celebration: CELEBRATIONS[possession % CELEBRATIONS.length],
  };
}

/**
 * @param {number} elapsedMs Milliseconds since the shared wait clock started.
 * @returns Frame of the play: solved figures, ball, net and score. Pure.
 */
export function resolveHoopsPlay(elapsedMs) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const possession = Math.floor(elapsed / HOOPS_POSSESSION_MS);
  const t = playSeconds((elapsed - possession * HOOPS_POSSESSION_MS) / 1000);
  const plan = planFor(possession);

  const heroStep = runTrack(HERO_TRACK, t, plan);
  const heroSpec = heroStep.previous
    ? blendSpec(heroStep.previous.spec, heroStep.current.spec, heroStep.weight)
    : heroStep.current.spec;
  const defenderStep = runTrack(DEFENDER_TRACK, t, plan);
  const defenderSpec = defenderStep.previous
    ? blendSpec(defenderStep.previous, defenderStep.current, defenderStep.weight)
    : defenderStep.current;

  let ball;
  if (t < B.flight) {
    ball = { ...heroStep.current.ball, loose: false, trail: [], spin: t * 5 };
    if (heroStep.previous) {
      ball.x = mix(heroStep.previous.ball.x, ball.x, heroStep.weight);
      ball.y = mix(heroStep.previous.ball.y, ball.y, heroStep.weight);
    }
  } else {
    const release = shoot(B.flight, plan).ball;
    const inAir = t < B.swish;
    const point = inAir ? flightAt(release, t) : dropAt(t);
    const trail = [];
    if (inAir) {
      for (let i = 1; i <= 5; i += 1) {
        const earlier = t - i * 0.03;
        if (earlier > B.flight) trail.push(flightAt(release, earlier));
      }
    }
    ball = { ...point, depth: 'near', loose: true, trail, spin: -(t - B.flight) * 9 };
  }

  const made = t >= B.swish;
  const sinceMake = t - B.swish;
  return {
    possession, time: t, beat: beatAt(t), spot: plan.spot, celebration: plan.celebration,
    hero: solveFigure(heroSpec), defender: solveFigure(defenderSpec), ball,
    net: made ? Math.exp(-sinceMake * 4.2) : 0, netAge: made ? sinceMake : 0,
    pop: made && sinceMake < 1.25 ? sinceMake / 1.25 : -1,
    doze: plan.celebration === 'night' && t > PARTY_FROM + 0.2 && t < PARTY_TO ? t - PARTY_FROM - 0.2 : -1,
    points: possession * 3 + (made ? 3 : 0),
    fade: Math.min(smooth(span(t, 0, 0.3)), 1 - smooth(span(t, PLAY_SECONDS - 0.45, PLAY_SECONDS - 0.05))),
  };
}
