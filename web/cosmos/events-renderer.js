/**
 * Yeaft Cosmos — GPU Event Particle Sculptor, Observatory HUD Fiducials & High-Craft 2D Fallback
 *
 * Primary volumetric cosmic events render in native WebGL (`shaders-events.js` + `gl-engine.js`).
 * This module supplies:
 * 1. `fillEventGpuParticles`: matching additive GPU micro-particles for all 8 phenomena
 * 2. `drawCosmicEventHud`: delicate astronomical telescope field fiducials during observation
 * 3. `drawCosmicEventCanvas`: upgraded real-texture Canvas 2D renderer for 2D Eco / no-GPU mode
 */
import { getLoadedCosmosImage } from './texture-loader.js';

function createSeeds(seedStart, count) {
  let s = seedStart >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      a: rnd() * Math.PI * 2,
      r: rnd(),
      spd: 0.35 + rnd() * 0.95,
      sz: 1.0 + Math.pow(rnd(), 2.2) * 3.1,
      hue: rnd(),
      ph: rnd(),
      wob: (rnd() - 0.5) * 0.65,
      z: (rnd() - 0.5) * 2.0,
    });
  }
  return out;
}

const SEEDS = createSeeds(314159, 460);

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Populate GPU additive particle buffer matching the active WebGL cosmic event shader.
 */
