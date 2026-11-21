/**
 * The basketball: a shaded sphere whose seams are curves on its surface,
 * turned by the ball's spin and seen through the camera. They roll over the
 * ball the way real seams do, instead of sliding round a flat disc.
 */
import { blend, rgb } from '../stage.js';
import { cross, dot } from '../stick/vec.js';

const TAU = Math.PI * 2;
const STEPS = 28;

/** The eight-panel pattern on a unit sphere: two great circles and the loop either side of one. */
const SEAMS = (() => {
  const loop = at => Array.from({ length: STEPS + 1 }, (_, i) => at((i / STEPS) * TAU));
  // Each side loop runs round a pole, nearest the other seams where those cross.
  const side = sign => loop((turn) => {
    const reach = 0.98 + 0.12 * Math.cos(2 * turn);
    return [sign * Math.cos(reach), Math.sin(reach) * Math.cos(turn), Math.sin(reach) * Math.sin(turn)];
  });
  return [loop(turn => [0, Math.cos(turn), Math.sin(turn)]), loop(turn => [Math.cos(turn), Math.sin(turn), 0]), side(1), side(-1)];
})();

/** `point` turned by `angle` about the unit `axis`. */
function spun(point, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const along = dot(axis, point) * (1 - c);
  const side = cross(axis, point);
  return [point[0] * c + side[0] * s + axis[0] * along, point[1] * c + side[1] * s + axis[1] * along, point[2] * c + side[2] * s + axis[2] * along];
}

function disc(ctx, x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
}

/**
 * @param camera Camera from `makeCamera`.
 * @param {{ at: number[], trail: number[][], axis: number[], spin: number }} ball
 *   Where it is, where it just was, and how far it has turned about `axis`.
 * @param {number} feet Radius of the ball.
 * @param {{ ball: number[], seam: number[], glint: number[] }} colors
 * @returns {{ depth: number, draw: () => void }} A part for a painter's sort.
 */
export function ballPart(ctx, camera, ball, feet, colors) {
  const at = camera.project(ball.at);
  return {
    depth: at.depth,
    draw() {
      if (at.depth < 1) return;
      const radius = Math.max(1.8, feet * at.k);
      ball.trail.forEach((point, index) => {
        const ghost = camera.project(point);
        disc(ctx, ghost.x, ghost.y, radius * (1 - 0.14 * (index + 1)), rgb(colors.ball, 0.34 - 0.07 * index));
      });
      // A thin gap round the ball keeps it apart from the hand that has it.
      ctx.globalCompositeOperation = 'destination-out';
      disc(ctx, at.x, at.y, radius + Math.max(0.8, 0.07 * at.k), '#000');
      ctx.globalCompositeOperation = 'source-over';
      // Lit from the upper left, like the players.
      const shading = ctx.createRadialGradient(at.x - 0.38 * radius, at.y - 0.42 * radius, 0.08 * radius, at.x, at.y, 1.04 * radius);
      shading.addColorStop(0, rgb(blend(colors.ball, colors.glint, 0.42)));
      shading.addColorStop(0.5, rgb(colors.ball));
      shading.addColorStop(1, rgb(blend(colors.ball, colors.seam, 0.62)));
      disc(ctx, at.x, at.y, radius, shading);
      if (radius < 2.6) return;
      ctx.strokeStyle = rgb(colors.seam, radius < 4 ? 0.7 : 0.92);
      ctx.lineWidth = Math.max(0.55, 0.085 * radius);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const seam of SEAMS) {
        ctx.beginPath();
        let drawing = false;
        for (const point of seam) {
          const turned = spun(point, ball.axis, ball.spin);
          // Only the half of the ball that faces the camera.
          if (dot(turned, camera.forward) > 0.04) {
            drawing = false;
            continue;
          }
          const x = at.x + dot(turned, camera.right) * radius;
          const y = at.y - dot(turned, camera.up) * radius;
          if (drawing) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          drawing = true;
        }
        ctx.stroke();
      }
    },
  };
}
