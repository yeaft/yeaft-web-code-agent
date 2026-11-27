/**
 * Yeaft Cosmos — Photorealistic 3D-Occluded Artificial Satellites for Active Sessions
 *
 * Renders delicate, astronomically proportioned orbital spacecraft around each
 * Agent's planet whenever Sessions are executing (`running`) or waiting for
 * confirmation (`waiting`):
 *   - True 3D inclined orbits with pixel-accurate planet-globe occlusion (`z < 0`)
 *   - Real aerospace materials: obsidian-graphite solar arrays with subtle metallic
 *     sun-glint, brushed titanium bus with muted champagne Kapton MLI core, and
 *     whisper-fine orbital wake filament (no cartoon colors or oversized clipart)
 *   - Three subtle spacecraft silhouettes (Twin-Wing Comm Relay, Slim Orbital
 *     Observatory, Micro Truss Relay) dynamically lit from the Sun
 */

const MAX_SATELLITES_PER_PLANET = 4;

const ORBIT_PRESETS = [
  { tilt: 0.34, rot: -0.32, speed: 0.48, phase: 0.62 },
  { tilt: 0.48, rot:  0.44, speed: -0.38, phase: 2.38 },
  { tilt: 0.40, rot: -0.84, speed: 0.32, phase: 4.12 },
  { tilt: 0.54, rot:  0.94, speed: -0.27, phase: 5.42 },
];

function hashSessionId(id) {
  const str = String(id || '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function evalOrbitPoint(pos, orbitR, tilt, rc, rs, a) {
  const lx = Math.cos(a) * orbitR;
  const ly = Math.sin(a) * orbitR * tilt;
  return {
    x: pos.x + lx * rc - ly * rs,
    y: pos.y + lx * rs + ly * rc,
    z: Math.sin(a),
  };
}

/**
 * Pure orbital & spacecraft geometry projection for a planet's live sessions.
 * Exported for deterministic unit testing and shared canvas rendering.
 */
export function computeSessionSatellites(pos, planetId, liveSessions, realTime, opts = {}) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.r) || pos.r <= 2) {
    return [];
  }
  const sessions = Array.isArray(liveSessions) ? liveSessions.slice(0, MAX_SATELLITES_PER_PLANET) : [];
  if (sessions.length === 0) return [];

  const { sunPt = null, isCompact = false } = opts;
  const baseOrbitMul = planetId === 'saturn' ? 2.15 : (planetId === 'uranus' ? 1.66 : 1.50);
  const t = Number.isFinite(realTime) ? realTime : 0;

  return sessions.map((session, idx) => {
    const preset = ORBIT_PRESETS[idx % ORBIT_PRESETS.length];
    const hash = hashSessionId(session?.id || `slot-${idx}`);
    const phaseJitter = ((hash % 1000) / 1000 - 0.5) * 0.7;
    const orbitR = pos.r * (baseOrbitMul + idx * 0.24);
    const rc = Math.cos(preset.rot);
    const rs = Math.sin(preset.rot);
    const angle = preset.phase + phaseJitter + t * preset.speed;
    const dir = preset.speed >= 0 ? 1 : -1;

    const pt = evalOrbitPoint(pos, orbitR, preset.tilt, rc, rs, angle);
    const ahead = evalOrbitPoint(pos, orbitR, preset.tilt, rc, rs, angle + dir * 0.03);
    const vx = ahead.x - pt.x;
    const vy = ahead.y - pt.y;
    const heading = Math.atan2(vy, vx);
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);

    const toPx = pos.x - pt.x;
    const toPy = pos.y - pt.y;
    const nadirLocalY = -sinH * toPx + cosH * toPy;
    const nadirSign = nadirLocalY >= 0 ? 1 : -1;
    const nadirAngleWorld = Math.atan2(toPy, toPx);

    const sdx = (sunPt && Number.isFinite(sunPt.x) ? sunPt.x : 0) - pt.x;
    const sdy = (sunPt && Number.isFinite(sunPt.y) ? sunPt.y : 0) - pt.y;
    const sLen = Math.hypot(sdx, sdy);
    const sunWx = sLen >= 1e-6 ? sdx / sLen : 1;
    const sunWy = sLen >= 1e-6 ? sdy / sLen : 0;
    const sunLocalX = cosH * sunWx + sinH * sunWy;
    const sunLocalY = -sinH * sunWx + cosH * sunWy;

    // Delicate, astronomically faithful scale (never oversized relative to host planet)
    const depthScale = 1.0 + pt.z * 0.12;
    const rawScale = (isCompact ? 0.14 : 0.165) * pos.r + (isCompact ? 2.3 : 2.8);
    const scale = Math.max(isCompact ? 4.6 : 5.4, Math.min(13.5, rawScale)) * depthScale;

    const isWaiting = session?.status === 'waiting';
    return {
      sessionId: session?.id || `slot-${idx}`,
      status: isWaiting ? 'waiting' : 'running',
      isWaiting,
      variant: idx === 0 ? 0 : (idx % 3),
      orbitR,
      tilt: preset.tilt,
      rot: preset.rot,
      rc,
      rs,
      speed: preset.speed,
      dir,
      angle,
      x: pt.x,
      y: pt.y,
      z: pt.z,
      heading,
      nadirSign,
      nadirAngleWorld,
      sunLocalX,
      sunLocalY,
      depthScale,
      scale,
      phaseSeed: (hash % 360) * (Math.PI / 180),
      // Muted aerospace palette: cool pale silver-ice for running, warm muted amber for waiting
      accentRgb: isWaiting ? '244, 194, 114' : '184, 214, 246',
    };
  });
}

