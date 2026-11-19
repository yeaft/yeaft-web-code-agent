/**
 * Canvas renderer for the basketball waiting scene. Paints one solved play
 * frame through the camera; holds no state. Colours come from the `--hoops-*`
 * tokens on the host element so the scene follows the theme and the status tint.
 */
import { BALL_RADIUS, BODY, RIM } from './hoops-play.js';

/** Feet of screen drop per unit of z: the nearer lane sits slightly lower. */
const LANE_DROP = 0.32;
const TAU = Math.PI * 2;

const clamp01 = value => Math.min(1, Math.max(0, value));
const blend = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const css = ([r, g, b]) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

function parseColor(ctx, value, fallback) {
  if (!value) return fallback;
  // Let the canvas normalise any CSS colour syntax to #rrggbb or rgba().
  // Alpha is ignored: the tokens are opaque in both themes, and every colour
  // here is mixed against the surface in RGB rather than drawn translucent.
  ctx.fillStyle = '#000000';
  ctx.fillStyle = value;
  const normal = String(ctx.fillStyle);
  if (normal.startsWith('#') && normal.length === 7) {
    return [parseInt(normal.slice(1, 3), 16), parseInt(normal.slice(3, 5), 16), parseInt(normal.slice(5, 7), 16)];
  }
  const parts = normal.match(/[\d.]+/g);
  return parts && parts.length >= 3 ? parts.slice(0, 3).map(Number) : fallback;
}

/**
 * Resolve the scene palette from the host element's `--hoops-*` tokens.
 * @param {Element} element Host element carrying the tokens.
 * @param {CanvasRenderingContext2D} ctx Any 2D context, used to parse colours.
 */
export function readHoopsPalette(element, ctx) {
  const style = getComputedStyle(element);
  const token = (name, fallback) => parseColor(ctx, style.getPropertyValue(name).trim(), fallback);
  const surface = token('--hoops-surface', [250, 250, 248]);
  const ink = token('--hoops-ink', [44, 44, 44]);
  const soft = token('--hoops-soft', [114, 110, 104]);
  const ball = token('--hoops-ball', [201, 138, 61]);
  // Seams take whichever of ink and surface is darker, so they show in both themes.
  const weight = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const dark = weight(ink) < weight(surface) ? ink : surface;
  return {
    surface, ball,
    hero: ink, heroFar: blend(ink, surface, 0.4),
    defender: blend(soft, surface, 0.3), defenderFar: blend(soft, surface, 0.58),
    line: token('--hoops-line', [224, 221, 216]),
    rig: blend(soft, surface, 0.3),
    shadow: blend(ink, surface, 0.9),
    seam: blend(ball, dark, 0.55),
    label: blend(ink, surface, 0.25),
    font: style.fontFamily || 'sans-serif',
  };
}

function strokePath(ctx, points, width, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
}

function fillCircle(ctx, x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
}

function fillEllipse(ctx, x, y, rx, ry, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.fill();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ play: object, camera: object, width: number, height: number, dpr: number, palette: object }} frame
 *   `width`/`height` are CSS px; `dpr` scales the backing store.
 */
