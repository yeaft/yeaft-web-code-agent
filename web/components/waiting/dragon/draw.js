/**
 * Renderer for the Dragon Ball waiting animation: paints one solved frame of
 * the fight through the camera onto a transparent canvas. Holds no state.
 * The fighters are stick figures, told apart by hair, body tone and torso
 * colour; the floor is a few thin lines; everything else is energy.
 */
import { blend, rgb } from '../stage.js';
import { paintParts, stickParts } from '../stick/figure.js';
import { clamp01, smooth, span } from '../stick/vec.js';
import { drawAura, drawBeam, drawBlast, drawBolt, drawBomb, drawBurst, drawDust, drawMotes, drawOrb, drawSmoke, drawSparks, drawSpeedLines, hash } from './fx.js';
import { GOKU_HAIR, VEGETA_HAIR, makeCrown } from './hair.js';

const TAU = Math.PI * 2;

/**
 * Stretches of floor line, broken like a line drawn by hand: [from x, to x, z].
 * The fight keeps within ±27 ft; the floor runs on well past that for the
 * world either side of the fight on a wide stage.
 */
const FLOOR = [
  [-27, -18.6, 0], [-17.9, -8.2, 0], [-7.4, 2.9, 0], [3.5, 13.6, 0], [14.4, 24, 0],
  [-14, -11.6, 2.6], [-4.6, -2.9, 3.1], [5.2, 7.9, 2.4], [-9.5, -7.8, -3.4], [0.8, 3.2, -3.8], [10.4, 12.2, -3], [16, 18.4, 2.8], [-21, -19, -2.6],
  // Beyond the fight.
  [-78, -68, 0], [-67.2, -58.4, 0], [-57.6, -47.7, 0], [-46.9, -38.2, 0], [-37.4, -27.8, 0],
  [24.8, 34.1, 0], [34.9, 45.3, 0], [46, 55.2, 0], [56.1, 66.4, 0], [67.2, 78, 0],
  [-70.5, -68.4, 2.7], [-61, -59.2, -3.6], [-50.4, -47.9, 2.5], [-41, -39.1, -3.2], [-33.5, -31.2, 2.9],
  [28.6, 30.9, -3.1], [37.2, 39.4, 2.6], [44.8, 46.6, -3.7], [52.5, 55.1, 3], [62.4, 64.2, -2.8], [71, 73.3, 2.4],
];
/** Rocks: outlines standing on the floor, as [x, y] offsets from a spot. */
const ROCKS = [
  { at: [-19.5, -2.2], outline: [[0, 0], [0.5, 1.0], [1.4, 1.35], [2.2, 0.7], [2.6, 0]] },
  { at: [13.4, -2.6], outline: [[0, 0], [0.4, 0.6], [1.1, 0.8], [1.6, 0]] },
  { at: [3.6, -4.4], outline: [[0, 0], [0.3, 0.4], [0.9, 0.5], [1.2, 0]] },
  // Beyond the fight.
  { at: [-35, -3], outline: [[0, 0], [0.4, 0.7], [1.2, 0.9], [1.9, 0.4], [2.2, 0]] },
  { at: [-56, -3.6], outline: [[0, 0], [0.3, 0.45], [0.9, 0.55], [1.3, 0]] },
  { at: [30, -2.4], outline: [[0, 0], [0.5, 0.9], [1.3, 1.2], [2.1, 0.6], [2.4, 0]] },
  { at: [49, -3.9], outline: [[0, 0], [0.3, 0.4], [0.9, 0.5], [1.2, 0]] },
  { at: [63, -2.8], outline: [[0, 0], [0.4, 0.6], [1.1, 0.8], [1.6, 0]] },
];
/** Cracks running out from where the first wave hit: [dx, dz, length]. */
const CRACKS = [[-1, 0.15, 2.6], [1, -0.1, 2.2], [-0.6, 1, 1.5], [0.7, 1, 1.7], [-0.5, -1, 1.8], [0.55, -1, 1.4]];

function polyline(ctx, points) {
  ctx.beginPath();
  points.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
  ctx.stroke();
}

/** The bare floor: its lines and rocks. */
function drawGround(ctx, camera, colors) {
  const P = point => camera.project(point);
  ctx.strokeStyle = rgb(colors.ground);
  ctx.lineWidth = 1.2;
  for (const [from, to, z] of FLOOR) {
    const a = P([from, 0, z]);
    const b = P([to, 0, z]);
    if (a.depth > 1 && b.depth > 1) polyline(ctx, [a, b]);
  }
  for (const rock of ROCKS) {
    const points = rock.outline.map(([dx, dy]) => P([rock.at[0] + dx, dy, rock.at[1]]));
    if (points.every(point => point.depth > 1)) polyline(ctx, points);
  }
}