function drawOrbitHalf(ctx, pos, sat, frontHalf, alphaMul) {
  if (alphaMul <= 0.01) return;
  const startA = frontHalf ? 0 : Math.PI;
  const endA = frontHalf ? Math.PI : Math.PI * 2;
  const steps = 28;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = startA + (i / steps) * (endA - startA);
    const p = evalOrbitPoint(pos, sat.orbitR, sat.tilt, sat.rc, sat.rs, a);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  const baseAlpha = frontHalf ? (sat.isWaiting ? 0.15 : 0.105) : (sat.isWaiting ? 0.075 : 0.052);
  ctx.strokeStyle = `rgba(${sat.accentRgb}, ${(baseAlpha * alphaMul).toFixed(3)})`;
  ctx.lineWidth = frontHalf ? 0.58 : 0.45;
  ctx.stroke();
}

function drawOrbitalWake(ctx, pos, sat, frontHalf, alphaMul) {
  if (alphaMul <= 0.01) return;
  const segments = 14;
  const arcLen = 0.72;
  let prev = evalOrbitPoint(pos, sat.orbitR, sat.tilt, sat.rc, sat.rs, sat.angle);
  ctx.lineCap = 'round';
  for (let i = 1; i <= segments; i++) {
    const frac = i / segments;
    const a = sat.angle - sat.dir * frac * arcLen;
    const curr = evalOrbitPoint(pos, sat.orbitR, sat.tilt, sat.rc, sat.rs, a);
    const midZ = (prev.z + curr.z) * 0.5;
    if ((frontHalf && midZ >= 0) || (!frontHalf && midZ < 0)) {
      const fade = (1 - frac) * (1 - frac);
      const aSeg = fade * (frontHalf ? (sat.isWaiting ? 0.42 : 0.32) : 0.18) * alphaMul;
      if (aSeg > 0.008) {
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(curr.x, curr.y);
        ctx.strokeStyle = `rgba(${sat.accentRgb}, ${aSeg.toFixed(3)})`;
        ctx.lineWidth = Math.max(0.28, (0.95 - frac * 0.65) * sat.depthScale);
        ctx.stroke();
      }
    }
    prev = curr;
  }
}

/**
 * Photorealistic dark-graphite photovoltaic solar panel catching subtle directional sunlight.
 */
