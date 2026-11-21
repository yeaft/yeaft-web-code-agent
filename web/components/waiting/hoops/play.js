/**
 * Choreography of the basketball waiting animation: possessions that come
 * round in turn, resolved as a pure function of elapsed time. Nothing here
 * keeps state, so any canvas reading the same clock shows the same frame.
 *
 * Every body movement is motion capture (mocap.js): real players walking the
 * ball up, working a defender, pulling up and going to the rim, strung
 * together clip after clip. What the capture could not hold is worked out
 * from it: the ball follows the hands (it leaves the hand where a push ends,
 * bounces once, and is met where the next push begins), and the defender is
 * the ball handler seen in a mirror a beat late, so he slides, sits down and
 * goes up with the shot as the ball handler does, his chest up and giving
 * ground when his man leans in. When he is beaten he trails his man on the
 * far side, a beat behind, stride for stride.
 *
 * Play space is in feet. The rim's centre is above the origin; the ball is
 * shot toward +x, y is up. Where on the arc it happens is `angle`, and the
 * renderer turns the court under the play instead.
 */
import { J, blendPoses, clipInfo, clipPose, figureOf, mirrored, moved, perform, rerooted, upright } from './mocap.js';
import { add, cross, mix, mix3, mul, smooth, span, sub, turn, unit } from '../stick/vec.js';

export const RIM = Object.freeze({ y: 10, radius: 0.75 });
export const BALL_RADIUS = 0.4;
export const DEFENDER_SIZE = 1.04;

const GRAVITY = 32.2;
/** Share of its speed a ball keeps off the floor. */
const BOUNCE = 0.78;
/** The backboard's face, out from the rim's centre (see court.js). */
const BOARD = 1.25;
/** How long a celebration holds him, and how long the possession lasts after it. */
const PARTY = 1.75;
const OUTRO = 0.9;
const WALK = clipInfo('walk');
const WALK_STRIDE = Math.hypot(WALK.loop[0], WALK.loop[1]);
const WALK_SPEED = WALK_STRIDE / WALK.seconds;
/**
 * How far forward a back may lean, in radians: eased from the first number
 * toward the second. The capture of the handles dribbles nearly doubled
 * over; a guard in a game keeps his chest up, and his defender more so.
 */
const HERO_LEAN = [0.5, 0.8];
const GUARD_LEAN = [0.3, 0.55];
/** Least room, in feet, between the two upper bodies' joints along the line between them. */
const ROOM = 1.9;
const UPPER = [J.chest, J.neck, J.crown, J.lshoulder, J.rshoulder];

// ── The possessions ───────────────────────────────────────────────────────
//
// `hero` lists the clips the ball handler plays, one into the next; the
// entry `shot` names holds the gather and the release. The shot goes toward
// where he is facing as it leaves his hand (`aim: 'facing'`) or where he is
// going (`'travel'`), from `range` feet out. His defender mirrors him `lag`
// seconds late from `gap` feet in front, closing to `close` as he rises; on a
// drive he is beaten at `beaten` (seconds before the release) and trails him.

const PULLUP = {
  name: 'pullup', worth: 3, side: 1, angles: [0, -0.45, 0.4],
  hero: [
    { clip: 'bringup', from: 0, to: 2.2 },
    { clip: 'handles', from: 0.15, to: 2.55, blend: 0.35 },
    { clip: 'pullup', from: 0.2, to: 2.35, blend: 0.35 },
  ],
  shot: 2, aim: 'facing', range: 23.2, flight: 1.3,
  defender: { lag: 0.2, gap: 4.6, close: 3.3 },
};

const LAYUP = {
  name: 'layup', worth: 2, side: -1, angles: [0.35, -0.3, 0.6],
  hero: [
    { clip: 'bringup', from: 0, to: 2.0 },
    { clip: 'layup', from: 0.0, to: 2.9, blend: 0.4 },
  ],
  shot: 1, aim: 'travel', range: 2.6, flight: 0.55, bank: true,
  defender: { lag: 0.22, gap: 4.4, close: 4.4, beaten: 0.8 },
};

const JUMPER = {
  name: 'jumper', worth: 2, side: 1, angles: [-0.6, 0.25, -0.2],
  hero: [
    { clip: 'bringup', from: 0, to: 5.85 },
  ],
  shot: 0, aim: 'facing', range: 16.5, flight: 1.05,
  defender: { lag: 0.24, gap: 5.0, close: 3.6 },
};