/** The floor as the fight leaves it: the crater opens where the first wave hits. */
function drawFloor(ctx, camera, play, colors) {
  const P = point => camera.project(point);
  drawGround(ctx, camera, colors);
  if (play.crater) {
    const [x, , z] = play.crater.at;
    const open = smooth(clamp01(play.crater.age / 0.25));
    ctx.strokeStyle = rgb(blend(colors.ground, colors.ink, 0.3));
    for (const [dx, dz, long] of CRACKS) {
      const mid = P([x + dx * long * 0.5 * open, 0, z + dz * long * 0.5 * open + 0.2 * dx]);
      polyline(ctx, [P([x + dx * 0.3, 0, z + dz * 0.3]), mid, P([x + dx * long * open, 0, z + dz * long * open])]);
    }
    // Rubble thrown up round the rim.
    for (const side of [-1, 1]) {
      const base = x + side * 1.5;
      polyline(ctx, [P([base - 0.4, 0, z + 0.4]), P([base - 0.1 * side, 0.5 * open, z + 0.4]), P([base + 0.45, 0, z + 0.4])]);
    }
  }
}

function drawShadows(ctx, camera, play, colors) {
  for (const who of ['goku', 'vegeta']) {
    const fig = play[who];
    const at = camera.project(fig.ground);
    if (at.depth < 1 || play.shown[who] < 0.5) continue;
    // Smaller and fainter the higher the fighter flies.
    const height = clamp01((fig.pelvis[1] - 3) / 9);
    ctx.fillStyle = rgb(colors.shade, 0.12 * (1 - 0.7 * height));
    ctx.beginPath();
    ctx.ellipse(at.x, at.y, (1.25 - 0.5 * height) * at.k, Math.max(1, (1.25 - 0.5 * height) * at.k * camera.squash), 0, 0, TAU);
    ctx.fill();
  }
}

/** Screen box of a figure: its middle, top of the hair and lowest foot. */
function boxOf(camera, fig) {
  const head = camera.project(fig.head);
  const pelvis = camera.project(fig.pelvis);
  const feet = fig.legs.map(leg => camera.project(leg.toe).y);
  return { x: (head.x + pelvis.x) / 2, top: head.y - 2.2 * head.k, bottom: Math.max(feet[0], feet[1], pelvis.y) + 0.5 * pelvis.k, k: pelvis.k };
}

/** A figure's parts, thinned to `strength` when it is an after-image or half gone. */
function fighterParts(ctx, camera, fig, style, strength) {
  if (strength <= 0.02) return [];
  const parts = stickParts(ctx, camera, fig, style);
  if (strength >= 0.99) return parts;
  return parts.map(part => ({
    depth: part.depth,
    draw() {
      ctx.globalAlpha = strength;
      part.draw();
      ctx.globalAlpha = 1;
    },
  }));
}

