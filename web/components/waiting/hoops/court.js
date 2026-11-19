/**
 * The court and hoop of the basketball waiting animation, as line art drawn
 * through the camera: nothing is filled, so the page shows through. The court
 * is fixed in the world with the rim's centre above the origin and the
 * baseline behind it; `angle` is where on the arc the play stands, and the
 * court is turned under play space by it.
 */
import { blend, rgb } from '../stage.js';
import { RIM } from './play.js';
import { turn } from '../stick/vec.js';

const TAU = Math.PI * 2;
const HALF_WIDTH = 25;
const BASELINE = 5.25;
const FAR_END = BASELINE - 94;
const MIDCOURT = BASELINE - 47;
const FREE_THROW = BASELINE - 19;
const KEY_HALF = 8;
/** Three-point line: 23 ft 9 in from the rim, straightening 22 ft out in the corners. */
const ARC = 23.75;
const CORNER = 22;
const BOARD = 1.25;
const LINE_WIDTH = 0.17;
/** Nothing nearer the camera than this is drawn. */
const NEAR = 0.6;

/** Points on a floor circle; angle 0 is straight out from the hoop. */
const ring = (cx, cz, radius, from, to, steps) => Array.from({ length: steps + 1 }, (_, i) => {
  const angle = from + (to - from) * (i / steps);
  return [cx - radius * Math.cos(angle), 0, cz + radius * Math.sin(angle)];
});
const floor = (x, z) => [x, 0, z];
const ARC_REACH = Math.asin(CORNER / ARC);

const THREE = [floor(BASELINE, -CORNER), ...ring(0, 0, ARC, -ARC_REACH, ARC_REACH, 44), floor(BASELINE, CORNER)];
const LINES = [
  [floor(FAR_END, -HALF_WIDTH), floor(BASELINE, -HALF_WIDTH), floor(BASELINE, HALF_WIDTH), floor(FAR_END, HALF_WIDTH), floor(FAR_END, -HALF_WIDTH)],
  [floor(MIDCOURT, -HALF_WIDTH), floor(MIDCOURT, HALF_WIDTH)],
  ring(MIDCOURT, 0, 6, 0, TAU, 28),
  [floor(BASELINE, -KEY_HALF), floor(FREE_THROW, -KEY_HALF), floor(FREE_THROW, KEY_HALF), floor(BASELINE, KEY_HALF)],
  ring(FREE_THROW, 0, 6, 0, TAU, 28),
  ring(0, 0, 4, -Math.PI / 2, Math.PI / 2, 14),
];

const BOARD_EDGE = [[BOARD, 9.5, -3], [BOARD, 9.5, 3], [BOARD, 13, 3], [BOARD, 13, -3], [BOARD, 9.5, -3]];
const BOARD_SQUARE = [[BOARD, 10, -1], [BOARD, 10, 1], [BOARD, 11.5, 1], [BOARD, 11.5, -1], [BOARD, 10, -1]];
const STANCHION = [[BOARD, 11.3, 0], [5.9, 10.5, 0], [7.8, 0, 0]];
const RIM_STEPS = 20;
const NET_STRINGS = 12;

function clipNear(a, b) {
  if (a[2] < NEAR && b[2] < NEAR) return null;
  if (a[2] >= NEAR && b[2] >= NEAR) return [a, b];
  const u = (NEAR - a[2]) / (b[2] - a[2]);
  const cut = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, NEAR];
  return a[2] < NEAR ? [cut, b] : [a, cut];
}

