/**
 * The players of the basketball waiting animation, drawn from a solved
 * figure (stick/rig.js) as people rather than sticks: limbs that taper from
 * joint to joint, a torso with a body's width and depth, a head with hair and
 * a face, and a kit. Every shape is the outline of spheres placed on the
 * skeleton, so a player looks right from any side the camera takes.
 *
 * Parts come back as { depth, draw } for a painter's sort. Each first clears
 * a thin gap round itself, which keeps a limb readable where it crosses the
 * body or the other player, and is lit from the upper left.
 */
import { blend, rgb } from '../stage.js';
import { add, cross, dot, mix3, mul, sub, unit } from '../stick/vec.js';

const TAU = Math.PI * 2;
const UP = [0, 1, 0];
/** Half-widths of the body in feet. */
const GIRTH = Object.freeze({
  shorts: 0.35, hem: 0.33, thigh: 0.27, knee: 0.2, calf: 0.215, ankle: 0.125, heel: 0.17, toe: 0.125,
  deltoid: 0.215, elbow: 0.15, wrist: 0.105, hand: 0.165, neck: 0.16, head: 0.41, chest: 0.44, waist: 0.37, strap: 0.2,
});
/** How far the shaded side of a shape is mixed toward the kit's shade. */
const SHADE = 0.3;
const FAR = 0.2;

const between = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });

/** Outline of two circles and the skin stretched between them, added to `path`. */
function capsule(path, a, ra, b, rb, dx = 0, dy = 0) {
  const ax = a.x + dx;
  const ay = a.y + dy;
  const bx = b.x + dx;
  const by = b.y + dy;
  const far = Math.hypot(bx - ax, by - ay);
  if (far <= Math.abs(ra - rb) + 1e-3) {
    const [x, y, radius] = ra >= rb ? [ax, ay, ra] : [bx, by, rb];
    path.moveTo(x + radius, y);
    path.arc(x, y, radius, 0, TAU);
    return;
  }
  const base = Math.atan2(by - ay, bx - ax);
  const spread = Math.acos((ra - rb) / far);
  path.moveTo(ax + ra * Math.cos(base + spread), ay + ra * Math.sin(base + spread));
  path.arc(ax, ay, ra, base + spread, base + TAU - spread);
  path.arc(bx, by, rb, base - spread, base + spread);
  path.closePath();
}

