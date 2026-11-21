/**
 * The basketball: a lit sphere with its seams, turning as it travels, and a
 * smear behind it when it moves fast.
 */
import { blend, rgb } from '../stage.js';

const TAU = Math.PI * 2;

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, radius: number, spin: number, trail?: [number, number] }} ball
 *   Centre and radius on the picture, `spin` in radians, and `trail`: how far
 *   it has come since a moment ago, in picture px.
 * @param colors Stage colours: ball, seam, glint, shade.
 */
export function drawBall(ctx, ball, colors) {
  const { x, y, radius, spin } = ball;
  if (radius < 0.4) return;
  const trail = ball.trail || [0, 0];
  const speed = Math.hypot(trail[0], trail[1]);
  if (speed > radius * 0.5) {
    // Motion blur: two ghosts back along its path.
    for (const [back, strength] of [[1, 0.16], [0.5, 0.3]]) {
      ctx.fillStyle = rgb(colors.ball, strength);
      ctx.beginPath();
      ctx.arc(x - trail[0] * back, y - trail[1] * back, radius * (1 - 0.12 * back), 0, TAU);
      ctx.fill();
    }
  }

  const paint = ctx.createRadialGradient(x - radius * 0.38, y - radius * 0.45, radius * 0.08, x, y, radius * 1.05);
  paint.addColorStop(0, rgb(blend(colors.ball, colors.glint, 0.5)));
  paint.addColorStop(0.45, rgb(colors.ball));
  paint.addColorStop(1, rgb(blend(colors.ball, colors.shade, 0.45)));
  ctx.fillStyle = paint;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();

  if (radius < 2.2) return;
  // Seams: the equator and the two ribs either side of it, seen on a ball
  // that has turned by `spin` about the axis pointing out of the picture.
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.clip();
  ctx.translate(x, y);
  ctx.rotate(spin);
  ctx.strokeStyle = rgb(colors.seam, 0.7);
  ctx.lineWidth = Math.max(0.5, radius * 0.1);
  ctx.beginPath();
  ctx.moveTo(-radius, 0);
  ctx.lineTo(radius, 0);
  ctx.moveTo(0, -radius);
  ctx.lineTo(0, radius);
  ctx.stroke();
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * radius * 1.12, 0, radius * 0.62, radius * 0.98, 0, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

/** The ball's shadow on the floor: tighter and darker the closer the ball is to it. */
export function drawBallShadow(ctx, x, floorY, radius, height, shade) {
  const lift = Math.max(0, Math.min(1, height / (radius * 14)));
  ctx.fillStyle = rgb(shade, 0.22 * (1 - 0.75 * lift));
  ctx.beginPath();
  ctx.ellipse(x, floorY, radius * (0.95 + 0.5 * lift), radius * (0.95 + 0.5 * lift) * 0.16, 0, 0, TAU);
  ctx.fill();
}
