/**
 * Energy and impact effects for the Dragon Ball waiting animation. Every
 * function draws one effect at a place already projected to the picture, in
 * px, and holds no state: what an effect looks like is a function of the
 * time or age passed in, with any variation taken from `hash`. Effects are
 * shapes with edges of their own on a transparent canvas; the bright ones
 * carry a coloured rim so they read on a light page as well as a dark one.
 */
import { blend, rgb } from '../stage.js';
import { easeOut, mix, smooth, span } from '../stick/vec.js';

const TAU = Math.PI * 2;

/** Repeatable noise in [0, 1) for a number. */
export function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
const fract = value => value - Math.floor(value);

function disc(ctx, x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, radius), 0, TAU);
  ctx.fill();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** Closed outline of a wobbling blob. */
function lump(ctx, x, y, radius, wobble, phase) {
  ctx.beginPath();
  for (let i = 0; i < 26; i += 1) {
    const a = (i / 26) * TAU;
    const r = radius * (1 + wobble * (0.6 * Math.sin(i * 2.4 + phase) + 0.4 * Math.sin(i * 5.3 - phase * 1.7)));
    if (i) ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    else ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}

/**
 * Star-burst of a blow landing: a spiked star that snaps open, a ring and a
 * few flecks thrown off. `age` runs 0 to 1 over its life.
 */
export function drawBurst(ctx, x, y, radius, age, seed, colors) {
  const open = radius * (0.35 + 0.65 * easeOut(Math.min(1, age / 0.2)));
  const fade = 1 - smooth(span(age, 0.35, 0.95));
  const turn = hash(seed) * TAU;
  const points = 9;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const a = turn + (i * Math.PI) / points;
    const r = open * (i % 2 ? 0.34 : 0.72 + 0.5 * hash(seed + i));
    if (i) ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    else ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = rgb(colors.flash, fade);
  ctx.fill();
  ctx.strokeStyle = rgb(colors.spark, fade);
  ctx.lineWidth = Math.max(1, radius * 0.08);
  ctx.stroke();
  ctx.strokeStyle = rgb(colors.spark, 0.85 * Math.pow(1 - age, 1.5));
  ctx.lineWidth = Math.max(0.8, radius * 0.1 * (1 - age));
  ctx.beginPath();
  ctx.arc(x, y, radius * (0.55 + 1.5 * easeOut(age)), 0, TAU);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, radius * 0.07);
  for (let i = 0; i < 7; i += 1) {
    const a = turn + 0.4 + (i * TAU) / 7 + 0.5 * hash(seed + 20 + i);
    const from = radius * (1.0 + 1.5 * easeOut(age));
    const to = from + radius * 0.5 * (1 - age);
    line(ctx, x + Math.cos(a) * from, y + Math.sin(a) * from, x + Math.cos(a) * to, y + Math.sin(a) * to);
  }
}

/** Streaks left in the air behind something fast. (dx, dy) points back along its path. */
export function drawSpeedLines(ctx, x, y, dx, dy, long, spread, strength, seed, color) {
  ctx.lineWidth = Math.max(0.8, spread * 0.045);
  for (let i = 0; i < 6; i += 1) {
    const across = (hash(seed + i * 3.7) - 0.5) * 2 * spread;
    const start = long * (0.25 + 0.5 * hash(seed + i * 1.9));
    const reach = long * (0.5 + 0.7 * hash(seed + i * 5.3));
    const px = x - dy * across + dx * start;
    const py = y + dx * across + dy * start;
    ctx.strokeStyle = rgb(color, strength * (0.35 + 0.4 * hash(seed + i)));
    line(ctx, px, py, px + dx * reach, py + dy * reach);
  }
}

/**
 * Aura: a flame standing round a fighter from `bottom` up to `top`, its
 * tongues climbing. `half` is its half-width.
 */
export function drawAura(ctx, x, top, bottom, half, time, strength, color) {
  const tall = bottom - top;
  const steps = 18;
  const edge = (side, v, scale) => {
    const body = Math.pow(Math.sin(Math.PI * Math.pow(v, 0.72)), 0.8);
    // Tongues: each swells slowly and breaks off as it climbs.
    const lick = fract(v * 4.2 - time * 2.6 + (side > 0 ? 0.4 : 0));
    const sway = half * 0.16 * Math.sin(time * 6.3 + v * 3) * v * v;
    return [x + sway + side * half * scale * body * (0.82 + 0.32 * lick), bottom - tall * v * (0.55 + 0.45 * scale)];
  };
  for (const [scale, fill, rim] of [[1, 0.1, 0.62], [0.6, 0.14, 0.3]]) {
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    for (let i = 1; i < steps; i += 1) ctx.lineTo(...edge(-1, i / steps, scale));
    ctx.lineTo(...edge(1, 1, scale));
    for (let i = steps - 1; i > 0; i -= 1) ctx.lineTo(...edge(1, i / steps, scale));
    ctx.closePath();
    ctx.fillStyle = rgb(color, fill * strength);
    ctx.fill();
    ctx.strokeStyle = rgb(color, rim * strength);
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }
}

