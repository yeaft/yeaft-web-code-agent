/**
 * Samples the authored possessions onto the same 19 joints as the replay.
 * Coordinates are in court units (30 is 100 units tall), with y down.
 * Head, shoes and limb lengths are built here; only the acting is keyed.
 */
import { JOINT as J } from './tracks.js';

export const HOOP = [286, -155];
export const HOOP_RADIUS = 12;
const SIDES = [['L', 1], ['R', -1]];
const BALL_RADIUS = 6.17;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mix = (a, b, t) => a + (b - a) * t;

// Shape-preserving Hermite. A held key (such as a planted foot) stays exactly
// there; no overshoot at a stop or bounce, and no ease-to-zero through a run.
function tangent(a, b) {
  return a * b > 0 ? (2 * a * b) / (a + b) : 0;
}

function sample(keys, ms, defaults) {
  if (ms <= keys[0][0]) return defaults.map((value, j) => keys[0][j + 1] ?? value);
  let i = 1;
  while (i < keys.length && keys[i][0] < ms) i += 1;
  if (i === keys.length) return defaults.map((value, j) => keys[i - 1][j + 1] ?? value);
  const a = keys[i - 1];
  const b = keys[i];
  const prev = keys[i - 2];
  const next = keys[i + 1];
  const span = b[0] - a[0];
  const u = (ms - a[0]) / span;
  return defaults.map((value, j) => {
    const col = j + 1;
    const v = a[col] ?? value;
    const w = b[col] ?? value;
    const rate = (w - v) / span;
    const m = prev ? tangent((v - (prev[col] ?? value)) / (a[0] - prev[0]), rate) : 0;
    const n = next ? tangent(rate, ((next[col] ?? value) - w) / (next[0] - b[0])) : 0;
    return mix(v, w, u * u * (3 - 2 * u)) + span * u * (1 - u) * ((1 - u) * m - u * n);
  });
}

/** A two-bone chain. Finite reach keeps the body proportions stable. */
function chain(start, end, a, b, side, profile = 1) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const raw = Math.hypot(dx, dy);
  const x = raw > 1e-4 ? dx / raw : 0;
  const y = raw > 1e-4 ? dy / raw : 1;
  const length = clamp(raw, Math.abs(a - b) + 0.1, a + b - Math.min(a, b) * 0.04);
  const along = (a * a + length * length - b * b) / (2 * length);
  const off = Math.sqrt(Math.max(0, a * a - along * along)) * side * profile;
  return [
    [start[0] + x * along - y * off, start[1] + y * along + x * off],
    [start[0] + x * length, start[1] + y * length],
  ];
}

function actor(spec, ms) {
  const { size, facing } = spec;
  const [hipX, ground, hipHeight, lean, chest, look] = sample(spec.pose, ms, [0, 0, 46, 0, 0.45, facing]);
  let hipY = ground - hipHeight;
  const feet = SIDES.map(([side]) => sample(spec.feet[side], ms, [hipX, ground, 0, facing, 0]));
  const leanAngle = Math.asin(clamp(lean / (size * 0.252), -0.75, 0.75));
  // Keep the planted feet fixed even if the authored stride overreaches.
  // Lower the hips just enough for the longest leg to stay in reach.
  const thigh = size * 0.238;
  const shin = size * 0.232;
  const reach = thigh + shin * 0.95;
  for (const [index, [, sign]] of SIDES.entries()) {
    const [footX, floor, lift, toeDir] = feet[index];
    const shiftX = footX - toeDir * size * 0.018 - hipX - sign * chest * size * 0.071;
    const ankleY = floor - lift - size * 0.043;
    const room = Math.sqrt(Math.max(0, reach ** 2 - shiftX ** 2));
    hipY = Math.max(hipY, ankleY - room - sign * Math.sin(leanAngle) * chest * size * 0.065);
  }
  const shoulderX = hipX + Math.sin(leanAngle) * size * 0.252;
  const shoulderY = hipY - Math.cos(leanAngle) * size * 0.252;
  const p = [];
  p[J.neck] = [shoulderX + lean * 0.12, shoulderY - size * 0.035];
  p[J.top] = [p[J.neck][0] + lean * 0.19, p[J.neck][1] - size * 0.147];
  p[J.nose] = [mix(p[J.top][0], p[J.neck][0], 0.48) + look * size * 0.055, p[J.top][1] + size * 0.087];

  const pose = { points: p, size, presence: 1 };
  // The diagonals place the far and near limbs in slightly different lanes.
  for (const [index, [side, sign]] of SIDES.entries()) {
    const yOffset = sign * Math.sin(leanAngle) * chest;
    const shoulder = [shoulderX + sign * chest * size * 0.11, shoulderY + yOffset * size * 0.095];
    const hip = [hipX + sign * chest * size * 0.071, hipY + yOffset * size * 0.065];
    p[J[`shoulder${side}`]] = shoulder;
    p[J[`hip${side}`]] = hip;

    const [footX, floor, lift, toeDir, pitch] = feet[index];
    const toe = [footX + toeDir * size * 0.064, floor - lift + Math.sin(pitch) * size * 0.038];
    const heel = [footX - toeDir * size * 0.042, floor - lift - Math.sin(pitch) * size * 0.038];
    // The leg is solved against the planted sole, not the other way round.
    const ankle = [footX - toeDir * size * 0.018, floor - lift - size * 0.043];
    const [knee] = chain(hip, ankle, thigh, shin, -toeDir, 0.98);
    p[J[`knee${side}`]] = knee;
    p[J[`ankle${side}`]] = ankle;
    p[J[`toe${side}`]] = toe;
    p[J[`heel${side}`]] = heel;
    pose[`floor${side}`] = floor;

    const [dx, dy, bend] = sample(spec.arms[side], ms, [facing * 6, 25, 1]);
    const [elbow, wrist] = chain(shoulder, [shoulder[0] + dx, shoulder[1] + dy], size * 0.174, size * 0.155, bend, Math.min(1, Math.hypot(dx, dy) / (size * 0.13)));
    p[J[`elbow${side}`]] = elbow;
    p[J[`wrist${side}`]] = wrist;
    pose[`arm${side}Front`] = side === 'R' || dx * facing > 1;
  }
  pose.legLNear = pose.floorL > pose.floorR;
  return pose;
}