export function fillEventGpuParticles(buf, evDraw, w, h, dpr, densityScale = 1.0) {
  if (!buf || !evDraw || evDraw.alpha <= 0.004 || densityScale <= 0) return 0;
  const maxPts = 520;
  const step = densityScale < 0.7 ? 2 : 1;
  let count = 0;

  const p = evDraw.progress;
  const evT = evDraw.elapsed;
  const x = evDraw.x;
  const y = evDraw.y;
  const S = evDraw.eventRadiusPx;
  const alphaMaster = evDraw.alpha;
  const rotC = Math.cos(evDraw.angle || 0);
  const rotS = Math.sin(evDraw.angle || 0);
  const sizeScale = Math.max(0.42, Math.min(1.42, S / 215));

  const birthEnv = smoothstep(0.0, 0.14, p);
  const decayEnv = smoothstep(1.0, 0.76, p);
  const lifeEnv = birthEnv * decayEnv * alphaMaster;
  if (lifeEnv <= 0.004) return 0;

  // Exact inverse of EVENT_VERT (vLocal = (aCorner.x, -aCorner.y), Y-up) + GLSL column-major rot2(uAngle):
  // qr = (c*qx + s*qy, -s*qx + c*qy) => q = (c*lx - s*ly, s*lx + c*ly), screen = (x + qx, y - qy).
  const pushLocal = (lx, ly, sz, r, g, b, a) => {
    if (count >= maxPts || a <= 0.01) return;
    const qx = lx * rotC - ly * rotS;
    const qy = lx * rotS + ly * rotC;
    const sx = x + qx;
    const sy = y - qy;
    if (sx < -24 || sx > w + 24 || sy < -24 || sy > h + 24) return;
    const off = count * 7;
    buf[off] = sx * dpr;
    buf[off + 1] = sy * dpr;
    buf[off + 2] = Math.max(1.0, sz * sizeScale) * dpr;
    buf[off + 3] = r;
    buf[off + 4] = g;
    buf[off + 5] = b;
    buf[off + 6] = Math.min(1.0, a);
    count++;
  };

  const type = evDraw.eventType;

  /* 0. SUPERNOVA — Shock-front luminous ejecta knots & remnant spark field */
  if (type === 0) {
    const expP = Math.max(0, (p - 0.19) / 0.81);
    if (expP > 0.01) {
      const rShell = S * (0.14 + Math.pow(expP, 0.62) * 1.38);
      const env = smoothstep(0.0, 0.12, expP) * decayEnv * alphaMaster;
      for (let i = 0; i < 340; i += step) {
        const sd = SEEDS[i];
        const asym = 1.0 + 0.12 * Math.sin(sd.a * 3.0 + evDraw.seed * 6.28) + 0.07 * Math.cos(sd.a * 5.0);
        const dist = rShell * asym * (0.34 + sd.r * 0.78);
        const ang = sd.a + sd.wob * expP * 0.35;
        const tw = 0.65 + 0.35 * Math.sin(evT * (2.2 + sd.spd * 2.5) + sd.ph * 25.0);
        const isOuter = sd.r > 0.72;
        const colR = isOuter ? 1.0 : (sd.hue < 0.55 ? 0.56 : 0.86);
        const colG = isOuter ? 0.58 : (sd.hue < 0.55 ? 0.90 : 0.72);
        const colB = isOuter ? 0.34 : 1.0;
        pushLocal(
          Math.cos(ang) * dist,
          Math.sin(ang) * dist,
          sd.sz * (isOuter ? 1.08 : 0.88),
          colR, colG, colB,
          (0.28 + 0.44 * sd.spd) * tw * (1.0 - expP * 0.35) * env,
        );
      }
    }

  /* 1. PLANET SHATTER — Ballistic molten lava droplets & sheared 3D Roche debris boulders */
  } else if (type === 1) {
    const hitT = 0.24;
    if (p < hitT + 0.04) {
      const ap = Math.max(0, Math.min(1, p / hitT));
      const appEnv = birthEnv * (1.0 - smoothstep(hitT - 0.02, hitT + 0.04, p)) * alphaMaster;
      const ix = (1.25 + (0.24 - 1.25) * Math.pow(ap, 1.15)) * S;
      const iy = (-0.62 + (-0.14 + 0.62) * Math.pow(ap, 1.15)) * S;
      for (let i = 0; i < 64; i += step) {
        const sd = SEEDS[i];
        const trail = sd.r * 0.68 * S;
        const spread = sd.z * (0.04 + sd.r * 0.14) * S;
        pushLocal(
          ix + trail * 0.89 + spread * 0.45,
          iy - trail * 0.45 + spread * 0.89,
          sd.sz * 0.85,
          1.0, 0.62 + sd.hue * 0.3, 0.26,
          (1.0 - sd.r) * 0.68 * appEnv,
        );
      }
    }
    if (p >= hitT) {
      const bp = (p - hitT) / (1 - hitT);
      const env = decayEnv * alphaMaster;
      const rc = Math.cos(-0.22);
      const rs = Math.sin(-0.22);
      for (let i = 0; i < 380; i += step) {
        const sd = SEEDS[i];
        if (i < 210) {
          const ringEnv = smoothstep(0.10, 0.45, bp) * env;
          const rr = S * (0.42 + bp * 0.82) * (0.58 + sd.r * 0.72);
          const ang = sd.a + evT * (1.15 / Math.pow(0.45 + sd.r, 0.75));
          const ex = Math.cos(ang) * rr;
          const ey = Math.sin(ang) * rr * 0.27 + sd.z * S * 0.025;
          const heat = Math.max(0.18, 0.92 - bp * 0.36 - sd.r * 0.28);
          pushLocal(
            ex * rc - ey * rs,
            ex * rs + ey * rc,
            sd.sz * 0.86,
            1.0, 0.34 + heat * 0.56, 0.14 + heat * 0.36,
            (0.32 + 0.48 * heat) * ringEnv,
          );
        } else {
          const fanAng = -0.52 + (sd.a - Math.PI) * 0.72;
          const dist = S * (0.14 + Math.pow(bp, 0.72) * (0.42 + sd.spd * 1.05));
          const lx = 0.22 * S + Math.cos(fanAng) * dist;
          const ly = -0.12 * S + Math.sin(fanAng) * dist * 0.82;
          const cool = Math.max(0.16, 1.0 - bp * 0.58);
          pushLocal(
            lx, ly,
            sd.sz * (0.78 + 0.35 * cool),
            1.0, 0.38 + cool * 0.52, 0.16 + cool * 0.38,
            (0.35 + 0.45 * cool) * env,
          );
        }
      }
    }

  /* 2. BLACK HOLE BIRTH — Spiraling Gargantua accretion embers & polar jet plasma knots */
  } else if (type === 2) {
    const birthP = Math.max(0, (p - 0.23) / 0.77);
    if (birthP > 0.01) {
      const rs = S * 0.25 * smoothstep(0.0, 0.18, birthP);
      const bhEnv = smoothstep(0.0, 0.14, birthP) * decayEnv * alphaMaster;
      const jetEnv = smoothstep(0.04, 0.22, birthP) * (1.0 - smoothstep(0.56, 0.94, birthP)) * decayEnv * alphaMaster;
      for (let i = 0; i < 340; i += step) {
        const sd = SEEDS[i];
        if (i < 250) {
          const prog = (sd.ph + evT * (0.18 + sd.spd * 0.18)) % 1.0;
          const rad = rs * (1.14 + (1.0 - prog) * 4.2);
          const ang = sd.a + evT * (2.8 / Math.pow(Math.max(rad / Math.max(rs, 1), 1.0), 1.1));
          const lx = Math.cos(ang) * rad;
          const ly = Math.sin(ang) * rad * 0.19 + sd.z * rs * 0.14 * (1.0 - prog);
          // In Y-up shader coordinates, ly > 0 (sin(ang) > 0) is the back arc occluded behind the shadow.
          if (Math.sin(ang) > 0 && Math.hypot(lx, ly) < rs * 1.02) continue;
          const doppler = Math.max(0.38, Math.min(1.55, 1.0 - 0.44 * (lx / Math.max(rad, 1))));
          const heat = Math.min(1.0, prog * 0.8 + doppler * 0.35);
          pushLocal(
            lx, ly,
            sd.sz * (0.76 + heat * 0.45),
            1.0, 0.48 + heat * 0.44, 0.18 + heat * 0.64,
            Math.sin(prog * Math.PI) * 0.56 * doppler * bhEnv,
          );
        } else if (jetEnv > 0.01) {
          const side = i % 2 === 0 ? 1 : -1;
          const prog = (sd.ph + evT * (0.65 + sd.spd * 0.55)) % 1.0;
          const along = rs * 1.05 + prog * S * 1.65;
          const spread = sd.z * (0.018 + prog * 0.085) * S;
          pushLocal(
            spread, side * along,
            sd.sz * (0.85 - prog * 0.35),
            0.68, 0.86, 1.0,
            Math.sin(prog * Math.PI) * 0.72 * jetEnv,
          );
        }
      }
    }

  /* 3. KILONOVA — Tidal spiral tail sparks -> polar cyan + equatorial forged-gold ejecta */
  } else if (type === 3) {
    const mergeP = 0.42;
    if (p < mergeP) {
      const ip = p / mergeP;
      const inEnv = birthEnv * alphaMaster;
      const sep = S * 0.62 * Math.pow(1 - ip, 0.52);
      const omega = ip * ip * 20.0 + evT * 2.4;
      for (let i = 0; i < 190; i += step) {
        const sd = SEEDS[i];
        const arm = (i % 2) * Math.PI;
        const tail = sd.r * 0.65;
        const rad = sep + tail * S * (0.85 + ip * 0.35);
        const ang = omega + arm - tail * (3.2 + ip * 3.0) + sd.wob * 0.25;
        const isCyan = i % 2 === 0;
        pushLocal(
          Math.cos(ang) * rad,
          Math.sin(ang) * rad * 0.56,
          sd.sz * 0.82,
          isCyan ? 0.54 : 0.82, isCyan ? 0.88 : 0.68, 1.0,
          (1.0 - tail * 1.15) * (0.45 + 0.5 * ip) * inEnv,
        );
      }
    } else {
      const kp = (p - mergeP) / (1 - mergeP);
      const kEnv = decayEnv * alphaMaster;
      const rExp = S * (0.18 + Math.pow(kp, 0.60) * 1.24);
      for (let i = 0; i < 320; i += step) {
        const sd = SEEDS[i];
        const isPolar = sd.hue < 0.36;
        const ang = isPolar
          ? (sd.z >= 0 ? Math.PI * 0.5 : -Math.PI * 0.5) + sd.wob * 0.82
          : (sd.z >= 0 ? 0 : Math.PI) + sd.wob * 1.15;
        const dist = rExp * (0.28 + sd.r * 0.88);
        pushLocal(
          Math.cos(ang) * dist,
          Math.sin(ang) * dist,
          sd.sz * 0.92,
          isPolar ? 0.38 : 1.0,
          isPolar ? 0.94 : (0.62 + sd.r * 0.22),
          isPolar ? 0.96 : 0.28,
          (0.32 + 0.45 * sd.spd) * (1.0 - kp * 0.38) * kEnv,
        );
      }
    }

  /* 4. STELLAR SUPERFLARE — Coronal magnetic loop plasma droplets & CME solar-wind gusts */
  } else if (type === 4) {
    const sunR = evDraw.sunRadiusPx || S * 0.34;
    const cmeP = Math.max(0, (p - 0.16) / 0.84);
    const flareAng = evDraw.angle ?? -0.58;
    const baseC = Math.cos(flareAng);
    const baseS = Math.sin(flareAng);
    for (let i = 0; i < 260; i += step) {
      const sd = SEEDS[i];
      const angOff = sd.z * (0.48 + cmeP * 0.22);
      const front = sunR * (1.08 + Math.pow(cmeP, 0.72) * 3.1);
      const rad = sunR * 0.98 + (front - sunR * 0.98) * ((sd.r + evT * 0.14 * sd.spd) % 1.0);
      const lx = Math.cos(angOff) * rad;
      const ly = Math.sin(angOff) * rad;
      // Event 4 shader uses qr = rot2(-uAngle) * qs in Y-up space -> inverse is rot2(+uAngle), screenY = y - qy.
      const qx = lx * baseC + ly * baseS;
      const qy = -lx * baseS + ly * baseC;
      const sx = x + qx;
      const sy = y - qy;
      if (count >= maxPts || sx < -24 || sx > w + 24 || sy < -24 || sy > h + 24) continue;
      const uRad = (rad - sunR) / Math.max(front - sunR, 1);
      const off = count * 7;
      buf[off] = sx * dpr;
      buf[off + 1] = sy * dpr;
      buf[off + 2] = Math.max(1.1, sd.sz * Math.max(0.45, sunR / 62)) * dpr;
      buf[off + 3] = 1.0;
      buf[off + 4] = 0.88 - uRad * 0.52;
      buf[off + 5] = 0.52 - uRad * 0.38;
      buf[off + 6] = Math.sin(uRad * Math.PI) * 0.58 * lifeEnv;
      count++;
    }

  /* 5. GAMMA-RAY BURST — Ultra-fast collimated relativistic jet knots & cocoon sparks */
  } else if (type === 5) {
    const beamEnv = smoothstep(0.10, 0.24, p) * decayEnv * alphaMaster;
    if (beamEnv > 0.005) {
      const jetReach = S * (0.28 + smoothstep(0.12, 0.42, p) * 2.25);
      for (let i = 0; i < 290; i += step) {
        const sd = SEEDS[i];
        const side = i % 2 === 0 ? 1 : -1;
        const prog = (sd.ph + evT * (0.85 + sd.spd * 0.9)) % 1.0;
        const along = prog * jetReach;
        const spread = sd.z * (0.02 + Math.pow(prog, 0.82) * 0.26) * S;
        const isCore = Math.abs(sd.z) < 0.36;
        pushLocal(
          side * along, spread,
          sd.sz * (isCore ? 0.95 : 0.72),
          isCore ? 0.95 : 0.64,
          isCore ? 0.90 : 0.52,
          1.0,
          Math.sin(prog * Math.PI) * (isCore ? 0.76 : 0.48) * beamEnv,
        );
      }
    }

  /* 6. TIDAL DISRUPTION — Torn stellar plasma knots flowing down the parabolic tidal river */
  } else if (type === 6) {
    const streamEnv = smoothstep(0.08, 0.22, p) * decayEnv * alphaMaster;
    const headT = Math.min(1.25, p * 1.38);
    const tailT = Math.max(0.0, headT - 0.88);
    for (let i = 0; i < 320; i += step) {
      const sd = SEEDS[i];
      const isDisk = i >= 220 && p > 0.36;
      if (!isDisk) {
        const u = (sd.r + evT * 0.14 * sd.spd) % 1.0;
        const tc = tailT + (headT - tailT) * u;
        const ang = -2.35 + tc * 6.4;
        const rad = S * (0.22 + 1.08 * Math.exp(-tc * 1.62));
        const spread = sd.z * S * (0.025 + u * 0.055);
        const heat = Math.min(1.0, 0.32 + u * 0.65);
        pushLocal(
          Math.cos(ang) * rad + spread,
          Math.sin(ang) * rad * 0.58 + spread * 0.6,
          sd.sz * 0.86,
          1.0, 0.38 + heat * 0.54, 0.16 + heat * 0.42,
          Math.sin(u * Math.PI) * 0.62 * streamEnv,
        );
      } else {
        const accEnv = smoothstep(0.36, 0.62, p) * decayEnv * alphaMaster;
        const rBh = S * 0.21;
        const rad = rBh * (1.2 + sd.r * 3.1);
        const ang = sd.a + evT * (2.4 / Math.pow(1.0 + sd.r * 2.0, 0.8));
        const lx = Math.cos(ang) * rad + rBh * 0.22;
        const ly = Math.sin(ang) * rad * 0.24;
        // In Y-up shader coordinates, ly > 0 (sin(ang) > 0) is occluded behind the black-hole shadow.
        if (Math.sin(ang) > 0 && Math.hypot(lx, ly) < rBh) continue;
        pushLocal(
          lx, ly,
          sd.sz * 0.82,
          1.0, 0.68, 0.34,
          0.52 * accEnv,
        );
      }
    }

  /* 7. COMET BREAKUP — Shimmering CN icy coma sparks & curved golden dust/meteor stream */
  } else if (type === 7) {
    const pathU = p - 0.48;
    const hx = pathU * 1.42 * S;
    const hy = (-pathU * 0.34 - pathU * pathU * 0.28) * S;
    const splitP = smoothstep(0.16, 0.92, p);
    const ionX = -0.94;
    const ionY = 0.34;
    const perpX = -0.34;
    const perpY = -0.94;
    for (let i = 0; i < 310; i += step) {
      const sd = SEEDS[i];
      const isIon = sd.hue < 0.44;
      const along = sd.r * (0.8 + splitP * 1.25) * S;
      const curve = isIon
        ? Math.sin(along * 0.04 - evT * 3.5) * 0.015 * S
        : 0.16 * (along / Math.max(S, 1)) * (along / Math.max(S, 1)) * S;
      const lat = sd.z * (isIon ? 0.045 : 0.18) * (0.3 + sd.r) * S + curve;
      const lx = hx + ionX * along + perpX * lat;
      const ly = hy + ionY * along + perpY * lat;
      const tw = 0.55 + 0.45 * Math.sin(evT * 4.5 + sd.ph * 40.0);
      pushLocal(
        lx, ly,
        sd.sz * (isIon ? 0.78 : 0.92),
        isIon ? 0.46 : 1.0,
        isIon ? 0.92 : 0.88,
        isIon ? 1.0 : 0.68,
        (1.0 - sd.r * 0.82) * 0.62 * tw * lifeEnv,
      );
    }
  }

  return count;
}