/**
 * Energy wave from (ax, ay) to (bx, by): a coloured body with a pale core,
 * a flare where it leaves the hands and a rounded head. `power` 0 to 1
 * thins it as it dies.
 */
export function drawBeam(ctx, ax, ay, bx, by, half, time, power, colors) {
  const long = Math.hypot(bx - ax, by - ay);
  if (long < 1 || power <= 0.01) return;
  const ux = (bx - ax) / long;
  const uy = (by - ay) / long;
  const steps = 12;
  const width = (s, scale) => half * scale * power * (0.5 + 0.5 * smooth(Math.min(1, s * 4))) * (1 + 0.08 * Math.sin(s * long * 0.3 - time * 38));
  const body = (scale) => {
    ctx.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const s = i / steps;
      const w = width(s, scale);
      const px = ax + ux * long * s - uy * w;
      const py = ay + uy * long * s + ux * w;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    for (let i = steps; i >= 0; i -= 1) {
      const s = i / steps;
      const w = width(s, scale);
      ctx.lineTo(ax + ux * long * s + uy * w, ay + uy * long * s - ux * w);
    }
    ctx.closePath();
    ctx.fill();
  };
  ctx.fillStyle = rgb(colors.beam, 0.92);
  body(1);
  disc(ctx, bx, by, half * 1.3 * power, rgb(colors.beam, 0.92));
  disc(ctx, ax, ay, half * 1.25 * power, rgb(colors.beam, 0.92));
  ctx.fillStyle = rgb(colors.beamCore);
  body(0.5);
  disc(ctx, bx, by, half * 0.78 * power, rgb(colors.beamCore));
  disc(ctx, ax, ay, half * 0.72 * power, rgb(colors.beamCore));
  // Streaks running down the core give it a direction.
  ctx.strokeStyle = rgb(colors.beam, 0.55);
  ctx.lineWidth = Math.max(0.8, half * 0.12);
  for (let i = 0; i < 4; i += 1) {
    const s = fract(time * 2.8 + i * 0.27);
    const across = (i - 1.5) * half * 0.2 * power;
    const from = long * s;
    const to = Math.min(long, from + long * 0.12 + half);
    line(ctx, ax + ux * from - uy * across, ay + uy * from + ux * across, ax + ux * to - uy * across, ay + uy * to + ux * across);
  }
}

