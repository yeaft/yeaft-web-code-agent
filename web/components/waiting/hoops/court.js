/**
 * The setting of the basketball waiting animation, as line art the page shows
 * through: the floor of the possession (its far edge and the three-point
 * line, where the capture has them) and, for the make, the basket from below.
 */
import { rgb } from '../stage.js';
import { ARC, FLOOR_EDGE } from './tracks.js';

const TAU = Math.PI * 2;

/**
 * Floor lines across the whole canvas.
 * @param camera From `resolveHoopsCamera` on the court.
 * @param {number} width Canvas width in CSS px.
 */
export function drawFloor(ctx, camera, colors, width) {
  const left = camera.worldX(0);
  const right = camera.worldX(width);
  const thin = Math.max(0.6, 13 * camera.k);

  // Where the floor ends and the stands begin.
  ctx.lineWidth = thin;
  ctx.strokeStyle = rgb(colors.line);
  ctx.beginPath();
  ctx.moveTo(0, camera.y(FLOOR_EDGE[0] + FLOOR_EDGE[1] * left));
  ctx.lineTo(width, camera.y(FLOOR_EDGE[0] + FLOOR_EDGE[1] * right));
  ctx.stroke();

  // The three-point line: a circle on the floor, seen nearly edge-on. Its top
  // is at the left; both sides run off to the right, toward the basket.
  const [cx, cy, a, b, shear] = ARC;
  if (right <= cx - a) return;
  const reach = Math.acos(Math.max(-1, Math.min(1, (cx - right) / a)));
  ctx.lineWidth = Math.max(0.8, 18 * camera.k);
  ctx.strokeStyle = rgb(colors.arc);
  ctx.beginPath();
  const steps = 56;
  for (let i = 0; i <= steps; i += 1) {
    // Even steps in angle bunch the points at the tip, where the line turns.
    const angle = -reach + (2 * reach * i) / steps;
    const x = cx - a * Math.cos(angle);
    const y = cy + shear * (x - cx) + b * Math.sin(angle);
    if (i === 0) ctx.moveTo(camera.x(x), camera.y(y)); else ctx.lineTo(camera.x(x), camera.y(y));
  }
  ctx.stroke();
}

/** The basket from below, in rim radii from the centre of the rim. */
const BOARD = [[-2.5, -1.05], [4.3, -1.75], [4.3, -7.2], [-2.5, -6.1]];
const TARGET = [[-1.25, -1.45], [1.55, -1.72], [1.55, -3.95], [-1.25, -3.6]];
const RIM_TILT = 0.36; // how open the rim's ellipse is from this low
const NET = { length: 1.95, strands: 12, rings: [[0, 1], [0.34, 0.84], [0.68, 0.68], [1, 0.58]] };

function polygon(ctx, camera, points) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(camera.x(x), camera.y(y)) : ctx.lineTo(camera.x(x), camera.y(y))));
  ctx.closePath();
}

/** The backboard, its target square and the arm that holds it: what stays put. */
export function drawBoard(ctx, camera, colors, width) {
  ctx.lineJoin = 'round';
  polygon(ctx, camera, BOARD);
  ctx.fillStyle = rgb(colors.rig, 0.1);
  ctx.fill();
  ctx.lineWidth = Math.max(0.8, 0.09 * camera.k);
  ctx.strokeStyle = rgb(colors.rig);
  ctx.stroke();
  polygon(ctx, camera, TARGET);
  ctx.lineWidth = Math.max(0.7, 0.07 * camera.k);
  ctx.stroke();
  // The arm runs back from behind the board and off the picture.
  ctx.lineWidth = Math.max(1, 0.42 * camera.k);
  ctx.strokeStyle = rgb(colors.rig, 0.55);
  ctx.beginPath();
  ctx.moveTo(camera.x(4.3), camera.y(-3.6));
  ctx.lineTo(Math.max(width, camera.x(9)), camera.y(-2.2) + (Math.max(width, camera.x(9)) - camera.x(9)) * 0.3);
  ctx.stroke();
  // Bracket between board and rim.
  ctx.lineWidth = Math.max(0.8, 0.16 * camera.k);
  ctx.strokeStyle = rgb(colors.rim);
  ctx.beginPath();
  ctx.moveTo(camera.x(0.15), camera.y(-RIM_TILT));
  ctx.lineTo(camera.x(0.3), camera.y(-1.3));
  ctx.stroke();
}

/** Where the net is pushed and pulled to as the ball goes through and it swings back. */
function netShape(play) {
  const since = play.sinceMake;
  const ball = play.ball;
  const settle = since > 0 ? Math.exp(-4.2 * since) : 0;
  return {
    sway: since > 0 ? 0.22 * settle * Math.sin(17 * since) : 0,
    stretch: since > 0 ? 0.32 * settle * Math.cos(15 * since) + 0.28 * Math.max(0, 1 - Math.abs(ball.y - NET.length) / 1.2) : 0,
    ball,
  };
}

/**
 * One half of the rim and net: the far half is painted before the ball and
 * the near half after it, so the ball goes through the middle.
 * @param {'far' | 'near'} half
 */
export function drawRim(ctx, camera, colors, play, half) {
  const far = half === 'far';
  const shape = netShape(play);
  const length = NET.length + shape.stretch;
  /** A point of the net: `turn` around the rim (0..1), `ring` index down its length. */
  const knot = (turn, ring) => {
    const [down, wide] = NET.rings[ring];
    const y = down * length;
    let radius = wide;
    // The ball pushes the net out where it is.
    const gap = Math.abs(y - shape.ball.y);
    if (gap < 0.56) radius = Math.max(radius, Math.sqrt(0.56 * 0.56 - gap * gap) + 0.06);
    const angle = turn * TAU;
    return [Math.cos(angle) * radius + shape.sway * down, y + Math.sin(angle) * radius * RIM_TILT];
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.5, 0.055 * camera.k);
  ctx.strokeStyle = rgb(colors.net, far ? 0.65 : 0.95);
  ctx.beginPath();
  for (let i = 0; i < NET.strands; i += 1) {
    const turn = (i + 0.5) / NET.strands;
    // Strands on the far side of the rim have the upper half of its ellipse.
    if ((Math.sin(turn * TAU) < 0) !== far) continue;
    for (const lean of [-1, 1]) {
      NET.rings.forEach((_, ring) => {
        const [x, y] = knot(turn + (lean * (ring % 2)) / (2 * NET.strands), ring);
        if (ring === 0) ctx.moveTo(camera.x(x), camera.y(y)); else ctx.lineTo(camera.x(x), camera.y(y));
      });
    }
  }
  ctx.stroke();

  ctx.lineWidth = Math.max(1.1, 0.15 * camera.k);
  ctx.strokeStyle = rgb(colors.rim);
  ctx.beginPath();
  ctx.ellipse(camera.x(0), camera.y(0), camera.k, camera.k * RIM_TILT, 0, far ? Math.PI : 0, far ? TAU : Math.PI);
  ctx.stroke();
}
