/**
 * The players of the basketball waiting animation, drawn from a figure
 * (mocap.js `figureOf`) at a person's real proportions: a head an eighth of
 * his height, shoulders wider than his hips, thighs, calves and forearms
 * that swell and taper as muscle does, and a kit cut as one is: a tank top,
 * long shorts, crew socks and high-tops. Every shape is the outline of
 * spheres placed on the skeleton, so it looks right from any side the camera
 * takes, and is shaded across its width from a light at the upper left.
 *
 * Parts come back as { depth, draw } for a painter's sort.
 */
import { blend, rgb } from '../stage.js';
import { add, cross, dot, mix3, mul, sub, unit } from '../stick/vec.js';

const TAU = Math.PI * 2;
const UP = [0, 1, 0];
/** Half-widths of the body in feet, for a man of 6 ft 3 in. */
const GIRTH = Object.freeze({
  thigh: 0.27, knee: 0.165, calf: 0.195, ankle: 0.115, heel: 0.14, toe: 0.11,
  deltoid: 0.19, biceps: 0.155, elbow: 0.11, forearm: 0.13, wrist: 0.085, hand: 0.1,
  neck: 0.2, trapezius: 0.15, skull: 0.27, jaw: 0.225,
});
/** Light from the upper left, as a screen direction. */
const LIGHT = [-0.62, -0.78];
const FAR = 0.18;

/** Outline of two circles and the skin stretched between them, added to `path`. */
function capsule(path, a, ra, b, rb) {
  const far = Math.hypot(b.x - a.x, b.y - a.y);
  if (far <= Math.abs(ra - rb) + 1e-3) {
    const [x, y, radius] = ra >= rb ? [a.x, a.y, ra] : [b.x, b.y, rb];
    path.moveTo(x + radius, y);
    path.arc(x, y, radius, 0, TAU);
    return;
  }
  const base = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = Math.acos((ra - rb) / far);
  path.moveTo(a.x + ra * Math.cos(base + spread), a.y + ra * Math.sin(base + spread));
  path.arc(a.x, a.y, ra, base + spread, base + TAU - spread);
  path.arc(b.x, b.y, rb, base - spread, base + spread);
  path.closePath();
}

function polygon(path, points) {
  path.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) path.lineTo(points[i].x, points[i].y);
  path.closePath();
}

