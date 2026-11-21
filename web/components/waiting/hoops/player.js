/**
 * The players of the basketball waiting animation, drawn on the joints of
 * their capture (hoops/tracks.js).
 *
 * The capture says where each joint was as the camera saw it, so a pose
 * already has its foreshortening. What stands on those joints is drawn here
 * the way a figure is drawn: an athlete's build (the cap of the shoulder, the
 * swell of upper arm, forearm, thigh and calf, each on the side of the limb
 * it belongs to), a head that turns with its nose and has a jaw, ears, hair
 * and a beard, open hands, a tucked-in jersey with its neckline, trim and
 * number, sleeveless or with short sleeves, loose shorts with a stripe and a
 * hem, and shoes standing on their soles. Every form is painted flat, with
 * the side away from the light a tone darker and the far side of the body a
 * tone back.
 *
 * Lengths in the tables are fractions of the player's standing height.
 */
import { blend, rgb } from '../stage.js';
import { JOINT as J } from './tracks.js';

const TAU = Math.PI * 2;
/** Where the light comes from, as a unit vector on the picture. */
const LIGHT = [-0.55, -0.83];
/** How far into a limb the dark tone reaches from the edge turned away from the light, as a share of its width. */
const SHADE_REACH = 0.4;
/** How much of the shade colour is in a colour's dark tone, and in everything on the far side of the body. */
const DARK = 0.3;
const FAR = 0.16;

const BODY = {
  // Half the distance between the shoulder joints and between the hip joints, seen square on.
  shoulders: 0.1, hips: 0.066,
  // Half the height of the head, and how far the nose is from its axis in profile.
  head: 0.064, nose: 0.055,
  // The cap of a shoulder round its joint, and where the muscle from it ends on the side of the neck: this far
  // up it, this far from its middle.
  cap: 0.036, slope: 0.05, nape: 0.03,
  // A rounded mass is lit this far short of its edge away from the light.
  rim: 0.011,
  // His shorts at the hip.
  seat: 0.07,
  // How thick the sole of a shoe is.
  sole: 0.013,
  // What is worn over a limb stands this far off it.
  cloth: 0.003,
};

/**
 * Limbs, bone by bone: [how far along the bone, half-width on one side, on
 * the other]. The first side is the inside of the elbow for an arm and the
 * front for a leg.
 */
const UPPER_ARM = [[0, 0.04, 0.04], [0.3, 0.037, 0.035], [0.62, 0.031, 0.031], [1, 0.024, 0.027]];
const FOREARM = [[0, 0.024, 0.027], [0.24, 0.03, 0.026], [0.66, 0.022, 0.021], [1, 0.0165, 0.0165]];
const THIGH = [[0, 0.058, 0.06], [0.5, 0.057, 0.055], [0.86, 0.042, 0.042], [1, 0.038, 0.035]];
const SHIN = [[0, 0.038, 0.035], [0.3, 0.029, 0.044], [0.64, 0.025, 0.03], [0.9, 0.02, 0.022], [1, 0.021, 0.021]];
const NECK = [[0, 0.041, 0.041], [0.4, 0.034, 0.034], [1, 0.032, 0.032]];
/** His shorts along a thigh, loose and nearly to the knee; the last two stations are the band at the hem. */
const SHORTS = [[0, 0.07, 0.07], [0.45, 0.071, 0.071], [0.81, 0.07, 0.07], [0.89, 0.07, 0.07]];
/** The back of their hem, lower than the front of it. */
const HEM = [[0.85, 0.068, 0.068], [0.93, 0.066, 0.066]];
/** What he wears under them, where it shows below the hem. */
const UNDER = [[0.74, 0.048, 0.047], [0.87, 0.043, 0.043], [0.98, 0.039, 0.037]];
/** A short sleeve along an upper arm, closer to it, with its band at the hem. */
const SLEEVE = [[0, 0.045, 0.045], [0.24, 0.044, 0.042], [0.4, 0.04, 0.039], [0.46, 0.04, 0.039]];

/**
 * The trunk, rung by rung: [how far down the spine from the shoulders to the
 * hips, half-width seen square on, half-depth seen from the side].
 */
const TRUNK = {
  strap: [0, 0.084, 0.042], collar: [0, 0.052, 0.036], hole: [0.19, 0.068, 0.034],
  chest: [0.26, 0.098, 0.066], waist: [0.62, 0.081, 0.058], tuck: [0.8, 0.086, 0.063],
};

/** Fingers, little to first: [where on the knuckles, across the hand toward the thumb; angle off the hand; length]. */
const FINGERS = [[-0.0155, -0.2, 0.029], [-0.0055, -0.07, 0.037], [0.005, 0.04, 0.04], [0.0155, 0.16, 0.036]];

/** Mirrors the right half of a shape seen square on: its points from the top round to the bottom give all of it. */
const whole = (half) => {
  const round = [...half];
  for (let i = half.length / 2 - 2; i >= 1; i -= 1) round.push(-half[i * 2], half[i * 2 + 1]);
  return round;
};

/**
 * Shapes of the head: the points round each, in halves of the head's height
 * from its middle, x to the picture's right and y up. `square` is the shape
 * seen from the front (`back` from behind) and `side` is where the same
 * points are with the face turned to the right; a head turned part of the way
 * is between the two. So a point keeps to one place on him: those on the side
 * his face turns to close up at the front of it, and those on the side the
 * camera keeps spread out over the side of his head.
 */
const SKULL = {
  square: whole([0, 1, 0.5, 0.9, 0.76, 0.42, 0.76, -0.12, 0.62, -0.6, 0.3, -0.98, 0, -1.06]),
  side: [-0.1, 1, 0.45, 0.93, 0.8, 0.5, 0.82, 0.08, 1.12, -0.26, 0.82, -0.52, 0.74, -1.04, 0.12, -0.9, -0.3, -0.5, -0.62, -0.42, -0.94, 0.2, -0.74, 0.8],
};
/**
 * Hair has sixteen points. From the front and from the side: the top; seven
 * down the far side, ending by the ear and at the corner of the temple; the
 * middle of the hairline; then the near side the other way: the corner of
 * the temple, the sideburn, over the ear, behind it, the nape, the back of
 * the head and the top of that. From behind, the points of the hairline lie
 * down the edge his face comes round and those from the ear to the nape
 * along the bottom.
 */