function palm(hero, side) {
  if (side === 'both') {
    const [ax, ay] = palm(hero, 'L');
    const [bx, by] = palm(hero, 'R');
    return [(ax + bx) / 2, (ay + by) / 2];
  }
  const [x, y] = hero.points[J[`wrist${side}`]];
  const [ex, ey] = hero.points[J[`elbow${side}`]];
  const length = Math.hypot(x - ex, y - ey) || 1;
  const reach = 0.093 * hero.size;
  return [x + ((x - ex) / length) * reach, y + ((y - ey) / length) * reach];
}

const contact = key => typeof key[1] === 'string';

/**
 * Prepare one play. Key rows start with milliseconds. Body rows contain hip X,
 * projected floor Y, hip height, lean X, chest turn and gaze; foot rows give
 * sole X, floor Y, lift, toe direction and pitch; arm rows place each wrist
 * relative to its shoulder with elbow bend as the last column.
 * Ball rows either name the palm(s) at contact or give a bounce X and floor Y.
 */
export function choreograph(play) {
  const handle = play.handle.map(key => {
    const ball = contact(key) ? palm(actor(play.players.hero, key[0]), key[1]) : [key[1], key[2] - BALL_RADIUS];
    return { at: key[0], side: contact(key) ? key[1] : null, x: ball[0], y: ball[1], floor: key[2] };
  });
  const [x, y] = palm(actor(play.players.hero, play.fire), play.hand);
  const path = [[play.fire, x, y], ...play.targets];
  const air = (ms, i) => {
    const a = path[i];
    const b = path[i + 1];
    const u = clamp((ms - a[0]) / (b[0] - a[0]), 0, 1);
    // Gravity in the projected plane. A board impact is a new, short arc.
    const seconds = (b[0] - a[0]) / 1000;
    return { x: mix(a[1], b[1], u), y: mix(a[2], b[2], u) - 0.5 * 475 * seconds ** 2 * u * (1 - u), held: false };
  };

  const flight = ms => air(ms, path.length > 2 && ms >= path[1][0] ? 1 : 0);
  const turns = [0];
  for (let i = 1; i < handle.length; i += 1) {
    const a = handle[i - 1];
    const b = handle[i];
    turns.push(turns[i - 1] + (a.side && b.side ? 0 : (b.at - a.at) * 0.009));
  }
  const spinAt = ms => {
    if (ms >= play.fire) return turns[turns.length - 1] - 0.0105 * (ms - play.fire);
    const next = handle.findIndex(key => key.at > ms);
    if (next < 0) return turns[turns.length - 1];
    const previous = handle[next - 1].at;
    return mix(turns[next - 1], turns[next], (ms - previous) / (handle[next].at - previous));
  };

  function ballAt(ms, hero) {
    if (ms >= play.fire) {
      return { ...flight(ms), floor: mix((hero.floorL + hero.floorR) / 2, 0, clamp((ms - play.fire) / 450, 0, 1)) };
    }
    let i = 1;
    while (i < handle.length && handle[i].at <= ms) i += 1;
    const a = handle[i - 1];
    const b = handle[i];
    const ground = (hero.floorL + hero.floorR) / 2;
    if (a.side && (!b || b.side)) {
      const [ax, ay] = palm(hero, a.side);
      if (!b) return { x: ax, y: ay, held: true, floor: ground };
      const [bx, by] = palm(hero, b.side);
      const u = clamp((ms - a.at) / (b.at - a.at), 0, 1);
      const t = u * u * (3 - 2 * u);
      return { x: mix(ax, bx, t), y: mix(ay, by, t), held: true, floor: ground };
    }
    const u = clamp((ms - a.at) / (b.at - a.at), 0, 1);
    // Fingers push the ball, the bounce reverses its vertical speed, and
    // it decelerates toward the receiving palm without pausing on the floor.
    const progressY = a.side ? u * (0.6 + 0.4 * u) : u * (1.55 - 0.55 * u);
    return { x: mix(a.x, b.x, u), y: mix(a.y, b.y, progressY), held: false, floor: a.floor ?? b.floor };
  }

  return {
    ...play,
    flight, spinAt,
    sample(ms) {
      const players = Object.fromEntries(Object.entries(play.players).map(([name, spec]) => [name, actor(spec, ms)]));
      const ball = ballAt(ms, players.hero);
      const back = Math.max(0, ms - 14);
      const before = ballAt(back, ball.held || (ms >= play.fire && back < play.fire) ||
        handle.some(key => key.side && back <= key.at && key.at <= ms) ? actor(play.players.hero, back) : players.hero);
      const [vx, vy, height] = sample(play.view, ms, [0, 0, 180]);
      return {
        capture: { players, ball, view: { x: vx, y: vy, height } },
        trail: [ball.x - before.x, ball.y - before.y],
        spin: spinAt(ms),
      };
    },
  };
}
