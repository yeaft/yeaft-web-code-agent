/**
 * Renderer for the basketball waiting animation: paints one solved play frame
 * through the camera onto a transparent canvas. Holds no state. The players
 * are stick figures in the page's own ink; the ball and the rim are the only
 * colour.
 */
import { blend, rgb } from '../stage.js';
import { paintParts, stickParts } from '../stick/figure.js';
import { clamp01 } from '../stick/vec.js';
import { drawCourt, drawHoop } from './court.js';
import { BALL_RADIUS, DEFENDER_SIZE, RIM } from './play.js';

const TAU = Math.PI * 2;

function disc(ctx, x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
}

function ballPart(ctx, camera, play, colors) {
  const ball = camera.project(play.ball.at);
  return {
    depth: ball.depth,
    draw() {
      if (ball.depth < 1) return;
      const radius = Math.max(1.8, BALL_RADIUS * ball.k);
      play.ball.trail.forEach((point, index) => {
        const ghost = camera.project(point);
        disc(ctx, ghost.x, ghost.y, radius * (1 - 0.14 * (index + 1)), rgb(colors.ball, 0.34 - 0.07 * index));
      });
      // A thin gap round the ball keeps it apart from the hand that has it.
      ctx.globalCompositeOperation = 'destination-out';
      disc(ctx, ball.x, ball.y, radius + Math.max(1, 0.09 * ball.k), rgb(colors.ball));
      ctx.globalCompositeOperation = 'source-over';
      disc(ctx, ball.x, ball.y, radius, rgb(colors.ball));
      if (radius < 3.2) return;
      ctx.save();
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, radius, 0, TAU);
      ctx.clip();
      ctx.translate(ball.x, ball.y);
      ctx.rotate(play.ball.spin);
      ctx.strokeStyle = rgb(colors.seam);
      ctx.lineWidth = Math.max(0.7, 0.07 * ball.k);
      ctx.beginPath();
      ctx.moveTo(-radius, 0);
      ctx.lineTo(radius, 0);
      ctx.stroke();
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(side * radius * 1.05, 0, radius * 0.62, radius * 0.95, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

function drawShadows(ctx, camera, play, colors) {
  const shade = (point, feet, strength) => {
    const at = camera.project([point[0], 0, point[2]]);
    if (at.depth < 1) return;
    ctx.fillStyle = rgb(colors.shade, strength);
    ctx.beginPath();
    ctx.ellipse(at.x, at.y, feet * at.k, feet * at.k * camera.squash, 0, 0, TAU);
    ctx.fill();
  };
  shade(play.defender.ground, 1.2 * DEFENDER_SIZE, 0.1);
  shade(play.hero.ground, 1.15, 0.1);
  const height = clamp01(play.ball.at[1] / 16);
  shade(play.ball.at, BALL_RADIUS * (1.1 - 0.4 * height), 0.16 * (1 - 0.6 * height));
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

/** Marks drawn flat on the picture: the three going up, the nap, and the running score. */
function drawMarks(ctx, camera, play, colors, scale) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (play.pop >= 0) {
    const at = camera.project([-0.5, RIM.y + 0.9 + play.pop * 1.1, 2.9]);
    const strength = clamp01(play.pop / 0.12) * clamp01((1 - play.pop) / 0.3);
    // Only once the camera is on the rim; from across the court it would be a smudge.
    if (at.depth > 1 && at.k > 12 && strength > 0) {
      ctx.font = `800 ${(Math.min(20, Math.max(11, 1.4 * at.k)) * scale).toFixed(1)}px ${colors.font}`;
      ctx.fillStyle = rgb(colors.ball, strength);
      ctx.fillText('+3', at.x, at.y);
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
    disc(ctx, 23 * scale, 15 * scale, 4.2 * scale, rgb(colors.ball));
    ctx.fillStyle = rgb(colors.text);
    ctx.fillText(String(play.points), 31 * scale, 15.5 * scale);
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx Scaled to CSS px and cleared to transparent.
 * @param {{ play: object, camera: object, width: number, height: number, colors: object }} frame
 */
export function drawHoopsFrame(ctx, { play, camera, width, height, colors }) {
  // Lighter tones are mixed toward the page rather than drawn see-through, so
  // overlapping limbs never show darker seams.
  const styles = {
    hero: { near: rgb(colors.ink), far: rgb(blend(colors.ink, colors.surface, 0.36)), mark: '30', markColor: rgb(colors.surface), font: colors.font },
    defender: { near: rgb(blend(colors.soft, colors.surface, 0.18)), far: rgb(blend(colors.soft, colors.surface, 0.5)) },
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  drawCourt(ctx, camera, colors, play.angle);
  drawShadows(ctx, camera, play, colors);
  drawHoop(ctx, camera, colors, play.angle, play, 'back');

  const ball = ballPart(ctx, camera, play, colors);
  // A shot near the hoop is painted between the rim's two halves; otherwise
  // the ball takes its place among the players by distance.
  const atHoop = play.ball.loose && Math.hypot(play.ball.at[0], play.ball.at[1] - RIM.y, play.ball.at[2]) < 7;
  if (atHoop) ball.draw();
  drawHoop(ctx, camera, colors, play.angle, play, 'front');

  const parts = [
    ...stickParts(ctx, camera, play.defender, styles.defender),
    ...stickParts(ctx, camera, play.hero, styles.hero),
  ];
  if (!atHoop) parts.push(ball);
  paintParts(ctx, parts);

  drawDust(ctx, camera, play, colors);
  drawMarks(ctx, camera, play, colors, width / 352);
  if (play.fade < 1) {
    // Fade the whole picture toward the page by thinning what has been drawn.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = rgb(colors.ink, 1 - play.fade);
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  }
}