const DRIVE = {
  name: 'drive', worth: 2, side: -1, angles: [-0.25, 0.5, 0],
  hero: [
    { clip: 'bringup', from: 0.6, to: 2.4 },
    { clip: 'handles', from: 0.9, to: 2.55, blend: 0.35 },
    { clip: 'layup', from: 0.35, to: 2.9, blend: 0.4 },
  ],
  shot: 2, aim: 'travel', range: 2.6, flight: 0.55, bank: true,
  defender: { lag: 0.2, gap: 4.4, close: 4.4, beaten: 0.75 },
};

// ── Ball in the hands ─────────────────────────────────────────────────────

const HAND = [J.lhand, J.rhand];
const WRIST = [J.lwrist, J.rwrist];

/** Where a ball sits under a dribbling hand: below the palm, a little past the fingers. */
function underHand(pose, hand) {
  const h = pose[HAND[hand]];
  const w = pose[WRIST[hand]];
  const reach = unit([h[0] - w[0], 0, h[2] - w[2]]);
  return [h[0] + reach[0] * 0.12, h[1] - BALL_RADIUS - 0.06, h[2] + reach[2] * 0.12];
}

/**
 * A ball held for a shot: between the hands while both are on it, then on
 * the shooting hand's fingers once the other comes off.
 */
function heldBall(pose, shooter) {
  const l = pose[J.lhand];
  const r = pose[J.rhand];
  const fig = figureOf(pose);
  const between = add(mul(add(l, r), 0.5), mul(fig.forward, 0.12));
  const h = pose[HAND[shooter]];
  const w = pose[WRIST[shooter]];
  const along = unit(sub(h, w));
  const onFingers = add(add(h, mul(along, 0.1)), [0, BALL_RADIUS * 0.8, 0]);
  const apart = Math.hypot(l[0] - r[0], l[1] - r[1], l[2] - r[2]);
  return mix3(between, onFingers, smooth(span(apart, 0.95, 1.5)));
}

/**
 * A dribble in the air: down from where it left the hand, once off the
 * floor, and up into the hand that meets it. Thrown down hard enough to make
 * the trip in the time there is.
 */
function bounced(from, to, since, total) {
  const h0 = Math.max(0.05, from[1] - BALL_RADIUS);
  const h1 = Math.max(0.05, to[1] - BALL_RADIUS);
  // Time to the floor: where what is left after it carries the ball back up to the hand.
  let lo = 1e-3;
  let hi = total - 1e-3;
  for (let i = 0; i < 28; i += 1) {
    const down = (lo + hi) / 2;
    const up = total - down;
    const rebound = BOUNCE * (h0 / down + 0.5 * GRAVITY * down);
    if (rebound * up - 0.5 * GRAVITY * up * up > h1) lo = down;
    else hi = down;
  }
  const down = (lo + hi) / 2;
  const u = since / total;
  const x = mix(from[0], to[0], u);
  const z = mix(from[2], to[2], u);
  if (since < down) {
    const v0 = h0 / down - 0.5 * GRAVITY * down;
    return [x, BALL_RADIUS + h0 - v0 * since - 0.5 * GRAVITY * since * since, z];
  }
  const s = since - down;
  const rebound = BOUNCE * (h0 / down + 0.5 * GRAVITY * down);
  return [x, BALL_RADIUS + rebound * s - 0.5 * GRAVITY * s * s, z];
}

/**
 * The dribble as one list of { catch, hand, release } in performance time,
 * from every clip's own, each kept while its clip is the one showing. A
 * catch comes at least a short bounce after the release before it.
 */
function dribblesOf(perf, entries, gather) {
  const all = [];
  perf.parts.forEach((part, index) => {
    const info = clipInfo(part.clip);
    const next = perf.parts[index + 1];
    const own = [part.start + part.blend / 2, next ? next.start + next.blend / 2 : Infinity];
    for (const [caught, hand, released] of info.dribbles || []) {
      const release = perf.time(index, released);
      if (released < part.from || released > part.to || release < own[0] || release >= own[1]) continue;
      all.push({ catch: perf.time(index, caught), hand, release });
    }
  });
  all.sort((p, q) => p.release - q.release);
  const kept = [];
  for (const dribble of all) {
    if (dribble.release > gather - 0.22) break;
    const last = kept[kept.length - 1];
    const earliest = last ? last.release + 0.26 : -Infinity;
    const caught = Math.max(dribble.catch, earliest);
    if (caught > dribble.release - 0.06) continue;
    kept.push({ ...dribble, catch: caught });
  }
  return kept;
}

// ── Putting a possession together ─────────────────────────────────────────

/** Rotate and move a pose from performance space into play space. */
const placeWith = place => pose => moved(pose, place.angle, place.dx, place.dz);

