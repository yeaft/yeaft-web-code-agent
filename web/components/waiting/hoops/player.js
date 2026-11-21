/**
 * Draws a basketball player from the joints of his capture (hoops/tracks.js).
 *
 * The joints are where the camera saw them, so the pose already has its
 * foreshortening; this module puts a body on it: limbs that taper and swell
 * as limbs do, a torso and shorts with the thickness of a body, shoes, and a
 * head with its hair. Every part is shaded round, lit from the upper left,
 * and sized from the player's standing height where he is, so he grows as he
 * comes toward the camera.
 */
import { blend, rgb } from '../stage.js';
import { JOINT as J } from './tracks.js';

const TAU = Math.PI * 2;

/** Half-widths and lengths of the body, as fractions of standing height. */
const BODY = {
  headWide: 0.047, headTall: 0.066, neck: 0.027,
  strap: 0.030, chest: 0.070, waist: 0.061, hip: 0.056,
  shoulder: 0.036, elbow: 0.022, forearm: 0.025, wrist: 0.015, hand: 0.019, handLong: 0.07,
  thigh: 0.052, knee: 0.034, calf: 0.037, ankle: 0.020,
  shortsTop: 0.064, shortsHem: 0.058, shortsLong: 0.78,
  heel: 0.019, ball: 0.021, toe: 0.015, collar: 0.025, sole: 0.011,
};
/** Where the light comes from, as a unit vector on the picture. */
const LIGHT = [-0.55, -0.83];
/** Parts thinner than this on the picture are filled flat: shading would not show. */
const FLAT_BELOW = 0.8;

const mix = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
const span = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** A colour as paint for a round part: toward the light, as it is, and turned away from it. */
function paintOf(color, spec) {
  const tone = base => ({ lit: rgb(blend(base, spec.light, 0.18)), mid: rgb(base), dark: rgb(blend(base, spec.shade, 0.38)) });
  // `far` is the same on the side of the body away from the viewer, which is dimmer.
  return { near: tone(color), far: tone(blend(color, spec.shade, 0.22)) };
}

/**
 * What a player wears, made ready to paint with.
 * @param spec [r, g, b] for skin, hair, jersey, shorts, thigh, shin, shoe, sole, and `shade` and
 *   `light` every colour is turned toward; optional sock, trim, number with `mark` and `font`,
 *   `beard` (0..1), `hairLong` (how far down the head the hairline comes, in head heights).
 */
export function createKit(spec) {
  const paint = color => (color ? paintOf(color, spec) : null);
  return {
    skin: paint(spec.skin), jersey: paint(spec.jersey), shorts: paint(spec.shorts), thigh: paint(spec.thigh),
    shin: paint(spec.shin), sock: paint(spec.sock), shoe: paint(spec.shoe), sole: paint(spec.sole),
    hair: rgb(spec.hair), beard: spec.beard ? rgb(spec.hair, spec.beard) : null, hairLong: spec.hairLong || 0,
    trim: spec.trim ? paint(spec.trim) : null, number: spec.number ? rgb(spec.number, 0.95) : null,
    mark: spec.mark, font: spec.font,
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
 * Fill for a round part: lit on the side that faces the light and falling
 * away to shadow on the other. The part is `r` wide either side of (x, y)
 * and curves along (nx, ny).
 */
function rounded(ctx, tone, x, y, nx, ny, r) {
  if (r < FLAT_BELOW) return tone.mid;
  const lit = nx * LIGHT[0] + ny * LIGHT[1];
  const toward = lit < 0 ? -1 : 1;
  // A part that lies along the light is lit evenly: stretch the fall-off past its edges.
  const reach = (toward * r) / (0.4 + 0.6 * Math.abs(lit));
  const paint = ctx.createLinearGradient(x + nx * reach, y + ny * reach, x - nx * reach, y - ny * reach);
  paint.addColorStop(0, tone.lit);
  paint.addColorStop(0.42, tone.mid);
  paint.addColorStop(1, tone.dark);
  return paint;
}

/** Fills the current path as a part that runs from `a` to `b`, `r` wide at its widest. */
function fillAlong(ctx, a, b, r, tone) {
  const d = span(a, b);
  ctx.fillStyle = d < r * 0.5
    ? rounded(ctx, tone, a[0], a[1], LIGHT[0], LIGHT[1], r)
    : rounded(ctx, tone, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, -(b[1] - a[1]) / d, (b[0] - a[0]) / d, r);
  ctx.fill();
}

/** One tapering segment of a limb. */
function limb(ctx, a, ar, b, br, tone) {
  ctx.beginPath();
  capsule(ctx, a, ar, b, br);
  fillAlong(ctx, a, b, Math.max(ar, br), tone);
}

/** Outline around a set of discs [x, y, r]: the convex hull of points on their rims. */
function hullPath(ctx, discs) {
  const points = [];
  for (const [x, y, r] of discs) {
    for (let i = 0; i < 10; i += 1) points.push([x + Math.cos((i * TAU) / 10) * r, y + Math.sin((i * TAU) / 10) * r]);
  }
  points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const hull = [];
  for (const p of points) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
    hull.push(p);
  }
  const lower = hull.length + 1;
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const p = points[i];
    while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
    hull.push(p);
  }
  ctx.beginPath();
  ctx.moveTo(hull[0][0], hull[0][1]);
  for (let i = 1; i < hull.length - 1; i += 1) ctx.lineTo(hull[i][0], hull[i][1]);
  ctx.closePath();
}

