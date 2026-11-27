/**
 * Yeaft Cosmos — GPU Living Particle Pools, 3D Cosmic Web Graph & 2D Vector Astronomical HUD
 */
import { PLANETS, keplerPos, keplerOrbitPoint } from './constants.js';

/* Two realistic long-period comets on high-eccentricity Keplerian ellipses (Sun at focus) */
const COMETS = [
  { orbitR: 0.92, ecc: 0.72, argPeri: 0.42, incl: 0.22, speed: 0.056, phase: 0.78, scale: 1.0, dustRgb: [252, 236, 210], ionRgb: [108, 194, 255] },
  { orbitR: 1.18, ecc: 0.76, argPeri: 3.45, incl: -0.18, speed: -0.038, phase: 3.85, scale: 0.78, dustRgb: [246, 228, 198], ionRgb: [122, 206, 255] },
];

function evalCometState(cm, tVal, project, sunPt) {
  const wp = keplerPos(cm, tVal);
  const pt = project(wp.x, wp.z, wp.y);
  const wpPrev = keplerPos(cm, tVal - 0.045);
  const prevPt = project(wpPrev.x, wpPrev.z, wpPrev.y);
  const velDx = prevPt.x - pt.x;
  const velDy = prevPt.y - pt.y;
  const velLen = Math.max(Math.hypot(velDx, velDy), 0.001);
  const backX = velDx / velLen;
  const backY = velDy / velLen;

  const dxSun = pt.x - sunPt.x;
  const dySun = pt.y - sunPt.y;
  const dSun = Math.max(Math.hypot(dxSun, dySun), 1);
  const antiX = dxSun / dSun;
  const antiY = dySun / dSun;
  const worldDist = Math.max(0.18, Math.hypot(wp.x, wp.z, wp.y));
  const closeness = Math.max(0.22, Math.min(1.0, 0.52 / Math.pow(worldDist, 0.78)));
  const persp = Math.min(1.75, pt.persp || 1.0);
  return { pt, antiX, antiY, backX, backY, closeness, persp, cm };
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function createParticlePools() {
  const rnd = makeRng(20261126);

  // Asteroid Belt + Kuiper Belt
  const belt = [];
  for (let i = 0; i < 460; i++) {
    const r = 0.435 + rnd() * 0.072;
    belt.push({
      r,
      angle: rnd() * Math.PI * 2,
      speed: 0.044 + (0.48 - r) * 0.12 + rnd() * 0.012,
      incl: (rnd() - 0.5) * 0.018,
      size: 1.1 + rnd() * 1.8,
      alpha: 0.20 + rnd() * 0.36,
      col: rnd() > 0.4 ? [0.76, 0.72, 0.66] : [0.64, 0.74, 0.88],
    });
  }
  for (let i = 0; i < 380; i++) {
    const r = 1.02 + rnd() * 0.24;
    belt.push({
      r,
      angle: rnd() * Math.PI * 2,
      speed: 0.008 + rnd() * 0.006,
      incl: (rnd() - 0.5) * 0.045,
      size: 0.95 + rnd() * 1.45,
      alpha: 0.14 + rnd() * 0.24,
      col: [0.60, 0.74, 0.96],
    });
  }

  // Interstellar drifting dust
  const dust = [];
  for (let i = 0; i < 240; i++) {
    dust.push({
      x: rnd(),
      y: rnd(),
      z: 0.25 + rnd() * 0.95,
      size: 1.0 + rnd() * 2.1,
      alpha: 0.12 + rnd() * 0.30,
      tint: rnd(),
    });
  }

  // Solar wind emanation
  const solarWind = [];
  for (let i = 0; i < 160; i++) {
    solarWind.push({
      angle: rnd() * Math.PI * 2,
      phase: rnd(),
      speed: 0.08 + rnd() * 0.12,
      maxDist: 0.22 + rnd() * 0.38,
      size: 1.2 + rnd() * 1.9,
    });
  }

  // Lazily synthesize Galaxy (2,000) & Event Horizon (480) pools only when those scales enter view.
  let galStarsCache = null;
  let bhInfallCache = null;

  function buildGalStars() {
    const grnd = makeRng(20261129);
    const arr = [];
    for (let i = 0; i < 2000; i++) {
      const arm = i % 4;
      const r = 0.06 + Math.pow(grnd(), 0.75) * 0.88;
      const spiral = arm * (Math.PI * 0.5) + Math.log(r + 0.08) * 2.6 + (grnd() - 0.5) * (0.45 + r * 0.55);
      const tint = grnd();
      arr.push({
        r,
        angle: spiral,
        speed: 0.08 / Math.pow(r + 0.16, 0.65),
        zOff: (grnd() - 0.5) * 0.032 * (1.2 - r * 0.6),
        size: 1.0 + Math.pow(grnd(), 2.2) * 2.8,
        alpha: (0.28 + grnd() * 0.58) * (1.0 - r * 0.45),
        col: tint < 0.28 ? [0.66, 0.84, 1.0] : (tint < 0.76 ? [0.96, 0.95, 1.0] : [1.0, 0.80, 0.58]),
      });
    }
    return arr;
  }

  function buildBhInfall() {
    const brnd = makeRng(20261131);
    const arr = [];
    for (let i = 0; i < 480; i++) {
      arr.push({
        angle0: brnd() * Math.PI * 2,
        rStart: 1.8 + brnd() * 3.8,
        phase: brnd(),
        speed: 0.06 + brnd() * 0.14,
        incl: (brnd() - 0.5) * 0.16,
        size: 1.1 + brnd() * 2.0,
      });
    }
    return arr;
  }

  return {
    belt,
    dust,
    solarWind,
    get galStars() {
      if (!galStarsCache) galStarsCache = buildGalStars();
      return galStarsCache;
    },
    get bhInfall() {
      if (!bhInfallCache) bhInfallCache = buildBhInfall();
      return bhInfallCache;
    },
  };
}

export function createCosmicWebGraph() {
  const rnd = makeRng(88421);
  const nodes = [];
  const hubPalette = [
    'rgba(124, 196, 255, 1)',
    'rgba(196, 166, 255, 1)',
    'rgba(244, 194, 122, 1)',
    'rgba(120, 232, 198, 1)',
  ];
  for (let i = 0; i < 82; i++) {
    const isHub = i < 12;
    nodes.push({
      x: (rnd() - 0.5) * 1.72,
      y: (rnd() - 0.5) * 1.18,
      z: (rnd() - 0.5) * 1.25,
      isHub,
      baseR: isHub ? (0.95 + rnd() * 0.45) : (0.65 + rnd() * 0.55),
      phase: rnd() * Math.PI * 2,
      excite: 0,
      color: hubPalette[i % hubPalette.length],
      neighbors: [],
    });
  }

  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    const dists = [];
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y, nodes[i].z - nodes[j].z);
      if (d < 0.58) dists.push({ j, d });
    }
    dists.sort((a, b) => a.d - b.d);
    const take = nodes[i].isHub ? 5 : 3;
    for (let k = 0; k < Math.min(take, dists.length); k++) {
      const j = dists[k].j;
      const edgeIdx = edges.length;
      edges.push({ a: i, b: j, curve: (rnd() - 0.5) * 0.18, weight: Math.max(0.2, 1 - dists[k].d / 0.58) });
      nodes[i].neighbors.push({ edgeIdx, dir: 1 });
      nodes[j].neighbors.push({ edgeIdx, dir: -1 });
    }
  }

  const pulseCols = [[138, 212, 255], [202, 170, 255], [255, 206, 134], [126, 238, 204]];
  const pulses = [];
  for (let i = 0; i < 64 && edges.length > 0; i++) {
    pulses.push({
      edgeIdx: i % edges.length,
      t: rnd(),
      dir: rnd() > 0.5 ? 1 : -1,
      speed: 0.45 + rnd() * 0.85,
      life: 0.65 + rnd() * 0.35,
      col: pulseCols[i % pulseCols.length],
    });
  }

  return { nodes, edges, pulses };
}

