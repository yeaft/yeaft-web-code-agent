/**
 * Hair for the Dragon Ball waiting animation: the one detail that says who a
 * stick figure is. A hairstyle is a set of spikes fixed to the skull, each
 * [forward, up, right, length, half-width] in head radii. They are projected
 * with the head's own axes, so the silhouette turns, tips and lies down with
 * the head, and the tips trail a little behind a head that moves fast.
 */
import { cross, dot } from '../stick/vec.js';

/** Spikes fanning to both sides and up, a mane behind, two bangs in front. */
export const GOKU_HAIR = [
  [-0.15, 0.5, 1, 2.0, 0.5], [-0.25, -0.05, 1, 1.7, 0.42],
  [-0.1, 1, 0.42, 1.9, 0.5], [-0.25, 1, -0.3, 2.0, 0.5],
  [-0.15, 0.6, -1, 2.0, 0.5], [-0.3, 0.05, -1, 1.8, 0.45], [-0.35, -0.5, -0.85, 1.45, 0.38],
  [-1, 0.6, 0.1, 1.9, 0.5], [-1, 0.05, -0.1, 1.7, 0.45], [-0.7, 1, 0, 1.9, 0.5], [-0.9, -0.45, 0, 1.4, 0.36],
  [1, 0.55, 0.3, 1.3, 0.38], [1, 0.2, -0.25, 1.25, 0.32],
];

/** One tall flame swept straight up, and the widow's peak. */
export const VEGETA_HAIR = [
  [-0.12, 1, 0, 2.9, 0.62], [-0.05, 1, 0.3, 2.55, 0.5], [-0.05, 1, -0.3, 2.55, 0.5],
  [-0.1, 1, 0.6, 2.05, 0.45], [-0.1, 1, -0.6, 2.05, 0.45],
  [-0.45, 1, 0, 2.5, 0.58], [-0.85, 0.75, 0, 1.75, 0.5],
  [0.95, 0.42, 0, 1.14, 0.3],
];

/**
 * @param {number[][]} spikes A hairstyle from this module.
 * @param fig Solved figure whose head carries it.
 * @param camera Camera the figure is drawn through.
 * @param {string} color CSS colour of the hair.
 * @param {number[]} [drift] Velocity of the head in feet per second; the tips lag behind it.
 * @returns {(ctx: CanvasRenderingContext2D, head: { x: number, y: number, radius: number }) => void}
 *   `crown` callback for `stickParts`.
 */
export function makeCrown(spikes, fig, camera, color, drift = [0, 0, 0]) {
  const right = cross(fig.face, fig.headUp);
  const flat = axis => [dot(axis, camera.right), -dot(axis, camera.up)];
  const F = flat(fig.face);
  const U = flat(fig.headUp);
  const R = flat(right);
  // Lag of the tips, in head radii, capped so the hair bends rather than streams.
  const lag = flat(drift);
  const pull = Math.hypot(lag[0], lag[1]);
  const give = pull > 1e-6 ? -Math.min(0.55, pull * 0.022) / pull : 0;
  return (ctx, head) => {
    const r = head.radius;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const [forward, up, side, long, wide] of spikes) {
      let dx = forward * F[0] + up * U[0] + side * R[0];
      let dy = forward * F[1] + up * U[1] + side * R[1];
      const size = Math.hypot(forward, up, side);
      dx /= size;
      dy /= size;
      // A spike aimed at the camera still shows as a stub past the skull.
      const seen = Math.hypot(dx, dy);
      if (seen < 0.05) continue;
      const reach = Math.max(long * seen, 1.05);
      const ux = dx / seen;
      const uy = dy / seen;
      const tipX = head.x + (ux * reach + lag[0] * give * (long - 1)) * r;
      const tipY = head.y + (uy * reach + lag[1] * give * (long - 1)) * r;
      const baseX = head.x + ux * 0.25 * r;
      const baseY = head.y + uy * 0.25 * r;
      ctx.moveTo(baseX - uy * wide * r, baseY + ux * wide * r);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(baseX + uy * wide * r, baseY - ux * wide * r);
      ctx.closePath();
    }
    ctx.fill();
  };
}