/** Fills the hull of `discs` as one mass, lit across its whole extent. */
function mass(ctx, discs, tone) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, r] of discs) {
    x0 = Math.min(x0, x - r);
    y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r);
    y1 = Math.max(y1, y + r);
  }
  hullPath(ctx, discs);
  ctx.fillStyle = rounded(ctx, tone, (x0 + x1) / 2, (y0 + y1) / 2, LIGHT[0], LIGHT[1], Math.hypot(x1 - x0, y1 - y0) * 0.42);
  ctx.fill();
}

/** The player's joints placed on the picture, with the length that sizes his body. */
function place(camera, pose) {
  return { at: pose.points.map(([x, y]) => [camera.x(x), camera.y(y)]), unit: pose.size * camera.k };
}

function drawArm(ctx, body, kit, side, far) {
  const { at, unit } = body;
  const shoulder = at[side === 'L' ? J.shoulderL : J.shoulderR];
  const elbow = at[side === 'L' ? J.elbowL : J.elbowR];
  const wrist = at[side === 'L' ? J.wristL : J.wristR];
  const skin = far ? kit.skin.far : kit.skin.near;
  limb(ctx, shoulder, BODY.shoulder * unit, elbow, BODY.elbow * unit, skin);
  // The forearm is thickest a third of the way down from the elbow; the hand carries on from it.
  const length = span(elbow, wrist) || 1;
  const belly = mix(elbow, wrist, 0.3);
  const tip = mix(elbow, wrist, 1 + (BODY.handLong * unit) / length);
  ctx.beginPath();
  capsule(ctx, elbow, BODY.elbow * unit, belly, BODY.forearm * unit);
  capsule(ctx, belly, BODY.forearm * unit, wrist, BODY.wrist * unit);
  capsule(ctx, wrist, BODY.hand * unit, tip, BODY.hand * 0.78 * unit);
  fillAlong(ctx, elbow, tip, BODY.forearm * unit, skin);
}

/** A basketball shoe: heel, ball of the foot, toe and the collar round the ankle, on its sole. */
function drawShoe(ctx, ankle, heel, toe, unit, kit, far) {
  const ball = mix(heel, toe, 0.68);
  mass(ctx, [
    [heel[0], heel[1], BODY.heel * unit], [ball[0], ball[1], BODY.ball * unit],
    [toe[0], toe[1], BODY.toe * unit], [ankle[0], ankle[1], BODY.collar * unit],
  ], far ? kit.shoe.far : kit.shoe.near);
  const length = span(heel, toe);
  if (length < BODY.heel * unit) return; // seen end on
  let nx = -(toe[1] - heel[1]) / length;
  let ny = (toe[0] - heel[0]) / length;
  // The sole is on the side of the foot away from the ankle.
  if ((ankle[0] - heel[0]) * nx + (ankle[1] - heel[1]) * ny > 0) { nx = -nx; ny = -ny; }
  ctx.beginPath();
  ctx.moveTo(heel[0] + nx * BODY.heel * 0.85 * unit, heel[1] + ny * BODY.heel * 0.85 * unit);
  ctx.lineTo(toe[0] + nx * BODY.toe * 0.85 * unit, toe[1] + ny * BODY.toe * 0.85 * unit);
  ctx.lineWidth = Math.max(0.45, BODY.sole * unit);
  ctx.strokeStyle = (far ? kit.sole.far : kit.sole.near).mid;
  ctx.stroke();
}

