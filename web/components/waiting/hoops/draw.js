/**
 * Renderer for the basketball waiting animation: paints one frame of the play
 * through the camera onto a transparent canvas. Holds no state. The setting
 * is line art the page shows through; the players and the ball are drawn in
 * their own colours.
 */
import { blend, rgb } from '../stage.js';
import { drawBall, drawBallShadow } from './ball.js';
import { drawBoard, drawCourtBasket, drawFloor, drawRim } from './court.js';
import { createKit, drawPlayer, drawPlayerShadow } from './player.js';

const TAU = Math.PI * 2;
/** The ball's radius as a fraction of the shooter's standing height: it is as far away as he is. */
const BALL_TO_HEIGHT = 0.0617;
/** The ball's radius under the rim, in rim radii. */
const BALL_AT_RIM = 0.52;

/** How much a defender standing well behind the nearest player fades into the page. */
const HAZE = 0.16;

const kitsByColors = new WeakMap();
/**
 * What each player looks like and wears, made once per set of stage colours.
 * Jerseys stay clean and unnumbered so the focus is pure athletic motion rather
 * than broadcast team branding.
 */
function kitsOf(colors) {
  let kits = kitsByColors.get(colors);
  if (kits) return kits;
  const heroNear = colors.ink;
  const heroFar = blend(colors.ink, colors.surface, 0.28);
  const defNear = blend(colors.soft, colors.surface, 0.12);
  const defFar = blend(colors.soft, colors.surface, 0.38);
  const defBackNear = blend(colors.soft, colors.surface, 0.26);
  const defBackFar = blend(colors.soft, colors.surface, 0.48);
  const defenderKit = createKit({
    near: defNear, far: defFar,
    shortsNear: blend(defNear, colors.ink, 0.08),
    shortsFar: defFar,
  });
  const helpKit = createKit({
    near: defBackNear, far: defBackFar,
    shortsNear: defBackNear,
    shortsFar: defBackFar,
  });
  kits = {
    hero: createKit({
      near: heroNear, far: heroFar,
      vest: blend(heroNear, colors.surface, 0.04),
      shortsNear: heroNear,
      shortsFar: heroFar,
    }),
    guard: defenderKit,
    wing: helpKit,
    big: helpKit,
  };
  kitsByColors.set(colors, kits);
  return kits;
}

/** Marks drawn flat on the picture: the running score in the corner, and the points going up at the rim. */
function drawMarks(ctx, play, camera, colors, core) {
  const scale = core.width / 352;
  ctx.textBaseline = 'middle';
  if (play.shot === 'rim' && play.pop >= 0) {
    const strength = Math.min(1, play.pop / 0.12) * Math.min(1, (1 - play.pop) / 0.3);
    if (strength > 0) {
      ctx.textAlign = 'center';
      ctx.font = `800 ${(26 * scale).toFixed(1)}px ${colors.font}`;
      ctx.fillStyle = rgb(colors.ball, strength);
      ctx.fillText(`+${play.worth}`, camera.x(-2.6), camera.y(0.5 - play.pop * 1.3));
    }
  }
  if (play.points > 0) {
    // Scoreboard: a ball and his points for this wait.
    ctx.font = `700 ${(11 * scale).toFixed(1)}px ${colors.font}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = rgb(colors.ball);
    ctx.beginPath();
    ctx.arc(core.x + 23 * scale, core.y + 15 * scale, 4.2 * scale, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgb(colors.text);
    ctx.fillText(String(play.points), core.x + 31 * scale, core.y + 15.5 * scale);
  }
}

/** The possession on the floor. */
function drawCourtShot(ctx, { play, camera, width, colors }) {
  const { players, ball } = play.capture;
  const kits = kitsOf(colors);
  const staged = play.id !== 'replay';
  drawFloor(ctx, camera, colors, width, staged);
  if (staged) drawCourtBasket(ctx, camera, colors, width);

  const radius = players.hero.size * BALL_TO_HEIGHT * camera.k;
  const drawn = {
    x: camera.x(ball.x), y: camera.y(ball.y), radius, spin: play.spin,
    trail: [play.trail[0] * camera.k, play.trail[1] * camera.k],
  };
  const seen = Object.keys(players).filter(name => players[name].presence > 0.01);
  for (const name of seen) {
    ctx.globalAlpha = players[name].presence;
    drawPlayerShadow(ctx, camera, players[name], colors.shade);
  }
  ctx.globalAlpha = 1;
  const floorY = camera.y(ball.floor);
  drawBallShadow(ctx, drawn.x, floorY, radius, floorY - drawn.y - radius, colors.shade);

  // Whoever stands lower on the floor is nearer the camera and painted later.
  const depth = name => players[name].floorL + players[name].floorR;
  const order = [...seen].sort((a, b) => depth(a) - depth(b));
  const nearest = depth(order[order.length - 1]);
  // A ball he cannot be seen with is behind somebody; in his hands it goes
  // between his body and his arms; loose, it is in front of everyone.
  if (ball.hidden) drawBall(ctx, drawn, colors);
  for (const name of order) {
    const hero = name === 'hero';
    // Defenders further off sit back a little, so bodies that overlap stay apart to the eye.
    const back = hero ? 0 : Math.min(1, (nearest - depth(name)) / (0.6 * players[name].size));
    drawPlayer(
      ctx, camera, players[name], kits[name], (1 - HAZE * back) * players[name].presence,
      hero && ball.held && !ball.hidden ? on => drawBall(on, drawn, colors) : undefined,
    );
  }
  if (!ball.held && !ball.hidden) drawBall(ctx, drawn, colors);
}

/** The make, from under the rim. */
function drawRimShot(ctx, { play, camera, width, colors }) {
  drawBoard(ctx, camera, colors, width);
  drawRim(ctx, camera, colors, play, 'far');
  drawBall(ctx, {
    x: camera.x(play.ball.x), y: camera.y(play.ball.y), radius: BALL_AT_RIM * camera.k, spin: play.ball.spin,
  }, colors);
  drawRim(ctx, camera, colors, play, 'near');
}

/**
 * @param {CanvasRenderingContext2D} ctx Scaled to CSS px and cleared to transparent.
 * @param {{ play: object, camera: object, width: number, height: number, colors: object,
 *   core: { x: number, y: number, width: number, height: number },
 *   backdrop?: CanvasRenderingContext2D }} frame `core` and `backdrop` as the stage gives them.
 */
export function drawHoopsFrame(ctx, frame) {
  const { play, camera, width, colors, core, backdrop } = frame;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (play.shot === 'rim') {
    // The setting beyond the play on a wide stage: the basket with nothing going through it.
    if (backdrop) {
      drawBoard(backdrop, camera, colors, width);
      drawRim(backdrop, camera, colors, { ...play, sinceMake: -1, ball: { x: 0, y: -99 } }, 'far');
      drawRim(backdrop, camera, colors, { ...play, sinceMake: -1, ball: { x: 0, y: -99 } }, 'near');
    }
    drawRimShot(ctx, frame);
  } else {
    if (backdrop) {
      backdrop.lineCap = 'round';
      const staged = play.id !== 'replay';
      drawFloor(backdrop, camera, colors, width, staged);
      if (staged) drawCourtBasket(backdrop, camera, colors, width);
    }
    drawCourtShot(ctx, frame);
  }
  drawMarks(ctx, play, camera, colors, core);
}