export function drawHoopsFrame(ctx, { play, camera, width, height, dpr, palette }) {
  const scale = camera.scale;
  const originX = width / 2 - camera.cx * scale;
  const originY = height / 2 + camera.cy * scale;
  const X = x => originX + x * scale;
  const Y = (y, z = 0) => originY - y * scale + z * LANE_DROP * scale;
  const at = (point, z) => [X(point.x), Y(point.y, z)];
  // Fading mixes toward the surface instead of using alpha, so overlapping
  // limbs never show darker seams mid-fade.
  const live = color => css(blend(palette.surface, color, play.fade));

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Floor, with plank ticks so camera moves read as travel, and the arc.
  const floorY = Math.round(Y(0)) + 0.5;
  const reach = width + height;
  const line = css(palette.line);
  ctx.lineCap = 'butt';
  strokePath(ctx, [[-reach, floorY], [Math.min(reach, X(5.4)), floorY]], 1, line);
  const firstTick = Math.ceil((-originX - reach) / scale / 6) * 6;
  for (let x = firstTick; x <= 0 && X(x) < reach; x += 6) {
    strokePath(ctx, [[Math.round(X(x)) + 0.5, floorY], [Math.round(X(x)) + 0.5, floorY + 3]], 1, line);
  }
  // The three-point line: one taller tick, so "from deep" has something to be deep of.
  const arcX = Math.round(X(-23.75)) + 0.5;
  strokePath(ctx, [[arcX, floorY], [arcX, floorY + 6]], 1, css(palette.rig));
  ctx.lineCap = 'round';

  // Hoop rig: stanchion, backboard, rim.
  const rig = css(palette.rig);
  strokePath(ctx, [[X(1.3), Y(11.2)], [X(3.6), Y(11.2)], [X(4.7), Y(8.6)], [X(4.7), Y(0)]], Math.max(1.25, 0.2 * scale), rig);
  strokePath(ctx, [[X(1.3), Y(9.45)], [X(1.3), Y(13)]], Math.max(1.75, 0.3 * scale), rig);
  strokePath(ctx, [[X(RIM.x - RIM.radius), Y(RIM.y)], [X(1.3), Y(RIM.y)]], Math.max(1.5, 0.17 * scale), css(palette.ball));

  const figures = [
    { figure: play.defender, color: live(palette.defender), far: live(palette.defenderFar), number: '' },
    { figure: play.hero, color: live(palette.hero), far: live(palette.heroFar), number: '30' },
  ];
  // A dribbled ball lives in the handler's lane, on the side of the hand that has it.
  const handLane = play.ball.depth === 'near' ? 0.35 : play.ball.depth === 'far' ? -0.35 : 0;
  const ballZ = play.ball.loose ? 0 : play.hero.z + handLane;

  // Shadows first so nothing stands on top of its own shadow.
  const shadow = live(palette.shadow);
  for (const { figure } of figures) {
    const lift = clamp01(Math.min(figure.legs[0].foot.y, figure.legs[1].foot.y) / 1.5);
    fillEllipse(ctx, X(figure.hip.x), Y(0, figure.z) + 1, 1.15 * scale * (1 - 0.35 * lift), Math.max(1, 0.13 * scale), shadow);
  }
  const ballHeight = clamp01(play.ball.y / 16);
  fillEllipse(ctx, X(play.ball.x), Y(0, ballZ) + 1, BALL_RADIUS * scale * (1 - 0.45 * ballHeight),
    Math.max(0.75, 0.1 * scale), css(blend(palette.surface, blend(palette.shadow, palette.surface, ballHeight), play.fade)));

  const limb = Math.max(1.6, 0.44 * scale);
  const arm = Math.max(1.4, 0.36 * scale);
  const drawFar = ({ figure, far }) => {
    const leg = figure.legs[1];
    const toe = [X(leg.foot.x + 0.5 * figure.face), Y(leg.foot.y + 0.04, figure.z)];
    strokePath(ctx, [at(figure.hip, figure.z), at(leg.knee, figure.z), at(leg.foot, figure.z), toe], limb, far);
    strokePath(ctx, [at(figure.shoulder, figure.z), at(figure.arms[1].elbow, figure.z), at(figure.arms[1].hand, figure.z)], arm, far);
  };
  const drawNear = ({ figure, color, number }) => {
    const z = figure.z;
    strokePath(ctx, [at(figure.hip, z), at(figure.shoulder, z)], Math.max(2.8, 0.94 * scale), color);
    fillCircle(ctx, X(figure.head.x), Y(figure.head.y, z), Math.max(2.1, BODY.head * scale), color);
    const leg = figure.legs[0];
    const toe = [X(leg.foot.x + 0.5 * figure.face), Y(leg.foot.y + 0.04, z)];
    strokePath(ctx, [at(figure.hip, z), at(leg.knee, z), at(leg.foot, z), toe], limb, color);
    // The number only shows where the jersey is big enough to carry it, and
    // goes on before the arm so the arm covers it the way an arm would.
    if (number && scale >= 14 && Math.abs(figure.face) > 0.6) {
      ctx.save();
      ctx.translate(X((figure.hip.x + figure.shoulder.x) / 2), Y((figure.hip.y + figure.shoulder.y) / 2 + 0.25, z));
      ctx.rotate(figure.lean * figure.side);
      ctx.fillStyle = css(palette.surface);
      ctx.font = `700 ${Math.round(0.56 * scale)}px ${palette.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(number, 0, 0);
      ctx.restore();
    }
    const { elbow, hand } = figure.arms[0];
    if (scale >= 6) {
      // Knock a thin gap around the near arm so it reads against the torso.
      // It starts below the shoulder, which stays fused to the body.
      const start = { x: figure.shoulder.x + (elbow.x - figure.shoulder.x) * 0.4, y: figure.shoulder.y + (elbow.y - figure.shoulder.y) * 0.4 };
      strokePath(ctx, [at(start, z), at(elbow, z), at(hand, z)], arm + Math.max(2, 0.2 * scale), css(palette.surface));
    }
    strokePath(ctx, [at(figure.shoulder, z), at(elbow, z), at(hand, z)], arm, color);
  };
  const drawBall = () => {
    const radius = Math.max(1.9, BALL_RADIUS * scale);
    play.ball.trail.forEach((point, index) => {
      fillCircle(ctx, X(point.x), Y(point.y), radius * (1 - 0.13 * (index + 1)), live(blend(palette.ball, palette.surface, 0.45 + 0.1 * index)));
    });
    const x = X(play.ball.x);
    const y = Y(play.ball.y, ballZ);
    fillCircle(ctx, x, y, radius, live(palette.ball));
    if (radius < 4.5) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.clip();
    ctx.translate(x, y);
    ctx.rotate(play.ball.spin);
    ctx.strokeStyle = live(palette.seam);
    ctx.lineWidth = Math.max(0.75, 0.07 * scale);
    ctx.beginPath();
    ctx.moveTo(-radius, 0);
    ctx.lineTo(radius, 0);
    ctx.moveTo(0, -radius);
    ctx.lineTo(0, radius);
    ctx.stroke();
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * radius * 1.05, 0, radius * 0.62, radius * 0.95, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  };

  const [defender, hero] = figures;
  drawFar(defender);
  drawNear(defender);
  if (play.ball.depth === 'far') drawBall();
  drawFar(hero);
  if (play.ball.depth === 'mid') drawBall();
  drawNear(hero);
  if (play.ball.depth === 'near') drawBall();

  // Net over the ball, so a make drops through it.
  const kick = play.net * Math.sin(play.netAge * 17);
  const spread = 1 + 0.5 * play.net * Math.max(0, Math.cos(play.netAge * 9));
  const sag = 0.38 * play.net * Math.abs(Math.sin(play.netAge * 13));
  const netWidth = Math.max(0.75, 0.05 * scale);
  const mids = [];
  const ends = [];
  for (let i = 0; i < 5; i += 1) {
    const top = [X(RIM.x - 0.72 + i * 0.36), Y(RIM.y)];
    const mid = [X(RIM.x + (-0.56 + i * 0.28) * spread + 0.12 * kick), Y(RIM.y - 0.75 - sag * 0.4)];
    const end = [X(RIM.x + (-0.4 + i * 0.2) * spread + 0.22 * kick), Y(RIM.y - 1.5 - sag)];
    mids.push(mid);
    ends.push(end);
    strokePath(ctx, [top, mid, end], netWidth, rig);
  }
  strokePath(ctx, mids, netWidth, rig);
  strokePath(ctx, ends, netWidth, rig);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (play.pop >= 0) {
    const strength = clamp01(play.pop / 0.15) * clamp01((1 - play.pop) / 0.35) * play.fade;
    ctx.fillStyle = css(blend(palette.surface, palette.ball, strength));
    ctx.font = `700 11px ${palette.font}`;
    ctx.fillText('+3', X(RIM.x - 1.6), Y(RIM.y + 1.5 + play.pop * 1.4));
  }
  if (play.doze >= 0) {
    for (let i = 0; i < 3; i += 1) {
      const age = (play.doze - i * 0.3) % 1.2;
      if (play.doze < i * 0.3) continue;
      const strength = clamp01(age / 0.15) * clamp01((1.2 - age) / 0.5) * play.fade;
      ctx.fillStyle = css(blend(palette.surface, palette.label, strength));
      ctx.font = `600 ${Math.round(Math.min(12, Math.max(7, (0.55 + 0.12 * i) * scale)))}px ${palette.font}`;
      ctx.fillText('z', X(play.hero.head.x + 0.9 + 0.55 * i + 0.25 * age), Y(play.hero.head.y + 0.6 + 0.5 * i + 0.9 * age, play.hero.z));
    }
  }
}