function drawSolarWing(ctx, xCenter, yStart, yEnd, width, skewX, sunGlint, S) {
  const halfW = width * 0.5;
  const x0L = xCenter - halfW;
  const x0R = xCenter + halfW;
  const x1L = x0L + skewX;
  const x1R = x0R + skewX;

  ctx.beginPath();
  ctx.moveTo(x0L, yStart);
  ctx.lineTo(x0R, yStart);
  ctx.lineTo(x1R, yEnd);
  ctx.lineTo(x1L, yEnd);
  ctx.closePath();

  const glintPos = Math.max(0.20, Math.min(0.80, 0.5 + sunGlint * 0.30));
  const sheen = Math.max(0, sunGlint);
  const grad = ctx.createLinearGradient(x0L, yStart, x1R, yEnd);
  grad.addColorStop(0, '#10151f');
  grad.addColorStop(Math.max(0.06, glintPos - 0.24), '#1c2636');
  grad.addColorStop(glintPos, sheen > 0.25 ? '#6d83a1' : '#3d4f6a');
  grad.addColorStop(Math.min(0.94, glintPos + 0.24), '#1a2333');
  grad.addColorStop(1, '#0e131c');
  ctx.fillStyle = grad;
  ctx.fill();

  // Hairline anodized titanium panel edge (stroked before cell grid replaces the outer path)
  ctx.strokeStyle = `rgba(202, 216, 236, ${(0.44 + sheen * 0.28).toFixed(3)})`;
  ctx.lineWidth = Math.max(0.42, S * 0.042);
  ctx.stroke();

  // Whisper-fine solar cell divisions (visible cleanly at medium/closeup zoom)
  if (Math.abs(yEnd - yStart) >= 5.6) {
    const cells = S >= 10.5 ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(xCenter, yStart);
    ctx.lineTo(xCenter + skewX, yEnd);
    for (let c = 1; c < cells; c++) {
      const f = c / cells;
      const cy = yStart + (yEnd - yStart) * f;
      const sx = skewX * f;
      ctx.moveTo(x0L + sx, cy);
      ctx.lineTo(x0R + sx, cy);
    }
    ctx.strokeStyle = `rgba(176, 198, 224, ${(0.20 + sheen * 0.14).toFixed(3)})`;
    ctx.lineWidth = 0.42;
    ctx.stroke();
  }
}

/**
 * Tiny specular sunlight glint (real-world Iridium-style flare) grazing the spacecraft.
 */
function drawSolarGlint(ctx, x, y, S, intensity) {
  if (intensity <= 0.12) return;
  const r = S * (0.28 + intensity * 0.34);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255, 253, 246, ${(0.72 * intensity).toFixed(3)})`);
  g.addColorStop(0.32, `rgba(218, 234, 255, ${(0.28 * intensity).toFixed(3)})`);
  g.addColorStop(1, 'rgba(200, 224, 255, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  // Subtle 4-point diffraction cross only on strong specular flash
  if (intensity > 0.52) {
    const arm = r * 1.15;
    ctx.strokeStyle = `rgba(248, 252, 255, ${(0.36 * intensity).toFixed(3)})`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm * 0.7);
    ctx.lineTo(x, y + arm * 0.7);
    ctx.stroke();
  }
}

function drawMicroDish(ctx, x, y, nadirSign, S) {
  const r = S * 0.14;
  ctx.beginPath();
  ctx.moveTo(x - S * 0.02, y - nadirSign * S * 0.08);
  ctx.lineTo(x, y - nadirSign * r * 0.18);
  ctx.strokeStyle = 'rgba(182, 198, 218, 0.72)';
  ctx.lineWidth = Math.max(0.45, S * 0.045);
  ctx.stroke();

  ctx.save();
  ctx.translate(x, y);
  const startA = nadirSign > 0 ? 1.18 * Math.PI : 0.18 * Math.PI;
  const endA = nadirSign > 0 ? 1.82 * Math.PI : 0.82 * Math.PI;
  const cy = nadirSign * r * 0.42;
  ctx.fillStyle = '#c8d5e5';
  ctx.beginPath();
  ctx.arc(0, cy, r, startA, endA);
  ctx.quadraticCurveTo(0, -nadirSign * r * 0.08, Math.cos(startA) * r, cy + Math.sin(startA) * r);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(226, 236, 248, 0.75)';
  ctx.lineWidth = 0.4;
  ctx.stroke();
  ctx.restore();
}

function drawNavigationBeacon(ctx, x, y, S, sat, realTime) {
  const pulse = sat.isWaiting
    ? Math.pow(Math.max(0, Math.sin(realTime * 4.6 + sat.phaseSeed)), 4)
    : 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(realTime * 2.6 + sat.phaseSeed)), 2);
  const haloR = Math.max(2.4, S * (sat.isWaiting ? 0.38 : 0.24)) * (0.8 + 0.35 * pulse);
  const g = ctx.createRadialGradient(x, y, 0, x, y, haloR);
  g.addColorStop(0, `rgba(255, 255, 255, ${(0.55 + 0.40 * pulse).toFixed(3)})`);
  g.addColorStop(0.38, `rgba(${sat.accentRgb}, ${(0.32 + 0.46 * pulse).toFixed(3)})`);
  g.addColorStop(1, `rgba(${sat.accentRgb}, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, haloR, 0, Math.PI * 2);
  ctx.fill();
}