function staged(spec) {
  const perf = perform(spec.hero);
  const shotPart = spec.shot;
  const shotInfo = clipInfo(spec.hero[shotPart].clip);
  const gather = perf.time(shotPart, shotInfo.gather);
  const release = perf.time(shotPart, shotInfo.release);
  const shooter = shotInfo.shooter;
  const dribbles = dribblesOf(perf, spec.hero, gather);

  // Turn the performance so the shot goes toward +x, from `range` feet out.
  const atRelease = perf.at(release);
  const before = perf.at(release - 0.25);
  const facing = (() => {
    const s = sub(atRelease[J.rshoulder], atRelease[J.lshoulder]);
    return Math.atan2(-s[0], s[2]);
  })();
  const travel = Math.atan2(atRelease[J.pelvis][2] - before[J.pelvis][2], atRelease[J.pelvis][0] - before[J.pelvis][0]);
  const aim = spec.aim === 'travel' ? travel : facing;
  const ballOut = turn(heldBall(atRelease, shooter), -aim);
  const place = { angle: -aim, dx: -spec.range - ballOut[0], dz: -ballOut[2] };
  const put = placeWith(place);
  const heroAt = t => upright(put(perf.at(t)), HERO_LEAN[0], HERO_LEAN[1]);

  const flight = spec.flight;
  const made = release + flight;
  const party = made + 0.5;
  const seconds = party + PARTY + OUTRO;
  const walk = Math.min(perf.duration - 0.35, release + 0.95);
  const sizeup = perf.parts.length > 1 ? perf.parts[1].start : 1.4;
  const releasePoint = heldBall(heroAt(release), shooter);
  const landing = heroAt(walk);

  const play = {
    ...spec, perf, put, heroAt, dribbles, gather, release, shooter, flight, made, party, seconds,
    walk, sizeup, releasePoint,
    ms: Math.round(seconds * 1000),
    move: sizeup + 0.5,
    stand: [releasePoint[0], releasePoint[2]],
    spot: (() => { const p = heroAt(sizeup)[J.pelvis]; return [p[0], p[2]]; })(),
    // Walking off: from where he lands, back up the court, a little toward the camera.
    away: { from: [landing[J.pelvis][0], landing[J.pelvis][2]], heading: Math.PI - 0.25 * spec.side },
  };
  play.marks = {
    bringup: 0, sizeup, move: play.move, gather, flight: release, swish: made, celebrate: party, reset: seconds - 0.4,
  };
  play.routes = spec.angles.map(angle => routeOf(play, angle));
  // The move, the gather, the shot about to leave his hand (head to shoes still in the picture), the ball going in.
  play.stills = [sizeup + 0.9, gather + 0.15, release - 0.15, made + 0.05];
  return play;
}

// ── Walking along a path ──────────────────────────────────────

/**
 * A looping clip played along a straight line from `from` heading `heading`,
 * `distance` feet along it: the stride is the capture's, the root the path's.
 */
function loopAlong(name, stride, seconds, distance, from, heading) {
  // The capture runs along +x from the origin, so turning it carries it down the path, sway and all.
  return moved(clipPose(name, (distance / stride) * seconds), heading, from[0], from[1]);
}

/** Distance covered by `t` seconds after setting off: easing up to `speed` over `ramp` seconds. */
const covered = (t, speed, ramp) => (t <= 0 ? 0 : t < ramp ? (speed * t * t) / (2 * ramp) : speed * (t - ramp / 2));

/** His walk off, back up the court after the shot. */
function walkingOff(play, t, lag = 0, aside = 0) {
  const since = t - play.walk - lag;
  const { from, heading } = play.away;
  const side = turn([0, 0, aside], heading);
  return loopAlong('walk', WALK_STRIDE, WALK.seconds, covered(since, WALK_SPEED * 0.9, 0.8), [from[0] + side[0], from[1] + side[2]], heading);
}

// ── Ball handler ──────────────────────────────────────────────────────────

function heroAt(play, t) {
  let pose = play.heroAt(Math.min(t, play.perf.duration));
  if (t > play.walk) pose = blendPoses(pose, walkingOff(play, t), smooth(span(t, play.walk, play.walk + 0.7)));
  return pose;
}