/**
 * Draw whisper-minimal observatory telescope field fiducials on the 2D HUD canvas
 * while zoomed in (`obsBlend > 0.25`).
 */
export function drawCosmicEventHud(ctx, w, h, evDraw, centerShiftX = 0) {
  if (!evDraw || evDraw.obsBlend <= 0.25 || evDraw.alpha <= 0.05) return;
  const a = Math.max(0, (evDraw.obsBlend - 0.25) / 0.75) * 0.16 * evDraw.alpha;
  const cx = w * 0.5 + centerShiftX * 0.55;
  const cy = h * 0.5;
  const rad = Math.min(w, h) * 0.42;
  ctx.save();
  ctx.strokeStyle = `rgba(186, 218, 255, ${a.toFixed(3)})`;
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const ang = i * Math.PI * 0.5;
    const r0 = rad * 0.94;
    const r1 = rad * 0.985;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.stroke();
  }
  ctx.restore();
}

/* ── High-Craft 2D Canvas Fallback (2D Eco Mode / Async Shader Warm-Up Bridge) ── */

function drawDiffractionStar(ctx, x, y, span, angle, rgb, alpha) {
  if (span <= 2 || alpha <= 0.008) return;
  for (let k = 0; k < 3; k++) {
    const a = angle + k * (Math.PI / 3);
    const dx = Math.cos(a) * span;
    const dy = Math.sin(a) * span;
    const g = ctx.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
    g.addColorStop(0, `rgba(${rgb}, 0)`);
    g.addColorStop(0.45, `rgba(${rgb}, ${(alpha * 0.65).toFixed(3)})`);
    g.addColorStop(0.50, `rgba(255, 255, 255, ${Math.min(1, alpha).toFixed(3)})`);
    g.addColorStop(0.55, `rgba(${rgb}, ${(alpha * 0.65).toFixed(3)})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(0.9, span * 0.012);
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
  }
}

function drawFeatheredNebulaShell(ctx, x, y, rOut, innerRgb, midRgb, outerRgb, alpha) {
  if (rOut <= 2 || alpha <= 0.005) return;
  const g = ctx.createRadialGradient(x, y, rOut * 0.56, x, y, rOut * 1.16);
  g.addColorStop(0, `rgba(${innerRgb}, 0)`);
  g.addColorStop(0.44, `rgba(${innerRgb}, ${(alpha * 0.42).toFixed(3)})`);
  g.addColorStop(0.70, `rgba(${midRgb}, ${(alpha * 0.82).toFixed(3)})`);
  g.addColorStop(0.86, `rgba(${outerRgb}, ${(alpha * 0.34).toFixed(3)})`);
  g.addColorStop(1, `rgba(${outerRgb}, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, rOut * 1.16, 0, Math.PI * 2);
  ctx.fill();
}

function drawClippedSphereImg(ctx, img, cx, cy, r, fallbackColors) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    const iw = img.naturalWidth || img.width || 1;
    const ih = img.naturalHeight || img.height || 1;
    ctx.drawImage(img, 0, 0, iw * 0.5, ih, cx - r, cy - r, r * 2, r * 2);
  } else {
    const g = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.25, r * 0.1, cx, cy, r);
    g.addColorStop(0, fallbackColors[0]);
    g.addColorStop(0.6, fallbackColors[1]);
    g.addColorStop(1, fallbackColors[2]);
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
}