/** Jagged bolt between two points; `seed` picks its shape, so stepping the seed makes it flicker. */
export function drawBolt(ctx, x1, y1, x2, y2, sway, seed, width, color) {
  const long = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = -(y2 - y1) / long;
  const ny = (x2 - x1) / long;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  for (let i = 1; i < 6; i += 1) {
    const s = i / 6;
    const off = (hash(seed + i * 9.7) - 0.5) * 2 * sway * Math.sin(Math.PI * s);
    ctx.lineTo(mix(x1, x2, s) + nx * off, mix(y1, y2, s) + ny * off);
  }
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** Sparks thrown out from a point, each on its own short life. */
export function drawSparks(ctx, x, y, reach, time, count, strength, seed, color) {
  ctx.lineWidth = Math.max(0.9, reach * 0.045);
  for (let i = 0; i < count; i += 1) {
    const life = fract(time * (1.8 + 2.2 * hash(seed + i)) + hash(seed + i * 2.3));
    const a = hash(seed + i * 4.1 + Math.floor(time * (1.8 + 2.2 * hash(seed + i)) + hash(seed + i * 2.3))) * TAU;
    const from = reach * (0.2 + 0.8 * easeOut(life));
    const to = from + reach * 0.3 * (1 - life);
    const fall = reach * 0.3 * life * life;
    ctx.strokeStyle = rgb(color, strength * (1 - life));
    line(ctx, x + Math.cos(a) * from, y + Math.sin(a) * from + fall, x + Math.cos(a) * to, y + Math.sin(a) * to + fall);
  }
}

/** The charge between cupped palms: a small bright ball, crackling. */
export function drawOrb(ctx, x, y, radius, time, colors) {
  disc(ctx, x, y, radius * 1.9, rgb(colors.beam, 0.22));
  disc(ctx, x, y, radius, rgb(colors.beam));
  disc(ctx, x, y, radius * 0.58, rgb(colors.beamCore));
  const flicker = Math.floor(time * 20);
  for (let i = 0; i < 3; i += 1) {
    const a = hash(flicker + i * 3.3) * TAU;
    const far = radius * (2.4 + 1.6 * hash(flicker + i * 7.1));
    drawBolt(ctx, x + Math.cos(a) * radius, y + Math.sin(a) * radius, x + Math.cos(a) * far, y + Math.sin(a) * far, radius * 0.7, flicker + i * 13, Math.max(0.9, radius * 0.16), rgb(colors.beam, 0.9));
  }
}

/** Spirit Bomb: a pale sphere deepening to blue at its rim, slow currents turning inside. */
export function drawBomb(ctx, x, y, radius, time, colors) {
  if (radius < 0.5) return;
  const halo = ctx.createRadialGradient(x, y, radius * 0.92, x, y, radius * 1.38);
  halo.addColorStop(0, rgb(colors.bomb, 0.4));
  halo.addColorStop(1, rgb(colors.bomb, 0));
  disc(ctx, x, y, radius * 1.38, halo);
  const body = ctx.createRadialGradient(x - radius * 0.22, y - radius * 0.28, radius * 0.08, x, y, radius);
  body.addColorStop(0, rgb(colors.bombCore));
  body.addColorStop(0.58, rgb(blend(colors.bombCore, colors.bomb, 0.38)));
  body.addColorStop(1, rgb(colors.bomb));
  disc(ctx, x, y, radius, body);
  ctx.strokeStyle = rgb(colors.bomb);
  ctx.lineWidth = Math.max(1, radius * 0.05);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.stroke();
  if (radius < 6) return;
  ctx.strokeStyle = rgb(colors.bombCore, 0.8);
  ctx.lineWidth = Math.max(1, radius * 0.055);
  for (let i = 0; i < 3; i += 1) {
    const a = time * (1.7 - 0.45 * i) * (i % 2 ? -1 : 1) + i * 2.1;
    ctx.beginPath();
    ctx.arc(x, y, radius * (0.36 + 0.2 * i), a, a + 1.3 + 0.35 * i);
    ctx.stroke();
  }
}

/** Motes of light streaming in from all around to feed the bomb. */
export function drawMotes(ctx, x, y, radius, reach, time, strength, colors) {
  ctx.lineWidth = Math.max(1, reach * 0.022);
  for (let i = 0; i < 30; i += 1) {
    const life = fract(time * (0.75 + 0.6 * hash(i * 7.7)) + hash(i * 1.3));
    const a = hash(i * 3.1) * TAU + 0.6 * (1 - life);
    const far = radius + reach * (0.5 + 0.5 * hash(i * 5.9));
    const near = mix(far, radius * 0.9, life * life);
    const tail = near + reach * 0.09 * (0.5 + life);
    const glow = strength * Math.pow(Math.sin(Math.PI * Math.min(1, life * 1.15)), 0.7);
    ctx.strokeStyle = rgb(colors.bomb, 0.85 * glow);
    line(ctx, x + Math.cos(a) * near, y + Math.sin(a) * near, x + Math.cos(a) * tail, y + Math.sin(a) * tail);
    disc(ctx, x + Math.cos(a) * near, y + Math.sin(a) * near, Math.max(0.9, reach * 0.02), rgb(colors.bombCore, glow));
  }
}

/**
 * Explosion at (x, y), `radius` px across its fireball: rays and rings first,
 * a fireball that swells and thins, debris, and smoke left hanging.
 * `floor`, if given, is the y the blast sits on; nothing is drawn below it.
 */
export function drawBlast(ctx, x, y, radius, blast, colors, floor) {
  const { age, life, kind } = blast;
  const edge = kind === 'beam' ? colors.beam : colors.bomb;
  const core = kind === 'beam' ? colors.beamCore : colors.bombCore;
  const seed = kind === 'beam' ? 3 : 11;
  ctx.save();
  if (floor !== undefined) {
    ctx.beginPath();
    ctx.rect(x - radius * 4, floor - radius * 4, radius * 8, radius * 4);
    ctx.clip();
  }
  // Shockwave rings, one after another.
  for (let i = 0; i < 3; i += 1) {
    const p = (age - i * 0.13) / 0.75;
    if (p <= 0 || p >= 1) continue;
    ctx.strokeStyle = rgb(edge, 0.75 * Math.pow(1 - p, 1.6));
    ctx.lineWidth = 0.6 + radius * 0.07 * (1 - p);
    ctx.beginPath();
    ctx.arc(x, y, radius * (0.45 + 1.35 * easeOut(p)), 0, TAU);
    ctx.stroke();
  }
  // Rays.
  const burst = 1 - span(age, 0, 0.34);
  if (burst > 0) {
    ctx.fillStyle = rgb(core, 0.9 * burst);
    ctx.strokeStyle = rgb(edge, 0.9 * burst);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * TAU + hash(seed + i);
      const long = radius * (1.5 + 1.4 * hash(seed + i * 3.1)) * easeOut(Math.min(1, age / 0.16));
      const wide = 0.11 + 0.06 * hash(seed + i * 1.7);
      ctx.moveTo(x + Math.cos(a - wide) * radius * 0.3, y + Math.sin(a - wide) * radius * 0.3);
      ctx.lineTo(x + Math.cos(a) * long, y + Math.sin(a) * long);
      ctx.lineTo(x + Math.cos(a + wide) * radius * 0.3, y + Math.sin(a + wide) * radius * 0.3);
    }
    ctx.fill();
    ctx.stroke();
  }
  // Fireball.
  const swell = (0.25 + 0.75 * easeOut(Math.min(1, age / 0.26))) * (1 + 0.14 * life);
  const thin = 1 - smooth(span(life, 0.3, 0.75));
  if (thin > 0.01) {
    lump(ctx, x, y, radius * swell, 0.1, age * 5 + seed);
    ctx.fillStyle = rgb(edge, 0.9 * thin);
    ctx.fill();
    ctx.strokeStyle = rgb(blend(edge, colors.ink, 0.2), thin);
    ctx.lineWidth = Math.max(1, radius * 0.03);
    ctx.stroke();
    lump(ctx, x, y, radius * swell * 0.74, 0.12, -age * 6 + seed);
    ctx.fillStyle = rgb(blend(edge, core, 0.62), thin);
    ctx.fill();
    lump(ctx, x, y, radius * swell * 0.46, 0.14, age * 8);
    ctx.fillStyle = rgb(core, thin);
    ctx.fill();
    // The flash at its heart: most of the fireball for the first few frames.
    disc(ctx, x, y, radius * swell * 0.62 * (1 - smooth(span(age, 0, 0.26))), rgb(colors.flash, thin));
  }
  // Smoke.
  const smoke = span(life, 0.22, 0.86);
  if (smoke > 0) {
    for (let i = 0; i < 14; i += 1) {
      const a = hash(seed + i * 2.9) * TAU;
      const out = radius * (0.25 + 0.7 * hash(seed + i * 4.3)) * (0.7 + 0.5 * smoke);
      const size = radius * (0.09 + 0.1 * hash(seed + i * 6.1)) * (0.7 + 0.6 * smoke);
      const strength = 0.4 * Math.sin(Math.PI * Math.pow(smoke, 0.55)) * (0.6 + 0.4 * hash(seed + i));
      disc(ctx, x + Math.cos(a) * out, y + Math.sin(a) * out * 0.8 - radius * 0.45 * smoke, size, rgb(colors.dust, strength));
    }
  }
  // Debris on its way out and down.
  ctx.fillStyle = rgb(colors.dust, 0.95 * (1 - smooth(span(life, 0.45, 0.9))));
  for (let i = 0; i < 14; i += 1) {
    const a = hash(seed + i * 8.3) * TAU;
    const speed = radius * (1.6 + 2.2 * hash(seed + i * 2.1));
    const px = x + Math.cos(a) * speed * age * (1 - 0.25 * age);
    const py = y + Math.sin(a) * speed * age * 0.85 + radius * 0.9 * age * age;
    const size = Math.max(1, radius * (0.035 + 0.045 * hash(seed + i * 5.7)));
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(age * (4 + 9 * hash(seed + i)) + i);
    ctx.fillRect(-size, -size * 0.6, size * 2, size * 1.2);
    ctx.restore();
  }
  ctx.restore();
}

/** Puff of dust kicked up from the floor; `age` runs 0 to 1. */
export function drawDust(ctx, x, y, radius, age, color) {
  for (let i = 0; i < 4; i += 1) {
    const side = (i - 1.5) * 0.7;
    disc(ctx, x + radius * side * (0.5 + 0.9 * age), y - radius * (0.25 + 0.6 * age * (1 + 0.3 * i)), radius * (0.3 + 0.5 * age), rgb(color, 0.5 * Math.pow(1 - age, 1.4)));
  }
}

/** Wisps of smoke climbing off something that has had enough. `age` in seconds. */
export function drawSmoke(ctx, x, y, radius, age, color) {
  for (let i = 0; i < 5; i += 1) {
    const life = fract(age * 0.42 + i / 5);
    if (age * 0.42 + i / 5 < 1 && life > age * 0.42 + i / 5) continue;
    const drift = radius * (hash(i * 3.3) - 0.5) * 1.6 + radius * 0.35 * Math.sin(age * 2 + i);
    disc(ctx, x + drift, y - radius * 3.2 * life, radius * (0.3 + 0.55 * life), rgb(color, 0.42 * Math.sin(Math.PI * life)));
  }
}