export function fillGpuParticles(gpuBuf, pools, st, params) {
  const { w, h, dpr, cx, cy, span, tilt, solarAlpha, galAlpha, bhStrength, bhCx, bhCy, bhRadiusPx, densityScale = 1.0 } = params;
  if (densityScale <= 0) return 0;
  let count = 0;
  const maxPts = 3100;
  const step = densityScale < 0.7 ? 2 : 1;
  const yawCos = Math.cos(st.camRot.x * 0.38);
  const yawSin = Math.sin(st.camRot.x * 0.38);

  const pushPt = (xPx, yPx, sizePx, r, g, b, a) => {
    if (count >= maxPts || a <= 0.008) return;
    if (xPx < -16 || xPx > w + 16 || yPx < -16 || yPx > h + 16) return;
    const off = count * 7;
    gpuBuf[off] = xPx * dpr;
    gpuBuf[off + 1] = yPx * dpr;
    gpuBuf[off + 2] = sizePx * dpr;
    gpuBuf[off + 3] = r;
    gpuBuf[off + 4] = g;
    gpuBuf[off + 5] = b;
    gpuBuf[off + 6] = a;
    count++;
  };

  if (solarAlpha > 0.02) {
    const spd = Math.max(0.25, st.constants.orbitSpeed);
    for (let i = 0; i < pools.belt.length; i += step) {
      const p = pools.belt[i];
      const ang = p.angle + st.time * p.speed * spd;
      const ux = Math.cos(ang) * p.r, uz = Math.sin(ang) * p.r;
      const rx = ux * yawCos - uz * yawSin, rz = ux * yawSin + uz * yawCos;
      const persp = 1.0 / (1.0 - rz * 0.26);
      const sunSide = 0.52 + 0.48 * Math.max(0, -rz / Math.max(p.r, 0.2));
      pushPt(cx + rx * span * persp, cy + (rz * span * tilt + p.incl * span) * persp, p.size * persp, p.col[0], p.col[1], p.col[2], p.alpha * sunSide * solarAlpha);
    }
    for (let i = 0; i < pools.dust.length; i += step) {
      const d = pools.dust[i];
      const drift = st.realTime * 0.011 * d.z;
      const px = (((d.x - drift) % 1) + 1) % 1 * w;
      const py = (((d.y + drift * 0.36) % 1) + 1) % 1 * h;
      const twinkle = 0.65 + 0.35 * Math.sin(st.realTime * 1.4 + i);
      pushPt(px, py, d.size * (0.65 + d.z * 0.7), d.tint > 0.65 ? 0.96 : 0.72, d.tint > 0.65 ? 0.88 : 0.86, 1.0, d.alpha * twinkle * solarAlpha);
    }
    for (let i = 0; i < pools.solarWind.length; i += step) {
      const sw = pools.solarWind[i];
      const prog = (sw.phase + st.realTime * sw.speed) % 1.0;
      const dist = (0.045 + prog * sw.maxDist) * span;
      pushPt(cx + Math.cos(sw.angle + st.realTime * 0.04) * dist, cy + Math.sin(sw.angle + st.realTime * 0.04) * dist * (0.65 + tilt * 0.35), sw.size * (1.1 - prog * 0.45), 1.0, 0.82, 0.56, Math.sin(prog * Math.PI) * 0.36 * solarAlpha);
    }
  }

  if (galAlpha > 0.02) {
    const gcx = w * 0.5 + st.parallax.x * 12, gcy = h * 0.5 + st.parallax.y * 8;
    const gRad = Math.min(w, h) * 0.66, gTilt = 0.54 + st.camRot.y * 0.16;
    const rc = Math.cos(-0.26), rs = Math.sin(-0.26);
    for (let i = 0; i < pools.galStars.length; i += step) {
      const gSt = pools.galStars[i];
      const ang = gSt.angle - st.realTime * gSt.speed * 0.38 - st.time * gSt.speed * 0.25;
      const lx = Math.cos(ang) * gSt.r, ly = Math.sin(ang) * gSt.r * gTilt + gSt.zOff;
      pushPt(gcx + (lx * rc - ly * rs) * gRad, gcy + (lx * rs + ly * rc) * gRad, gSt.size, gSt.col[0], gSt.col[1], gSt.col[2], Math.max(0, gSt.alpha) * (0.82 + 0.18 * Math.sin(st.realTime * 1.8 + i * 0.7)) * galAlpha);
    }
  }

  if (bhStrength > 0.06 && bhRadiusPx > 32) {
    const tiltCos = Math.cos(-0.15), tiltSin = Math.sin(-0.15);
    for (let i = 0; i < pools.bhInfall.length; i += step) {
      const pt = pools.bhInfall[i];
      const prog = (pt.phase + st.realTime * pt.speed) % 1.0;
      const r = pt.rStart * (1.0 - prog) + 1.04 * prog;
      const ang = pt.angle0 + st.realTime * (2.6 / Math.pow(r, 1.15)) + prog * 4.5;
      const ex = Math.cos(ang) * r, ey = Math.sin(ang) * r * 0.18 + pt.incl * (1.0 - prog);
      const rx = ex * tiltCos - ey * tiltSin, ry = ex * tiltSin + ey * tiltCos;
      if (Math.sin(ang) < 0 && Math.hypot(rx, ry) < 1.02) continue;
      const heat = Math.min(1.0, (2.8 - r) / 1.8);
      const doppler = Math.max(0.4, Math.min(1.45, 1.0 - 0.4 * (ex / Math.max(r, 0.5))));
      pushPt(bhCx + rx * bhRadiusPx, bhCy + ry * bhRadiusPx, pt.size * (0.8 + heat * 0.7), 1.0, 0.56 + heat * 0.38, 0.24 + heat * 0.62, Math.sin(prog * Math.PI) * 0.62 * doppler * bhStrength);
    }
  }

  return count;
}