function drawLeg(ctx, body, kit, side, far) {
  const { at, unit } = body;
  const left = side === 'L';
  const hip = at[left ? J.hipL : J.hipR];
  const knee = at[left ? J.kneeL : J.kneeR];
  const ankle = at[left ? J.ankleL : J.ankleR];
  const pick = paint => (far ? paint.far : paint.near);

  limb(ctx, hip, BODY.thigh * unit, knee, BODY.knee * unit, pick(kit.thigh));
  // The calf swells a third of the way down from the knee.
  const calf = mix(knee, ankle, 0.3);
  ctx.beginPath();
  capsule(ctx, knee, BODY.knee * unit, calf, BODY.calf * unit);
  capsule(ctx, calf, BODY.calf * unit, ankle, BODY.ankle * unit);
  fillAlong(ctx, knee, ankle, BODY.calf * unit, pick(kit.shin));
  if (kit.sock) limb(ctx, mix(knee, ankle, 0.7), BODY.ankle * 1.22 * unit, ankle, BODY.ankle * 1.12 * unit, pick(kit.sock));
  drawShoe(ctx, ankle, at[left ? J.heelL : J.heelR], at[left ? J.toeL : J.toeR], unit, kit, far);

  // His shorts hang off the hip over most of the thigh, wider than the leg.
  const hem = mix(hip, knee, BODY.shortsLong);
  limb(ctx, hip, BODY.shortsTop * unit, hem, BODY.shortsHem * unit, pick(kit.shorts));
  if (kit.trim && unit > 24) {
    const out = span(hip, knee) || 1;
    const px = (-(knee[1] - hip[1]) / out) * BODY.shortsHem * 0.92 * unit;
    const py = ((knee[0] - hip[0]) / out) * BODY.shortsHem * 0.92 * unit;
    ctx.beginPath();
    ctx.moveTo(hem[0] + px, hem[1] + py);
    ctx.lineTo(hem[0] - px, hem[1] - py);
    ctx.lineWidth = Math.max(0.5, 0.013 * unit);
    ctx.strokeStyle = pick(kit.trim).mid;
    ctx.stroke();
  }
}