function drawSpacecraftBody(ctx, sat, realTime, alphaMul) {
  const S = sat.scale;
  const sunGlint = sat.sunLocalX * 0.72 + sat.sunLocalY * 0.52;
  const skew = S * 0.07;
  // Smooth periodic sunlight glint as the orbital attitude passes specular alignment
  const flare = Math.pow(Math.max(0, Math.cos(sat.angle * 2.0 + sat.phaseSeed)), 6) * 0.85
    + Math.max(0, sunGlint) * 0.35;

  ctx.save();
  ctx.globalAlpha *= alphaMul;
  ctx.translate(sat.x, sat.y);
  ctx.rotate(sat.heading);

  if (sat.variant === 1) {
    // ── Variant 1: Slim Orbital Observatory / Telescope Craft ──
    ctx.strokeStyle = 'rgba(180, 196, 218, 0.72)';
    ctx.lineWidth = Math.max(0.5, S * 0.052);
    ctx.beginPath();
    ctx.moveTo(-S * 0.06, -S * 0.13);
    ctx.lineTo(-S * 0.08, -S * 0.24);
    ctx.moveTo(-S * 0.06, S * 0.13);
    ctx.lineTo(-S * 0.08, S * 0.24);
    ctx.stroke();

    drawSolarWing(ctx, -S * 0.08, -S * 0.23, -S * 0.92, S * 0.22, -S * 0.09, sunGlint, S);
    drawSolarWing(ctx, -S * 0.08, S * 0.23, S * 0.92, S * 0.22, -S * 0.09, -sunGlint * 0.55, S);

    // Muted champagne-bronze aft instrument module
    const aftG = ctx.createLinearGradient(-S * 0.30, -S * 0.12, -S * 0.08, S * 0.12);
    aftG.addColorStop(0, '#d6bc8a');
    aftG.addColorStop(0.5, '#9d7c46');
    aftG.addColorStop(1, '#4b3a1d');
    ctx.fillStyle = aftG;
    ctx.fillRect(-S * 0.30, -S * 0.11, S * 0.21, S * 0.22);

    // Slim brushed-titanium optical tube
    const tubeG = ctx.createLinearGradient(0, -S * 0.11, 0, S * 0.11);
    tubeG.addColorStop(0, '#e6eef8');
    tubeG.addColorStop(0.45, '#9badc2');
    tubeG.addColorStop(1, '#3d4c60');
    ctx.fillStyle = tubeG;
    ctx.beginPath();
    ctx.moveTo(-S * 0.09, -S * 0.105);
    ctx.lineTo(S * 0.38, -S * 0.095);
    ctx.lineTo(S * 0.43, -S * 0.045);
    ctx.lineTo(S * 0.38, S * 0.095);
    ctx.lineTo(-S * 0.09, S * 0.105);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(214, 228, 244, 0.58)';
    ctx.lineWidth = 0.42;
    ctx.stroke();

    drawMicroDish(ctx, -S * 0.19, sat.nadirSign * S * 0.18, sat.nadirSign, S * 0.85);
    drawSolarGlint(ctx, S * 0.04, -S * 0.38, S, Math.min(1, flare));
    drawNavigationBeacon(ctx, S * 0.34, -sat.nadirSign * S * 0.11, S, sat, realTime);
  } else if (sat.variant === 2) {
    // ── Variant 2: Micro Modular Truss Station ──
    ctx.strokeStyle = 'rgba(186, 202, 222, 0.78)';
    ctx.lineWidth = Math.max(0.65, S * 0.062);
    ctx.beginPath();
    ctx.moveTo(0, -S * 0.94);
    ctx.lineTo(0, S * 0.94);
    ctx.stroke();

    drawSolarWing(ctx, -S * 0.12, -S * 0.26, -S * 0.90, S * 0.15, skew * 0.45, sunGlint, S);
    drawSolarWing(ctx, S * 0.12, -S * 0.26, -S * 0.90, S * 0.15, skew * 0.45, sunGlint * 0.8, S);
    drawSolarWing(ctx, -S * 0.12, S * 0.26, S * 0.90, S * 0.15, skew * 0.45, -sunGlint * 0.5, S);
    drawSolarWing(ctx, S * 0.12, S * 0.26, S * 0.90, S * 0.15, skew * 0.45, -sunGlint * 0.7, S);

    // Slender titanium pressurized core
    const modG = ctx.createLinearGradient(0, -S * 0.10, 0, S * 0.10);
    modG.addColorStop(0, '#e8f0fa');
    modG.addColorStop(0.5, '#96a9bf');
    modG.addColorStop(1, '#3d4c61');
    ctx.fillStyle = modG;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-S * 0.26, -S * 0.095, S * 0.54, S * 0.19, S * 0.06);
    else ctx.rect(-S * 0.26, -S * 0.095, S * 0.54, S * 0.19);
    ctx.fill();

    // Subtle champagne docking ring
    ctx.fillStyle = '#ad8c53';
    ctx.fillRect(-S * 0.055, -S * 0.10, S * 0.11, S * 0.20);

    drawSolarGlint(ctx, S * 0.10, -S * 0.52, S, Math.min(1, flare));
    drawNavigationBeacon(ctx, S * 0.28, 0, S, sat, realTime);
  } else {
    // ── Variant 0 (Primary): Sleek Twin-Wing Aerospace Comm-Relay Satellite ──
    // Fine structural wing struts
    ctx.strokeStyle = 'rgba(188, 204, 224, 0.76)';
    ctx.lineWidth = Math.max(0.52, S * 0.050);
    ctx.beginPath();
    ctx.moveTo(0, -S * 0.12);
    ctx.lineTo(0, -S * 0.26);
    ctx.moveTo(0, S * 0.12);
    ctx.lineTo(0, S * 0.26);
    ctx.stroke();

    // Slender dark-graphite photovoltaic wings
    drawSolarWing(ctx, 0, -S * 0.24, -S * 1.0, S * 0.25, skew, sunGlint, S);
    drawSolarWing(ctx, 0, S * 0.24, S * 1.0, S * 0.25, skew, -sunGlint * 0.55, S);

    // Compact hexagonal spacecraft bus (brushed titanium frame + muted champagne Kapton foil)
    const gx = sat.sunLocalX * S * 0.22;
    const gy = sat.sunLocalY * S * 0.16;
    const busGrad = ctx.createLinearGradient(gx, gy, -gx, -gy);
    busGrad.addColorStop(0, '#e5d3a8');
    busGrad.addColorStop(0.42, '#b69458');
    busGrad.addColorStop(0.82, '#695128');
    busGrad.addColorStop(1, '#362915');

    const bx = S * 0.19;
    const by = S * 0.135;
    const ch = S * 0.048;
    ctx.beginPath();
    ctx.moveTo(-bx + ch, -by);
    ctx.lineTo(bx - ch, -by);
    ctx.lineTo(bx, -by + ch);
    ctx.lineTo(bx, by - ch);
    ctx.lineTo(bx - ch, by);
    ctx.lineTo(-bx + ch, by);
    ctx.lineTo(-bx, by - ch);
    ctx.lineTo(-bx, -by + ch);
    ctx.closePath();
    ctx.fillStyle = busGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(222, 232, 245, 0.62)';
    ctx.lineWidth = Math.max(0.45, S * 0.042);
    ctx.stroke();

    // Brushed titanium fore bulkhead
    ctx.fillStyle = '#cfdbe9';
    ctx.fillRect(bx - S * 0.035, -by * 0.55, S * 0.06, by * 1.1);

    // Subtle nadir high-gain dish
    drawMicroDish(ctx, S * 0.13, sat.nadirSign * S * 0.18, sat.nadirSign, S);

    // Real-world solar specular glint on the sun-facing edge
    drawSolarGlint(ctx, S * 0.04, (sunGlint >= 0 ? -1 : 1) * S * 0.44, S, Math.min(1, flare));

    // Subtle navigation strobe on opposite mast tip
    const tipX = S * 0.12;
    const tipY = -sat.nadirSign * S * 0.22;
    ctx.beginPath();
    ctx.moveTo(S * 0.08, -sat.nadirSign * S * 0.12);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = 'rgba(196, 212, 232, 0.72)';
    ctx.lineWidth = 0.45;
    ctx.stroke();
    drawNavigationBeacon(ctx, tipX, tipY, S, sat, realTime);
  }

  ctx.restore();
}

