/**
 * Renderer for the basketball waiting animation: paints one solved play frame
 * through the camera onto a transparent canvas. Holds no state. The court is
 * line art the page shows through; the players and the ball are drawn in
 * their own colours.
 */
import { blend, rgb } from '../stage.js';
import { paintParts } from '../stick/figure.js';
import { clamp01 } from '../stick/vec.js';
import { ballPart } from './ball.js';
import { drawCourt, drawHoop } from './court.js';
import { BALL_RADIUS, RIM } from './play.js';
import { playerParts } from './player.js';

const TAU = Math.PI * 2;
const ANKLE = 0.28;

function disc(ctx, x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
}

/** Soft shadows under the players, a darker one under each foot on the floor, and the ball's. */
function drawShadows(ctx, camera, play, colors) {
  const shade = (point, feet, strength) => {
    const at = camera.project([point[0], 0, point[2]]);
    if (at.depth < 1 || strength <= 0) return;
    ctx.fillStyle = rgb(colors.shade, strength);
    ctx.beginPath();
    ctx.ellipse(at.x, at.y, feet * at.k, feet * at.k * camera.squash, 0, 0, TAU);
    ctx.fill();
  };
  for (const fig of [play.defender, play.hero]) {
    shade(fig.ground, 1.1 * fig.size, 0.07);
    for (const leg of fig.legs) {
      // A foot's shadow thins and spreads as the foot leaves the floor.
      const lift = Math.max(0, leg.ankle[1] - ANKLE * fig.size);
      shade([(leg.ankle[0] + leg.toe[0]) / 2, 0, (leg.ankle[2] + leg.toe[2]) / 2], (0.4 + 0.3 * lift) * fig.size, 0.2 * clamp01(1 - lift / 0.9));
    }
  }
  const height = clamp01(play.ball.at[1] / 16);
  shade(play.ball.at, BALL_RADIUS * (1.1 - 0.4 * height), 0.18 * (1 - 0.6 * height));
}

function drawDust(ctx, camera, play, colors) {
  for (const puff of play.dust) {
    for (let i = 0; i < 4; i += 1) {
      const bearing = i * 1.9 + 0.6;
      const drift = puff.size * (0.35 + 0.9 * puff.age);
      const cloud = camera.project([puff.at[0] + Math.cos(bearing) * drift, 0.2 + 0.55 * puff.age * (1 + 0.3 * i), puff.at[2] + Math.sin(bearing) * drift]);
      if (cloud.depth < 1) continue;
      disc(ctx, cloud.x, cloud.y, puff.size * (0.3 + 0.5 * puff.age) * cloud.k, rgb(colors.dust, 0.5 * Math.pow(1 - puff.age, 1.4)));
    }
  }
}

/**
 * Marks drawn flat on the picture: the points going up, the nap, and the
 * running score, which sits in the corner of the core.
 */
function drawMarks(ctx, camera, play, colors, core) {
  const scale = core.width / 352;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (play.pop >= 0) {
    const at = camera.project([-0.5, RIM.y + 0.9 + play.pop * 1.1, 2.9]);
    const strength = clamp01(play.pop / 0.12) * clamp01((1 - play.pop) / 0.3);
    // Only once the camera is on the rim; from across the court it would be a smudge.
    if (at.depth > 1 && at.k > 12 && strength > 0) {
      ctx.font = `800 ${(Math.min(20, Math.max(11, 1.4 * at.k)) * scale).toFixed(1)}px ${colors.font}`;
      ctx.fillStyle = rgb(colors.ball, strength);
      ctx.fillText(`+${play.worth}`, at.x, at.y);
    }
  }
  if (play.doze >= 0) {
    const head = camera.project(play.hero.head);
    for (let i = 0; i < 3; i += 1) {
      if (play.doze < i * 0.3) continue;
      const age = (play.doze - i * 0.3) % 1.2;
      const strength = clamp01(age / 0.15) * clamp01((1.2 - age) / 0.5);
      ctx.font = `700 ${((0.55 + 0.14 * i) * head.k).toFixed(1)}px ${colors.font}`;
      ctx.fillStyle = rgb(colors.text, strength);
      ctx.fillText('z', head.x + (0.95 + 0.5 * i + 0.25 * age) * head.k, head.y - (0.6 + 0.45 * i + 0.8 * age) * head.k);
    }
  }
  if (play.points > 0) {
    // Scoreboard: a ball and his points for this wait.
    ctx.font = `700 ${(11 * scale).toFixed(1)}px ${colors.font}`;
    ctx.textAlign = 'left';
    disc(ctx, core.x + 23 * scale, core.y + 15 * scale, 4.2 * scale, rgb(colors.ball));
    ctx.fillStyle = rgb(colors.text);
    ctx.fillText(String(play.points), core.x + 31 * scale, core.y + 15.5 * scale);
  }
}