function drawTorso(ctx, body, kit, facing) {
  const { at, unit } = body;
  const sl = at[J.shoulderL];
  const sr = at[J.shoulderR];
  const hl = at[J.hipL];
  const hr = at[J.hipR];
  const top = mix(sl, sr, 0.5);
  const base = mix(hl, hr, 0.5);

  mass(ctx, [
    [hl[0], hl[1], BODY.shortsTop * unit], [hr[0], hr[1], BODY.shortsTop * unit], [...mix(top, base, 0.84), BODY.hip * unit],
  ], kit.shorts.near);

  // A sleeveless jersey: its straps sit inside the shoulders, so the shoulders show past them.
  const chest = mix(top, base, 0.27);
  const waist = mix(top, base, 0.7);
  mass(ctx, [
    [...mix(sl, top, 0.1), BODY.strap * unit], [...mix(sr, top, 0.1), BODY.strap * unit],
    [chest[0], chest[1], BODY.chest * unit], [waist[0], waist[1], BODY.waist * unit],
    [...mix(hl, base, 0.3), BODY.hip * 0.94 * unit], [...mix(hr, base, 0.3), BODY.hip * 0.94 * unit],
  ], kit.jersey.near);

  if (kit.mark && Math.abs(facing) > 0.5 && unit > 34) {
    // His number, square to the chest: on the front when he faces the camera, the back when he does not.
    const lean = Math.atan2(base[1] - top[1], base[0] - top[0]) - Math.PI / 2;
    const where = mix(top, base, facing > 0 ? 0.38 : 0.32);
    ctx.save();
    ctx.translate(where[0], where[1]);
    ctx.rotate(lean);
    ctx.font = `800 ${(0.118 * unit).toFixed(1)}px ${kit.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = kit.number;
    ctx.fillText(kit.mark, 0, 0);
    ctx.restore();
  }
}

function drawHead(ctx, body, kit, facing) {
  const { at, unit } = body;
  const crown = at[J.top];
  const neck = at[J.neck];
  const nose = at[J.nose];
  const reach = span(neck, crown) || 1;
  const up = [(crown[0] - neck[0]) / reach, (crown[1] - neck[1]) / reach];
  const across = [-up[1], up[0]];
  const tall = BODY.headTall * unit;
  const wide = BODY.headWide * unit;
  const centre = [crown[0] - up[0] * tall, crown[1] - up[1] * tall];
  const tilt = Math.atan2(up[1], up[0]) + Math.PI / 2;
  // Which way the face points across the picture, from where the nose sits on the head.
  const turn = Math.max(-1, Math.min(1, ((nose[0] - centre[0]) * across[0] + (nose[1] - centre[1]) * across[1]) / wide));
  // With his back to the camera and his head not turned, there is no face to see.
  const away = facing < -0.35 && Math.abs(turn) < 0.55;
  const skin = kit.skin.near;

  // The neck comes up out of the collar, in the shadow of the jaw.
  limb(ctx, neck, BODY.neck * 1.12 * unit, mix(neck, centre, 0.7), BODY.neck * unit, kit.skin.far);

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(centre[0], centre[1], wide, tall, tilt, 0, TAU);
  ctx.fillStyle = kit.hair;
  ctx.fill();
  if (unit > 16) {
    ctx.clip();
    if (away) {
      // The nape, under the hairline.
      ctx.beginPath();
      ctx.ellipse(centre[0] - up[0] * tall * 1.02, centre[1] - up[1] * tall * 1.02, wide * 0.8, tall * 0.46, tilt, 0, TAU);
      ctx.fillStyle = kit.skin.far.mid;
      ctx.fill();
    } else {
      // The face: the front and lower part of the head, with the hair over and behind it.
      const drop = 0.34 + kit.hairLong;
      const fx = centre[0] + across[0] * turn * wide * 0.55 - up[0] * tall * drop;
      const fy = centre[1] + across[1] * turn * wide * 0.55 - up[1] * tall * drop;
      ctx.beginPath();
      ctx.ellipse(fx, fy, wide * (1.03 - 0.2 * Math.abs(turn)), tall * 0.98, tilt, 0, TAU);
      ctx.fillStyle = rounded(ctx, skin, fx, fy, LIGHT[0], LIGHT[1], tall * 1.25);
      ctx.fill();
      if (kit.beard) {
        ctx.beginPath();
        ctx.ellipse(
          fx + across[0] * turn * wide * 0.2 - up[0] * tall * 0.62, fy + across[1] * turn * wide * 0.2 - up[1] * tall * 0.62,
          wide * 0.78, tall * 0.4, tilt, 0, TAU,
        );
        ctx.fillStyle = kit.beard;
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param camera From `resolveHoopsCamera`: `x`, `y` map capture space to the picture, `k` is its scale.
 * @param pose One player from `sampleCapture`.
 * @param kit From `createKit`.
 * @param {() => void} [carry] Draws what he holds, between his body and the arms in front of it.
 */
export function drawPlayer(ctx, camera, pose, kit, carry) {
  const body = place(camera, pose);
  const { at, unit } = body;
  // +1 facing the camera, -1 with his back to it, 0 in profile.
  const facing = Math.max(-1, Math.min(1, (at[J.shoulderL][0] - at[J.shoulderR][0]) / (0.24 * unit)));
  const nearLeg = pose.legLNear ? 'L' : 'R';
  const farLeg = pose.legLNear ? 'R' : 'L';
  const arms = [['L', pose.armLFront], ['R', pose.armRFront]];
  // Of two arms on the same side of the body, the far one is painted first.
  if (pose.legLNear) arms.reverse();

  for (const [side, front] of arms) if (!front) drawArm(ctx, body, kit, side, true);
  drawLeg(ctx, body, kit, farLeg, true);
  drawLeg(ctx, body, kit, nearLeg, false);
  drawTorso(ctx, body, kit, facing);
  drawHead(ctx, body, kit, facing);
  if (carry) carry();
  for (const [side, front] of arms) if (front) drawArm(ctx, body, kit, side, side !== nearLeg && Math.abs(facing) < 0.6);
}

/**
 * What a player leaves on the floor: a soft shadow under him and a darker one
 * under each foot, fading as the foot lifts.
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