/**
 * Draw all photorealistic artificial satellites for a planet in two true depth passes:
 *   1. Far-side pass (`z < 0`): clipped cleanly behind the planet's globe
 *   2. Near-side pass (`z >= 0`): rendered crisply in front of the planet
 */
export function drawSessionSatellites(ctx, w, h, pos, planetId, liveSessions, realTime, opts = {}) {
  if (!ctx || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [];
  const rawFade = Number.isFinite(opts.fadeMul) ? opts.fadeMul : 1.0;
  const fadeMul = Math.max(0, Math.min(1, rawFade));
  if (fadeMul <= 0.02) return [];

  const safeTime = Number.isFinite(realTime) ? realTime : 0;
  const sats = computeSessionSatellites(pos, planetId, liveSessions, safeTime, opts);
  if (sats.length === 0) return [];

  // Viewport-cull offscreen planets (e.g. during Planet Focus closeup) before allocating clip/gradients
  const maxReach = sats[sats.length - 1].orbitR + 36;
  if (pos.x + maxReach < 0 || pos.x - maxReach > w || pos.y + maxReach < 0 || pos.y - maxReach > h) {
    return sats;
  }

  const orbitAlphaMul = fadeMul * Math.max(0.32, Math.min(1.1, Number.isFinite(opts.orbitOpacity) ? opts.orbitOpacity + 0.30 : 0.85));

  ctx.save();
  // 1. Far-side pass (occluded cleanly behind parent planet globe)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.moveTo(pos.x + pos.r * 0.985, pos.y);
  ctx.arc(pos.x, pos.y, pos.r * 0.985, 0, Math.PI * 2, true);
  ctx.clip('evenodd');

  const farSats = sats.filter((s) => s.z < 0).sort((a, b) => a.z - b.z);
  for (const sat of sats) {
    drawOrbitHalf(ctx, pos, sat, false, orbitAlphaMul);
    drawOrbitalWake(ctx, pos, sat, false, fadeMul);
  }
  for (const sat of farSats) {
    drawSpacecraftBody(ctx, sat, safeTime, fadeMul * 0.82);
  }
  ctx.restore();

  // 2. Near-side pass (in front of planet globe, depth-sorted frontmost last)
  const nearSats = sats.filter((s) => s.z >= 0).sort((a, b) => a.z - b.z);
  for (const sat of sats) {
    drawOrbitHalf(ctx, pos, sat, true, orbitAlphaMul);
    drawOrbitalWake(ctx, pos, sat, true, fadeMul);
  }
  for (const sat of nearSats) {
    drawSpacecraftBody(ctx, sat, safeTime, fadeMul);
  }
  ctx.restore();

  return sats;
}
