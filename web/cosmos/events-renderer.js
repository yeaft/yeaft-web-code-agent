/**
 * Yeaft Cosmos — High-Craft Multi-Phase Cosmic Event Canvas Renderer (8 Phenomena)
 */

function makeRays(seedStart, count) {
  let s = seedStart >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({
      ang: rnd() * Math.PI * 2,
      spd: 0.35 + rnd() * 0.95,
      size: 1.4 + rnd() * 3.8,
      hue: rnd(),
      delay: rnd() * 0.14,
      wobble: (rnd() - 0.5) * 0.25,
    });
  }
  return arr;
}

const RAYS_SN = makeRays(10131, 120);
const RAYS_PLANET = makeRays(29847, 110);
const RAYS_BH = makeRays(51923, 88);
const RAYS_COMET = makeRays(77341, 72);

function drawTaperedSpike(ctx, x, y, len, angle, rgbaCenter, width) {
  const dx = Math.cos(angle) * len;
  const dy = Math.sin(angle) * len;
  const grad = ctx.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
  grad.addColorStop(0, 'rgba(200, 235, 255, 0)');
  grad.addColorStop(0.42, rgbaCenter);
  grad.addColorStop(0.50, 'rgba(255, 255, 255, 0.96)');
  grad.addColorStop(0.58, rgbaCenter);
  grad.addColorStop(1, 'rgba(200, 235, 255, 0)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x - dx, y - dy);
  ctx.lineTo(x + dx, y + dy);
  ctx.stroke();
}

function drawFeatheredShell(ctx, x, y, rOut, innerRgb, midRgb, outerRgb, alpha) {
  if (rOut <= 2 || alpha <= 0.005) return;
  const g = ctx.createRadialGradient(x, y, rOut * 0.68, x, y, rOut * 1.12);
  g.addColorStop(0, `rgba(${innerRgb}, 0)`);
  g.addColorStop(0.42, `rgba(${innerRgb}, ${alpha * 0.45})`);
  g.addColorStop(0.68, `rgba(${midRgb}, ${alpha * 0.85})`);
  g.addColorStop(0.84, `rgba(${outerRgb}, ${alpha * 0.35})`);
  g.addColorStop(1, `rgba(${outerRgb}, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, rOut * 1.12, 0, Math.PI * 2);
  ctx.fill();
}

export function drawCosmicEventCanvas(ctx, w, h, active, pos) {
  if (!active || !pos) return;
  const def = active.def;
  const p = Math.max(0, Math.min(1, active.elapsed / active.duration));
  const scale = Math.max(0.14, pos.scale || 1);
  const S = Math.min(w, h) * 0.23 * scale;
  const x = pos.x;
  const y = pos.y;
  const focus = typeof pos.focusProgress === 'number' ? pos.focusProgress : (active.observing ? 1 : 0);

  // Smooth fade-in (first 4%) & fade-out tail (final 10%) so distant events emerge and dissolve naturally
  const startFade = p < 0.04 ? Math.max(0.15, p / 0.04) : 1;
  const endFade = p > 0.90 ? Math.max(0, 1 - (p - 0.90) / 0.10) : 1;
  // Slightly soften brilliance when far away so distant events sit naturally in deep space
  const depthAtten = 0.72 + focus * 0.28;

  ctx.save();
  ctx.globalAlpha = startFade * endFade * depthAtten;
  ctx.globalCompositeOperation = 'lighter';

  if (def.id === 'supernova') {
    const flash = Math.exp(-Math.pow((p - 0.24) / 0.085, 2));
    const expP = Math.max(0, (p - 0.18) / 0.82);

    if (expP > 0.01) {
      const rOut = S * (0.20 + Math.pow(expP, 0.72) * 1.48);
      const fade = Math.sin(Math.min(1, expP) * Math.PI * 0.92);

      for (let lobe = 0; lobe < 5; lobe++) {
        const la = lobe * 1.26 + 0.3;
        const lx = x + Math.cos(la) * rOut * 0.26;
        const ly = y + Math.sin(la) * rOut * 0.22;
        const lr = rOut * (0.72 + (lobe % 2) * 0.18);
        const neb = ctx.createRadialGradient(lx, ly, lr * 0.08, lx, ly, lr);
        neb.addColorStop(0, lobe % 2 === 0 ? `rgba(148, 224, 255, ${0.26 * fade})` : `rgba(255, 168, 118, ${0.20 * fade})`);
        neb.addColorStop(0.55, lobe % 2 === 0 ? `rgba(104, 146, 255, ${0.18 * fade})` : `rgba(220, 108, 168, ${0.14 * fade})`);
        neb.addColorStop(1, 'rgba(40, 60, 140, 0)');
        ctx.fillStyle = neb;
        ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.fill();
      }

      drawFeatheredShell(ctx, x, y, rOut * 0.92, '142, 226, 255', '214, 242, 255', '255, 138, 92', 0.65 * (1 - expP * 0.62));

      RAYS_SN.forEach((ray) => {
        const rp = Math.max(0, expP - ray.delay);
        if (rp <= 0) return;
        const dist = rOut * (0.22 + ray.spd * 0.82);
        const ang = ray.ang + ray.wobble * expP;
        const hx = x + Math.cos(ang) * dist;
        const hy = y + Math.sin(ang) * dist;
        const tx = x + Math.cos(ang) * dist * 0.66;
        const ty = y + Math.sin(ang) * dist * 0.66;
        const col = ray.hue < 0.45 ? '156, 228, 255' : (ray.hue < 0.78 ? '255, 192, 132' : '212, 164, 255');
        const g = ctx.createLinearGradient(tx, ty, hx, hy);
        g.addColorStop(0, `rgba(${col}, 0)`);
        g.addColorStop(0.7, `rgba(${col}, ${0.46 * (1 - expP * 0.62)})`);
        g.addColorStop(1, `rgba(255, 255, 255, ${0.58 * (1 - expP * 0.68)})`);
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy);
        ctx.strokeStyle = g; ctx.lineWidth = ray.size * 0.44; ctx.lineCap = 'round'; ctx.stroke();
      });
    }

    const coreR = S * (0.22 + flash * 0.88);
    const cg = ctx.createRadialGradient(x, y, 0, x, y, coreR);
    cg.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
    cg.addColorStop(0.24, `rgba(176, 232, 255, ${0.72 + flash * 0.24})`);
    cg.addColorStop(0.58, `rgba(104, 168, 255, ${0.28 + flash * 0.25})`);
    cg.addColorStop(1, 'rgba(80, 140, 255, 0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(x, y, coreR, 0, Math.PI * 2); ctx.fill();

    const flareLen = S * (0.52 + flash * 1.55);
    drawTaperedSpike(ctx, x, y, flareLen, 0, `rgba(190, 232, 255, ${0.38 + flash * 0.45})`, 1.7 * pos.scale);
    drawTaperedSpike(ctx, x, y, flareLen * 0.78, Math.PI * 0.5, `rgba(190, 232, 255, ${0.32 + flash * 0.42})`, 1.5 * pos.scale);

    if (expP > 0.22) {
      const bAng = active.elapsed * 3.4;
      const bLen = S * 0.72 * Math.min(1, (expP - 0.22) * 2.4);
      drawTaperedSpike(ctx, x, y, bLen, bAng, 'rgba(154, 230, 255, 0.58)', 2.2 * pos.scale);
    }
  } else if (def.id === 'planet-shatter') {
    const hitT = 0.20;
    const rPl = S * 0.30;
    if (p < hitT + 0.14) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      const pg = ctx.createRadialGradient(x - rPl * 0.3, y - rPl * 0.25, rPl * 0.08, x, y, rPl);
      pg.addColorStop(0, '#a67b5e');
      pg.addColorStop(0.55, '#4b2c20');
      pg.addColorStop(1, '#120806');
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(x, y, rPl, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      if (p < hitT) {
        const ap = p / hitT;
        const ix = x + (1 - ap) * S * 1.25;
        const iy = y - (1 - ap) * S * 0.62;
        const tail = ctx.createLinearGradient(ix, iy, ix + S * 0.42, iy - S * 0.21);
        tail.addColorStop(0, 'rgba(255, 224, 168, 0.92)');
        tail.addColorStop(0.45, 'rgba(255, 118, 48, 0.52)');
        tail.addColorStop(1, 'rgba(255, 72, 24, 0)');
        ctx.strokeStyle = tail; ctx.lineWidth = rPl * 0.42; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(ix, iy); ctx.lineTo(ix + S * 0.42, iy - S * 0.21); ctx.stroke();
      }
    }

    if (p >= hitT) {
      const bp = (p - hitT) / (1 - hitT);
      const impactFlash = Math.exp(-Math.pow(bp / 0.15, 2));

      for (let k = 0; k < 4; k++) {
        const a = -0.5 + k * 1.52;
        const px = x + Math.cos(a) * S * bp * 0.36;
        const py = y + Math.sin(a) * S * bp * 0.26;
        const pr = S * (0.28 + bp * 0.92);
        const plg = ctx.createRadialGradient(px, py, 0, px, py, pr);
        plg.addColorStop(0, `rgba(255, 214, 146, ${0.46 * (1 - bp * 0.58)})`);
        plg.addColorStop(0.42, `rgba(255, 110, 44, ${0.32 * (1 - bp * 0.62)})`);
        plg.addColorStop(1, 'rgba(180, 36, 16, 0)');
        ctx.fillStyle = plg; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      }

      drawFeatheredShell(ctx, x, y, S * (0.26 + Math.pow(bp, 0.78) * 1.38), '255, 166, 92', '255, 116, 52', '196, 44, 24', 0.56 * (1 - bp * 0.72));

      if (bp < 0.78) {
        const coreFade = 1 - bp / 0.78;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (let c = 0; c < 6; c++) {
          const ca = c * 1.04 + bp * 0.45;
          const cd = S * (0.04 + bp * 0.42) * (0.7 + (c % 3) * 0.24);
          const cx2 = x + Math.cos(ca) * cd;
          const cy2 = y + Math.sin(ca) * cd * 0.78;
          const cr = rPl * (0.26 - bp * 0.12) * (0.8 + (c % 2) * 0.35);
          ctx.fillStyle = `rgba(34, 16, 12, ${0.88 * coreFade})`;
          ctx.beginPath();
          ctx.moveTo(cx2 + cr, cy2);
          ctx.lineTo(cx2 + cr * 0.2, cy2 + cr * 0.85);
          ctx.lineTo(cx2 - cr * 0.9, cy2 + cr * 0.3);
          ctx.lineTo(cx2 - cr * 0.4, cy2 - cr * 0.8);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = `rgba(255, 152, 68, ${0.85 * coreFade})`;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
        ctx.restore();
      }

      RAYS_PLANET.forEach((sh) => {
        const dist = S * (0.14 + Math.pow(bp, 0.74) * (0.58 + sh.spd * 1.02));
        const swirl = bp * bp * 0.55;
        const a = sh.ang + swirl;
        const sx = x + Math.cos(a) * dist;
        const sy = y + Math.sin(a) * dist * (0.68 + 0.32 * (1 - bp));
        const tx = x + Math.cos(a - 0.04) * dist * 0.84;
        const ty = y + Math.sin(a - 0.04) * dist * 0.84 * (0.68 + 0.32 * (1 - bp));
        const heat = Math.max(0.14, 1 - bp * 0.72);
        const col = sh.hue < 0.45 ? '255, 208, 128' : '255, 114, 52';
        const tg = ctx.createLinearGradient(tx, ty, sx, sy);
        tg.addColorStop(0, `rgba(${col}, 0)`);
        tg.addColorStop(1, `rgba(${col}, ${heat})`);
        ctx.strokeStyle = tg;
        ctx.lineWidth = Math.max(1.1, sh.size * 0.58 * pos.scale * (1 - bp * 0.32));
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(sx, sy); ctx.stroke();
      });

      const fg = ctx.createRadialGradient(x, y, 0, x, y, S * (0.24 + impactFlash * 0.82));
      fg.addColorStop(0, `rgba(255, 252, 238, ${0.95 * (0.35 + impactFlash * 0.65) * (1 - bp * 0.55)})`);
      fg.addColorStop(0.38, `rgba(255, 168, 86, ${0.55 * (1 - bp * 0.62)})`);
      fg.addColorStop(1, 'rgba(255, 80, 28, 0)');
      ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(x, y, S * (0.24 + impactFlash * 0.82), 0, Math.PI * 2); ctx.fill();
    }
  } else if (def.id === 'blackhole-birth') {
    const collapseP = Math.min(1, p / 0.28);
    const birthP = Math.max(0, (p - 0.24) / 0.76);
    if (p < 0.32) {
      const starR = S * (0.65 * (1 - collapseP * 0.72));
      const sg = ctx.createRadialGradient(x, y, 0, x, y, starR);
      sg.addColorStop(0, '#ffffff');
      sg.addColorStop(0.4, 'rgba(164, 214, 255, 0.85)');
      sg.addColorStop(1, 'rgba(98, 134, 255, 0)');
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(x, y, starR, 0, Math.PI * 2); ctx.fill();
    }
    if (birthP > 0) {
      const ehR = S * 0.26 * Math.min(1, birthP * 2.2);
      const jetEnv = Math.sin(Math.min(1, birthP * 1.15) * Math.PI);
      if (jetEnv > 0.01) {
        drawTaperedSpike(ctx, x, y, S * 1.75 * Math.min(1, birthP * 1.8), -0.42, `rgba(170, 218, 255, ${0.75 * jetEnv})`, 4.8 * pos.scale * jetEnv);
      }
      drawFeatheredShell(ctx, x, y, ehR * 1.26, '255, 224, 156', '255, 152, 62', '180, 62, 18', 0.72 * Math.min(1, birthP * 2.2));
      RAYS_BH.forEach((pt) => {
        const prog = (pt.delay * 4 + birthP * (1.2 + pt.spd)) % 1;
        const rad = ehR * (1.1 + (1 - prog) * 3.5);
        const ang = pt.ang + active.elapsed * (2.6 / Math.max(0.6, rad / ehR));
        const lx = Math.cos(ang) * rad, ly = Math.sin(ang) * rad * 0.25;
        const rc = Math.cos(-0.2), rs = Math.sin(-0.2);
        ctx.fillStyle = `rgba(255, ${Math.round(168 + prog * 70)}, ${Math.round(82 + prog * 95)}, ${0.72 * Math.sin(prog * Math.PI)})`;
        ctx.beginPath(); ctx.arc(x + lx * rc - ly * rs, y + lx * rs + ly * rc, pt.size * 0.55 * pos.scale, 0, Math.PI * 2); ctx.fill();
      });
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
      const sep = S * 0.56 * Math.pow(1 - ip, 0.72);
      const ang = ip * ip * 18.0 + active.elapsed * 2.2;
      for (let k = 0; k < 2; k++) {
        const a = ang + k * Math.PI;
        const nx = x + Math.cos(a) * sep, ny = y + Math.sin(a) * sep * 0.58;
        const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, S * 0.24);
        ng.addColorStop(0, '#ffffff');
        ng.addColorStop(0.32, k === 0 ? 'rgba(130, 216, 255, 0.9)' : 'rgba(186, 152, 255, 0.9)');
        ng.addColorStop(1, 'rgba(110, 156, 255, 0)');
        ctx.fillStyle = ng; ctx.beginPath(); ctx.arc(nx, ny, S * 0.24, 0, Math.PI * 2); ctx.fill();
      }
      for (let wv = 0; wv < 3; wv++) {
        const ph = (ip * 3.0 + wv * 0.33) % 1;
        drawFeatheredShell(ctx, x, y, S * (0.20 + ph * 1.45), '132, 192, 255', '176, 168, 255', '104, 132, 255', (1 - ph) * 0.32);
      }
    } else {
      const kp = (p - mergeP) / (1 - mergeP);
      const r = S * (0.25 + Math.pow(kp, 0.65) * 1.38);
      const kg = ctx.createRadialGradient(x, y, 0, x, y, r);
      kg.addColorStop(0, `rgba(255, 255, 255, ${0.95 * (1 - kp * 0.5)})`);
      kg.addColorStop(0.32, `rgba(118, 240, 224, ${0.72 * (1 - kp * 0.55)})`);
      kg.addColorStop(0.68, `rgba(255, 196, 108, ${0.42 * (1 - kp * 0.65)})`);
      kg.addColorStop(1, 'rgba(140, 120, 255, 0)');
      ctx.fillStyle = kg; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      drawFeatheredShell(ctx, x, y, r * 1.05, '132, 244, 226', '255, 212, 136', '156, 132, 255', 0.55 * (1 - kp * 0.7));
    }
  } else if (def.id === 'solar-flare') {
    // Distant stellar superflare around a far-away yellow-white star (never overwrites our foreground Sun)
    const starR = S * 0.22;
    const erupt = Math.sin(p * Math.PI);
    const flareR = starR * (1.25 + p * 3.9);
    const baseAng = -0.68;

    const corona = ctx.createRadialGradient(x, y, starR * 0.2, x, y, starR * 2.8);
    corona.addColorStop(0, 'rgba(255, 250, 232, 0.96)');
    corona.addColorStop(0.28, 'rgba(255, 198, 108, 0.72)');
    corona.addColorStop(0.65, 'rgba(255, 118, 42, 0.24)');
    corona.addColorStop(1, 'rgba(255, 72, 20, 0)');
    ctx.fillStyle = corona;
    ctx.beginPath(); ctx.arc(x, y, starR * 2.8, 0, Math.PI * 2); ctx.fill();

    const cme = ctx.createRadialGradient(x, y, starR * 0.72, x, y, flareR);
    cme.addColorStop(0, `rgba(255, 244, 200, ${0.76 * erupt})`);
    cme.addColorStop(0.45, `rgba(255, 134, 48, ${0.48 * erupt})`);
    cme.addColorStop(1, 'rgba(255, 68, 24, 0)');
    ctx.fillStyle = cme;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, flareR, baseAng - 0.64, baseAng + 0.64); ctx.closePath(); ctx.fill();

    ctx.beginPath();
    ctx.arc(x + Math.cos(baseAng) * starR * 0.92, y + Math.sin(baseAng) * starR * 0.92, starR * (0.50 + erupt * 1.35), baseAng - 0.85, baseAng + 0.85);
    ctx.strokeStyle = `rgba(255, 178, 86, ${0.82 * erupt})`; ctx.lineWidth = Math.max(1.2, 3.8 * scale); ctx.stroke();

    const starCore = ctx.createRadialGradient(x, y, 0, x, y, starR);
    starCore.addColorStop(0, '#ffffff');
    starCore.addColorStop(0.68, 'rgba(255, 224, 152, 0.96)');
    starCore.addColorStop(1, 'rgba(255, 146, 54, 0.82)');
    ctx.fillStyle = starCore;
    ctx.beginPath(); ctx.arc(x, y, starR, 0, Math.PI * 2); ctx.fill();
  } else if (def.id === 'gamma-burst') {
    const beamEnv = Math.sin(p * Math.PI);
    // Scale beam length proportionally with event scale so distant GRBs look far away instead of spanning the whole screen
    const len = Math.min(Math.max(w, h) * 0.88, S * (3.1 + focus * 1.4)) * Math.min(1, p * 2.4);
    drawTaperedSpike(ctx, x, y, len, -0.54, `rgba(196, 136, 255, ${0.58 * beamEnv})`, Math.max(2.4, 16 * scale * beamEnv));
    drawTaperedSpike(ctx, x, y, len, -0.54, `rgba(248, 232, 255, ${0.95 * beamEnv})`, Math.max(1.0, 3.2 * scale * beamEnv));
    const coreG = ctx.createRadialGradient(x, y, 0, x, y, S * 0.76 * (0.4 + beamEnv));
    coreG.addColorStop(0, `rgba(255, 255, 255, ${0.96 * beamEnv})`);
    coreG.addColorStop(0.35, `rgba(204, 152, 255, ${0.68 * beamEnv})`);
    coreG.addColorStop(1, 'rgba(114, 78, 255, 0)');
    ctx.fillStyle = coreG; ctx.beginPath(); ctx.arc(x, y, S * 0.76 * (0.4 + beamEnv), 0, Math.PI * 2); ctx.fill();
  } else if (def.id === 'tidal-disruption') {
    const bhR = S * 0.18;
    drawFeatheredShell(ctx, x, y, bhR * 1.32, '255, 212, 146', '255, 134, 56', '180, 48, 22', 0.65);
    ctx.beginPath();
    for (let i = 0; i <= 90; i++) {
      const u = i / 90;
      const tCurve = Math.max(0, p * 1.25 - u * 0.65);
      if (tCurve <= 0) continue;
      const ang = -2.4 + tCurve * 5.8 + u * 1.4;
      const rad = S * (1.05 * Math.exp(-tCurve * 1.55) + 0.18);
      const sx = x + Math.cos(ang) * rad, sy = y + Math.sin(ang) * rad * 0.64;
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.strokeStyle = 'rgba(255, 162, 86, 0.85)'; ctx.lineWidth = 4.4 * pos.scale; ctx.lineCap = 'round'; ctx.stroke();
    const flare = Math.sin(p * Math.PI);
    const tg = ctx.createRadialGradient(x, y, bhR, x, y, S * 0.88);
    tg.addColorStop(0, `rgba(255, 224, 174, ${0.72 * flare})`);
    tg.addColorStop(0.5, `rgba(255, 124, 58, ${0.32 * flare})`);
    tg.addColorStop(1, 'rgba(255, 92, 42, 0)');
    ctx.fillStyle = tg; ctx.beginPath(); ctx.arc(x, y, S * 0.88, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#020308'; ctx.beginPath(); ctx.arc(x, y, bhR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  } else if (def.id === 'comet-breakup') {
    const headX = x + (p - 0.5) * S * 1.6, headY = y - (p - 0.5) * S * 0.55;
    const splitP = Math.max(0, (p - 0.18) / 0.82);
    for (let k = 0; k < 7; k++) {
      const spread = (k - 3) * splitP * S * 0.16;
      const lag = Math.abs(k - 3) * splitP * S * 0.14;
      const fx = headX - lag * 0.8 + spread * 0.3, fy = headY + lag * 0.35 + spread * 0.65;
      const tailLen = S * (0.55 + (1 - Math.abs(k - 3) * 0.1) * 0.45);
      const tx = fx - tailLen * 0.92, ty = fy + tailLen * 0.34;
      const cg = ctx.createLinearGradient(fx, fy, tx, ty);
      cg.addColorStop(0, 'rgba(220, 250, 255, 0.92)');
      cg.addColorStop(0.45, 'rgba(116, 218, 255, 0.44)');
      cg.addColorStop(1, 'rgba(116, 218, 255, 0)');
      ctx.strokeStyle = cg; ctx.lineWidth = (3.4 - Math.abs(k - 3) * 0.36) * pos.scale; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(fx, fy, (3.2 - Math.abs(k - 3) * 0.3) * pos.scale, 0, Math.PI * 2); ctx.fill();
    }
    RAYS_COMET.forEach((pt) => {
      const mx = headX - pt.spd * S * 0.95 * (0.3 + splitP * 0.7) + Math.cos(pt.ang) * S * 0.25 * splitP;
      const my = headY + pt.spd * S * 0.35 * (0.3 + splitP * 0.7) + Math.sin(pt.ang) * S * 0.22 * splitP;
      ctx.fillStyle = pt.hue < 0.6 ? 'rgba(164, 238, 255, 0.65)' : 'rgba(255, 224, 166, 0.55)';
      ctx.beginPath(); ctx.arc(mx, my, pt.size * 0.4 * pos.scale, 0, Math.PI * 2); ctx.fill();
    });
  }

  ctx.restore();
}