/** Convex outline of screen points. */
function hull(points) {
  points.sort((p, q) => p.x - q.x || p.y - q.y);
  const turn = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const chain = (list) => {
    const out = [];
    for (const point of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  return [...chain(points), ...chain(points.slice().reverse())];
}

/** Outline on screen of spheres given as [centre, radius in feet]. */
function outline(camera, spheres) {
  const points = [];
  for (const [centre, feet] of spheres) {
    const at = camera.project(centre);
    const radius = Math.max(0.5, feet * at.k);
    for (let i = 0; i < 16; i += 1) points.push({ x: at.x + radius * Math.cos(i * TAU / 16), y: at.y + radius * Math.sin(i * TAU / 16) });
  }
  return hull(points);
}

/**
 * Fill `path` in `color`, rounded by a gradient across `width` px about
 * (x, y) at right angles to `axis`: lit on the side facing the light,
 * falling into shade on the other.
 */
function rounded(ctx, path, color, kit, x, y, axis, width) {
  let nx = -axis.y;
  let ny = axis.x;
  const size = Math.hypot(nx, ny) || 1;
  nx /= size;
  ny /= size;
  if (nx * LIGHT[0] + ny * LIGHT[1] < 0) {
    nx = -nx;
    ny = -ny;
  }
  if (width < 2.5) {
    ctx.fillStyle = rgb(color);
    ctx.fill(path);
    return;
  }
  const gradient = ctx.createLinearGradient(x + nx * width, y + ny * width, x - nx * width, y - ny * width);
  gradient.addColorStop(0, rgb(blend(color, kit.light, 0.16)));
  gradient.addColorStop(0.42, rgb(color));
  gradient.addColorStop(1, rgb(blend(color, kit.shade, 0.42)));
  ctx.fillStyle = gradient;
  ctx.fill(path);
}

/** A tapering limb through screen points [{ x, y, r }], rounded across its length. */
function limb(ctx, joints, color, kit) {
  const path = new Path2D();
  for (let i = 1; i < joints.length; i += 1) capsule(path, joints[i - 1], joints[i - 1].r, joints[i], joints[i].r);
  const first = joints[0];
  const last = joints[joints.length - 1];
  const middle = joints[Math.floor(joints.length / 2)];
  const widest = Math.max(...joints.map(joint => joint.r));
  rounded(ctx, path, color, kit, middle.x, middle.y, { x: last.x - first.x, y: last.y - first.y }, widest);
  return path;
}

/**
 * The part of a cap on the head that the camera sees, as a path: the cap is
 * every point of a sphere at (x, y) of `radius` px within `reach` radians of
 * `axis`. Used for hair and beard, which is why they wrap round the head as
 * it turns. Returns false when none of it shows.
 */
function capPath(ctx, x, y, radius, axis, reach, flat) {
  const side = unit(cross(axis, Math.abs(axis[1]) < 0.9 ? UP : [1, 0, 0]));
  const other = cross(axis, side);
  const c = Math.cos(reach);
  const s = Math.sin(reach);
  const steps = 28;
  const rim = [];
  for (let i = 0; i < steps; i += 1) {
    const turn = (i / steps) * TAU;
    const at = flat(add(mul(axis, c), add(mul(side, s * Math.cos(turn)), mul(other, s * Math.sin(turn)))));
    rim.push({ x: x + at.x * radius, y: y + at.y * radius, shows: at.shows });
  }
  const showing = rim.filter(point => point.shows).length;
  if (!showing) return false;
  ctx.beginPath();
  if (showing === steps) {
    polygon(ctx, rim);
    return true;
  }
  // The rim dips behind the head: close the shape along the head's own edge, on the side the cap is.
  let start = 0;
  while (!(rim[start].shows && !rim[(start + steps - 1) % steps].shows)) start += 1;
  const run = [];
  for (let i = start; rim[i % steps].shows && run.length < steps; i += 1) run.push(rim[i % steps]);
  const angleOf = point => Math.atan2(point.y - y, point.x - x);
  const first = angleOf(run[0]);
  const last = angleOf(run[run.length - 1]);
  const middle = flat(axis);
  const wrap = angle => ((angle % TAU) + TAU) % TAU;
  ctx.moveTo(x + radius * Math.cos(first), y + radius * Math.sin(first));
  for (const point of run) ctx.lineTo(point.x, point.y);
  ctx.lineTo(x + radius * Math.cos(last), y + radius * Math.sin(last));
  ctx.arc(x, y, radius, last, first, wrap(Math.atan2(middle.y, middle.x) - last) > wrap(first - last));
  ctx.closePath();
  return true;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param camera Camera from `makeCamera`.
 * @param fig Figure from `figureOf`.
 * @param kit Colours as [r, g, b]: `skin`, `hair`, `jersey`, `shorts`,
 *   `trim`, `number`, `socks`, `shoe`, `sole`, `shade` (what the dark side
 *   of everything is mixed toward) and `light` (what the lit side is). `mark`
 *   is the shirt number, `font` its typeface, `beard` whether he has one.
 * @returns {{ depth: number, draw: () => void }[]} Parts for a painter's sort.
 */
export function playerParts(ctx, camera, fig, kit) {
  const P = point => camera.project(point);
  const pelvis = P(fig.pelvis);
  const chest = P(fig.chest);
  // Too close to, or behind, the camera to draw sensibly.
  if (pelvis.depth < 1.5 || chest.depth < 1.5) return [];
  const size = fig.size;
  const core = (pelvis.depth + chest.depth) / 2;
  const toned = (color, depth) => (depth > core + 0.08 ? blend(color, kit.shade, FAR) : color);
  /** A screen point with a radius of `feet` there. */
  const R = (point, feet) => {
    const at = P(point);
    return { x: at.x, y: at.y, r: Math.max(0.55, feet * size * at.k), depth: at.depth };
  };
  const parts = [];
  const spine = unit(sub(fig.chest, fig.pelvis));

  fig.legs.forEach((leg, index) => {
    const thighAt = u => mix3(leg.hip, leg.knee, u);
    const shinAt = u => mix3(leg.knee, leg.ankle, u);
    const foot = sub(leg.toe, leg.ankle);
    const flat = unit([foot[0], 0, foot[2]]);
    // The heel sits behind and below the ankle joint, whichever way the foot is tipped.
    const heelAt = add(sub(leg.ankle, mul(flat, 0.13 * size)), [0, -0.17 * size, 0]);
    const ballAt = add(mix3(leg.ankle, leg.toe, 0.62), [0, -0.06 * size, 0]);
    const knee = P(leg.knee);
    parts.push({
      depth: knee.depth,
      draw() {
        const skin = toned(kit.skin, knee.depth);
        // Thigh below the shorts, the knee, and a calf that swells high and tapers to the ankle.
        limb(ctx, [R(thighAt(0.6), GIRTH.thigh * 0.92), R(leg.knee, GIRTH.knee), R(shinAt(0.3), GIRTH.calf), R(shinAt(0.72), GIRTH.ankle * 1.18), R(leg.ankle, GIRTH.ankle)], skin, kit);
        // Crew socks over the ankle.
        limb(ctx, [R(shinAt(0.74), GIRTH.ankle * 1.25), R(leg.ankle, GIRTH.ankle * 1.18)], toned(kit.socks, knee.depth), kit);
        // High-top shoe: a collar round the ankle, then heel to toe, on a pale sole.
        const shoe = toned(kit.shoe, knee.depth);
        limb(ctx, [R(add(leg.ankle, [0, 0.02, 0]), GIRTH.heel), R(heelAt, GIRTH.heel * 0.95), R(ballAt, GIRTH.toe * 1.15), R(leg.toe, GIRTH.toe)], shoe, kit);
        const heel = P(add(heelAt, [0, -0.09 * size, 0]));
        const tip = P(add(leg.toe, [0, -0.07 * size, 0]));
        const k = knee.k * size;
        if (k > 5) {
          ctx.strokeStyle = rgb(toned(kit.sole, knee.depth));
          ctx.lineWidth = Math.max(0.8, 0.07 * k);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(heel.x, heel.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
        }
        // Long shorts: wide and loose, down to just above the knee.
        const out = mul(fig.hipsAcross || fig.right, index === 0 ? -1 : 1);
        const shorts = toned(kit.shorts, knee.depth);
        limb(ctx, [R(add(leg.hip, mul(out, 0.03 * size)), 0.37), R(add(thighAt(0.82), mul(out, 0.02 * size)), 0.33)], shorts, kit);
        const hemA = P(add(add(thighAt(0.86), mul(out, 0.3 * size)), mul(spine, 0.02)));
        const hemB = P(add(add(thighAt(0.82), mul(out, -0.3 * size)), mul(spine, 0.02)));
        if (k > 6) {
          ctx.strokeStyle = rgb(toned(kit.trim, knee.depth));
          ctx.lineWidth = Math.max(0.7, 0.045 * k);
          ctx.beginPath();
          ctx.moveTo(hemA.x, hemA.y);
          ctx.lineTo(hemB.x, hemB.y);
          ctx.stroke();
        }
      },
    });
  });

  fig.arms.forEach((arm) => {
    const elbow = P(arm.elbow);
    const hand = P(arm.hand);
    const depth = (elbow.depth + hand.depth) / 2;
    const upperAt = u => mix3(arm.root, arm.elbow, u);
    const foreAt = u => mix3(arm.elbow, arm.wrist, u);
    const reach = unit(sub(arm.hand, arm.wrist));
    parts.push({
      depth,
      draw() {
        const skin = toned(kit.skin, depth);
        limb(ctx, [R(arm.root, GIRTH.deltoid), R(upperAt(0.45), GIRTH.biceps), R(arm.elbow, GIRTH.elbow)], skin, kit);
        limb(ctx, [R(arm.elbow, GIRTH.elbow), R(foreAt(0.28), GIRTH.forearm), R(arm.wrist, GIRTH.wrist)], skin, kit);
        limb(ctx, [R(arm.wrist, GIRTH.wrist), R(arm.hand, GIRTH.hand), R(add(arm.hand, mul(reach, 0.16 * size)), GIRTH.hand * 0.75)], skin, kit);
      },
    });
  });

  parts.push({
    depth: core,
    draw() {
      const k = ((pelvis.k + chest.k) / 2) * size;
      const along = u => mix3(fig.pelvis, fig.chest, u);
      const across = fig.right;
      const hipsAcross = fig.hipsAcross || across;
      const wide = (point, dir, feet) => add(point, mul(dir, feet * size));
      // The shorts' waist and seat.
      const shorts = outline(camera, [
        [wide(along(0.18), hipsAcross, -0.27), 0.3], [wide(along(0.18), hipsAcross, 0.27), 0.3],
        [fig.hips[0], 0.33], [fig.hips[1], 0.33], [add(fig.pelvis, mul(spine, -0.22 * size)), 0.3],
      ].map(([c, r]) => [c, r * size]));
      const lower = new Path2D();
      polygon(lower, shorts);
      rounded(ctx, lower, kit.shorts, kit, pelvis.x, pelvis.y, { x: 0, y: 1 }, 0.4 * k);
      // The neck and the slope of the shoulders, which the jersey's straps sit on.
      const top = fig.chest;
      const base = mix3(fig.chest, fig.neck, 0.4);
      const yoke = new Path2D();
      polygon(yoke, outline(camera, [
        [fig.neck, GIRTH.neck * 0.95], [base, GIRTH.neck * 1.05],
        [mix3(base, fig.shoulders[0], 0.55), GIRTH.trapezius], [mix3(base, fig.shoulders[1], 0.55), GIRTH.trapezius],
      ].map(([c, r]) => [c, r * size])));
      const throat = P(base);
      rounded(ctx, yoke, blend(kit.skin, kit.shade, 0.1), kit, throat.x, throat.y, { x: 0, y: 1 }, GIRTH.neck * k);
      // The jersey: narrow straps over the shoulders, a deep chest, hanging loose over the waist.
      const jersey = outline(camera, [
        [wide(fig.shoulders[0], across, 0.13), 0.13], [wide(fig.shoulders[1], across, -0.13), 0.13],
        [wide(add(along(0.72), mul(fig.forward, 0.08 * size)), across, -0.26), 0.3], [wide(add(along(0.72), mul(fig.forward, 0.08 * size)), across, 0.26), 0.3],
        [wide(along(0.42), across, -0.25), 0.29], [wide(along(0.42), across, 0.25), 0.29],
        [wide(along(0.16), hipsAcross, -0.27), 0.29], [wide(along(0.16), hipsAcross, 0.27), 0.29],
        [add(top, mul(spine, -0.12 * size)), 0.24],
      ].map(([c, r]) => [c, r * size]));
      const upper = new Path2D();
      polygon(upper, jersey);
      const middle = P(along(0.55));
      rounded(ctx, upper, kit.jersey, kit, middle.x, middle.y, { x: chest.x - pelvis.x, y: chest.y - pelvis.y }, 0.55 * k);

      // 1 with his chest to the camera, -1 with his back to it.
      const facing = dot(fig.forward, unit(sub(camera.eye, fig.chest)));
      if (k > 4 && Math.abs(facing) > 0.2) {
        // The neckline between the straps, scooped deep in front and shallow at the back, edged in the trim colour.
        const front = facing > 0;
        const out = mul(fig.forward, (front ? 0.2 : -0.22) * size);
        const left = P(add(wide(base, across, -0.25), out));
        const right = P(add(wide(base, across, 0.25), out));
        const dip = P(add(add(top, mul(spine, (front ? -0.16 : 0.08) * size)), mul(fig.forward, (front ? 0.3 : -0.3) * size)));
        // The control point that takes the curve through `dip` halfway along.
        const bend = { x: 2 * dip.x - (left.x + right.x) / 2, y: 2 * dip.y - (left.y + right.y) / 2 };
        const upLeft = P(wide(fig.neck, across, -0.25));
        const upRight = P(wide(fig.neck, across, 0.25));
        ctx.fillStyle = rgb(blend(kit.skin, kit.shade, 0.1));
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.quadraticCurveTo(bend.x, bend.y, right.x, right.y);
        ctx.lineTo(upRight.x, upRight.y);
        ctx.lineTo(upLeft.x, upLeft.y);
        ctx.closePath();
        ctx.fill();
        if (k > 6) {
          ctx.strokeStyle = rgb(kit.trim);
          ctx.lineWidth = Math.max(0.6, 0.04 * k);
          ctx.beginPath();
          ctx.moveTo(left.x, left.y);
          ctx.quadraticCurveTo(bend.x, bend.y, right.x, right.y);
          ctx.stroke();
        }
      }
      // The number only shows where the torso is big enough, and turned enough, to carry it.
      if (!kit.mark || k < 9 || Math.abs(facing) < 0.3) return;
      const at = P(add(along(0.56), mul(fig.forward, Math.sign(facing) * 0.32 * size)));
      ctx.save();
      ctx.translate(at.x, at.y);
      ctx.rotate(Math.atan2(chest.x - pelvis.x, pelvis.y - chest.y));
      ctx.scale(Math.min(1, 0.25 + Math.abs(facing)), 1);
      ctx.fillStyle = rgb(kit.number);
      ctx.font = `800 ${(0.48 * k).toFixed(1)}px ${kit.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(kit.mark, 0, 0);
      ctx.restore();
    },
  });

  const head = P(fig.head);
  parts.push({
    // Just nearer than the torso, so a head tipped forward stays in front of the chest.
    depth: Math.min(head.depth, core - 0.02),
    draw() {
      const k = head.k * size;
      // The top of the neck, in the head's shadow (the torso draws the rest, under the jersey).
      limb(ctx, [R(fig.neck, GIRTH.neck * 0.95), R(mix3(fig.neck, fig.head, 0.5), GIRTH.neck * 0.9)], blend(kit.skin, kit.shade, 0.14), kit);
      // Skull and jaw: an egg a little longer than it is wide.
      const skullAt = add(fig.head, mul(fig.headUp, 0.04 * size));
      const jawAt = add(add(fig.head, mul(fig.headUp, -0.21 * size)), mul(fig.face, 0.07 * size));
      const skull = P(skullAt);
      const shape = new Path2D();
      polygon(shape, outline(camera, [[skullAt, GIRTH.skull * size], [jawAt, GIRTH.jaw * size]]));
      rounded(ctx, shape, kit.skin, kit, skull.x, skull.y, { x: 0, y: 1 }, GIRTH.skull * k);
      const radius = Math.max(0.8, GIRTH.skull * k);
      const away = unit(sub(skullAt, camera.eye));
      const flat = point => ({ x: dot(point, camera.right), y: -dot(point, camera.up), shows: dot(point, away) < 0 });
      // Short hair, cropped close: on top and round the back.
      ctx.fillStyle = rgb(kit.hair);
      if (capPath(ctx, skull.x, skull.y, radius * 1.03, unit(sub(mul(fig.headUp, 0.8), mul(fig.face, 0.6))), 1.3, flat)) ctx.fill();
      if (kit.beard && radius > 2.2) {
        const jaw = P(jawAt);
        ctx.fillStyle = rgb(kit.hair, 0.7);
        if (capPath(ctx, jaw.x, jaw.y, Math.max(0.8, GIRTH.jaw * k) * 1.02, unit(sub(mul(fig.face, 0.55), mul(fig.headUp, 0.84))), 0.85, flat)) ctx.fill();
      }
    },
  });
  return parts;
}