const HAIR = {
  // Short all over.
  crop: {
    square: whole([0, 1.07, 0.53, 0.97, 0.8, 0.5, 0.8, 0.34, 0.79, 0.22, 0.79, 0.1, 0.78, 0, 0.64, 0.42, 0, 0.7]),
    side: [-0.1, 1.07, 0.45, 1, 0.54, 0.91, 0.61, 0.83, 0.67, 0.75, 0.71, 0.68, 0.74, 0.62, 0.74, 0.59, 0.7, 0.56,
      0.42, 0.5, 0.22, -0.06, 0.02, 0.3, -0.4, -0.44, -0.7, -0.46, -0.99, 0.2, -0.79, 0.85],
    back: [-0.53, 0.97, 0, 1.07, 0.53, 0.97, 0.7, 0.74, 0.81, 0.48, 0.81, 0.3, 0.8, 0.1, 0.78, -0.1, 0.69, -0.29,
      0.58, -0.46, 0.3, -0.58, 0, -0.6, -0.3, -0.58, -0.58, -0.46, -0.78, -0.1, -0.81, 0.48],
  },
  // Square across the top.
  flat: {
    square: whole([0, 1.17, 0.58, 1.15, 0.81, 0.66, 0.8, 0.4, 0.79, 0.25, 0.79, 0.12, 0.78, 0.02, 0.64, 0.42, 0, 0.7]),
    side: [-0.1, 1.17, 0.5, 1.15, 0.62, 1.02, 0.67, 0.9, 0.71, 0.79, 0.73, 0.7, 0.75, 0.63, 0.75, 0.6, 0.71, 0.56,
      0.42, 0.5, 0.22, -0.04, 0.02, 0.3, -0.38, -0.4, -0.68, -0.42, -0.97, 0.3, -0.83, 1.06],
    back: [-0.58, 1.15, 0, 1.17, 0.58, 1.15, 0.72, 0.88, 0.82, 0.58, 0.81, 0.34, 0.8, 0.12, 0.78, -0.08, 0.69, -0.27,
      0.58, -0.42, 0.3, -0.54, 0, -0.56, -0.3, -0.54, -0.58, -0.42, -0.78, -0.08, -0.82, 0.58],
  },
  // Over the ears and down to the shoulders: where the others go over the ear and behind it, this hangs beside the face.
  long: {
    square: whole([0, 1.07, 0.55, 0.98, 0.85, 0.5, 0.87, -0.1, 0.87, -0.6, 0.85, -0.92, 0.68, -0.3, 0.46, 0.5, 0, 0.64]),
    side: [-0.1, 1.07, 0.46, 1, 0.55, 0.91, 0.62, 0.83, 0.68, 0.75, 0.72, 0.68, 0.75, 0.62, 0.75, 0.59, 0.71, 0.55,
      0.46, 0.5, 0.24, 0, -0.04, -0.3, -0.26, -1.2, -0.8, -1.15, -1.04, 0, -0.82, 0.85],
    back: [-0.55, 0.98, 0, 1.07, 0.55, 0.98, 0.73, 0.76, 0.86, 0.5, 0.87, 0.14, 0.88, -0.22, 0.88, -0.6, 0.82, -0.88,
      0.74, -1.15, 0.36, -1.28, 0, -1.3, -0.36, -1.28, -0.74, -1.15, -0.88, -0.6, -0.86, 0.5],
  },
};
const BEARD = {
  square: whole([0, -1.09, 0.33, -1.01, 0.67, -0.58, 0.76, -0.1, 0.58, -0.3, 0.36, -0.52, 0, -0.4]),
  side: [0.62, -1.1, 0.8, -0.94, 0.86, -0.64, 0.88, -0.46, 0.68, -0.4, 0.5, -0.52, 0.32, -0.38, 0.22, -0.42, 0.16, -0.2, 0.08, -0.06, -0.28, -0.54, 0.14, -0.96],
};
/** The most points round a shape of the head. */
const RING = 16;
/**
 * A face seen from behind as the head turns to the side: the front of the
 * jaw, which the beard closes up to, and how far toward the edge of the face
 * the eye is when it first shows. Both in halves of the head's height.
 */
const JAW = 0.72;
const EDGE = 0.3;

const mix = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
const span = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const ease = u => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const pick = (paint, far) => (far ? paint.far : paint.near);

/**
 * What a player looks like and wears, made ready to paint with.
 * @param spec Colours as [r, g, b]: `skin`, `hair`, `jersey` (his shorts are the same), `trim`,
 *   `number`, `shoe`, `sole`, and `shade`, which the dark side of every colour is mixed toward.
 *   Colours of what not everyone wears: `tights` down the whole leg, `under` for what shows
 *   below the hem of his shorts, `knee` for a sleeve over each knee, `sock`, `sleeve` over one
 *   arm (`sleeveSide`: 'L' or 'R') and `stripe` on the shoe. `sleeved` gives his jersey short
 *   sleeves. `mark` is the number on his jersey, in `font`. `cut` names his hair (see HAIR),
 *   `shaved` (0..1) thins it to the scalp and `beard` (0..1) is how full his beard is.
 */
export function createKit(spec) {
  const paint = (color) => {
    if (!color) return null;
    const tone = base => ({ lit: rgb(base), dark: rgb(blend(base, spec.shade, DARK)) });
    return { near: tone(color), far: tone(blend(color, spec.shade, FAR)) };
  };
  return {
    skin: paint(spec.skin), jersey: paint(spec.jersey), trim: paint(spec.trim), shoe: paint(spec.shoe), sole: paint(spec.sole),
    tights: paint(spec.tights), under: paint(spec.under), knee: paint(spec.knee), sock: paint(spec.sock),
    sleeve: paint(spec.sleeve), sleeveSide: spec.sleeveSide, stripe: spec.stripe ? rgb(spec.stripe) : null,
    sleeved: Boolean(spec.sleeved),
    hair: rgb(spec.hair, 1 - (spec.shaved || 0)), cut: HAIR[spec.cut] || HAIR.crop,
    beard: spec.beard ? rgb(spec.hair, spec.beard) : null, features: rgb(blend(spec.skin, spec.shade, 0.72)),
    number: spec.number ? rgb(spec.number) : null, mark: spec.mark, font: spec.font,
  };
}

/** Adds a capsule that tapers from radius `ar` at `a` to `br` at `b` to the current path. */
function capsule(ctx, a, ar, b, br) {
  const d = span(a, b);
  if (d <= Math.abs(ar - br) + 1e-6) {
    const [at, r] = ar >= br ? [a, ar] : [b, br];
    ctx.moveTo(at[0] + r, at[1]);
    ctx.arc(at[0], at[1], r, 0, TAU);
    return;
  }
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const spread = Math.acos((ar - br) / d);
  ctx.moveTo(a[0] + Math.cos(angle + spread) * ar, a[1] + Math.sin(angle + spread) * ar);
  ctx.arc(a[0], a[1], ar, angle + spread, angle + TAU - spread);
  ctx.arc(b[0], b[1], br, angle - spread, angle + spread);
  ctx.closePath();
}

/**
 * Adds to the current path the outline round a set of discs [x, y, r]: the
 * convex hull of points on their rims. The discs can be moved by (dx, dy) and
 * made smaller by `less`.
 */
function hull(ctx, discs, dx = 0, dy = 0, less = 0) {
  const points = [];
  for (const [x, y, r] of discs) {
    const radius = r - less;
    if (radius > 0) for (let i = 0; i < 10; i += 1) points.push([x + dx + Math.cos((i * TAU) / 10) * radius, y + dy + Math.sin((i * TAU) / 10) * radius]);
    else points.push([x + dx, y + dy]);
  }
  points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const round = [];
  for (const p of points) {
    while (round.length >= 2 && cross(round[round.length - 2], round[round.length - 1], p) <= 0) round.pop();
    round.push(p);
  }
  const lower = round.length + 1;
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const p = points[i];
    while (round.length >= lower && cross(round[round.length - 2], round[round.length - 1], p) <= 0) round.pop();
    round.push(p);
  }
  ctx.moveTo(round[0][0], round[0][1]);
  for (let i = 1; i < round.length - 1; i += 1) ctx.lineTo(round[i][0], round[i][1]);
  ctx.closePath();
}

/**
 * Fills a rounded mass, the hulls of each set of discs in `parts` taken
 * together: in its dark tone, then in its lit tone short of the edge away
 * from the light by `rim`. Without a rim it is all in its lit tone.
 */
function mass(ctx, parts, tone, rim) {
  ctx.beginPath();
  for (const discs of parts) hull(ctx, discs);
  ctx.fillStyle = rim > 0 ? tone.dark : tone.lit;
  ctx.fill();
  if (!(rim > 0)) return;
  ctx.beginPath();
  for (const discs of parts) hull(ctx, discs, LIGHT[0] * rim, LIGHT[1] * rim, rim);
  ctx.fillStyle = tone.lit;
  ctx.fill();
}