export function drawCosmosHud(ctx, w, h, st, webGraph, galaxyBooks, agentsByPlanet, layout, drawEventFn) {
  const { cx, cy, span, tilt, solarAlpha, galAlpha, webAlpha, solarProj, planetFocusId, planetZoom = 1.0 } = layout;

  if (solarAlpha > 0.015) {
    ctx.save();
    ctx.globalAlpha = solarAlpha;
    const yawCos = Math.cos(st.camRot.x * 0.38);
    const yawSin = Math.sin(st.camRot.x * 0.38);
    const project = solarProj?.project || ((ux, uz, uy = 0) => {
      const rx = ux * yawCos - uz * yawSin;
      const rz = ux * yawSin + uz * yawCos;
      const persp = 1.0 / (1.0 - rz * 0.26);
      return {
        x: cx + rx * span * persp,
        y: cy + (rz * span * tilt + uy * span) * persp,
        persp,
      };
    });
    const sunPt = solarProj?.sunPt || { x: cx, y: cy };
    const orbitOpacity = st.constants.orbitLines;
    const closeupFade = planetFocusId ? Math.max(0, 1.0 - Math.max(0, (planetZoom - 2.6) / 2.2)) : 1.0;

    // Clip orbit & trail strokes behind planet globes so orbits never cut across zoomed spheres
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    for (const p of PLANETS) {
      const pos = st.planetScreen[p.id];
      if (!pos || pos.r <= 2) continue;
      ctx.moveTo(pos.x + pos.r * 0.99, pos.y);
      ctx.arc(pos.x, pos.y, pos.r * 0.99, 0, Math.PI * 2, true);
    }
    ctx.clip('evenodd');

    if (orbitOpacity > 0.02) {
      PLANETS.forEach((p) => {
        const agent = agentsByPlanet[p.id];
        const isFocus = st.hoverPlanetId === p.id || st.focusedPlanetId === p.id || planetFocusId === p.id;
        ctx.beginPath();
        for (let i = 0; i <= 120; i++) {
          const E = (i / 120) * Math.PI * 2;
          const wp = keplerOrbitPoint(p, E);
          const pt = project(wp.x, wp.z, wp.y);
          if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
        }
        ctx.strokeStyle = isFocus
          ? (agent && agent.status === 'waiting' ? `rgba(255, 190, 92, ${0.38 * orbitOpacity})` : `rgba(136, 206, 255, ${0.34 * orbitOpacity})`)
          : (agent ? `rgba(176, 208, 255, ${0.14 * orbitOpacity})` : `rgba(156, 184, 228, ${0.068 * orbitOpacity})`);
        ctx.lineWidth = isFocus ? 1.15 : 0.85;
        ctx.stroke();
      });
    }

    // Keplerian Orbit motion trails
    if (orbitOpacity > 0.02) {
      PLANETS.forEach((p) => {
        const agent = agentsByPlanet[p.id];
        const dtArc = (agent ? 0.36 : 0.22) / Math.max(p.speed, 0.01);
        ctx.beginPath();
        let endPt = null;
        for (let i = 0; i <= 22; i++) {
          const wp = keplerPos(p, st.time - (i / 22) * dtArc);
          const pt = project(wp.x, wp.z, wp.y);
          if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
          if (i === 22) endPt = pt;
        }
        const pos = st.planetScreen[p.id];
        if (pos && endPt) {
          const grad = ctx.createLinearGradient(pos.x, pos.y, endPt.x, endPt.y);
          const tint = agent && agent.status === 'waiting' ? '255, 190, 92' : '152, 208, 255';
          grad.addColorStop(0, `rgba(${tint}, ${(agent ? 0.32 : 0.13) * Math.min(1.2, orbitOpacity)})`);
          grad.addColorStop(1, `rgba(${tint}, 0)`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = agent ? 1.35 : 0.85;
          ctx.stroke();
        }
      });
    }

    // Solar Apex Galactic Motion & 3D Keplerian Helical Planet Trails (when zoomed out)
    const galTravel = solarProj?.galTravel || 0;
    if (galTravel > 0.02 && orbitOpacity > 0.02 && solarProj?.sunGalacticOffset) {
      const gt = galTravel;
      const trOp = Math.min(1.35, orbitOpacity);
      const trailDur = 26.0;
      const fwdDur = 8.5;
      const stepsBack = 42;
      ctx.beginPath();
      for (let i = 0; i <= stepsBack; i++) {
        const tHist = st.time - (i / stepsBack) * trailDur;
        const gOff = solarProj.sunGalacticOffset(tHist, gt);
        const pt = project(0, 0, 0, gOff);
        if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      const tailEndPt = project(0, 0, 0, solarProj.sunGalacticOffset(st.time - trailDur, gt));
      const sunTrailGrad = ctx.createLinearGradient(sunPt.x, sunPt.y, tailEndPt.x, tailEndPt.y);
      sunTrailGrad.addColorStop(0, `rgba(255, 214, 142, ${0.26 * gt * trOp})`);
      sunTrailGrad.addColorStop(0.48, `rgba(255, 188, 108, ${0.11 * gt * trOp})`);
      sunTrailGrad.addColorStop(1, 'rgba(255, 164, 82, 0)');
      ctx.strokeStyle = sunTrailGrad;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      ctx.beginPath();
      for (let i = 0; i <= 14; i++) {
        const tFwd = st.time + (i / 14) * fwdDur;
        const gOff = solarProj.sunGalacticOffset(tFwd, gt);
        const pt = project(0, 0, 0, gOff);
        if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      ctx.setLineDash([3, 7]);
      ctx.strokeStyle = `rgba(255, 224, 168, ${0.14 * gt * trOp})`;
      ctx.lineWidth = 0.85;
      ctx.stroke();
      ctx.setLineDash([]);

      const helixSteps = 56;
      PLANETS.forEach((p) => {
        const agent = agentsByPlanet[p.id];
        ctx.beginPath();
        let endPt = null;
        for (let i = 0; i <= helixSteps; i++) {
          const tHist = st.time - (i / helixSteps) * trailDur;
          const gOff = solarProj.sunGalacticOffset(tHist, gt);
          const wp = keplerPos(p, tHist);
          const pt = project(wp.x, wp.z, wp.y, gOff);
          if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
          if (i === helixSteps) endPt = pt;
        }
        const pos = st.planetScreen[p.id];
        if (pos && endPt) {
          const hg = ctx.createLinearGradient(pos.x, pos.y, endPt.x, endPt.y);
          const colRgb = agent ? '142, 208, 255' : '184, 202, 234';
          hg.addColorStop(0, `rgba(${colRgb}, ${(agent ? 0.16 : 0.085) * gt * trOp})`);
          hg.addColorStop(0.55, `rgba(${colRgb}, ${(agent ? 0.068 : 0.036) * gt * trOp})`);
          hg.addColorStop(1, `rgba(${colRgb}, 0)`);
          ctx.strokeStyle = hg;
          ctx.lineWidth = agent ? 0.95 : 0.65;
          ctx.stroke();
        }
      });
    }

    ctx.restore(); // end sphere-clip

    // Photorealistic Volumetric Dual-Tail Comets (Additive Soft Gaussian Dust Fan + Feathered CO+ Ion Plume + Parabolic Coma)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let ci = 0; ci < COMETS.length; ci++) {
      const cs = evalCometState(COMETS[ci], st.realTime, project, sunPt);
      const cmx = cs.pt.x;
      const cmy = cs.pt.y;
      if (cmx < -220 || cmx > w + 220 || cmy < -220 || cmy > h + 220) continue;
      const cl = cs.closeness;
      const sc = cs.persp * cs.cm.scale;
      const ionLen = (58 + cl * 110) * sc;
      const dustLen = (48 + cl * 88) * sc;

      const dDirX = cs.antiX * 0.72 + cs.backX * 0.28;
      const dDirY = cs.antiY * 0.72 + cs.backY * 0.28;
      const dLenN = Math.max(Math.hypot(dDirX, dDirY), 0.001);
      const dnx = dDirX / dLenN;
      const dny = dDirY / dLenN;
      const dpx = -dny;
      const dpy = dnx;
      const curveSign = (cs.antiX * cs.backY - cs.antiY * cs.backX) >= 0 ? 1 : -1;
      const [dr, dg, db] = cs.cm.dustRgb;

      const dustSteps = 26;
      for (let sIdx = 0; sIdx < dustSteps; sIdx++) {
        const u = (sIdx + 0.35) / dustSteps;
        const along = Math.pow(u, 1.15) * dustLen;
        const bend = (u * u * 15.5 + u * 2.0) * sc * curveSign;
        const px = cmx + dnx * along + dpx * bend;
        const py = cmy + dny * along + dpy * bend;
        const puffR = (2.8 + Math.pow(u, 0.88) * 16.5) * sc;
        const falloff = Math.pow(1.0 - u, 1.55) * (0.105 * cl);
        if (falloff < 0.002) continue;
        const g = ctx.createRadialGradient(px, py, 0, px, py, puffR);
        g.addColorStop(0, `rgba(${dr}, ${dg}, ${db}, ${falloff})`);
        g.addColorStop(0.42, `rgba(${dr}, ${Math.max(0, dg - 10)}, ${Math.max(0, db - 22)}, ${falloff * 0.42})`);
        g.addColorStop(1, `rgba(${dr}, ${Math.max(0, dg - 18)}, ${Math.max(0, db - 34)}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, puffR, 0, Math.PI * 2);
        ctx.fill();
      }

      const ipx = -cs.antiY;
      const ipy = cs.antiX;
      const [ir, ig, ib] = cs.cm.ionRgb;
      const ionAngle = Math.atan2(cs.antiY, cs.antiX);
      const ionSteps = 22;
      for (let sIdx = 0; sIdx < ionSteps; sIdx++) {
        const u = (sIdx + 0.25) / ionSteps;
        const along = Math.pow(u, 1.08) * ionLen;
        const sway = Math.sin(u * 6.5 - st.realTime * 1.9 + ci * 2.1) * (0.9 + u * 2.8) * sc;
        const px = cmx + cs.antiX * along + ipx * sway;
        const py = cmy + cs.antiY * along + ipy * sway;
        const knot = 0.84 + 0.34 * Math.pow(0.5 + 0.5 * Math.sin(u * 14.0 - st.realTime * 3.1 + ci), 3.0);
        const rx = (5.5 + u * 11.5) * sc;
        const ry = (1.6 + u * 4.4) * sc;
        const fa = Math.pow(1.0 - u, 1.45) * 0.095 * cl * knot;
        if (fa < 0.002) continue;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ionAngle);
        ctx.scale(1, ry / Math.max(rx, 0.5));
        const igrad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        igrad.addColorStop(0, `rgba(178, 232, 255, ${fa})`);
        igrad.addColorStop(0.45, `rgba(${ir}, ${ig}, ${ib}, ${fa * 0.45})`);
        igrad.addColorStop(1, `rgba(${ir}, ${ig}, ${ib}, 0)`);
        ctx.fillStyle = igrad;
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      const outerR = (10.5 + cl * 7.5) * sc;
      const outerComa = ctx.createRadialGradient(
        cmx - cs.antiX * 0.8 * sc, cmy - cs.antiY * 0.8 * sc, 0,
        cmx + cs.antiX * 2.2 * sc, cmy + cs.antiY * 2.2 * sc, outerR,
      );
      outerComa.addColorStop(0, `rgba(248, 253, 255, ${0.58 * cl})`);
      outerComa.addColorStop(0.22, `rgba(168, 236, 238, ${0.26 * cl})`);
      outerComa.addColorStop(0.55, `rgba(126, 202, 236, ${0.075 * cl})`);
      outerComa.addColorStop(1, 'rgba(96, 174, 224, 0)');
      ctx.fillStyle = outerComa;
      ctx.beginPath();
      ctx.arc(cmx, cmy, outerR, 0, Math.PI * 2);
      ctx.fill();

      const coreR = Math.max(1.3, 2.5 * sc);
      const coreGrad = ctx.createRadialGradient(cmx, cmy, 0, cmx, cmy, coreR);
      coreGrad.addColorStop(0, 'rgba(255, 255, 255, 0.96)');
      coreGrad.addColorStop(0.45, 'rgba(232, 248, 255, 0.56)');
      coreGrad.addColorStop(1, 'rgba(176, 228, 255, 0)');
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cmx, cmy, coreR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Occasional Deep-Space Meteors
    if (st.realTime >= st.nextMeteorAt) {
      st.nextMeteorAt = st.realTime + 6.5 + Math.random() * 8.5;
      st.meteors.push({ x: Math.random() * w * 0.85 + w * 0.08, y: Math.random() * h * 0.45 + h * 0.05, vx: -260 - Math.random() * 180, vy: 110 + Math.random() * 90, t: 0, dur: 0.75 });
    }
    for (let i = st.meteors.length - 1; i >= 0; i--) {
      const m = st.meteors[i];
      m.t += 0.016;
      if (m.t >= m.dur) { st.meteors.splice(i, 1); continue; }
      const env = Math.sin((m.t / m.dur) * Math.PI);
      const hx = m.x + m.vx * m.t, hy = m.y + m.vy * m.t;
      const mg = ctx.createLinearGradient(hx, hy, hx - m.vx * 0.14, hy - m.vy * 0.14);
      mg.addColorStop(0, `rgba(232, 246, 255, ${0.72 * env})`);
      mg.addColorStop(1, 'rgba(160, 214, 255, 0)');
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - m.vx * 0.14, hy - m.vy * 0.14);
      ctx.strokeStyle = mg; ctx.lineWidth = 1.25; ctx.stroke();
    }

    // Active Session Flashing Halos & Orbiting Satellites (converged on deep close-up)
    Object.entries(agentsByPlanet).forEach(([planetId, agent]) => {
      const pos = st.planetScreen[planetId];
      if (!pos || !agent) return;
      if (planetFocusId === planetId && closeupFade < 0.05) return;
      const liveSessions = agent.liveSessions || [];

      if (st.constants.activeFlash && liveSessions.length > 0) {
        const isWait = agent.status === 'waiting';
        const rgb = isWait ? '255, 190, 92' : '116, 202, 255';
        const rings = isWait ? 2 : 1;
        const fadeMul = planetFocusId === planetId ? closeupFade : 1.0;
        for (let k = 0; k < rings; k++) {
          const ph = (st.realTime * (isWait ? 0.42 : 0.34) + k * 0.5) % 1.0;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, pos.r * (1.22 + ph * (isWait ? 1.22 : 0.88)), 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${rgb}, ${(1.0 - ph) * (isWait ? 0.52 : 0.36) * fadeMul})`;
          ctx.lineWidth = isWait ? 1.35 : 1.1;
          ctx.stroke();
        }
      }

      liveSessions.slice(0, 4).forEach((s, idx) => {
        const satOrbit = pos.r * (1.42 + idx * 0.28);
        const tiltSat = 0.46 + idx * 0.16, rotSat = -0.34 + idx * 0.52;
        const sAng = st.realTime * (0.78 - idx * 0.14) + idx * 2.4;
        const rc = Math.cos(rotSat), rs = Math.sin(rotSat);
        const satRgb = s.status === 'waiting' ? '255, 198, 102' : '124, 196, 255';
        ctx.beginPath();
        for (let tStep = 0; tStep <= 10; tStep++) {
          const a = sAng - tStep * 0.075;
          const lx = Math.cos(a) * satOrbit, ly = Math.sin(a) * satOrbit * tiltSat;
          const sx = pos.x + lx * rc - ly * rs, sy = pos.y + lx * rs + ly * rc;
          if (tStep === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        }
        ctx.strokeStyle = `rgba(${satRgb}, 0.44)`; ctx.lineWidth = 1.05; ctx.stroke();

        const lx0 = Math.cos(sAng) * satOrbit, ly0 = Math.sin(sAng) * satOrbit * tiltSat;
        const sx0 = pos.x + lx0 * rc - ly0 * rs, sy0 = pos.y + lx0 * rs + ly0 * rc;
        const glow = ctx.createRadialGradient(sx0, sy0, 0, sx0, sy0, 7.5);
        glow.addColorStop(0, `rgba(${satRgb}, 0.98)`);
        glow.addColorStop(0.4, `rgba(${satRgb}, 0.35)`);
        glow.addColorStop(1, `rgba(${satRgb}, 0)`);
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(sx0, sy0, 7.5, 0, Math.PI * 2); ctx.fill();
      });
    });

    // Orbit Swap Ripples, Telemetry Beams & Drag Arc
    for (let i = st.orbitRipples.length - 1; i >= 0; i--) {
      const rp = st.orbitRipples[i];
      rp.t += 0.022;
      if (rp.t >= 1) { st.orbitRipples.splice(i, 1); continue; }
      const pos = st.planetScreen[rp.planetId];
      if (!pos) continue;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, pos.r * (1.1 + rp.t * 2.1), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rp.color}, ${(1 - rp.t) * 0.72})`; ctx.lineWidth = 1.6; ctx.stroke();
    }
    for (let i = st.telemetryBeams.length - 1; i >= 0; i--) {
      const bm = st.telemetryBeams[i];
      bm.t += 0.030;
      if (bm.t >= 1) { st.telemetryBeams.splice(i, 1); continue; }
      const pos = st.planetScreen[bm.planetId];
      if (!pos) continue;
      const p = bm.t, mx = (bm.x0 + pos.x) * 0.5, my = Math.min(bm.y0, pos.y) - 64;
      const qx = (1 - p) * (1 - p) * bm.x0 + 2 * (1 - p) * p * mx + p * p * pos.x;
      const qy = (1 - p) * (1 - p) * bm.y0 + 2 * (1 - p) * p * my + p * p * pos.y;
      ctx.beginPath(); ctx.moveTo(bm.x0, bm.y0); ctx.quadraticCurveTo(mx, my, pos.x, pos.y);
      ctx.strokeStyle = `rgba(124, 196, 255, ${(1 - p) * 0.30})`; ctx.lineWidth = 1.2; ctx.stroke();
      const pg = ctx.createRadialGradient(qx, qy, 0, qx, qy, 13);
      pg.addColorStop(0, 'rgba(220, 244, 255, 0.96)'); pg.addColorStop(1, 'rgba(124, 196, 255, 0)');
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(qx, qy, 13, 0, Math.PI * 2); ctx.fill();
    }
    if (st.drag && st.drag.active) {
      const fromPos = st.planetScreen[st.drag.fromPlanetId];
      if (fromPos) {
        const targetPos = st.drag.overPlanetId ? st.planetScreen[st.drag.overPlanetId] : { x: st.drag.currX, y: st.drag.currY };
        const isSwap = Boolean(st.drag.overPlanetId && agentsByPlanet[st.drag.overPlanetId]);
        const midX = (fromPos.x + targetPos.x) * 0.5, midY = (fromPos.y + targetPos.y) * 0.5 - 56;
        ctx.beginPath(); ctx.setLineDash([5, 5]); ctx.moveTo(fromPos.x, fromPos.y); ctx.quadraticCurveTo(midX, midY, targetPos.x, targetPos.y);
        ctx.strokeStyle = isSwap ? 'rgba(244, 194, 122, 0.85)' : 'rgba(124, 196, 255, 0.78)'; ctx.lineWidth = 1.65; ctx.stroke();
        if (isSwap) {
          ctx.beginPath(); ctx.moveTo(targetPos.x, targetPos.y); ctx.quadraticCurveTo(midX, (fromPos.y + targetPos.y) * 0.5 + 56, fromPos.x, fromPos.y);
          ctx.strokeStyle = 'rgba(124, 196, 255, 0.65)'; ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  if (drawEventFn) drawEventFn(ctx, w, h);

  if (galAlpha > 0.06) {
    ctx.save();
    ctx.globalAlpha = galAlpha * 0.92;
    const gcx = w * 0.5 + st.parallax.x * 12, gcy = h * 0.5 + st.parallax.y * 8;
    const gRad = Math.min(w, h) * 0.52, gTilt = 0.54 + st.camRot.y * 0.16, spin = -st.realTime * 0.016 - st.time * 0.012;
    const t = st.realTime;

    (galaxyBooks || []).forEach((b, idx) => {
      if (!b) return;
      const rVal = typeof b.celestial?.r === 'number' ? b.celestial.r : (typeof b.r === 'number' ? b.r : 0.45);
      const thetaVal = typeof b.celestial?.theta === 'number' ? b.celestial.theta : (typeof b.theta === 'number' ? b.theta : idx * 1.1);
      const ang = thetaVal + spin;
      const bx = gcx + Math.cos(ang) * rVal * gRad;
      const by = gcy + Math.sin(ang) * rVal * gRad * gTilt;

      const kind = b.kind || 'book';
      const status = b.status || 'active';
      const unitCount = Math.max(0, Number(b.unitCount ?? b.readableUnitCount ?? 0));
      const sourceCount = Math.min(4, Math.max(0, Number(b.sourceCount ?? 0)));
      const sizeBoost = Math.min(4.8, Math.sqrt(unitCount) * 0.85);
      const twinkle = 0.88 + 0.12 * Math.sin(t * 2.1 + thetaVal * 3.0);

      if (kind === 'deck') {
        // Ice-cyan ringed star: luminous core + tilted concentric ellipses
        const coreR = (3.8 + sizeBoost * 0.55) * twinkle;
        const glow = ctx.createRadialGradient(bx, by, 0, bx, by, coreR * 4.2);
        glow.addColorStop(0, 'rgba(235, 252, 255, 0.96)');
        glow.addColorStop(0.32, 'rgba(110, 211, 236, 0.52)');
        glow.addColorStop(1, 'rgba(110, 211, 236, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(bx, by, coreR * 4.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(-0.42 + Math.sin(t * 0.25 + thetaVal) * 0.08);
        ctx.strokeStyle = 'rgba(148, 230, 250, 0.68)';
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.ellipse(0, 0, coreR * 2.6, coreR * 0.88, 0, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(196, 244, 255, 0.36)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.ellipse(0, 0, coreR * 3.55, coreR * 1.2, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = '#e8fbff';
        ctx.beginPath();
        ctx.arc(bx, by, coreR * 0.72, 0, Math.PI * 2);
        ctx.fill();
      } else if (kind === 'gallery') {
        // Aurora violet/rose luminous nebula cluster (multi-lobe nebula + 3-4 sparkling nuclei)
        const baseR = 9.5 + sizeBoost * 1.2;
        const lobes = [
          { dx: -baseR * 0.42, dy: -baseR * 0.22, r: baseR * 1.45, c0: 'rgba(218, 134, 245, 0.44)', c1: 'rgba(218, 134, 245, 0)' },
          { dx: baseR * 0.45, dy: baseR * 0.20, r: baseR * 1.35, c0: 'rgba(244, 138, 188, 0.38)', c1: 'rgba(244, 138, 188, 0)' },
          { dx: 0, dy: 0, r: baseR * 1.2, c0: 'rgba(255, 224, 248, 0.46)', c1: 'rgba(190, 128, 255, 0)' },
        ];
        for (const l of lobes) {
          const g = ctx.createRadialGradient(bx + l.dx, by + l.dy, 0, bx + l.dx, by + l.dy, l.r);
          g.addColorStop(0, l.c0);
          g.addColorStop(1, l.c1);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(bx + l.dx, by + l.dy, l.r, 0, Math.PI * 2);
          ctx.fill();
        }
        const nuclei = [
          [0, 0, 2.2],
          [-baseR * 0.48, -baseR * 0.28, 1.5],
          [baseR * 0.52, baseR * 0.18, 1.45],
          [baseR * 0.14, -baseR * 0.46, 1.25],
        ];
        nuclei.forEach(([nx, ny, nr], k) => {
          const spark = 0.72 + 0.28 * Math.sin(t * 2.8 + thetaVal + k * 1.7);
          ctx.fillStyle = `rgba(255, 244, 255, ${spark})`;
          ctx.beginPath();
          ctx.arc(bx + nx, by + ny, nr, 0, Math.PI * 2);
          ctx.fill();
        });
      } else if (kind === 'video') {
        // Electric blue/cyan pulsar: core + slow rotating twin light beams + expanding pulse ring
        const coreR = (3.8 + sizeBoost * 0.5) * twinkle;
        const beamAng = t * 0.55 + thetaVal;
        const beamLen = 17 + sizeBoost * 2.1;

        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(beamAng);
        const beamGrad = ctx.createLinearGradient(-beamLen, 0, beamLen, 0);
        beamGrad.addColorStop(0, 'rgba(92, 174, 255, 0)');
        beamGrad.addColorStop(0.35, 'rgba(130, 208, 255, 0.45)');
        beamGrad.addColorStop(0.5, 'rgba(235, 250, 255, 0.92)');
        beamGrad.addColorStop(0.65, 'rgba(130, 208, 255, 0.45)');
        beamGrad.addColorStop(1, 'rgba(92, 174, 255, 0)');
        ctx.fillStyle = beamGrad;
        ctx.beginPath();
        ctx.moveTo(0, -1.5);
        ctx.lineTo(beamLen, -3.4);
        ctx.lineTo(beamLen, 3.4);
        ctx.lineTo(0, 1.5);
        ctx.lineTo(-beamLen, 3.4);
        ctx.lineTo(-beamLen, -3.4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Expanding subtle pulse ring
        const pulsePhase = (t * 0.42 + thetaVal * 0.37) % 1;
        const pulseR = coreR * 1.4 + pulsePhase * (15 + sizeBoost);
        ctx.strokeStyle = `rgba(116, 198, 255, ${(1 - pulsePhase) * 0.42})`;
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.arc(bx, by, pulseR, 0, Math.PI * 2);
        ctx.stroke();

        const glow = ctx.createRadialGradient(bx, by, 0, bx, by, coreR * 3.8);
        glow.addColorStop(0, 'rgba(240, 250, 255, 0.98)');
        glow.addColorStop(0.35, 'rgba(96, 170, 255, 0.62)');
        glow.addColorStop(1, 'rgba(96, 170, 255, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(bx, by, coreR * 3.8, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Book (default): warm amber/gold main-sequence star + 4-point subtle diffraction spikes
        const coreR = (4.0 + sizeBoost * 0.6) * twinkle;
        const glow = ctx.createRadialGradient(bx, by, 0, bx, by, coreR * 4.4);
        glow.addColorStop(0, 'rgba(255, 250, 232, 0.98)');
        glow.addColorStop(0.30, 'rgba(246, 192, 98, 0.62)');
        glow.addColorStop(0.68, 'rgba(226, 148, 48, 0.18)');
        glow.addColorStop(1, 'rgba(226, 148, 48, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(bx, by, coreR * 4.4, 0, Math.PI * 2);
        ctx.fill();

        const spikeLen = coreR * 3.4;
        ctx.strokeStyle = 'rgba(255, 232, 180, 0.56)';
        ctx.lineWidth = 0.95;
        ctx.beginPath();
        ctx.moveTo(bx - spikeLen, by);
        ctx.lineTo(bx + spikeLen, by);
        ctx.moveTo(bx, by - spikeLen);
        ctx.lineTo(bx, by + spikeLen);
        ctx.stroke();

        ctx.fillStyle = b.color || '#ffe9b8';
        ctx.beginPath();
        ctx.arc(bx, by, coreR * 0.72, 0, Math.PI * 2);
        ctx.fill();
      }

      // Status overlays: generating, needs_attention, seed
      if (b.activeRunStatus === 'running' || status === 'generating') {
        const ringR = 14 + sizeBoost * 0.8;
        const collapseR = ringR + (1 - ((t * 0.6 + idx * 0.23) % 1)) * 7;
        ctx.strokeStyle = 'rgba(255, 196, 102, 0.34)';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.arc(bx, by, collapseR, 0, Math.PI * 2);
        ctx.stroke();

        const progress = Math.max(0.08, Math.min(1, Number(b.activeRunProgress ?? 0.35)));
        const startA = -Math.PI * 0.5 + t * 0.45;
        ctx.strokeStyle = 'rgba(255, 206, 118, 0.90)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(bx, by, ringR, startA, startA + Math.PI * 2 * progress);
        ctx.stroke();
      } else if (status === 'needs_attention') {
        const pulse = 0.35 + 0.35 * Math.sin(t * 1.9 + idx);
        const attnR = 13.5 + sizeBoost * 0.7;
        ctx.strokeStyle = `rgba(255, 126, 136, ${pulse})`;
        ctx.lineWidth = 1.45;
        ctx.beginPath();
        ctx.arc(bx, by, attnR, 0, Math.PI * 2);
        ctx.stroke();
      } else if (status === 'seed') {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(196, 224, 255, 0.42)';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(bx, by, 11.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Orbiting tiny satellite dots proportional to sourceCount (up to 4)
      for (let sIdx = 0; sIdx < sourceCount; sIdx++) {
        const satOrbit = 11.5 + sizeBoost * 0.7 + sIdx * 2.4;
        const satAng = t * (0.45 + sIdx * 0.14) + thetaVal + sIdx * ((Math.PI * 2) / Math.max(sourceCount, 1));
        const sx = bx + Math.cos(satAng) * satOrbit;
        const sy = by + Math.sin(satAng) * satOrbit * 0.68;
        ctx.fillStyle = 'rgba(216, 236, 255, 0.82)';
        ctx.beginPath();
        ctx.arc(sx, sy, 1.45, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.restore();
  }

  if (webAlpha > 0.04 && webGraph) {
    ctx.save();
    ctx.globalAlpha = webAlpha;
    const rotY = Math.sin(st.realTime * 0.07) * 0.14 + st.camRot.x * 0.35 + st.parallax.x * 0.08;
    const rotX = Math.cos(st.realTime * 0.055) * 0.08 + st.camRot.y * 0.28 + st.parallax.y * 0.06;
    const cY = Math.cos(rotY), sY = Math.sin(rotY), cX = Math.cos(rotX), sX = Math.sin(rotX);
    const proj = new Array(webGraph.nodes.length);

    for (let i = 0; i < webGraph.nodes.length; i++) {
      const n = webGraph.nodes[i];
      const x1 = n.x * cY - n.z * sY, z1 = n.x * sY + n.z * cY;
      const y2 = n.y * cX - z1 * sX, z2 = n.y * sX + z1 * cX;
      const persp = 1.0 / (1.0 - z2 * 0.34);
      const sx = w * 0.5 + x1 * w * 0.56 * persp, sy = h * 0.5 + y2 * h * 0.72 * persp;
      proj[i] = { x: sx, y: sy, z: z2, persp };
      const md = Math.hypot(sx - st.mouseX, sy - st.mouseY);
      if (md < 180) n.excite = Math.min(1.0, n.excite + (1.0 - md / 180) * 0.08);
      n.excite *= 0.965;
    }
    for (let i = 0; i < webGraph.edges.length; i++) {
      const e = webGraph.edges[i], pa = proj[e.a], pb = proj[e.b];
      const mx = (pa.x + pb.x) * 0.5 - (pb.y - pa.y) * e.curve, my = (pa.y + pb.y) * 0.5 + (pb.x - pa.x) * e.curve;
      const depthA = Math.max(0.18, Math.min(1.0, 0.58 + (pa.z + pb.z) * 0.35));
      const exB = Math.max(webGraph.nodes[e.a].excite, webGraph.nodes[e.b].excite) * 0.42;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.quadraticCurveTo(mx, my, pb.x, pb.y);
      ctx.strokeStyle = `rgba(156, 198, 255, ${(0.085 + e.weight * 0.085 + exB) * depthA})`;
      ctx.lineWidth = (0.65 + e.weight * 0.55 + exB * 1.1) * ((pa.persp + pb.persp) * 0.5); ctx.stroke();
    }
    for (let i = 0; i < webGraph.pulses.length; i++) {
      const pl = webGraph.pulses[i];
      pl.t += pl.speed * 0.016 * pl.dir;
      const e = webGraph.edges[pl.edgeIdx];
      if (!e) continue;
      if (pl.t >= 1.0 || pl.t <= 0.0) {
        const node = webGraph.nodes[pl.t >= 1.0 ? e.b : e.a];
        node.excite = Math.min(1.0, node.excite + 0.72);
        if (node.neighbors.length) {
          const next = node.neighbors[Math.floor(Math.random() * node.neighbors.length)];
          pl.edgeIdx = next.edgeIdx; pl.dir = next.dir; pl.t = next.dir > 0 ? 0.0 : 1.0;
        } else {
          pl.dir *= -1; pl.t = Math.max(0.01, Math.min(0.99, pl.t));
        }
      }
      const ce = webGraph.edges[pl.edgeIdx], pa = proj[ce.a], pb = proj[ce.b];
      const mx = (pa.x + pb.x) * 0.5 - (pb.y - pa.y) * ce.curve, my = (pa.y + pb.y) * 0.5 + (pb.x - pa.x) * ce.curve;
      const evalQ = (t) => { const mt = 1 - t; return [mt * mt * pa.x + 2 * mt * t * mx + t * t * pb.x, mt * mt * pa.y + 2 * mt * t * my + t * t * pb.y]; };
      const [hx, hy] = evalQ(pl.t), [tx, ty] = evalQ(Math.max(0, Math.min(1, pl.t - pl.dir * 0.16)));
      const [r, g, b] = pl.col;
      const grad = ctx.createLinearGradient(hx, hy, tx, ty);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${0.88 * pl.life})`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.strokeStyle = grad; ctx.lineWidth = 1.65; ctx.lineCap = 'round'; ctx.stroke();
      const dotG = ctx.createRadialGradient(hx, hy, 0, hx, hy, 6.2);
      dotG.addColorStop(0, `rgba(255, 255, 255, ${0.92 * pl.life})`);
      dotG.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = dotG; ctx.beginPath(); ctx.arc(hx, hy, 6.2, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < webGraph.nodes.length; i++) {
      const n = webGraph.nodes[i], p = proj[i];
      const pulse = 0.78 + 0.22 * Math.sin(st.realTime * 1.4 + n.phase) + n.excite * 0.75;
      const rad = (n.isHub ? 5.6 : 2.2) * n.baseR * p.persp * (1 + n.excite * 0.45);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 3.4);
      g.addColorStop(0, `rgba(255, 255, 255, ${Math.min(1, 0.85 * pulse)})`);
      g.addColorStop(0.28, n.color.replace(', 1)', `, ${Math.min(0.85, 0.48 * pulse)})`));
      g.addColorStop(1, 'rgba(130, 180, 255, 0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, rad * 3.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}