function polygon(path, points, dx = 0, dy = 0) {
  path.moveTo(points[0].x + dx, points[0].y + dy);
  for (let i = 1; i < points.length; i += 1) path.lineTo(points[i].x + dx, points[i].y + dy);
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

/** Outline on screen of spheres given as [centre, radius in feet], each `grow` px larger. */
function outline(camera, spheres, size, grow = 0) {
  const points = [];
  for (const [centre, feet] of spheres) {
    const at = camera.project(centre);
    const radius = feet * size * at.k + grow;
    for (let i = 0; i < 14; i += 1) points.push({ x: at.x + radius * Math.cos(i * TAU / 14), y: at.y + radius * Math.sin(i * TAU / 14) });
  }
  return hull(points);
}

/**
 * Fill a shape, then shade its lower right: the part a copy of it moved
 * toward the light leaves uncovered. `shape(path, dx, dy)` adds it to a path.
 */
function lit(ctx, shape, color, shade, shift) {
  const body = new Path2D();
  shape(body, 0, 0);
  ctx.fillStyle = rgb(color);
  ctx.fill(body);
  if (shift < 0.45) return;
  ctx.save();
  ctx.clip(body);
  const rest = new Path2D();
  rest.rect(-1e4, -1e4, 2e4, 2e4);
  shape(rest, -shift, -0.8 * shift);
  ctx.fillStyle = rgb(blend(color, shade, SHADE));
  ctx.fill(rest, 'evenodd');
  ctx.restore();
}

function clear(ctx, shape) {
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  shape(ctx);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
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
 * @param fig Solved figure from `solveFigure`.
 * @param kit Colours as [r, g, b]: `skin`, `hair`, `jersey`, `shorts`, `legs`
 *   (tights, or skin again), `shoe`, `number`, `trim`, `shade` (what the dark
 *   side of everything is mixed toward), and optionally `socks`, `sole` (the
 *   shoe's midsole), `stripe` (down the side of the shorts) and `guard` (a
 *   mouthguard). `mark` is the shirt number, `font` its typeface, `beard`
 *   whether he has one.
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
  const gapAt = k => Math.max(0.8, 0.07 * k);
  const toned = (color, depth) => (depth > core + 0.06 ? blend(color, kit.shade, FAR) : color);
  // A lone circle (no second radius) is shaded as the ball it is.
  const limb = (a, ra, b, rb, color) => lit(ctx, (path, dx, dy) => capsule(path, a, ra, b, rb, dx, dy), color, kit.shade, rb > 0 ? 0.36 * Math.min(ra, rb) : 0.22 * ra);
  const parts = [];

  fig.legs.forEach((leg, index) => {
    const hip = P(leg.hip);
    const knee = P(leg.knee);
    const ankle = P(leg.ankle);
    const toe = P(leg.toe);
    const back = [leg.ankle[0] - leg.toe[0], 0, leg.ankle[2] - leg.toe[2]];
    const heelAt = [leg.ankle[0] + back[0] * 0.2, Math.max(0.1 * size, leg.ankle[1] - 0.13 * size), leg.ankle[2] + back[2] * 0.2];
    const heel = P(heelAt);
    // The sole runs under the shoe whichever way the foot is tipped.
    const along = unit(sub(leg.toe, heelAt));
    const under = unit(sub([0, -1, 0], mul(along, -along[1])));
    const sole = [P(add(heelAt, mul(under, 0.115 * size))), P(add(leg.toe, mul(under, 0.085 * size)))];
    // The stripe down the outside of the shorts shows only from that side.
    const outside = mul(fig.right, index === 0 ? -1 : 1);
    const showsOutside = dot(outside, unit(sub(camera.eye, leg.hip))) > 0.12;
    const stripe = [P(add(leg.hip, mul(outside, 0.3 * size))), P(add(mix3(leg.hip, leg.knee, 0.64), mul(outside, 0.29 * size)))];
    const line = (from, to, color, width, cap) => {
      ctx.strokeStyle = rgb(color);
      ctx.lineWidth = width;
      ctx.lineCap = cap;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    };
    parts.push({
      depth: knee.depth,
      draw() {
        const k = knee.k * size;
        const wide = feet => Math.max(0.7, feet * k);
        const gap = gapAt(knee.k);
        const hem = between(hip, knee, 0.64);
        // The gap starts below the hip, which stays fused to the body.
        clear(ctx, (path) => {
          capsule(path, between(hip, knee, 0.45), wide(GIRTH.hem) + gap, knee, wide(GIRTH.knee) + gap);
          capsule(path, knee, wide(GIRTH.calf) + gap, ankle, wide(GIRTH.ankle) + gap);
          capsule(path, heel, wide(GIRTH.heel) + gap, toe, wide(GIRTH.toe) + gap);
        });
        const legs = toned(kit.legs, knee.depth);
        limb(hem, wide(GIRTH.thigh), knee, wide(GIRTH.knee), legs);
        limb(knee, wide(GIRTH.calf), ankle, wide(GIRTH.ankle), legs);
        if (kit.socks) limb(between(knee, ankle, 0.62), wide(0.155), ankle, wide(GIRTH.ankle + 0.012), toned(kit.socks, knee.depth));
        limb(heel, wide(GIRTH.heel), toe, wide(GIRTH.toe), toned(kit.shoe, knee.depth));
        if (kit.sole && k > 4) line(sole[0], sole[1], toned(kit.sole, knee.depth), Math.max(0.7, 0.06 * k), 'round');
        limb(hip, wide(GIRTH.shorts), hem, wide(GIRTH.hem), toned(kit.shorts, knee.depth));
        if (kit.stripe && showsOutside && k > 4) line(stripe[0], stripe[1], toned(kit.stripe, knee.depth), Math.max(0.8, 0.08 * k), 'butt');
      },
    });
  });

  fig.arms.forEach((arm) => {
    const root = P(arm.root);
    const elbow = P(arm.elbow);
    const wrist = P(arm.hand);
    const depth = (elbow.depth + wrist.depth) / 2;
    parts.push({
      depth,
      draw() {
        const k = elbow.k * size;
        const wide = feet => Math.max(0.6, feet * k);
        const gap = gapAt(elbow.k);
        const hand = between(elbow, wrist, 1.12);
        clear(ctx, (path) => {
          capsule(path, between(root, elbow, 0.45), wide(0.18) + gap, elbow, wide(GIRTH.elbow) + gap);
          capsule(path, elbow, wide(GIRTH.elbow) + gap, wrist, wide(GIRTH.wrist) + gap);
          capsule(path, hand, wide(GIRTH.hand) + gap, hand, 0);
        });
        const skin = toned(kit.skin, depth);
        limb(root, wide(GIRTH.deltoid), elbow, wide(GIRTH.elbow), skin);
        limb(elbow, wide(GIRTH.elbow), wrist, wide(GIRTH.wrist), skin);
        limb(hand, wide(GIRTH.hand), hand, 0, skin);
      },
    });
  });

  parts.push({
    depth: core,
    draw() {
      const k = ((pelvis.k + chest.k) / 2) * size;
      const along = u => mix3(fig.pelvis, fig.chest, u);
      const spine = unit(sub(fig.chest, fig.pelvis));
      const across = mul(unit(sub(fig.hips[1], fig.hips[0])), 0.15 * size);
      const jersey = [
        [add(fig.shoulders[0], mul(fig.right, 0.1 * size)), GIRTH.strap], [add(fig.shoulders[1], mul(fig.right, -0.1 * size)), GIRTH.strap],
        [add(along(0.7), mul(fig.forward, 0.07 * size)), GIRTH.chest],
        [sub(along(0.24), across), GIRTH.waist], [add(along(0.24), across), GIRTH.waist],
      ];
      const shorts = [
        [sub(along(0.2), across), GIRTH.waist + 0.012], [add(along(0.2), across), GIRTH.waist + 0.012],
        [fig.hips[0], GIRTH.shorts], [fig.hips[1], GIRTH.shorts], [add(fig.pelvis, mul(spine, -0.14 * size)), 0.33],
      ];
      const gap = gapAt(k / size);
      clear(ctx, (path) => {
        polygon(path, outline(camera, jersey, size, gap));
        polygon(path, outline(camera, shorts, size, gap));
      });
      const shift = 0.14 * k;
      const lower = outline(camera, shorts, size);
      lit(ctx, (path, dx, dy) => polygon(path, lower, dx, dy), kit.shorts, kit.shade, shift);
      const upper = outline(camera, jersey, size);
      lit(ctx, (path, dx, dy) => polygon(path, upper, dx, dy), kit.jersey, kit.shade, shift);

      // 1 with his chest to the camera, −1 with his back to it.
      const facing = dot(fig.forward, unit(sub(camera.eye, fig.chest)));
      const lean = Math.atan2(chest.x - pelvis.x, pelvis.y - chest.y);
      if (k > 6 && facing > 0.25) {
        // The neckline: a V in the trim colour.
        const dip = P(add(add(fig.chest, mul(spine, -0.2 * size)), mul(fig.forward, 0.3 * size)));
        ctx.strokeStyle = rgb(kit.trim);
        ctx.lineWidth = Math.max(0.7, 0.055 * k);
        ctx.beginPath();
        const left = P(add(fig.chest, mul(fig.right, -0.24 * size)));
        const right = P(add(fig.chest, mul(fig.right, 0.24 * size)));
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(dip.x, dip.y);
        ctx.lineTo(right.x, right.y);
        ctx.stroke();
      }
      // The number only shows where the torso is big enough, and turned enough, to carry it.
      if (!kit.mark || k < 8 || Math.abs(facing) < 0.3) return;
      const middle = P(add(along(0.58), mul(fig.forward, Math.sign(facing) * 0.3 * size)));
      ctx.save();
      ctx.translate(middle.x, middle.y);
      ctx.rotate(lean);
      ctx.scale(Math.min(1, 0.25 + Math.abs(facing)), 1);
      ctx.fillStyle = rgb(kit.number);
      ctx.font = `800 ${(0.6 * k).toFixed(1)}px ${kit.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(kit.mark, 0, 0);
      ctx.restore();
    },
  });

  const head = P(fig.head);
  const neck = P(fig.chest);
  parts.push({
    // Just nearer than the torso, so a head tipped forward stays in front of the chest.
    depth: Math.min(head.depth, core - 0.02),
    draw() {
      const k = head.k * size;
      const radius = Math.max(1.8, GIRTH.head * k);
      const gap = gapAt(head.k);
      clear(ctx, path => capsule(path, head, radius + gap, head, 0));
      // The neck sits in the head's shadow.
      limb(neck, Math.max(0.7, GIRTH.neck * k), head, Math.max(0.7, 0.15 * k), blend(kit.skin, kit.shade, 0.16));
      limb(head, radius, head, 0, kit.skin);

      const away = unit(sub(fig.head, camera.eye));
      const flat = point => ({ x: dot(point, camera.right), y: -dot(point, camera.up), shows: dot(point, away) < 0 });
      const hair = rgb(kit.hair);
      // A short fade: cropped on top, thinning down the sides and back.
      ctx.fillStyle = rgb(kit.hair, 0.4);
      if (capPath(ctx, head.x, head.y, radius, unit(sub(mul(fig.headUp, 0.74), mul(fig.face, 0.67))), 1.62, flat)) ctx.fill();
      ctx.fillStyle = hair;
      if (capPath(ctx, head.x, head.y, radius, unit(sub(mul(fig.headUp, 0.84), mul(fig.face, 0.54))), 1.34, flat)) ctx.fill();
      if (kit.beard) {
        ctx.fillStyle = rgb(kit.hair, 0.78);
        if (capPath(ctx, head.x, head.y, radius, unit(sub(mul(fig.face, 0.6), mul(fig.headUp, 0.8))), 0.62, flat)) ctx.fill();
      }
      if (radius < 6) return;
      // Close enough for a face: eyes, and the mouthguard he chews on.
      const right = unit(cross(fig.face, fig.headUp));
      for (const side of [-1, 1]) {
        const eye = flat(unit(add(add(mul(fig.face, 0.9), mul(right, 0.36 * side)), mul(fig.headUp, 0.1))));
        if (!eye.shows) continue;
        ctx.fillStyle = hair;
        ctx.beginPath();
        ctx.ellipse(head.x + eye.x * radius, head.y + eye.y * radius, Math.max(0.6, 0.095 * radius), Math.max(0.5, 0.07 * radius), 0, 0, TAU);
        ctx.fill();
      }
      if (!kit.guard || radius < 8) return;
      const mouth = flat(unit(add(sub(mul(fig.face, 0.82), mul(fig.headUp, 0.46)), mul(right, 0.2))));
      if (!mouth.shows) return;
      ctx.strokeStyle = rgb(kit.guard);
      ctx.lineWidth = Math.max(1, 0.13 * radius);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(head.x + mouth.x * radius, head.y + mouth.y * radius);
      ctx.lineTo(head.x + (mouth.x + 0.16) * radius, head.y + (mouth.y + 0.1) * radius);
      ctx.stroke();
    },
  });
  return parts;
}