/** Where the ball is while he has it, or null once it is away. */
function ballAt(play, pose, t) {
  if (t >= play.release) return null;
  if (t >= play.gather) return heldBall(pose, play.shooter);
  const list = play.dribbles;
  if (!list.length || t <= list[0].catch) return underHand(pose, list.length ? list[0].hand : play.shooter);
  for (let i = 0; i < list.length; i += 1) {
    const dribble = list[i];
    if (t < dribble.catch) {
      const before = list[i - 1];
      return bounced(underHand(play.heroAt(before.release), before.hand), underHand(play.heroAt(dribble.catch), dribble.hand), t - before.release, dribble.catch - before.release);
    }
    if (t <= dribble.release) return underHand(pose, dribble.hand);
  }
  // After the last push, down to the floor and up into his hands for the gather.
  const last = list[list.length - 1];
  return bounced(underHand(play.heroAt(last.release), last.hand), heldBall(play.heroAt(play.gather), play.shooter), t - last.release, play.gather - last.release);
}

// ── Defender ──────────────────────────────────────────────────────────────

/** Two-bone reach for an arm: the wrist to `target`, the elbow bending the way it already does. */
function reachArm(pose, side, target) {
  const [shoulder, elbow, wrist, hand] = side ? [J.rshoulder, J.relbow, J.rwrist, J.rhand] : [J.lshoulder, J.lelbow, J.lwrist, J.lhand];
  const s = pose[shoulder];
  const upper = Math.hypot(...sub(pose[elbow], s));
  const lower = Math.hypot(...sub(pose[wrist], pose[elbow]));
  const palm = Math.hypot(...sub(pose[hand], pose[wrist]));
  const toTarget = sub(target, s);
  const far = Math.min(upper + lower - 1e-3, Math.max(Math.abs(upper - lower) + 1e-3, Math.hypot(...toTarget)));
  const dir = unit(toTarget);
  const old = sub(pose[elbow], s);
  let bend = sub(old, mul(dir, old[0] * dir[0] + old[1] * dir[1] + old[2] * dir[2]));
  if (Math.hypot(...bend) < 1e-4) bend = cross(dir, [0, 1, 0]);
  bend = unit(bend);
  const cosine = (upper * upper + far * far - lower * lower) / (2 * upper * far);
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  const e = add(s, add(mul(dir, upper * cosine), mul(bend, upper * sine)));
  const w = add(s, mul(dir, far));
  const out = pose.slice();
  out[elbow] = e;
  out[wrist] = w;
  out[hand] = add(w, mul(unit(sub(w, e)), palm));
  return out;
}

/** Arms out and live: the hand on the ball's side low, the other up at the passing lane. */
function guarding(pose, t, weight) {
  if (weight <= 0) return pose;
  const fig = figureOf(pose);
  let out = pose;
  for (const side of [0, 1]) {
    const sway = 0.12 * Math.sin(t * 5.1 + side * 2.1);
    // [forward, out to his right, up] from the shoulder.
    const reach = side ? [0.7, 1.3, 0.05 + sway] : [0.95, -0.9, -1.0 + sway];
    const s = pose[side ? J.rshoulder : J.lshoulder];
    const target = add(add(add(s, mul(fig.forward, reach[0])), mul(fig.right, reach[1])), [0, reach[2], 0]);
    const wrist = pose[side ? J.rwrist : J.lwrist];
    out = reachArm(out, side, mix3(wrist, target, weight));
  }
  return out;
}

/**
 * The defender moved straight back from the ball handler until neither
 * upper body reaches into the other: when he leans in on his man, his man
 * gives ground. Eased, so he backs off smoothly rather than off a wall.
 */
function giveRoom(pose, hero) {
  const from = hero[J.pelvis];
  const to = pose[J.pelvis];
  const dir = unit([to[0] - from[0], 0, to[2] - from[2]]);
  const reach = (body, root, sign) => Math.max(...UPPER.map(n => sign * ((body[n][0] - root[0]) * dir[0] + (body[n][2] - root[2]) * dir[2])));
  const between = Math.hypot(to[0] - from[0], to[2] - from[2]) - reach(hero, from, 1) - reach(pose, to, -1);
  const back = 0.3 * Math.log1p(Math.exp((ROOM - between) / 0.3));
  return pose.map(p => [p[0] + dir[0] * back, p[1], p[2] + dir[2] * back]);
}

/** How far a beaten defender has gone the wrong way, in feet, and how late he trails his man, in seconds. */
const BITE = 2.4;
const TRAIL = 0.3;

