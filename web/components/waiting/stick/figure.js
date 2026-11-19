/**
 * Drawing for stick figures: a solved figure through a camera onto a
 * transparent canvas. A figure is round-capped strokes and a round head in
 * one colour. Its parts are returned as { depth, draw } so a scene can paint
 * everything it holds far to near. Each part first clears a thin gap around
 * itself, which is what keeps a limb readable where it crosses the body, the
 * other figure or the floor lines.
 */
import { BODY } from './rig.js';
import { dot, sub, unit } from './vec.js';

const TAU = Math.PI * 2;
/** Stroke widths in feet. */
const WIDE = Object.freeze({ torso: 0.86, leg: 0.42, arm: 0.36 });

function trace(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
}

/** Clear whatever lies under a stroke of `width` along `points`. */
function clearStroke(ctx, points, width) {
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = width;
  trace(ctx, points);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

function inkStroke(ctx, points, width, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  trace(ctx, points);
  ctx.stroke();
}

const partWay = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param camera Camera from `makeCamera`.
 * @param fig Solved figure from `solveFigure`.
 * @param {{ near: string, far: string, torso?: string, mark?: string, markColor?: string, font?: string, crown?: Function }} style
 *   `near`/`far` are CSS colours for the body and for limbs on its far side,
 *   `torso` an optional colour of its own for the trunk. `mark` is a short
 *   text for the torso (a shirt number) in `markColor`. `crown(ctx, head)`,
 *   if given, draws on top of the head (hair, a hat): `head` has its screen
 *   `x`/`y` and `radius`, `side` (−1 to 1: how far the face is turned to
 *   screen left or right) and `away` (1 for the back of the head, −1 full face).
 * @returns {{ depth: number, draw: () => void }[]} Parts for a painter's sort.
 */
export function stickParts(ctx, camera, fig, style) {
  const P = point => camera.project(point);
  const pelvis = P(fig.pelvis);
  const chest = P(fig.chest);
  // Too close to, or behind, the camera to draw sensibly.
  if (pelvis.depth < 1.5 || chest.depth < 1.5) return [];
  const size = fig.size;
  const core = (pelvis.depth + chest.depth) / 2;
  const tone = depth => (depth > core + 0.06 ? style.far : style.near);
  const gapAt = k => Math.max(1, 0.11 * k);
  const parts = [];

  fig.legs.forEach((leg) => {
    const hip = P(leg.hip);
    const knee = P(leg.knee);
    const ankle = P(leg.ankle);
    const toe = P(leg.toe);
    parts.push({
      depth: knee.depth,
      draw() {
        const width = Math.max(1.6, WIDE.leg * size * knee.k);
        // The gap starts below the hip, which stays fused to the body.
        clearStroke(ctx, [partWay(hip, knee, 0.4), knee, ankle, toe], width + 2 * gapAt(knee.k));
        inkStroke(ctx, [hip, knee, ankle, toe], width, tone(knee.depth));
      },
    });
  });

  fig.arms.forEach((arm) => {
    const root = P(arm.root);
    const elbow = P(arm.elbow);
    const hand = P(arm.hand);
    const depth = (elbow.depth + hand.depth) / 2;
    parts.push({
      depth,
      draw() {
        const width = Math.max(1.4, WIDE.arm * size * elbow.k);
        clearStroke(ctx, [partWay(root, elbow, 0.4), elbow, hand], width + 2 * gapAt(elbow.k));
        inkStroke(ctx, [root, elbow, hand], width, tone(depth));
      },
    });
  });

  parts.push({
    depth: core,
    draw() {
      const k = (pelvis.k + chest.k) / 2;
      const width = Math.max(2.6, WIDE.torso * size * k);
      clearStroke(ctx, [pelvis, chest], width + 2 * gapAt(k));
      inkStroke(ctx, [pelvis, chest], width, style.torso || style.near);
      // The mark only shows where the torso is big enough to carry it.
      if (!style.mark || k < 11) return;
      const middle = partWay(pelvis, chest, 0.56);
      ctx.save();
      ctx.translate(middle.x, middle.y);
      ctx.rotate(Math.atan2(chest.x - pelvis.x, pelvis.y - chest.y));
      ctx.fillStyle = style.markColor;
      ctx.font = `700 ${(0.54 * size * k).toFixed(1)}px ${style.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(style.mark, 0, 0);
      ctx.restore();
    },
  });

  const head = P(fig.head);
  parts.push({
    // Just nearer than the torso, so a head tipped forward stays in front of the chest.
    depth: Math.min(head.depth, core - 0.02),
    draw() {
      const radius = Math.max(2.1, BODY.head * size * head.k);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(head.x, head.y, radius + gapAt(head.k), 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = style.near;
      ctx.beginPath();
      ctx.arc(head.x, head.y, radius, 0, TAU);
      ctx.fill();
      if (style.crown) {
        style.crown(ctx, {
          x: head.x, y: head.y, radius,
          side: dot(fig.face, camera.right), away: dot(fig.face, unit(sub(fig.head, camera.eye))),
        });
      }
    },
  });
  return parts;
}

/** Paint parts far to near. */
export function paintParts(ctx, parts) {
  parts.sort((a, b) => b.depth - a.depth);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const part of parts) part.draw();
}