/** Most stations a strip is laid out with. */
const MOST = 6;
// A strip as it is laid out: its two edges, how far in the dark tone reaches from each, and a mark along it.
const edgeA = new Float32Array(MOST * 2);
const edgeB = new Float32Array(MOST * 2);
const shadeA = new Float32Array(MOST * 2);
const shadeB = new Float32Array(MOST * 2);
const markA = new Float32Array(MOST * 2);
const markB = new Float32Array(MOST * 2);
/** How many stations the strip is laid out with. */
let laid = 0;

/**
 * Adds a dart to the current path: a fold in cloth or the edge of a muscle,
 * narrowing from two ends to a point. Each of the three is given as its
 * station along the laid-out strip (fractions fall between stations) and how
 * far across it, from edge A (0) to edge B (1).
 */
function dart(ctx, ...places) {
  for (let n = 0; n < 6; n += 2) {
    const i = Math.min(Math.floor(places[n]), laid - 2);
    const u = places[n] - i;
    const o = i * 2;
    const ax = edgeA[o] + (edgeA[o + 2] - edgeA[o]) * u;
    const ay = edgeA[o + 1] + (edgeA[o + 3] - edgeA[o + 1]) * u;
    const x = ax + (edgeB[o] + (edgeB[o + 2] - edgeB[o]) * u - ax) * places[n + 1];
    const y = ay + (edgeB[o + 1] + (edgeB[o + 3] - edgeB[o + 1]) * u - ay) * places[n + 1];
    if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * For the first `count` stations of the strip in `edgeA`/`edgeB`, where the
 * dark tone ends on the way in from either edge. It thins toward both ends of
 * the strip, as the shadow on a rounded form does: to `ends` of its reach.
 */
function layShade(count, ends) {
  for (let i = 0; i < count; i += 1) {
    const reach = SHADE_REACH * (i === 0 || i === count - 1 ? ends : 1);
    const o = i * 2;
    const wx = edgeA[o] - edgeB[o];
    const wy = edgeA[o + 1] - edgeB[o + 1];
    const wide = Math.hypot(wx, wy);
    // How squarely edge A faces the light: the dark tone lies along the other edge.
    const lit = wide > 1e-6 ? (wx * LIGHT[0] + wy * LIGHT[1]) / wide : 0;
    const reachA = reach * clamp(-lit * 1.6, 0, 1);
    const reachB = reach * clamp(lit * 1.6, 0, 1);
    shadeA[o] = edgeA[o] - wx * reachA;
    shadeA[o + 1] = edgeA[o + 1] - wy * reachA;
    shadeB[o] = edgeB[o] + wx * reachB;
    shadeB[o + 1] = edgeB[o + 1] + wy * reachB;
  }
}

/**
 * Lays out a strip along the bone from `a` to `b`, a station for each row
 * of `table`. Edge A is on the left of the bone going from `a` to `b` as the
 * picture shows it. `lean` puts the table's first side on edge A (1), on edge
 * B (-1) or evens the two out (0); `pad` widens both edges and `skew` moves
 * width from edge B to edge A.
 */
function layBone(a, b, table, lean, unit, pad = 0, skew = 0) {
  let tx = b[0] - a[0];
  let ty = b[1] - a[1];
  const long = Math.hypot(tx, ty);
  if (long > 1e-3) { tx /= long; ty /= long; } else { tx = 0; ty = 1; }
  for (let i = 0; i < table.length; i += 1) {
    const [along, first, second] = table[i];
    const mean = (first + second) / 2;
    const tilt = (first - mean) * lean + skew;
    const x = a[0] + (b[0] - a[0]) * along;
    const y = a[1] + (b[1] - a[1]) * along;
    const o = i * 2;
    edgeA[o] = x + ty * (mean + tilt + pad) * unit;
    edgeA[o + 1] = y - tx * (mean + tilt + pad) * unit;
    edgeB[o] = x - ty * (mean - tilt + pad) * unit;
    edgeB[o + 1] = y + tx * (mean - tilt + pad) * unit;
  }
  laid = table.length;
  // A limb is a muscle between two joints: its shadow runs out at both.
  layShade(laid, 0.1);
}

/** Carries the path on from station `from` of an edge to station `to`, round through the stations between. */
function follow(ctx, points, from, to) {
  if (from === to) return;
  const step = to > from ? 1 : -1;
  if (from + step === to) {
    ctx.lineTo(points[to * 2], points[to * 2 + 1]);
    return;
  }
  for (let i = from + step; i !== to; i += step) {
    const next = i + step;
    const last = next === to;
    ctx.quadraticCurveTo(
      points[i * 2], points[i * 2 + 1],
      last ? points[next * 2] : (points[i * 2] + points[next * 2]) / 2,
      last ? points[next * 2 + 1] : (points[i * 2 + 1] + points[next * 2 + 1]) / 2,
    );
  }
}

/**
 * Carries the path from the end of one edge to the end of the other at
 * station `at`: straight across, or (`round`) bulging out as the end of a
 * limb does. `inward` is the station next to it.
 */
function cap(ctx, start, end, at, inward, round) {
  const sx = start[at * 2];
  const sy = start[at * 2 + 1];
  const ex = end[at * 2];
  const ey = end[at * 2 + 1];
  if (!round) {
    ctx.lineTo(ex, ey);
    return;
  }
  // Out of the strip: square to its end, away from the station before it.
  let ox = sy - ey;
  let oy = ex - sx;
  const inX = (start[inward * 2] + end[inward * 2] - sx - ex) / 2;
  const inY = (start[inward * 2 + 1] + end[inward * 2 + 1] - sy - ey) / 2;
  if (ox * inX + oy * inY > 0) { ox = -ox; oy = -oy; }
  const k = 2 / 3; // a cubic this far out is half a circle
  ctx.bezierCurveTo(sx + ox * k, sy + oy * k, ex + ox * k, ey + oy * k, ex, ey);
}

/** Adds to the current path what lies between two edges from station `from` to `to`, each end round or straight. */
function band(ctx, a, b, from, to, roundFrom, roundTo) {
  ctx.moveTo(a[from * 2], a[from * 2 + 1]);
  follow(ctx, a, from, to);
  cap(ctx, a, b, to, to - 1, roundTo);
  follow(ctx, b, to, from);
  cap(ctx, b, a, from, from + 1, roundFrom);
  ctx.closePath();
}

/** Fills the laid-out strip from station `from` to `to` in one colour. */
function fillStrip(ctx, style, from, to, roundFrom, roundTo) {
  ctx.beginPath();
  band(ctx, edgeA, edgeB, from, to, roundFrom, roundTo);
  ctx.fillStyle = style;
  ctx.fill();
}

/** Fills the laid-out strip from station `from` to `to` in its lit tone, and its side away from the light in its dark one. */
function paintStrip(ctx, tone, from, to, roundFrom, roundTo) {
  fillStrip(ctx, tone.lit, from, to, roundFrom, roundTo);
  ctx.beginPath();
  band(ctx, edgeA, shadeA, from, to, false, false);
  band(ctx, shadeB, edgeB, from, to, false, false);
  ctx.fillStyle = tone.dark;
  ctx.fill();
}

/** The player's joints placed on the picture, with the length that sizes his body. */
function place(camera, pose) {
  return { at: pose.points.map(([x, y]) => [camera.x(x), camera.y(y)]), unit: pose.size * camera.k };
}

/**
 * How his trunk lies on the picture: the spine from between the shoulders
 * (`top`) to between the hips (`base`), `down` it and to its `right`, and
 * half the line of the shoulders and of the hips as shares of their full
 * width, turned to the spine's right. `facing` is 1 with his chest square to
 * the camera, -1 with his back to it, 0 in profile.
 */
function trunkOf(body) {
  const { at, unit } = body;
  const top = mix(at[J.shoulderL], at[J.shoulderR], 0.5);
  const base = mix(at[J.hipL], at[J.hipR], 0.5);
  const long = span(top, base) || 1;
  const down = [(base[0] - top[0]) / long, (base[1] - top[1]) / long];
  const right = [down[1], -down[0]];
  const across = (left, other, width) => {
    let x = (left[0] - other[0]) / (2 * width * unit);
    let y = (left[1] - other[1]) / (2 * width * unit);
    const facing = x * right[0] + y * right[1];
    if (facing < 0) { x = -x; y = -y; }
    const size = Math.hypot(x, y);
    return size > 1 ? [x / size, y / size, facing] : [x, y, facing];
  };
  const shoulders = across(at[J.shoulderL], at[J.shoulderR], BODY.shoulders);
  return { top, base, long, down, right, shoulders, hips: across(at[J.hipL], at[J.hipR], BODY.hips), facing: clamp(shoulders[2], -1, 1) };
}

/**
 * From the spine to the edge of the trunk at a rung of TRUNK, as a vector on
 * the picture pointing to the spine's right. Seen from the side the trunk is
 * as wide as it is deep; in between, both count.
 */
function reachOf(trunk, unit, [along, front, deep]) {
  const u = clamp(along, 0, 1);
  const x = trunk.shoulders[0] + (trunk.hips[0] - trunk.shoulders[0]) * u;
  const y = trunk.shoulders[1] + (trunk.hips[1] - trunk.shoulders[1]) * u;
  const turned = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return [(x * front + trunk.right[0] * deep * turned) * unit, (y * front + trunk.right[1] * deep * turned) * unit];
}

/** A point on the edge of the trunk at a rung of TRUNK: `side` 1 to the spine's right, -1 to its left. */
function trunkEdge(trunk, unit, rung, side) {
  const [x, y] = reachOf(trunk, unit, rung);
  const far = rung[0] * trunk.long;
  return [trunk.top[0] + trunk.down[0] * far + side * x, trunk.top[1] + trunk.down[1] * far + side * y];
}

/** An open hand at the end of a forearm; `inside` is where the inside of the elbow is (see layBone), and so the thumb. */
function drawHand(ctx, elbow, wrist, unit, inside, tone, fingers) {
  let dx = wrist[0] - elbow[0];
  let dy = wrist[1] - elbow[1];
  const long = Math.hypot(dx, dy);
  if (long > 1e-3) { dx /= long; dy /= long; } else { dx = 0; dy = 1; }
  const thumb = inside >= 0 ? 1 : -1;
  const nx = dy * thumb;
  const ny = -dx * thumb;
  // `along` the hand from the wrist and `across` it toward the thumb.
  const point = (along, across) => [wrist[0] + (dx * along + nx * across) * unit, wrist[1] + (dy * along + ny * across) * unit];
  ctx.beginPath();
  capsule(ctx, point(0, 0), 0.017 * unit, point(0.03, 0), 0.0225 * unit);
  capsule(ctx, point(0.03, 0), 0.0225 * unit, point(0.05, 0), 0.021 * unit);
  if (fingers) {
    for (const [across, angle, length] of FINGERS) {
      capsule(ctx, point(0.053, across), 0.0076 * unit,
        point(0.053 + Math.cos(angle) * length, across + Math.sin(angle) * length), 0.0062 * unit);
    }
  } else {
    capsule(ctx, point(0.05, 0), 0.02 * unit, point(0.09, 0.002), 0.013 * unit);
  }
  capsule(ctx, point(0.016, 0.015), 0.0085 * unit, point(0.04, 0.036), 0.0068 * unit);
  ctx.fillStyle = tone.lit;
  ctx.fill();
}

function drawArm(ctx, body, kit, side, far, fine) {
  const { at, unit } = body;
  const left = side === 'L';
  const shoulder = at[left ? J.shoulderL : J.shoulderR];
  const elbow = at[left ? J.elbowL : J.elbowR];
  const wrist = at[left ? J.wristL : J.wristR];
  const skin = pick(kit.skin, far);
  // Which edge of the arm is the inside of the elbow: the one the forearm turns toward.
  const bend = ((elbow[0] - shoulder[0]) * (wrist[1] - elbow[1]) - (elbow[1] - shoulder[1]) * (wrist[0] - elbow[0]))
    / ((span(shoulder, elbow) || 1) * (span(elbow, wrist) || 1));
  const inside = clamp(-bend * 2.2, -1, 1);
  const sleeve = kit.sleeve && kit.sleeveSide === side ? pick(kit.sleeve, far) : null;

  // The inside of the elbow is on edge A of his arm (0 across it) or on edge B (1).
  const crook = inside >= 0 ? 0 : 1;

  layBone(shoulder, elbow, UPPER_ARM, inside, unit);
  paintStrip(ctx, skin, 0, 3, true, true);
  if (!kit.sleeved && fine > 90) {
    // Where the muscle of the shoulder ends: down the outside of the arm, and up across it to the armpit.
    ctx.beginPath();
    dart(ctx, 0.7, 0.5 + (crook - 0.5) * 0.5, 1.2, 1 - crook, 1.6, 1 - crook);
    ctx.fillStyle = skin.dark;
    ctx.fill();
  }
  if (sleeve) {
    layBone(shoulder, elbow, UPPER_ARM, inside, unit, BODY.cloth);
    paintStrip(ctx, sleeve, 2, 3, false, true);
  }
  if (kit.sleeved) {
    layBone(shoulder, elbow, SLEEVE, inside, unit);
    const cloth = pick(kit.jersey, far);
    paintStrip(ctx, cloth, 0, 3, true, false);
    if (fine > 70) {
      // It hangs from the top of the shoulder.
      ctx.beginPath();
      dart(ctx, 0.5, 0.5 + (crook - 0.5) * 0.3, 2, crook + (0.5 - crook) * 0.35, 2, crook + (0.5 - crook) * 0.75);
      ctx.fillStyle = cloth.dark;
      ctx.fill();
    }
    if (kit.trim && fine > 50) fillStrip(ctx, pick(kit.trim, far).lit, 2, 3, false, false);
  }
  layBone(elbow, wrist, FOREARM, inside, unit, sleeve ? BODY.cloth : 0);
  paintStrip(ctx, sleeve || skin, 0, 3, true, !sleeve);
  if (fine > 90 && Math.abs(inside) > 0.3) {
    // The crease in the crook of his elbow, running down into the forearm: deeper the more it is bent.
    ctx.beginPath();
    dart(ctx, 0, crook, 0.55, crook + (0.5 - crook) * 0.9 * Math.abs(inside), 0.3, crook);
    ctx.fillStyle = (sleeve || skin).dark;
    ctx.fill();
  }
  drawHand(ctx, elbow, wrist, unit, inside, skin, fine > 85);
}

/**
 * A basketball shoe: its sole flat under heel, ball and toe; on that the foot
 * of the shoe, the collar going up round the ankle and the laces sloping down
 * from it to the toes.
 */
function drawShoe(ctx, ankle, heel, toe, unit, kit, far, fine) {
  const long = span(heel, toe);
  // Up from the sole: toward the ankle, and square to the foot as far as its side shows.
  const middle = mix(heel, toe, 0.5);
  let ux = ankle[0] - middle[0];
  let uy = ankle[1] - middle[1];
  const high = Math.hypot(ux, uy) || 1;
  ux /= high;
  uy /= high;
  const seen = clamp(long / (0.09 * unit), 0, 1);
  if (long > 1e-3) {
    let nx = (heel[1] - toe[1]) / long;
    let ny = (toe[0] - heel[0]) / long;
    if (nx * ux + ny * uy < 0) { nx = -nx; ny = -ny; }
    ux += (nx - ux) * seen;
    uy += (ny - uy) * seen;
    const size = Math.hypot(ux, uy) || 1;
    ux /= size;
    uy /= size;
  }
  const ball = mix(heel, toe, 0.66);
  // A disc of the shoe round a point of the foot, `lift` above the floor.
  const disc = ([x, y], r, lift = 0) => [x + ux * lift * unit, y + uy * lift * unit, r * unit];
  mass(ctx, [[disc(heel, 0.022), disc(ball, 0.023), disc(toe, 0.018)]], pick(kit.sole, far), 0);
  const instep = disc(middle, 0.02, BODY.sole);
  mass(ctx, [
    [disc(heel, 0.021, BODY.sole), disc(ball, 0.022, BODY.sole), disc(toe, 0.017, BODY.sole)],
    [disc(ankle, 0.026), disc(heel, 0.021, BODY.sole)],
    [disc(ankle, 0.021), instep],
  ], pick(kit.shoe, far), BODY.rim * 0.6 * unit);
  if (seen < 0.6 || fine < 120) return;
  // Laces across the instep, and the stripe down its side.
  const laces = pick(kit.sole, far).lit;
  const slope = [instep[0] - ankle[0], instep[1] - ankle[1]];
  const reach = (0.011 * unit) / (Math.hypot(slope[0], slope[1]) || 1);
  ctx.beginPath();
  for (const along of [0.38, 0.6, 0.82]) {
    const x = ankle[0] + slope[0] * along;
    const y = ankle[1] + slope[1] * along;
    ctx.moveTo(x - slope[1] * reach, y + slope[0] * reach);
    ctx.lineTo(x + slope[1] * reach, y - slope[0] * reach);
  }
  ctx.lineWidth = 0.0055 * unit;
  ctx.strokeStyle = laces;
  ctx.stroke();
  if (!kit.stripe) return;
  const from = mix(ankle, heel, 0.35);
  const to = disc(mix(heel, toe, 0.4), 0, BODY.sole * 1.2);
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.lineWidth = 0.011 * unit;
  ctx.strokeStyle = kit.stripe;
  ctx.stroke();
}

function drawLeg(ctx, body, kit, trunk, side, far, fine) {
  const { at, unit } = body;
  const left = side === 'L';
  const hip = at[left ? J.hipL : J.hipR];
  const knee = at[left ? J.kneeL : J.kneeR];
  const ankle = at[left ? J.ankleL : J.ankleR];
  const heel = at[left ? J.heelL : J.heelR];
  const toe = at[left ? J.toeL : J.toeR];
  const cover = pick(kit.tights || kit.skin, far);

  // Which edge of the leg is its front: the knee points that way, and so does the foot.
  const thigh = span(hip, knee) || 1;
  const shin = span(knee, ankle) || 1;
  const sx = (ankle[0] - knee[0]) / shin;
  const sy = (ankle[1] - knee[1]) / shin;
  const bend = ((knee[0] - hip[0]) * sy - (knee[1] - hip[1]) * sx) / thigh;
  const pointing = ((toe[0] - heel[0]) * sy - (toe[1] - heel[1]) * sx) / (0.09 * unit);
  const front = clamp(bend * 2.5 + pointing, -1, 1);

  // His shorts hang off the hip over most of the thigh, looser than the leg and lower on its under side.
  const lying = (knee[0] - hip[0]) / thigh;
  // Round the back of the leg their hem is seen from inside.
  layBone(hip, knee, HEM, 0, unit, 0, -lying * 0.012);
  fillStrip(ctx, kit.jersey.far.dark, 0, 1, false, false);

  layBone(hip, knee, THIGH, front, unit);
  paintStrip(ctx, cover, 0, 3, true, true);
  // The shadow his shorts throw on the thigh.
  fillStrip(ctx, cover.dark, 1, 2, false, false);
  if (kit.knee) {
    layBone(hip, knee, THIGH, front, unit, BODY.cloth);
    paintStrip(ctx, pick(kit.knee, far), 2, 3, false, true);
  }
  if (kit.under) {
    layBone(hip, knee, UNDER, front, unit, BODY.cloth);
    paintStrip(ctx, pick(kit.under, far), 0, 2, false, false);
  }
  layBone(knee, ankle, SHIN, front, unit);
  paintStrip(ctx, cover, 0, 4, true, true);
  if (!kit.knee && fine > 90) {
    // Under the kneecap, on the front of the leg.
    const fore = front >= 0 ? 0 : 1;
    ctx.beginPath();
    dart(ctx, 0.22, fore + (0.5 - fore) * 0.95, 0.08, fore, 0.6, fore);
    ctx.fillStyle = cover.dark;
    ctx.fill();
  }
  if (kit.knee || kit.sock) {
    layBone(knee, ankle, SHIN, front, unit, BODY.cloth);
    if (kit.knee) paintStrip(ctx, pick(kit.knee, far), 0, 1, true, false);
    if (kit.sock) paintStrip(ctx, pick(kit.sock, far), 2, 4, false, true);
  }
  drawShoe(ctx, ankle, heel, toe, unit, kit, far, fine);

  layBone(hip, knee, SHORTS, 0, unit, 0, -lying * 0.012);
  const cloth = pick(kit.jersey, far);
  paintStrip(ctx, cloth, 0, 3, true, false);
  if (fine > 70) {
    // The folds they hang in, from the hip to the hem.
    ctx.beginPath();
    dart(ctx, 0.3, 0.44, 3, 0.2, 3, 0.33);
    dart(ctx, 1.1, 0.7, 3, 0.63, 3, 0.74);
    ctx.fillStyle = cloth.dark;
    ctx.fill();
  }
  if (!kit.trim || fine < 50) return;
  const trim = pick(kit.trim, far);
  fillStrip(ctx, trim.lit, 2, 3, false, false);
  // The stripe down the outside of the leg: at the edge seen from the front, down the middle from the side.
  const out = clamp(((hip[0] - trunk.base[0]) * (knee[1] - hip[1]) - (hip[1] - trunk.base[1]) * (knee[0] - hip[0])) / (thigh * BODY.hips * unit), -1, 1);
  const shows = far ? clamp((Math.abs(out) - 0.35) / 0.3, 0, 1) : 1;
  if (shows <= 0) return;
  const middle = 0.5 - 0.33 * out;
  for (let i = 0; i < 3; i += 1) {
    for (const [mark, across] of [[markA, middle - 0.08 * shows], [markB, middle + 0.08 * shows]]) {
      mark[i * 2] = edgeA[i * 2] + (edgeB[i * 2] - edgeA[i * 2]) * across;
      mark[i * 2 + 1] = edgeA[i * 2 + 1] + (edgeB[i * 2 + 1] - edgeA[i * 2 + 1]) * across;
    }
  }
  ctx.beginPath();
  band(ctx, markA, markB, 0, 2, false, false);
  ctx.fillStyle = trim.lit;
  ctx.fill();
}

/** The seat of his shorts, from the waistband over both hips: what the legs of his shorts hang from. */
function drawSeat(ctx, body, kit, trunk) {
  const { at, unit } = body;
  const [wl, wr] = [trunkEdge(trunk, unit, TRUNK.tuck, -1), trunkEdge(trunk, unit, TRUNK.tuck, 1)];
  mass(ctx, [[[wl[0], wl[1], 0], [wr[0], wr[1], 0],
    [at[J.hipL][0], at[J.hipL][1], BODY.seat * unit], [at[J.hipR][0], at[J.hipR][1], BODY.seat * unit]]], kit.jersey.near, 0);
}

/** His shoulders and his jersey, tucked in at the waistband. */
function drawTrunk(ctx, body, kit, trunk, fine) {
  const { at, unit } = body;
  const { down, facing } = trunk;
  const neck = at[J.neck];
  const jersey = kit.jersey.near;
  const edge = (rung, side) => trunkEdge(trunk, unit, rung, side);
  const lifted = ([x, y], by) => [x - down[0] * by * unit, y - down[1] * by * unit];
  // Either side of the neck, where the straps of the jersey end.
  const beside = reachOf(trunk, unit, TRUNK.collar);
  const collar = side => lifted([neck[0] + side * beside[0], neck[1] + side * beside[1]], 0.006);

  // Bare shoulders: the muscle sloping from the top of each up the side of the neck, and the cap of each.
  const crown = at[J.top];
  const tall = span(neck, crown) || 1;
  const up = [(crown[0] - neck[0]) / tall, (crown[1] - neck[1]) / tall];
  const upNeck = side => [
    neck[0] + (up[0] * BODY.slope - side * up[1] * BODY.nape) * unit,
    neck[1] + (up[1] * BODY.slope + side * up[0] * BODY.nape) * unit,
  ];
  // The shoulder on either side of the spine, and the top of its cap.
  const shoulder = side => at[(side > 0) === (facing >= 0) ? J.shoulderL : J.shoulderR];
  const capTop = side => lifted(shoulder(side), BODY.cap);
  // The slope from the top of a shoulder up the side of the neck bends here.
  const bend = side => lifted(collar(side), 0.012);
  ctx.beginPath();
  ctx.moveTo(...capTop(-1));
  ctx.quadraticCurveTo(...bend(-1), ...upNeck(-1));
  ctx.lineTo(...upNeck(1));
  ctx.quadraticCurveTo(...bend(1), ...capTop(1));
  ctx.lineTo(...edge(TRUNK.chest, 1));
  ctx.lineTo(...edge(TRUNK.chest, -1));
  ctx.closePath();
  ctx.fillStyle = kit.skin.near.lit;
  ctx.fill();
  if (!kit.sleeved) {
    ctx.beginPath();
    for (const joint of [J.shoulderL, J.shoulderR]) {
      ctx.moveTo(at[joint][0] + BODY.cap * unit, at[joint][1]);
      ctx.arc(at[joint][0], at[joint][1], BODY.cap * unit, 0, TAU);
    }
    ctx.fill();
  }

  // His neck, up into the head and down into the collar.
  const half = BODY.head * unit;
  const long = tall - half * 1.45;
  layBone(neck, [neck[0] + up[0] * long, neck[1] + up[1] * long], NECK, 0, unit);
  paintStrip(ctx, kit.skin.near, 0, 2, true, false);
  if (facing >= -0.3) {
    // From the front his jaw throws its shadow on it: from just under the chin on the side toward the light, down
    // across it to well under the chin on the other.
    const [lit, dark] = (edgeA[0] - edgeB[0]) * LIGHT[0] + (edgeA[1] - edgeB[1]) * LIGHT[1] > 0 ? [edgeA, edgeB] : [edgeB, edgeA];
    // The chin is this far up the neck from the joint, which may be under it.
    const chin = tall - half * 2.06;
    const share = long > 0 ? clamp((chin - 0.1 * half) / long, 0, 1) : 0;
    const [o, u] = share < NECK[1][0] ? [0, share / NECK[1][0]] : [2, (share - NECK[1][0]) / (1 - NECK[1][0])];
    const x = lit[o] + (lit[o + 2] - lit[o]) * u;
    const y = lit[o + 1] + (lit[o + 3] - lit[o + 1]) * u;
    const deep = Math.max(0.2 * half, 0.69 * half - chin);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(dark[4], dark[5]);
    follow(ctx, dark, 2, 0);
    ctx.bezierCurveTo(dark[0] - up[0] * deep, dark[1] - up[1] * deep, x - up[0] * 0.1 * half, y - up[1] * 0.1 * half, x, y);
    ctx.fillStyle = kit.skin.near.dark;
    ctx.fill();
  }

  // The jersey, scooped at the neck (deeper in front). Sleeveless, its straps are inside the shoulders and it
  // is cut away under the arms; with sleeves it goes over the shoulders and round them, and lies on the slope
  // of each shoulder halfway up to the neck, where its collar is.
  const scoop = lifted(neck, -(0.03 + 0.09 * clamp((facing + 0.2) / 0.6, 0, 1)));
  const round = BODY.cap * 2 * unit;
  const [left, right] = [-1, 1].map((side) => {
    const strap = kit.sleeved ? capTop(side) : lifted(edge(TRUNK.strap, side), 0.012);
    const over = kit.sleeved ? mix(strap, bend(side), 0.5) : mix(strap, collar(side), 0.5);
    return {
      collar: kit.sleeved ? lifted(mix(over, mix(bend(side), upNeck(side), 0.5), 0.5), BODY.cloth) : collar(side),
      strap: kit.sleeved ? lifted(strap, BODY.cloth) : strap,
      over: kit.sleeved ? lifted(over, BODY.cloth) : over,
      hole: kit.sleeved
        ? [shoulder(side)[0] + side * trunk.right[0] * round, shoulder(side)[1] + side * trunk.right[1] * round]
        : edge(TRUNK.hole, side),
      chest: edge(TRUNK.chest, side), waist: edge(TRUNK.waist, side), tuck: edge(TRUNK.tuck, side),
    };
  });
  ctx.beginPath();
  ctx.moveTo(...left.collar);
  ctx.quadraticCurveTo(...left.over, ...left.strap);
  ctx.quadraticCurveTo(...left.hole, ...left.chest);
  ctx.bezierCurveTo(...left.waist, ...left.waist, ...left.tuck);
  ctx.lineTo(...right.tuck);
  ctx.bezierCurveTo(...right.waist, ...right.waist, ...right.chest);
  ctx.quadraticCurveTo(...right.hole, ...right.strap);
  ctx.quadraticCurveTo(...right.over, ...right.collar);
  ctx.quadraticCurveTo(...scoop, ...left.collar);
  ctx.closePath();
  ctx.fillStyle = jersey.lit;
  ctx.fill();
  ['chest', 'waist', 'tuck'].forEach((rung, i) => {
    [edgeA[i * 2], edgeA[i * 2 + 1]] = right[rung];
    [edgeB[i * 2], edgeB[i * 2 + 1]] = left[rung];
  });
  laid = 3;
  layShade(3, 0.45);
  ctx.beginPath();
  band(ctx, edgeA, shadeA, 0, 2, false, false);
  band(ctx, shadeB, edgeB, 0, 2, false, false);
  if (fine > 70) {
    // Its folds: gathered where it is tucked in, and hanging across him from under an arm.
    dart(ctx, 0.9, 0.2, 2, 0.19, 2, 0.3);
    dart(ctx, 1.05, 0.83, 2, 0.7, 2, 0.8);
    dart(ctx, 1.6, 0.5, 0.15, 1, 0.6, 1);
  }
  ctx.fillStyle = jersey.dark;
  ctx.fill();

  // How much of his chest or his back the camera sees: 1 square on, 0 from the side.
  const turned = Math.hypot(trunk.shoulders[0], trunk.shoulders[1]);
  if (kit.trim && fine > 60) {
    // Trim round the neck, and round the armholes where they are at the edge of him: not seen from the side.
    ctx.lineWidth = 0.011 * unit;
    ctx.strokeStyle = kit.trim.near.lit;
    ctx.beginPath();
    ctx.moveTo(...right.collar);
    ctx.quadraticCurveTo(...scoop, ...left.collar);
    ctx.stroke();
    const open = kit.sleeved ? 0 : clamp((turned - 0.3) / 0.3, 0, 1);
    if (open > 0) {
      ctx.beginPath();
      for (const side of [left, right]) {
        ctx.moveTo(...side.strap);
        ctx.quadraticCurveTo(...side.hole, ...side.chest);
      }
      ctx.lineWidth = 0.011 * unit * open;
      ctx.stroke();
    }
  }

  // His number, square to the chest: on the front when he faces the camera, larger on the back when he does not.
  const shows = clamp((turned - 0.4) / 0.25, 0, 1);
  if (kit.mark && shows > 0 && fine > 50) {
    const far = (facing > 0 ? 0.37 : 0.33) * trunk.long;
    ctx.save();
    ctx.translate(trunk.top[0] + down[0] * far, trunk.top[1] + down[1] * far);
    ctx.rotate(Math.atan2(down[1], down[0]) - Math.PI / 2);
    ctx.scale(turned, 1);
    ctx.globalAlpha *= shows;
    ctx.font = `800 ${((facing > 0 ? 0.108 : 0.13) * unit).toFixed(1)}px ${kit.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = kit.number;
    ctx.fillText(kit.mark, 0, 0);
    // His name over it on the back, too small to read.
    if (facing < 0 && fine > 110) for (let i = -2; i < 2; i += 1) ctx.fillRect((i * 0.02 + 0.003) * unit, -0.083 * unit, 0.014 * unit, 0.011 * unit);
    ctx.restore();
  }

  // The waistband of his shorts.
  ctx.beginPath();
  ctx.moveTo(...left.tuck);
  ctx.lineTo(...right.tuck);
  ctx.lineWidth = 0.012 * unit;
  ctx.strokeStyle = jersey.dark;
  ctx.stroke();
}

const ring = new Float32Array(RING * 2);
/** How many points the laid-out shape has. */
let ringed = 0;
/**
 * Lays out a shape of the head (see SKULL) as the head is turned: `weight`
 * of the way from the shape seen square on to the one seen from the side,
 * mirrored if the face is turned to the left (`turn` below 0).
 */
function layRing(square, side, turn, weight) {
  const flip = turn < 0 ? -1 : 1;
  ringed = square.length / 2;
  for (let o = 0; o < ringed * 2; o += 2) {
    ring[o] = flip * (square[o] + (side[o] - square[o]) * weight);
    ring[o + 1] = square[o + 1] + (side[o + 1] - square[o + 1]) * weight;
  }
}

/** Starts a path round the laid-out shape, on a head `scale` times its size and moved by (dx, dy). */
function ringPath(ctx, head, scale = 1, dx = 0, dy = 0) {
  const k = head.half * scale;
  const x = i => head.x + dx + (head.across[0] * ring[i * 2] + head.up[0] * ring[i * 2 + 1]) * k;
  const y = i => head.y + dy + (head.across[1] * ring[i * 2] + head.up[1] * ring[i * 2 + 1]) * k;
  ctx.beginPath();
  ctx.moveTo((x(ringed - 1) + x(0)) / 2, (y(ringed - 1) + y(0)) / 2);
  for (let i = 0; i < ringed; i += 1) {
    const next = (i + 1) % ringed;
    ctx.quadraticCurveTo(x(i), y(i), (x(i) + x(next)) / 2, (y(i) + y(next)) / 2);
  }
  ctx.closePath();
}

/** His head. */
function drawHead(ctx, body, kit, facing, fine) {
  const { at, unit } = body;
  const crown = at[J.top];
  const neck = at[J.neck];
  const nose = at[J.nose];
  const tall = span(neck, crown) || 1;
  const up = [(crown[0] - neck[0]) / tall, (crown[1] - neck[1]) / tall];
  const across = [(neck[1] - crown[1]) / tall, (crown[0] - neck[0]) / tall];
  const half = BODY.head * unit;
  const head = { x: crown[0] - up[0] * half, y: crown[1] - up[1] * half, up, across, half };
  // Which way the face points across the picture, from where the nose sits on the head.
  const turn = clamp(((nose[0] - head.x) * across[0] + (nose[1] - head.y) * across[1]) / (BODY.nose * unit), -1, 1);
  const side = Math.abs(turn);
  const profile = ease((side - 0.1) / 0.75);
  const toward = turn < 0 ? -1 : 1;
  // With his back to the camera, his face comes into sight only as his head turns to the side.
  const behind = facing < -0.3;
  const face = behind ? ease((side - 0.55) / 0.3) : 1;
  const skin = kit.skin.near;
  const local = (x, y) => [head.x + (across[0] * x + up[0] * y) * half, head.y + (across[1] * x + up[1] * y) * half];
  const tilt = Math.atan2(up[1], up[0]) + Math.PI / 2;

  layRing(SKULL.square, SKULL.side, turn, profile);
  ringPath(ctx, head);
  ctx.fillStyle = skin.dark;
  ctx.fill();
  const rim = BODY.rim / BODY.head;
  ringPath(ctx, head, 1 - rim, LIGHT[0] * rim * half, LIGHT[1] * rim * half);
  ctx.fillStyle = skin.lit;
  ctx.fill();

  // Ears: one at either side seen square on or from behind. As his head turns, the one that goes to the far side
  // of it is lost and the other comes to the middle of the side of his head.
  ctx.beginPath();
  for (const which of [-1, 1]) {
    const hidden = (which === toward) !== behind;
    const size = hidden ? 1 - Math.min(1, profile * 1.4) : 1;
    if (size <= 0) continue;
    const [x, y] = local(hidden ? which * 0.8 : which * 0.8 + (-toward * 0.06 - which * 0.8) * profile, -0.04);
    ctx.moveTo(x + 0.12 * half * size, y);
    ctx.ellipse(x, y, 0.12 * half * size, 0.21 * half * size, tilt, 0, TAU);
  }
  ctx.fillStyle = skin.dark;
  ctx.fill();

  layRing(behind ? kit.cut.back : kit.cut.square, kit.cut.side, turn, profile);
  ctx.fillStyle = kit.hair;
  if (fine > 80) {
    // It thins out toward the temples and the nape before it ends.
    const full = ctx.globalAlpha;
    ringPath(ctx, head, 1, -up[0] * 0.1 * half, -up[1] * 0.1 * half);
    ctx.globalAlpha = full * 0.35;
    ctx.fill();
    ctx.globalAlpha = full;
  }
  ringPath(ctx, head);
  ctx.fill();
  if (face < 0.05) return;

  if (kit.beard) {
    // From behind, only the side of it on his jaw, closing up toward the front of his chin.
    layRing(BEARD.square, BEARD.side, turn, behind ? 1 : profile);
    if (face < 1) for (let o = 0; o < ringed * 2; o += 2) ring[o] = toward * (JAW + (ring[o] * toward - JAW) * face);
    ringPath(ctx, head);
    ctx.fillStyle = kit.beard;
    ctx.fill();
  }
  if (fine < 55) return;
  // On a small head there are only his eyes, drawn larger to be seen at all.
  const detailed = fine >= 130;
  const bold = clamp(150 / fine, 1, 1.6);
  // The shadow under his nose, until the nose itself stands out of the profile.
  if (detailed && profile < 0.7 && !behind) {
    const [x, y] = local(toward * (0.06 + 0.84 * profile), -0.2);
    ctx.beginPath();
    ctx.ellipse(x, y, 0.12 * half, 0.055 * half, tilt, 0, TAU);
    ctx.fillStyle = skin.dark;
    ctx.fill();
  }
  // Eyes, each under its brow: both seen square on. As his face turns, the one on the side it turns to narrows and
  // goes round the edge of it, and the other comes to the middle of the side of his head.
  ctx.beginPath();
  const brows = [];
  for (const which of [-1, 1]) {
    const leading = which === toward;
    const shows = (leading ? 1 - profile / 0.72 : 1) * face;
    if (shows < 0.1) continue;
    const eye = which * 0.33 * (1 - profile) + toward * ((leading ? 0.86 : 0.56) * profile + EDGE * (1 - face));
    const [x, y] = local(eye, 0.07);
    ctx.moveTo(x + 0.085 * half * bold * shows, y);
    ctx.ellipse(x, y, 0.085 * half * bold * shows, 0.06 * half * bold, tilt, 0, TAU);
    // A brow comes down toward the nose.
    brows.push(local(eye + which * 0.17 * shows, 0.26), local(eye - which * 0.15 * shows, 0.2));
  }
  ctx.fillStyle = kit.features;
  ctx.fill();
  if (!detailed) return;
  // His mouth, shut.
  const mouth = toward * (0.66 * profile + EDGE * 0.6 * (1 - face));
  const wide = (0.17 - 0.06 * profile) * face;
  ctx.beginPath();
  for (let i = 0; i < brows.length; i += 2) {
    ctx.moveTo(...brows[i]);
    ctx.lineTo(...brows[i + 1]);
  }
  ctx.moveTo(...local(mouth - wide, -0.5));
  ctx.lineTo(...local(mouth + wide, -0.5));
  ctx.lineWidth = 0.065 * half;
  ctx.strokeStyle = kit.features;
  ctx.stroke();
}

/** One player, standing as `pose` has him. */
function drawFigure(ctx, body, pose, kit, carry) {
  const trunk = trunkOf(body);
  // His standing height in px of the canvas: what is too small to show at that size is left out.
  const fine = body.unit * ctx.getTransform().a;
  const nearLeg = pose.legLNear ? 'L' : 'R';
  const farLeg = pose.legLNear ? 'R' : 'L';
  const arms = [['L', pose.armLFront], ['R', pose.armRFront]];
  // Of two arms on the same side of the body, the far one is painted first.
  if (pose.legLNear) arms.reverse();
  // Square to the camera, both his arms are in front of him; turned part of the way, the far one hangs behind his chest.
  const inFront = flag => flag || trunk.facing > 0.8;

  for (const [side, flag] of arms) if (!inFront(flag)) drawArm(ctx, body, kit, side, trunk.facing < 0.6, fine);
  drawLeg(ctx, body, kit, trunk, farLeg, true, fine);
  drawSeat(ctx, body, kit, trunk);
  drawLeg(ctx, body, kit, trunk, nearLeg, false, fine);
  drawTrunk(ctx, body, kit, trunk, fine);
  drawHead(ctx, body, kit, trunk.facing, fine);
  if (carry) carry(ctx);
  // One arm across his body is as near as the rest of him; of two, seen from the side, the far one sits back.
  const both = arms.every(([, flag]) => inFront(flag)) && Math.abs(trunk.facing) < 0.6;
  for (const [side, flag] of arms) if (inFront(flag)) drawArm(ctx, body, kit, side, both && side !== nearLeg, fine);
}

let sheet = null;
/** A sheet at least `width` by `height` px, to draw a player on before he goes onto the picture. */
function sheetOf(width, height) {
  if (!sheet) {
    const canvas = document.createElement('canvas');
    sheet = { canvas, g: canvas.getContext('2d') };
  }
  if (sheet.canvas.width < width || sheet.canvas.height < height) {
    sheet.canvas.width = Math.max(sheet.canvas.width, width);
    sheet.canvas.height = Math.max(sheet.canvas.height, height);
  }
  return sheet;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param camera From `resolveHoopsCamera`: `x`, `y` map capture space to the picture, `k` is its scale.
 * @param pose One player from `sampleCapture`.
 * @param kit From `createKit`.
 * @param {number} [alpha] How much of him shows, 0..1.
 * @param {(ctx: CanvasRenderingContext2D) => void} [carry] Draws what he holds, between his body and
 *   the arms in front of it, on the context it is given.
 */
export function drawPlayer(ctx, camera, pose, kit, alpha = 1, carry) {
  if (alpha <= 0.004) return;
  const body = place(camera, pose);
  if (alpha >= 0.996) {
    drawFigure(ctx, body, pose, kit, carry);
    return;
  }
  // Faded, he is drawn on a sheet of his own first, so that he thins as one
  // figure and his parts do not show through one another.
  const to = ctx.getTransform();
  const reach = 0.17 * body.unit;
  const xs = body.at.map(point => point[0]);
  const ys = body.at.map(point => point[1]);
  const left = Math.max(0, Math.floor((Math.min(...xs) - reach) * to.a + to.e));
  const top = Math.max(0, Math.floor((Math.min(...ys) - reach) * to.d + to.f));
  const width = Math.min(ctx.canvas.width, Math.ceil((Math.max(...xs) + reach) * to.a + to.e)) - left;
  const height = Math.min(ctx.canvas.height, Math.ceil((Math.max(...ys) + reach) * to.d + to.f)) - top;
  if (!(width > 0 && height > 0)) return;
  const { canvas, g } = sheetOf(width, height);
  if (!g) return;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, width, height);
  g.beginPath();
  g.rect(0, 0, width, height);
  g.clip();
  g.setTransform(to.a, 0, 0, to.d, to.e - left, to.f - top);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  drawFigure(g, body, pose, kit, carry);
  g.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  ctx.drawImage(canvas, 0, 0, width, height, left, top, width, height);
  ctx.restore();
}

/**
 * What a player leaves on the floor: a soft shadow under him and a darker one
 * under each foot, fading as the foot lifts.
 * @param pose One player from `sampleCapture`.
 * @param {number[]} shade [r, g, b] of the shadow.
 */
export function drawPlayerShadow(ctx, camera, pose, shade) {
  const { at, unit } = place(camera, pose);
  const blot = (x, y, wide, strength) => {
    if (strength <= 0.004) return;
    ctx.fillStyle = rgb(shade, strength);
    ctx.beginPath();
    ctx.ellipse(x, y, wide, wide * 0.16, 0, 0, TAU);
    ctx.fill();
  };
  const floorL = camera.y(pose.floorL);
  const floorR = camera.y(pose.floorR);
  blot((at[J.hipL][0] + at[J.hipR][0]) / 2, (floorL + floorR) / 2, 0.24 * unit, 0.07);
  for (const [toe, heel, floor] of [[J.toeL, J.heelL, floorL], [J.toeR, J.heelR, floorR]]) {
    const lift = Math.max(0, floor - Math.max(at[toe][1], at[heel][1]) - 0.012 * unit);
    const touch = Math.max(0, 1 - lift / (0.07 * unit));
    blot((at[toe][0] + at[heel][0]) / 2, floor, (0.075 + 0.05 * (1 - touch)) * unit, 0.05 + 0.2 * touch);
  }
}