function defenderAt(play, t, heroPose) {
  const { lag, gap, close, beaten } = play.defender;
  const from = beaten === undefined ? Infinity : play.release - beaten;
  // He waits at the spot until the ball handler arrives, mirroring his stance.
  const seen = Math.max(t - lag, play.sizeup);
  const hero = play.heroAt(Math.min(seen, play.perf.duration));
  const hx = hero[J.pelvis][0];
  const hz = hero[J.pelvis][2];
  // Between his man and the rim; on a drive, the line as it was when he was beaten.
  const line = Math.min(seen, from) === seen ? hero : play.heroAt(from);
  const toRim = unit([-line[J.pelvis][0], 0, -line[J.pelvis][2]]);
  // The far side of that line from the camera, where the drive leaves him.
  const wrong = mul([-toRim[2], 0, toRim[0]], toRim[0] * play.side > 0 ? -1 : 1);
  const bite = beaten === undefined ? 0 : BITE * smooth(span(t, from - 0.5, from));
  const space = mix(gap, close, smooth(span(t, play.gather - 0.3, play.release)));
  const x = hx + toRim[0] * space + wrong[0] * bite;
  const z = hz + toRim[2] * space + wrong[2] * bite;
  const yaw = Math.atan2(hz - z, hx - x);
  // Before the ball handler is there, the capture of a low stance stands in for him.
  const body = t - lag < play.sizeup
    ? blendPoses(mirrored(clipPose('handles', 0.3 + Math.max(0, t))), mirrored(hero), smooth(span(t - lag, play.sizeup - 0.5, play.sizeup)))
    : mirrored(hero);
  let pose = rerooted(upright(body, GUARD_LEAN[0], GUARD_LEAN[1]), x, z, yaw);
  // Lower his hands into a guard until the shot goes up; then he goes up with it.
  pose = guarding(pose, t, 1 - smooth(span(t, play.gather - 0.1, play.gather + 0.25)));
  pose = giveRoom(pose, heroPose);
  if (t > from) pose = blendPoses(pose, trailing(play, t, wrong), smooth(span(t, from, from + 0.55)));
  // He walks off beside his man on the side he is already on, so neither crosses behind the other.
  if (t > play.walk + 0.3) pose = blendPoses(pose, walkingOff(play, t, 0.5, (beaten === undefined ? -3.2 : 3.2) * play.side), smooth(span(t, play.walk + 0.3, play.walk + 1.1)));
  return pose;
}

/**
 * Beaten: he turns and comes after his man on the far side, a beat behind,
 * stride for stride with him, and goes up with him at the rim.
 */
function trailing(play, t, wrong) {
  const seen = upright(play.heroAt(Math.min(t - TRAIL, play.perf.duration)), GUARD_LEAN[0], GUARD_LEAN[1]);
  return seen.map(p => [p[0] + wrong[0] * BITE, p[1], p[2] + wrong[2] * BITE]);
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

// ── The loop of possessions ───────────────────────────────────────────────

const PLAYS = [PULLUP, LAYUP, JUMPER, DRIVE].map(staged);
const ROUND_MS = PLAYS.reduce((total, play) => total + play.ms, 0);
const ROUND_POINTS = PLAYS.reduce((total, play) => total + play.worth, 0);
const STARTS = PLAYS.map((_, index) => PLAYS.slice(0, index).reduce((total, play) => total + play.ms, 0));

/** A still for stalled connections: the first shot going up over his defender. */
export const HOOPS_POSTER_MS = Math.round((PLAYS[0].release - 0.15) * 1000);
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
  const turnOf = round % play.angles.length;

  const heroPose = heroAt(play, t);
  const held = ballAt(play, heroPose, t);
  const made = t >= play.made;
  const sinceMake = t - play.made;
  let ball;
  if (held) {
    ball = { at: held, loose: false, trail: [], axis: figureOf(heroPose).right, spin: t * 5 };
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

  const before = PLAYS.slice(0, index).reduce((total, earlier) => total + earlier.worth, 0);
  return {
    possession, name: play.name, time: t, beat: beatAt(play.marks, t), marks: play.marks,
    angle: play.angles[turnOf], side: play.side, spot: play.spot, stand: play.stand, celebration: 'stroll',
    hero: figureOf(heroPose), defender: figureOf(defenderAt(play, t, heroPose), DEFENDER_SIZE), ball,
    // His points for this wait, counting this shot once it drops.
    worth: play.worth, points: round * ROUND_POINTS + before + (made ? play.worth : 0),
    net: made ? Math.exp(-sinceMake * 4.2) : 0, netAge: made ? sinceMake : 0,
    pop: made && sinceMake < 1.3 ? sinceMake / 1.3 : -1,
    dust: [], shake: 0,
    // Headroom the camera should leave while the shot goes up over his defender.
    room: smooth(span(t, play.gather - 0.3, play.gather)) * (1 - smooth(span(t, play.release + 0.4, play.release + 0.9))),
    doze: -1,
    // The first possession is visible immediately; later possessions fade in.
    fade: Math.min(possession > 0 ? smooth(span(t, 0, 0.25)) : 1, 1 - smooth(span(t, play.seconds - 0.4, play.seconds - 0.05))),
  };
}