/** Where wave meets bomb: the wave splashing round the bomb's face, a flare, bolts and sparks. */
function drawFront(ctx, camera, play, colors) {
  const { front, bomb, time } = play;
  const at = camera.project(front.at);
  const centre = camera.project(bomb.at);
  const k = at.k;
  const facing = Math.atan2(at.y - centre.y, at.x - centre.x);
  const wrap = 0.5 + 0.25 * front.heat + 0.08 * Math.sin(time * 17);
  const radius = Math.hypot(at.x - centre.x, at.y - centre.y) / 0.92 + 0.12 * k;
  for (const [color, wide] of [[colors.beam, 0.62], [colors.beamCore, 0.3]]) {
    ctx.strokeStyle = rgb(color);
    ctx.lineWidth = wide * k * (0.7 + 0.3 * front.heat);
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, facing - wrap, facing + wrap);
    ctx.stroke();
  }
  const flicker = Math.floor(time * 18);
  for (let i = 0; i < 5; i += 1) {
    const a = facing + (hash(flicker + i * 5.1) - 0.5) * 3.6;
    const far = k * (1.6 + 2.4 * hash(flicker + i * 2.7)) * (0.6 + 0.6 * front.heat);
    drawBolt(ctx, at.x, at.y, at.x + Math.cos(a) * far, at.y + Math.sin(a) * far, 0.45 * k, flicker + i * 17, Math.max(1, 0.1 * k), rgb(i % 2 ? colors.bomb : colors.beam));
  }
  drawSparks(ctx, at.x, at.y, 3.4 * k * (0.6 + 0.5 * front.heat), time, 14, 1, 40, colors.spark);
  const flare = k * (0.55 + 0.35 * front.heat) * (1 + 0.1 * Math.sin(time * 29));
  ctx.fillStyle = rgb(colors.flash);
  ctx.strokeStyle = rgb(colors.spark);
  ctx.lineWidth = Math.max(1, 0.09 * k);
  ctx.beginPath();
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * TAU + time * 1.3;
    const r = flare * (i % 2 ? 0.55 : 1.25 + 0.5 * hash(i + Math.floor(time * 9)));
    if (i) ctx.lineTo(at.x + Math.cos(a) * r, at.y + Math.sin(a) * r);
    else ctx.moveTo(at.x + Math.cos(a) * r, at.y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/** Marks drawn flat on the picture: the streak of a vanish, speed lines, breath and alarm. */
function drawMarks(ctx, camera, play, colors) {
  const P = point => camera.project(point);
  for (const who of ['goku', 'vegeta']) {
    const [vx, vy] = play.speeds[who];
    const speed = Math.hypot(vx, vy);
    const strength = clamp01((speed - 13) / 14) * play.shown[who];
    if (strength <= 0.02) continue;
    const chest = P(play[who].chest);
    drawSpeedLines(ctx, chest.x, chest.y, -vx / speed, vy / speed, (2.2 + 2.2 * strength) * chest.k, 2.3 * chest.k, 0.8 * strength, who === 'goku' ? 3 : 9, who === 'goku' ? colors.ink : colors.soft);
  }
  if (play.zip) {
    const from = P(play.zip.from);
    const to = P(play.zip.to);
    const head = smooth(clamp01(play.zip.age / 0.45));
    const tail = smooth(clamp01((play.zip.age - 0.3) / 0.7));
    ctx.lineWidth = Math.max(1, 0.1 * from.k);
    for (let i = 0; i < 5; i += 1) {
      const lift = (i - 2) * 0.55 * from.k;
      ctx.strokeStyle = rgb(colors.ink, 0.6 - 0.08 * Math.abs(i - 2));
      polyline(ctx, [
        { x: from.x + (to.x - from.x) * tail, y: from.y + (to.y - from.y) * tail + lift },
        { x: from.x + (to.x - from.x) * head, y: from.y + (to.y - from.y) * head + lift },
      ]);
    }
  }
  if (play.sigh >= 0) {
    const head = P(play.goku.head);
    const out = play.sigh;
    for (let i = 0; i < 3; i += 1) {
      const life = clamp01(out * 1.5 - i * 0.18);
      if (life <= 0 || life >= 1) continue;
      ctx.fillStyle = rgb(colors.dust, 0.6 * Math.sin(Math.PI * life));
      ctx.beginPath();
      ctx.arc(head.x - (0.7 + 1.5 * life) * head.k, head.y + (0.25 + 0.35 * life) * head.k, (0.16 + 0.3 * life) * head.k, 0, TAU);
      ctx.fill();
    }
  }
  if (play.alarm > 0.02) {
    const head = P(play.vegeta.head);
    ctx.font = `800 ${(1.5 * head.k).toFixed(1)}px ${colors.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgb(colors.spark, play.alarm);
    ctx.fillText('!!', head.x + 1.9 * head.k, head.y - (1.0 + 0.5 * play.alarm) * head.k);
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

/**
 * How far the shake moves the whole picture, a little out of step on each
 * axis, in proportion to the size of the core. [0, 0] when still.
 */
function shakeOffset(play, core) {
  if (play.shake <= 0.05) return [0, 0];
  const size = play.shake * (core.width / 352);
  const t = play.time;
  return [size * (0.7 * Math.sin(t * 91) + 0.3 * Math.sin(t * 147 + 1)), size * (0.7 * Math.cos(t * 83) + 0.3 * Math.sin(t * 131))];
}

/** The bare floor, shaking with the fight: the world beyond it on a wide stage. */
function drawBackdrop(ctx, { play, camera, width, height, colors, core }) {
  ctx.save();
  ctx.translate(...shakeOffset(play, core));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  drawGround(ctx, camera, colors);
  ctx.restore();
  fadeOut(ctx, play, colors, width, height);
}

/**
 * @param {CanvasRenderingContext2D} ctx Scaled to CSS px and cleared to transparent.
 * @param {{ play: object, camera: object, width: number, height: number, colors: object,
 *   core: { x: number, y: number, width: number, height: number },
 *   backdrop?: CanvasRenderingContext2D }} frame `core` and `backdrop` as the stage gives them.
 */
export function drawDragonFrame(ctx, frame) {
  const { play, camera, width, height, colors, core, backdrop } = frame;
  if (backdrop) drawBackdrop(backdrop, frame);
  const P = point => camera.project(point);
  const { time } = play;
  // Lighter tones are mixed toward the page rather than drawn see-through, so
  // overlapping limbs never show darker seams.
  const tones = {
    goku: { near: rgb(colors.ink), far: rgb(blend(colors.ink, colors.surface, 0.34)), torso: rgb(colors.gi) },
    vegeta: { near: rgb(colors.soft), far: rgb(blend(colors.soft, colors.surface, 0.36)), torso: rgb(colors.armor) },
  };
  const hair = { goku: GOKU_HAIR, vegeta: VEGETA_HAIR };
  const styleOf = (who, fig, drift) => ({ ...tones[who], crown: makeCrown(hair[who], fig, camera, tones[who].near, drift) });

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (play.shake > 0.05) ctx.translate(...shakeOffset(play, core));
  drawFloor(ctx, camera, play, colors);
  drawShadows(ctx, camera, play, colors);

  // Energy behind the fighters, who then cut their own outline out of it.
  if (play.aura > 0.02 && play.shown.vegeta > 0.5) {
    const box = boxOf(camera, play.vegeta);
    drawAura(ctx, box.x, box.top - 1.2 * box.k, box.bottom + 0.6 * box.k, (2.3 + 0.5 * play.flare) * box.k, time, Math.min(1.25, play.aura), colors.beam);
    if (play.flare > 0.03) {
      ctx.strokeStyle = rgb(colors.beam, 0.8 * play.flare);
      ctx.lineWidth = 1 + 0.2 * box.k * play.flare;
      ctx.beginPath();
      ctx.arc(box.x, (box.top + box.bottom) / 2, (2 + 5 * (1 - play.flare)) * box.k, 0, TAU);
      ctx.stroke();
    }
  }
  for (const blast of play.blasts) {
    const at = P(blast.at);
    drawBlast(ctx, at.x, at.y, blast.size * at.k, blast, colors, blast.at[1] < 0.5 ? at.y : undefined);
  }
  if (play.bomb) {
    const at = P(play.bomb.at);
    if (play.bomb.gather > 0.02) drawMotes(ctx, at.x, at.y, play.bomb.radius * at.k, 8.5 * at.k, time, play.bomb.gather, colors);
    drawBomb(ctx, at.x, at.y, play.bomb.radius * at.k, time, colors);
  }
  if (play.beam) {
    const from = P(play.beam.from);
    const to = P(play.beam.to);
    drawBeam(ctx, from.x, from.y, to.x, to.y, play.beam.width * 0.5 * from.k, time, play.beam.power, colors);
  }

  // A blow lands behind the two of them, so the pose that landed it stays readable.
  for (const hit of play.hits) {
    const at = P(hit.at);
    drawBurst(ctx, at.x, at.y, hit.size * at.k, hit.age, hit.seed, colors);
  }

  for (const ghost of play.ghosts) {
    paintParts(ctx, fighterParts(ctx, camera, ghost.fig, styleOf(ghost.who, ghost.fig, play.speeds[ghost.who]), ghost.strength));
  }
  paintParts(ctx, [
    ...fighterParts(ctx, camera, play.vegeta, styleOf('vegeta', play.vegeta, play.speeds.vegeta), play.shown.vegeta),
    ...fighterParts(ctx, camera, play.goku, styleOf('goku', play.goku, play.speeds.goku), play.shown.goku),
  ]);

  // In front of them: what flies off the action.
  if (play.orb) {
    const at = P(play.orb.at);
    drawOrb(ctx, at.x, at.y, (0.2 + 0.42 * play.orb.size) * at.k, time, colors);
    drawSparks(ctx, at.x, at.y, 2.2 * at.k, time, 8, play.orb.size, 7, colors.beam);
  }
  if (play.front) drawFront(ctx, camera, play, colors);
  for (const puff of play.dust) {
    const at = P(puff.at);
    drawDust(ctx, at.x, at.y, puff.size * at.k, puff.age, colors.dust);
  }
  if (play.smoke >= 0) {
    const at = P(play.vegeta.chest);
    drawSmoke(ctx, at.x, at.y, 0.9 * at.k, play.smoke, colors.dust);
  }
  drawMarks(ctx, camera, play, colors);
  ctx.restore();
  fadeOut(ctx, play, colors, width, height);
}