/** Stroke a world polyline, each segment as wide as `feet` looks at its distance. */
function strokeLine(ctx, camera, points, color, feet, least = 0.75, most = 5) {
  ctx.strokeStyle = color;
  let previous = camera.view(points[0]);
  for (let i = 1; i < points.length; i += 1) {
    const next = camera.view(points[i]);
    const visible = clipNear(previous, next);
    if (visible) {
      const a = camera.screen(visible[0]);
      const b = camera.screen(visible[1]);
      ctx.lineWidth = Math.min(most, Math.max(least, feet * (a.k + b.k) / 2));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    previous = next;
  }
}

/**
 * The painted lines of the court.
 * @param {number} angle Where on the arc the play stands (radians).
 */
export function drawCourt(ctx, camera, colors, angle) {
  const placed = points => points.map(point => turn(point, -angle));
  ctx.lineCap = 'round';
  const line = rgb(colors.line);
  for (const points of LINES) strokeLine(ctx, camera, placed(points), line, LINE_WIDTH, 0.75, 2.5);
  // The three-point line carries the play, so it is drawn heavier.
  strokeLine(ctx, camera, placed(THREE), rgb(colors.arc), LINE_WIDTH * 1.5, 1.25, 3.5);
}

/**
 * The hoop in two layers, so a ball can pass between them.
 * @param {'back'|'front'} layer `back`: stanchion, backboard and the far half
 *   of the rim. `front`: net and the near half of the rim.
 * @param play Frame from `resolveHoopsPlay`; the net moves after a make.
 */
export function drawHoop(ctx, camera, colors, angle, play, layer) {
  const placed = points => points.map(point => turn(point, -angle));
  const centre = camera.view([0, RIM.y, 0]);
  if (centre[2] < NEAR) return;
  const rim = Array.from({ length: RIM_STEPS + 1 }, (_, i) => {
    const turnAt = (i / RIM_STEPS) * TAU;
    return [RIM.radius * Math.cos(turnAt), RIM.y, RIM.radius * Math.sin(turnAt)];
  });
  const rimColor = rgb(colors.rim);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Each rim segment belongs to the half its middle falls in.
  const strokeRimHalf = (wantFar) => {
    for (let i = 0; i < RIM_STEPS; i += 1) {
      const middle = camera.view([(rim[i][0] + rim[i + 1][0]) / 2, RIM.y, (rim[i][2] + rim[i + 1][2]) / 2]);
      if ((middle[2] > centre[2]) === wantFar) strokeLine(ctx, camera, [rim[i], rim[i + 1]], rimColor, 0.17, 1.25);
    }
  };

  if (layer === 'back') {
    const rig = rgb(colors.rig);
    strokeLine(ctx, camera, placed(STANCHION), rig, 0.4, 1.5, 7);
    strokeLine(ctx, camera, placed(BOARD_EDGE), rig, 0.16, 1.25);
    strokeLine(ctx, camera, placed(BOARD_SQUARE), rgb(blend(colors.rig, colors.line, 0.4)), 0.1, 0.75);
    strokeLine(ctx, camera, placed([[RIM.radius, RIM.y, 0], [BOARD, RIM.y, 0]]), rimColor, 0.3, 1.25);
    strokeRimHalf(true);
    return;
  }

  // After a make the net kicks toward the baseline, flares and sags, then settles.
  const kick = play.net * Math.sin(play.netAge * 17);
  const flare = 1 + 0.45 * play.net * Math.max(0, Math.cos(play.netAge * 9));
  const sag = 0.4 * play.net * Math.abs(Math.sin(play.netAge * 13));
  const net = rgb(colors.net);
  const hoops = [[], []];
  for (let i = 0; i <= NET_STRINGS; i += 1) {
    const turnAt = (i / NET_STRINGS) * TAU;
    const c = Math.cos(turnAt);
    const s = Math.sin(turnAt);
    const top = [RIM.radius * c, RIM.y, RIM.radius * s];
    const middle = [0.56 * flare * c + 0.1 * kick, RIM.y - 0.75 - sag * 0.4, 0.56 * flare * s];
    const bottom = [0.4 * flare * c + 0.22 * kick, RIM.y - 1.5 - sag, 0.4 * flare * s];
    hoops[0].push(middle);
    hoops[1].push(bottom);
    if (i < NET_STRINGS) strokeLine(ctx, camera, placed([top, middle, bottom]), net, 0.05, 0.7);
  }
  for (const loop of hoops) strokeLine(ctx, camera, placed(loop), net, 0.05, 0.7);
  strokeRimHalf(false);
}