export function drawCosmicEventCanvas(ctx, w, h, active, pos, visibilityAlpha = 1.0) {
  if (!active || !pos || visibilityAlpha <= 0.01) return;
  const def = active.def;
  const p = Math.max(0, Math.min(1, active.elapsed / active.duration));
  const S = pos.eventRadiusPx || (Math.min(w, h) * 0.24 * Math.max(0.14, pos.scale || 1));
  const x = pos.x;
  const y = pos.y;
  const focus = typeof pos.focusProgress === 'number' ? pos.focusProgress : (active.observing ? 1 : 0);

  // Smooth organic birth (0 -> 14%) and graceful afterglow fade (76 -> 100%)
  const birthEnv = smoothstep(0.0, 0.14, p);
  const decayEnv = smoothstep(1.0, 0.76, p);
  // Avoid double-attenuating when `pos` already carries computed `alpha` from `computeEventFrame`.
  const depthAtten = typeof pos.alpha === 'number' ? 1.0 : (0.76 + focus * 0.24);
  const masterA = birthEnv * decayEnv * depthAtten * Math.max(0, Math.min(1, visibilityAlpha));
  if (masterA <= 0.005) return;

  const nebImg = getLoadedCosmosImage('nebula');
  const sunImg = getLoadedCosmosImage('sun');
  const rockImg = getLoadedCosmosImage('mars');

  ctx.save();
  ctx.globalAlpha = masterA;
  ctx.globalCompositeOperation = 'lighter';

  if (def.id === 'supernova') {
    const flash = Math.exp(-Math.pow((p - 0.23) / 0.068, 2));
    const expP = Math.max(0, (p - 0.19) / 0.81);
    if (expP > 0.01) {
      const rOut = S * (0.16 + Math.pow(expP, 0.62) * 1.32);
      const env = smoothstep(0.0, 0.14, expP);
      if (nebImg) {
        ctx.save();
        ctx.globalAlpha = masterA * 0.56 * env;
        ctx.beginPath();
        ctx.arc(x, y, rOut * 1.08, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(nebImg, x - rOut * 1.18, y - rOut * 1.18, rOut * 2.36, rOut * 2.36);
        ctx.restore();
      }
      for (let lobe = 0; lobe < 6; lobe++) {
        const la = lobe * 1.05 + 0.35;
        const lx = x + Math.cos(la) * rOut * 0.28;
        const ly = y + Math.sin(la) * rOut * 0.24;
        const lr = rOut * (0.62 + (lobe % 2) * 0.22);
        const neb = ctx.createRadialGradient(lx, ly, lr * 0.1, lx, ly, lr);
        neb.addColorStop(0, lobe % 2 === 0 ? `rgba(116, 214, 255, ${(0.24 * env).toFixed(3)})` : `rgba(255, 134, 78, ${(0.22 * env).toFixed(3)})`);
        neb.addColorStop(0.55, lobe % 2 === 0 ? `rgba(82, 138, 255, ${(0.15 * env).toFixed(3)})` : `rgba(218, 86, 132, ${(0.12 * env).toFixed(3)})`);
        neb.addColorStop(1, 'rgba(30, 50, 120, 0)');
        ctx.fillStyle = neb;
        ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.fill();
      }
      drawFeatheredNebulaShell(ctx, x, y, rOut * 0.96, '118, 216, 255', '255, 152, 92', '224, 72, 62', 0.62 * env);
    }
    const coreR = S * (0.20 + flash * 0.72);
    const cg = ctx.createRadialGradient(x, y, 0, x, y, coreR);
    cg.addColorStop(0, 'rgba(255, 255, 255, 0.96)');
    cg.addColorStop(0.28, `rgba(164, 226, 255, ${(0.68 + flash * 0.25).toFixed(3)})`);
    cg.addColorStop(1, 'rgba(72, 134, 255, 0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(x, y, coreR, 0, Math.PI * 2); ctx.fill();
    drawDiffractionStar(ctx, x, y, S * (0.48 + flash * 1.15), 0.22, '182, 230, 255', 0.35 + flash * 0.6);
  } else if (def.id === 'planet-shatter') {
    const hitT = 0.24;
    const rPl = S * 0.34;
    if (p < hitT + 0.35) {
      const rem = 1 - smoothstep(hitT + 0.08, hitT + 0.35, p);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = masterA * rem;
      drawClippedSphereImg(ctx, rockImg, x, y, rPl, ['#b87450', '#633322', '#170a06']);
      ctx.restore();
    }
    if (p >= hitT) {
      const bp = (p - hitT) / (1 - hitT);
      const impactFlash = Math.exp(-Math.pow(bp / 0.12, 2));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.22);
      ctx.scale(1, 0.27);
      drawFeatheredNebulaShell(ctx, 0, 0, S * (0.46 + bp * 0.85), '255, 198, 126', '255, 114, 46', '172, 42, 18', 0.65 * smoothstep(0.08, 0.45, bp));
      ctx.restore();
      drawFeatheredNebulaShell(ctx, x + S * 0.16, y - S * 0.10, S * (0.24 + Math.pow(bp, 0.72) * 1.15), '255, 206, 134', '255, 118, 48', '186, 44, 22', 0.56 * (1 - bp * 0.55));
      drawDiffractionStar(ctx, x + S * 0.22, y - S * 0.12, S * (0.5 + impactFlash * 0.9), 0.4, '255, 206, 140', impactFlash * 0.88);
    }
  } else if (def.id === 'blackhole-birth') {
    const birthP = Math.max(0, (p - 0.23) / 0.77);
    if (p < 0.32) {
      const rStar = S * (0.44 * (1 - Math.min(1, p / 0.28) * 0.75));
      const sg = ctx.createRadialGradient(x, y, 0, x, y, rStar * 2.2);
      sg.addColorStop(0, '#ffffff');
      sg.addColorStop(0.36, 'rgba(164, 214, 255, 0.82)');
      sg.addColorStop(1, 'rgba(84, 126, 255, 0)');
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(x, y, rStar * 2.2, 0, Math.PI * 2); ctx.fill();
    }
    if (birthP > 0) {
      const ehR = S * 0.24 * smoothstep(0.0, 0.18, birthP);
      const jetEnv = smoothstep(0.04, 0.22, birthP) * (1 - smoothstep(0.58, 0.94, birthP));
      if (jetEnv > 0.01) {
        drawDiffractionStar(ctx, x, y, S * 1.55 * smoothstep(0.04, 0.42, birthP), Math.PI * 0.5 - 0.22, '142, 208, 255', jetEnv * 0.85);
      }
      drawFeatheredNebulaShell(ctx, x, y, ehR * 2.2, '255, 232, 178', '255, 154, 62', '180, 56, 16', 0.68);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.22);
      ctx.scale(1, 0.19);
      drawFeatheredNebulaShell(ctx, 0, 0, ehR * 4.4, '255, 242, 210', '255, 166, 72', '184, 58, 18', 0.85);
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#010205';
      ctx.beginPath(); ctx.arc(x, y, ehR, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  } else if (def.id === 'kilonova') {
    const mergeP = 0.42;
    if (p < mergeP) {
      const ip = p / mergeP;
      const sep = S * 0.58 * Math.pow(1 - ip, 0.52);
      const ang = ip * ip * 18.0 + active.elapsed * 2.2;
      for (let k = 0; k < 2; k++) {
        const a = ang + k * Math.PI;
        const nx = x + Math.cos(a) * sep;
        const ny = y + Math.sin(a) * sep * 0.56;
        const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, S * 0.24);
        ng.addColorStop(0, '#ffffff');
        ng.addColorStop(0.32, k === 0 ? 'rgba(116, 224, 255, 0.88)' : 'rgba(192, 148, 255, 0.88)');
        ng.addColorStop(1, 'rgba(92, 140, 255, 0)');
        ctx.fillStyle = ng; ctx.beginPath(); ctx.arc(nx, ny, S * 0.24, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      const kp = (p - mergeP) / (1 - mergeP);
      const r = S * (0.20 + Math.pow(kp, 0.60) * 1.24);
      const mFlash = Math.exp(-Math.pow((p - mergeP - 0.015) / 0.055, 2));
      drawFeatheredNebulaShell(ctx, x, y, r * 0.95, '98, 232, 232', '255, 184, 72', '186, 82, 168', 0.66 * (1 - kp * 0.45));
      drawDiffractionStar(ctx, x, y, S * (0.55 + mFlash * 1.0), 0.52, '182, 240, 255', mFlash * 0.85);
    }
  } else if (def.id === 'solar-flare') {
    // High-craft 2D stellar superflare: real boiling sun texture + feathered corona + 3 magnetic arches + CME plumes
    const starR = pos.sunRadiusPx || S * 0.34;
    const flarePeak = Math.exp(-Math.pow((p - 0.32) / 0.13, 2));
    const cmeP = Math.max(0, (p - 0.16) / 0.84);
    const baseAng = pos.angle ?? -0.58;

    const corona = ctx.createRadialGradient(x, y, starR * 0.6, x, y, starR * 3.1);
    corona.addColorStop(0, 'rgba(255, 242, 198, 0.86)');
    corona.addColorStop(0.32, 'rgba(255, 162, 58, 0.44)');
    corona.addColorStop(0.68, 'rgba(232, 82, 22, 0.14)');
    corona.addColorStop(1, 'rgba(180, 42, 8, 0)');
    ctx.fillStyle = corona;
    ctx.beginPath(); ctx.arc(x, y, starR * 3.1, 0, Math.PI * 2); ctx.fill();

    // Textured photosphere disc with limb darkening
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    drawClippedSphereImg(ctx, sunImg, x, y, starR, ['#fff7d4', '#ff9f34', '#be3808']);
    const limb = ctx.createRadialGradient(x, y, starR * 0.3, x, y, starR);
    limb.addColorStop(0, 'rgba(255, 248, 220, 0.18)');
    limb.addColorStop(0.76, 'rgba(255, 148, 40, 0.08)');
    limb.addColorStop(1, 'rgba(164, 34, 6, 0.62)');
    ctx.fillStyle = limb;
    ctx.beginPath(); ctx.arc(x, y, starR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Soft feathered CME plumes (organic radial lobes, zero hard pie-wedge edges!)
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(baseAng);
    for (let k = 0; k < 4; k++) {
      const dist = starR * (1.15 + cmeP * (1.1 + k * 0.55));
      const spread = (k - 1.5) * starR * 0.24 * (0.5 + cmeP);
      const pr = starR * (0.48 + cmeP * 0.78);
      const pg = ctx.createRadialGradient(dist, spread, pr * 0.1, dist, spread, pr);
      pg.addColorStop(0, `rgba(255, 212, 128, ${(0.42 * (1 - cmeP * 0.35)).toFixed(3)})`);
      pg.addColorStop(0.45, `rgba(255, 108, 34, ${(0.28 * (1 - cmeP * 0.4)).toFixed(3)})`);
      pg.addColorStop(1, 'rgba(180, 32, 8, 0)');
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(dist, spread, pr, 0, Math.PI * 2); ctx.fill();
    }
    // 3-strand feathered coronal magnetic arches
    for (let k = 0; k < 3; k++) {
      const archR = starR * (0.36 + k * 0.24) * (0.58 + 0.55 * Math.sin(Math.min(1, p * 1.35) * Math.PI));
      ctx.strokeStyle = `rgba(255, ${172 - k * 28}, ${72 - k * 14}, ${(0.72 - k * 0.14).toFixed(2)})`;
      ctx.lineWidth = Math.max(1.2, starR * (0.08 - k * 0.015));
      ctx.beginPath();
      ctx.ellipse(starR * 0.94, (k - 1) * starR * 0.08, archR * 1.15, archR * 0.72, 0, -Math.PI * 0.52, Math.PI * 0.52);
      ctx.stroke();
    }
    ctx.restore();
    drawDiffractionStar(ctx, x + Math.cos(baseAng) * starR * 1.04, y + Math.sin(baseAng) * starR * 1.04, starR * (1.2 + flarePeak * 1.4), 0.18, '255, 214, 134', flarePeak * 0.78);
  } else if (def.id === 'gamma-burst') {
    const beamEnv = smoothstep(0.10, 0.24, p);
    const len = Math.min(Math.max(w, h) * 0.85, S * (2.6 + focus * 1.4)) * smoothstep(0.10, 0.38, p);
    drawDiffractionStar(ctx, x, y, S * 0.95, 0.26, '206, 174, 255', beamEnv * 0.78);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(pos.angle ?? -0.52);
    const bg = ctx.createLinearGradient(-len, 0, len, 0);
    bg.addColorStop(0, 'rgba(138, 102, 255, 0)');
    bg.addColorStop(0.45, `rgba(168, 118, 255, ${(0.55 * beamEnv).toFixed(3)})`);
    bg.addColorStop(0.50, `rgba(255, 248, 255, ${(0.95 * beamEnv).toFixed(3)})`);
    bg.addColorStop(0.55, `rgba(116, 208, 255, ${(0.55 * beamEnv).toFixed(3)})`);
    bg.addColorStop(1, 'rgba(116, 208, 255, 0)');
    ctx.strokeStyle = bg;
    ctx.lineWidth = Math.max(2.5, S * 0.095);
    ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(len, 0); ctx.stroke();
    ctx.restore();
  } else if (def.id === 'tidal-disruption') {
    const bhR = S * 0.21;
    drawFeatheredNebulaShell(ctx, x, y, bhR * 2.4, '255, 214, 148', '255, 126, 48', '172, 46, 18', 0.65);
    const headT = Math.min(1.25, p * 1.38);
    const tailT = Math.max(0, headT - 0.88);
    for (let i = 0; i <= 36; i++) {
      const u = i / 36;
      const tc = tailT + (headT - tailT) * u;
      const ang = -2.35 + tc * 6.4;
      const rad = S * (0.22 + 1.08 * Math.exp(-tc * 1.62));
      const sx = x + Math.cos(ang) * rad;
      const sy = y + Math.sin(ang) * rad * 0.58;
      const pr = S * (0.04 + u * 0.06);
      const pg = ctx.createRadialGradient(sx, sy, 0, sx, sy, pr);
      pg.addColorStop(0, `rgba(255, ${Math.round(160 + u * 80)}, ${Math.round(80 + u * 90)}, ${(0.42 * Math.sin(u * Math.PI)).toFixed(3)})`);
      pg.addColorStop(1, 'rgba(255, 86, 28, 0)');
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(sx, sy, pr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#020308';
    ctx.beginPath(); ctx.arc(x, y, bhR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  } else if (def.id === 'comet-breakup') {
    const pathU = p - 0.48;
    const headX = x + pathU * S * 1.42;
    const headY = y - (pathU * 0.34 + pathU * pathU * 0.28) * S;
    const splitP = smoothstep(0.14, 0.92, p);
    for (let k = 0; k < 7; k++) {
      const weight = Math.exp(-k * 0.24);
      const lag = (k * 0.165) * splitP * S;
      const fx = headX - lag * 0.94;
      const fy = headY + lag * 0.34 + (k - 2.6) * splitP * S * 0.03;
      const tLen = S * (0.36 + weight * 0.56);
      const g = ctx.createLinearGradient(fx, fy, fx - tLen * 0.94, fy + tLen * 0.34);
      g.addColorStop(0, 'rgba(220, 250, 255, 0.88)');
      g.addColorStop(0.42, 'rgba(116, 218, 255, 0.42)');
      g.addColorStop(1, 'rgba(255, 210, 142, 0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(1.2, (1.8 + weight * 2.8) * Math.max(0.4, pos.scale || 1));
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx - tLen * 0.94, fy + tLen * 0.34); ctx.stroke();
      const coma = ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.max(3, S * (0.02 + weight * 0.03)));
      coma.addColorStop(0, 'rgba(255, 255, 255, 0.96)');
      coma.addColorStop(0.45, 'rgba(108, 232, 255, 0.55)');
      coma.addColorStop(1, 'rgba(72, 198, 255, 0)');
      ctx.fillStyle = coma;
      ctx.beginPath(); ctx.arc(fx, fy, Math.max(3, S * (0.02 + weight * 0.03)), 0, Math.PI * 2); ctx.fill();
    }
  }

  ctx.restore();
}