/** Fade what has been drawn toward the page, by thinning it. */
function fadeOut(ctx, play, colors, width, height) {
  if (play.fade >= 1) return;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = rgb(colors.ink, 1 - play.fade);
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
}

/** The court and hoop with nobody on it: the world beyond the play on a wide stage. */
function drawBackdrop(ctx, { play, camera, width, height, colors }) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  drawCourt(ctx, camera, colors, play.angle);
  drawHoop(ctx, camera, colors, play.angle, play, 'back');
  drawHoop(ctx, camera, colors, play.angle, play, 'front');
  ctx.restore();
  fadeOut(ctx, play, colors, width, height);
}

/** What each player wears. The shooter is in his team's colours; his defender is kept quieter. */
function kitsOf(colors) {
  const quiet = color => blend(color, colors.surface, 0.12);
  return {
    hero: {
      skin: colors.skin, hair: colors.hair, jersey: colors.jersey, shorts: colors.jersey, number: colors.number, trim: colors.trim,
      legs: colors.tights, shoe: colors.shoe, sole: colors.sole, stripe: colors.trim, guard: colors.guard,
      shade: colors.shade, mark: '30', font: colors.font, beard: true,
    },
    defender: {
      skin: quiet(colors.rivalSkin), hair: colors.hair, jersey: quiet(colors.rival), shorts: quiet(colors.rival), number: colors.rival, trim: colors.sock,
      legs: quiet(colors.rivalSkin), socks: quiet(colors.sock), shoe: quiet(blend(colors.rival, colors.shade, 0.25)), sole: quiet(colors.sole),
      shade: colors.shade, font: colors.font,
    },
  };
}

/**
 * @param {CanvasRenderingContext2D} ctx Scaled to CSS px and cleared to transparent.
 * @param {{ play: object, camera: object, width: number, height: number, colors: object,
 *   core: { x: number, y: number, width: number, height: number },
 *   backdrop?: CanvasRenderingContext2D }} frame `core` and `backdrop` as the stage gives them.
 */
export function drawHoopsFrame(ctx, frame) {
  const { play, camera, width, height, colors, core, backdrop } = frame;
  if (backdrop) drawBackdrop(backdrop, frame);
  const kits = kitsOf(colors);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  drawCourt(ctx, camera, colors, play.angle);
  drawShadows(ctx, camera, play, colors);
  drawHoop(ctx, camera, colors, play.angle, play, 'back');

  const ball = ballPart(ctx, camera, play.ball, BALL_RADIUS, colors);
  // A shot near the hoop is painted between the rim's two halves; otherwise
  // the ball takes its place among the players by distance.
  const atHoop = play.ball.loose && Math.hypot(play.ball.at[0], play.ball.at[1] - RIM.y, play.ball.at[2]) < 7;
  if (atHoop) ball.draw();
  drawHoop(ctx, camera, colors, play.angle, play, 'front');

  const parts = [
    ...playerParts(ctx, camera, play.defender, kits.defender),
    ...playerParts(ctx, camera, play.hero, kits.hero),
  ];
  if (!atHoop) parts.push(ball);
  paintParts(ctx, parts);

  drawDust(ctx, camera, play, colors);
  drawMarks(ctx, camera, play, colors, core);
  fadeOut(ctx, play, colors, width, height);
}
