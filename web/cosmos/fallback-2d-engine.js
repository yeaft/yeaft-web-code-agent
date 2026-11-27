/**
 * Yeaft Cosmos — High-Craft Canvas 2D Renderer (No-GPU / Software-GL / Eco Fallback)
 *
 * Uses the exact same real NASA/ESO/Hubble/JWST astronomical WebP textures loaded by
 * `texture-loader.js` with low-CPU 2D compositing, spherical spin slicing, directional
 * solar terminator shading, Saturn/Uranus 3D front/back rings, M51 galaxy, Cosmic Web,
 * and Gargantua black hole lensing — keeping Cosmos crisp and smooth without any GPU.
 */
import { requestCosmosTextureGroup, requestCosmosTextureTier, getLoadedCosmosImage } from './texture-loader.js';
import { drawCosmicEventCanvas } from './events-renderer.js';

function makeSeededStars(count = 240) {
  let s = 20261127;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const palette = [
    [164, 210, 255],
    [236, 245, 255],
    [255, 240, 214],
    [255, 210, 158],
    [255, 172, 126],
  ];
  const stars = [];
  for (let i = 0; i < count; i++) {
    const col = palette[Math.floor(rnd() * palette.length)];
    const mag = Math.pow(rnd(), 2.2);
    stars.push({
      x: rnd(),
      y: rnd(),
      depth: 0.25 + rnd() * 0.75,
      r: 0.55 + mag * 1.65,
      alpha: 0.28 + mag * 0.72,
      phase: rnd() * Math.PI * 2,
      speed: 0.8 + rnd() * 1.8,
      col,
      spike: mag > 0.78,
    });
  }
  return stars;
}

const FALLBACK_BODY_COLORS = {
  0: ['#fff6d6', '#ffaa3b', '#d94d12'],
  1: ['#c8c4be', '#7b7874', '#262423'],
  2: ['#f7dfae', '#cf9c52', '#4a3214'],
  3: ['#6cc4ff', '#2864a8', '#091830'],
  4: ['#e6885b', '#a8472a', '#2e1009'],
  5: ['#ebd6b8', '#b88b5f', '#362314'],
  6: ['#f0dfba', '#bda677', '#352a19'],
  7: ['#9ce8f2', '#5cb4c7', '#112c38'],
  8: ['#5c92ff', '#2a52b8', '#091438'],
};

function drawTiledEquirectTexture(ctx, img, cx, cy, rx, ry, spin) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return false;
  // Project a 180-degree visible hemisphere slice horizontally across the disc.
  const sliceW = iw * 0.5;
  const u = (((-spin / (Math.PI * 2)) % 1) + 1) % 1;
  const sx = u * iw;
  const dx = cx - rx;
  const dy = cy - ry;
  const dw = rx * 2;
  const dh = ry * 2;

  if (sx + sliceW <= iw) {
    ctx.drawImage(img, sx, 0, sliceW, ih, dx, dy, dw, dh);
  } else {
    const firstW = iw - sx;
    const secondW = sliceW - firstW;
    const firstDestW = dw * (firstW / sliceW);
    ctx.drawImage(img, sx, 0, firstW, ih, dx, dy, firstDestW + 0.5, dh);
    ctx.drawImage(img, 0, 0, secondW, ih, dx + firstDestW, dy, dw - firstDestW + 0.5, dh);
  }
  return true;
}

function drawPlanetaryRingHalf(ctx, b, front) {
  const isUranus = b.bodyType === 7;
  const r = b.radiusPx;
  const tiltAngle = isUranus ? 1.32 : -0.34;
  const squash = isUranus ? 0.30 : 0.36;
  const innerR = r * (isUranus ? 1.46 : 1.26);
  const outerR = r * (isUranus ? 1.88 : 2.38);

  ctx.save();
  ctx.translate(b.screenX, b.screenY);
  ctx.rotate(tiltAngle);
  ctx.scale(1, squash);

  const startA = front ? 0 : Math.PI;
  const endA = front ? Math.PI : Math.PI * 2;

  if (isUranus) {
    ctx.strokeStyle = 'rgba(170, 224, 245, 0.38)';
    ctx.lineWidth = Math.max(1.2, (outerR - innerR) * 0.16);
    ctx.beginPath();
    ctx.arc(0, 0, (innerR + outerR) * 0.52, startA, endA);
    ctx.stroke();
  } else {
    // Saturn multi-band Cassini rings (C, B, Cassini gap, A)
    const bands = [
      { f: 0.14, w: 0.20, col: 'rgba(176, 154, 122, 0.34)' },
      { f: 0.42, w: 0.30, col: 'rgba(232, 214, 178, 0.78)' },
      { f: 0.62, w: 0.08, col: 'rgba(22, 18, 14, 0.45)' }, // Cassini division
      { f: 0.82, w: 0.22, col: 'rgba(210, 192, 158, 0.62)' },
    ];
    const span = outerR - innerR;
    for (const band of bands) {
      ctx.strokeStyle = band.col;
      ctx.lineWidth = Math.max(1, span * band.w);
      ctx.beginPath();
      ctx.arc(0, 0, innerR + span * band.f, startA, endA);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawSun2D(ctx, b, realTime) {
  const { screenX: cx, screenY: cy, radiusPx: r } = b;
  const [ar, ag, ab] = b.atmo || [1.0, 0.72, 0.36];
  const sr = Math.min(255, Math.round(ar * 255));
  const sg = Math.min(255, Math.round(ag * 255));
  const sb = Math.min(255, Math.round(ab * 255));
  const coreR = Math.min(255, Math.round(255 * 0.52 + sr * 0.48));
  const coreG = Math.min(255, Math.round(255 * 0.52 + sg * 0.48));
  const coreB = Math.min(255, Math.round(255 * 0.52 + sb * 0.48));

  // Outer multi-stop flowing corona
  const coronaR = r * 3.45;
  const cg = ctx.createRadialGradient(cx, cy, r * 0.75, cx, cy, coronaR);
  cg.addColorStop(0, `rgba(${coreR}, ${coreG}, ${coreB}, 0.92)`);
  cg.addColorStop(0.28, `rgba(${sr}, ${sg}, ${sb}, 0.48)`);
  cg.addColorStop(0.56, `rgba(${Math.round(sr * 0.9)}, ${Math.round(sg * 0.68)}, ${Math.round(sb * 0.65)}, 0.16)`);
  cg.addColorStop(1, `rgba(${sr}, ${sg}, ${sb}, 0)`);
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(cx, cy, coronaR, 0, Math.PI * 2);
  ctx.fill();

  // Subtle horizontal anamorphic lens flare
  const flareW = r * 3.5;
  const fg = ctx.createLinearGradient(cx - flareW, cy, cx + flareW, cy);
  fg.addColorStop(0, `rgba(${coreR}, ${coreG}, ${coreB}, 0)`);
  fg.addColorStop(0.5, `rgba(${coreR}, ${coreG}, ${coreB}, 0.24)`);
  fg.addColorStop(1, `rgba(${coreR}, ${coreG}, ${coreB}, 0)`);
  ctx.fillStyle = fg;
  ctx.fillRect(cx - flareW, cy - Math.max(1.5, r * 0.08), flareW * 2, Math.max(3, r * 0.16));

  // Textured photosphere disc with limb darkening
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  const sunImg = getLoadedCosmosImage('sun');
  if (sunImg) {
    drawTiledEquirectTexture(ctx, sunImg, cx, cy, r, r, (b.spin || 0) + realTime * 0.015);
  } else {
    const pg = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    pg.addColorStop(0, `rgb(${coreR}, ${coreG}, ${coreB})`);
    pg.addColorStop(0.7, `rgb(${sr}, ${sg}, ${sb})`);
    pg.addColorStop(1, `rgb(${Math.round(sr * 0.65)}, ${Math.round(sg * 0.45)}, ${Math.round(sb * 0.35)})`);
    ctx.fillStyle = pg;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // Spectral tint & limb darkening
  const limb = ctx.createRadialGradient(cx, cy, r * 0.22, cx, cy, r);
  limb.addColorStop(0, `rgba(${coreR}, ${coreG}, ${coreB}, 0.34)`);
  limb.addColorStop(0.72, `rgba(${sr}, ${sg}, ${sb}, 0.26)`);
  limb.addColorStop(1, `rgba(${Math.round(sr * 0.6)}, ${Math.round(sg * 0.38)}, ${Math.round(sb * 0.32)}, 0.62)`);
  ctx.fillStyle = limb;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

function drawPlanet2D(ctx, b, realTime) {
  const { screenX: cx, screenY: cy, radiusPx: r, oblate = 1, bodyType, lightDir = [0.6, 0.2, 0.7] } = b;
  const rx = r;
  const ry = r * oblate;
  const hasRings = bodyType === 6 || bodyType === 7;
  const [ar, ag, ab] = b.atmo || [0.5, 0.7, 1.0];
  const atmoRgb = `${Math.round(ar * 255)}, ${Math.round(ag * 255)}, ${Math.round(ab * 255)}`;

  if (hasRings) drawPlanetaryRingHalf(ctx, b, false);

  // Exterior atmospheric halo & selection glow
  const haloMul = b.highlight > 0.05 ? 1.38 : 1.24;
  const haloAlpha = (bodyType === 3 ? 0.34 : 0.18) + (b.highlight || 0) * 0.28;
  const hg = ctx.createRadialGradient(cx, cy, r * 0.85, cx, cy, r * haloMul);
  hg.addColorStop(0, `rgba(${atmoRgb}, ${haloAlpha.toFixed(3)})`);
  hg.addColorStop(1, `rgba(${atmoRgb}, 0)`);
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(cx, cy, r * haloMul, 0, Math.PI * 2);
  ctx.fill();

  // Clipped oblate planetary disc
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();

  const img = getLoadedCosmosImage(b.texKey);
  if (img) {
    drawTiledEquirectTexture(ctx, img, cx, cy, rx, ry, b.spin || 0);
    if (bodyType === 3) {
      const clouds = getLoadedCosmosImage('earth_clouds');
      if (clouds) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.56;
        drawTiledEquirectTexture(ctx, clouds, cx, cy, rx, ry, (b.spin || 0) * 1.24 + realTime * 0.012 + 0.12);
        ctx.restore();
      }
    }
  } else {
    const pal = FALLBACK_BODY_COLORS[bodyType] || FALLBACK_BODY_COLORS[3];
    const g = ctx.createRadialGradient(
      cx + lightDir[0] * rx * 0.42,
      cy - lightDir[1] * ry * 0.42,
      r * 0.08,
      cx,
      cy,
      r * 1.15,
    );
    g.addColorStop(0, pal[0]);
    g.addColorStop(0.55, pal[1]);
    g.addColorStop(1, pal[2]);
    ctx.fillStyle = g;
    ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
  }

  // Physically motivated solar terminator & night hemisphere shading
  const sunOffX = cx + lightDir[0] * rx * 0.55;
  const sunOffY = cy - lightDir[1] * ry * 0.45;
  const shade = ctx.createRadialGradient(sunOffX, sunOffY, r * 0.16, cx - lightDir[0] * rx * 0.28, cy + lightDir[1] * ry * 0.2, r * 1.42);
  shade.addColorStop(0, 'rgba(255, 252, 245, 0.10)');
  shade.addColorStop(0.54, 'rgba(4, 8, 18, 0.04)');
  shade.addColorStop(0.84, 'rgba(3, 6, 15, 0.72)');
  shade.addColorStop(1, 'rgba(2, 4, 10, 0.90)');
  ctx.fillStyle = shade;
  ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);

  // Inner Fresnel atmospheric rim
  if (bodyType !== 1) {
    const rim = ctx.createRadialGradient(cx, cy, r * 0.68, cx, cy, r);
    rim.addColorStop(0, `rgba(${atmoRgb}, 0)`);
    rim.addColorStop(0.86, `rgba(${atmoRgb}, ${bodyType === 3 ? 0.24 : 0.12})`);
    rim.addColorStop(1, `rgba(${atmoRgb}, ${bodyType === 3 ? 0.58 : 0.30})`);
    ctx.fillStyle = rim;
    ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
  }
  ctx.restore();

  if (hasRings) drawPlanetaryRingHalf(ctx, b, true);
}

function drawBlackHole2D(ctx, cx, cy, rs, strength, realTime) {
  if (strength <= 0.005 || rs < 1.5) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, strength);
  ctx.translate(cx, cy);
  ctx.rotate(-0.15 + Math.sin(realTime * 0.14) * 0.015);

  // Upper & lower gravitationally lensed halo arches
  const archR = rs * 2.55;
  const ag = ctx.createRadialGradient(0, 0, rs * 0.92, 0, 0, archR);
  ag.addColorStop(0, 'rgba(255, 232, 186, 0.85)');
  ag.addColorStop(0.24, 'rgba(255, 166, 68, 0.52)');
  ag.addColorStop(0.62, 'rgba(196, 68, 18, 0.18)');
  ag.addColorStop(1, 'rgba(140, 36, 8, 0)');
  ctx.fillStyle = ag;
  ctx.beginPath();
  ctx.arc(0, 0, archR, 0, Math.PI * 2);
  ctx.fill();

  // Back equatorial Doppler accretion disk
  ctx.save();
  ctx.scale(1, 0.18);
  const diskOuter = rs * 5.6;
  const dg = ctx.createRadialGradient(-rs * 0.75, 0, rs * 0.9, 0, 0, diskOuter);
  dg.addColorStop(0, 'rgba(255, 248, 226, 0.95)');
  dg.addColorStop(0.26, 'rgba(255, 182, 84, 0.80)');
  dg.addColorStop(0.62, 'rgba(204, 72, 22, 0.38)');
  dg.addColorStop(1, 'rgba(120, 28, 6, 0)');
  ctx.fillStyle = dg;
  ctx.beginPath();
  ctx.arc(0, 0, diskOuter, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Pure black Event Horizon shadow
  ctx.fillStyle = '#010205';
  ctx.beginPath();
  ctx.arc(0, 0, rs, 0, Math.PI * 2);
  ctx.fill();

  // Razor-bright Photon Ring
  ctx.strokeStyle = 'rgba(255, 236, 196, 0.90)';
  ctx.lineWidth = Math.max(1.2, rs * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, rs * 1.03, 0, Math.PI * 2);
  ctx.stroke();

  // Front accretion ribbon crossing smoothly in front of the black hole shadow (layered feathered plasma)
  ctx.save();
  ctx.scale(1, 0.175);
  ctx.globalCompositeOperation = 'screen';
  const layers = [
    { rad: 2.35, width: 1.55, alpha: 0.34 },
    { rad: 2.08, width: 0.85, alpha: 0.62 },
    { rad: 1.88, width: 0.34, alpha: 0.90 },
  ];
  for (const l of layers) {
    const fg = ctx.createLinearGradient(-rs * 4.4, 0, rs * 4.4, 0);
    fg.addColorStop(0, 'rgba(180, 74, 24, 0)');
    fg.addColorStop(0.24, `rgba(255, 246, 224, ${l.alpha})`);
    fg.addColorStop(0.48, `rgba(255, 206, 126, ${(l.alpha * 0.92).toFixed(2)})`);
    fg.addColorStop(0.76, `rgba(218, 92, 28, ${(l.alpha * 0.52).toFixed(2)})`);
    fg.addColorStop(1, 'rgba(150, 40, 10, 0)');
    ctx.strokeStyle = fg;
    ctx.lineWidth = Math.max(1.4, rs * l.width);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, rs * l.rad, 0.08, Math.PI - 0.08);
    ctx.stroke();
  }
  ctx.restore();

  ctx.restore();
}

/**
 * High-Craft Canvas 2D Cosmos Renderer.
 * Drop-in compatible with `createCosmosEngine`'s interface.
 */
export function createFallback2DEngine(glCanvas, hudCanvas, opts = {}) {
  let bgCtx = null;
  try { bgCtx = glCanvas.getContext('2d'); } catch { bgCtx = null; }
  const ctx2d = hudCanvas.getContext('2d');
  // If glCanvas was already bound to a failed WebGL context, fall back to drawing
  // the 2D universe directly onto hudCanvas beneath the HUD overlay.
  const sharedSingleCanvas = !bgCtx && Boolean(ctx2d);
  const drawCtx = bgCtx || ctx2d;
  const isMobile = Boolean(opts.isMobile);
  const stars = makeSeededStars(isMobile ? 160 : 250);

  let width = 1;
  let height = 1;
  let dpr = 1;
  let bgDpr = 1;
  let destroyed = false;

  const loadedGroups = new Set();
  const loadedTiers = new Set();
  const unsubs = [];
  const stageTimers = [];
  let idleHandle = 0;

  function requestGroup(group) {
    if (destroyed || loadedGroups.has(group)) return;
    loadedGroups.add(group);
    unsubs.push(requestCosmosTextureGroup(group, null));
  }

  function requestTier(tier) {
    if (destroyed || loadedTiers.has(tier)) return;
    loadedTiers.add(tier);
    unsubs.push(requestCosmosTextureTier(tier, null));
  }

  requestTier(0);
  stageTimers.push(setTimeout(() => { if (!destroyed) requestTier(1); }, 140));
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    idleHandle = window.requestIdleCallback(() => {
      idleHandle = 0;
      if (!destroyed) requestTier(2);
    }, { timeout: 700 });
  } else {
    stageTimers.push(setTimeout(() => { if (!destroyed) requestTier(2); }, 450));
  }

  function ensureScaleTextures(scaleLog) {
    if (scaleLog > 16.0) requestGroup('galaxy');
    if (scaleLog > 20.0) requestGroup('web');
  }

  function resize() {
    if (destroyed) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    bgDpr = Math.min(dpr, isMobile ? 1.25 : 1.5);
    width = Math.max(glCanvas.clientWidth || window.innerWidth || 1, 1);
    height = Math.max(glCanvas.clientHeight || window.innerHeight || 1, 1);
    glCanvas.width = Math.max(1, Math.round(width * bgDpr));
    glCanvas.height = Math.max(1, Math.round(height * bgDpr));
    hudCanvas.width = Math.max(1, Math.round(width * dpr));
    hudCanvas.height = Math.max(1, Math.round(height * dpr));
    if (bgCtx) bgCtx.setTransform(bgDpr, 0, 0, bgDpr, 0, 0);
    if (ctx2d) ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resize();
  window.addEventListener('resize', resize);

  function toScreen(nx, ny) {
    const aspect = width / Math.max(height, 1);
    return {
      x: (nx / aspect + 0.5) * width,
      y: (0.5 - ny) * height,
    };
  }

  function renderFrame(frameState) {
    if (destroyed) return;
    if (drawCtx) {
      const {
        time = 0,
        realTime = 0,
        scaleLog = 13,
        parallax = { x: 0, y: 0 },
        camRot = { x: 0, y: 0 },
        warp = 0,
        fovZoom = 1.0,
        skyTint = [1.0, 1.0, 1.0],
        soarVec = [0.0, 0.0, 0.0],
        skyBright = 1.05,
        starDensity = 1.18,
        bhParams = { x: 0, y: 0, radius: 0, strength: 0 },
        galParams = { x: 0, y: 0, radius: 0, alpha: 0, tilt: 0.54 },
        webParams = { x: 0, y: 0, radius: 0, alpha: 0 },
        solarBodies = [],
        solarAlpha = 1,
        eventDraw = null,
        eventDraws = null,
        activeEvent = null,
      } = frameState || {};

      ensureScaleTextures(scaleLog);

      // 1. Deep void base
      drawCtx.fillStyle = '#03060f';
      drawCtx.fillRect(0, 0, width, height);

      // 2. Panoramic ESO Milky Way skybox tilted along galactic plane with seamless void fade
      const skyPresence = Math.max(0.28, 1.0 - Math.max(0, (scaleLog - 19.0) / 5.0) * 0.62);
      const safeFovZoom = Math.max(0.75, Math.min(3.4, fovZoom || 1.0));
      const milkyImg = getLoadedCosmosImage('milky');
      if (milkyImg) {
        drawCtx.save();
        drawCtx.translate(width * 0.5, height * 0.5);
        if (safeFovZoom !== 1.0) {
          const skyScale = 1 + (safeFovZoom - 1) * 0.36;
          drawCtx.scale(skyScale, skyScale);
        }
        drawCtx.rotate(-0.34);
        drawCtx.globalAlpha = Math.min(0.88, 0.56 * skyBright * skyPresence);
        const diag = Math.hypot(width, height);
        const mwW = Math.max(diag * 1.35, height * 2.1);
        const mwH = mwW * 0.5;
        const shiftX = ((((camRot.x + (soarVec[0] || 0) * 0.8) * 160 + parallax.x * 26 + realTime * 2.4) % mwW) + mwW) % mwW;
        const shiftY = -mwH * 0.5 + (camRot.y + (soarVec[1] || 0) * 0.6) * 45 + parallax.y * 14;
        drawCtx.drawImage(milkyImg, -mwW * 0.5 - shiftX, shiftY, mwW, mwH);
        drawCtx.drawImage(milkyImg, mwW * 0.5 - shiftX, shiftY, mwW, mwH);
        drawCtx.restore();

        // Subtle per-star-system celestial nebula atmosphere tint
        if (Math.abs((skyTint[0] ?? 1) - 1) > 0.03 || Math.abs((skyTint[1] ?? 1) - 1) > 0.03 || Math.abs((skyTint[2] ?? 1) - 1) > 0.03) {
          drawCtx.save();
          drawCtx.globalCompositeOperation = 'screen';
          const tr = Math.min(255, Math.round(Math.max(0, (skyTint[0] || 1) - 0.55) * 160));
          const tg = Math.min(255, Math.round(Math.max(0, (skyTint[1] || 1) - 0.55) * 145));
          const tb = Math.min(255, Math.round(Math.max(0, (skyTint[2] || 1) - 0.55) * 185));
          const ng = drawCtx.createRadialGradient(width * 0.5, height * 0.48, 20, width * 0.5, height * 0.5, Math.max(width, height) * 0.72);
          ng.addColorStop(0, `rgba(${tr}, ${tg}, ${tb}, 0.24)`);
          ng.addColorStop(1, `rgba(${tr}, ${tg}, ${tb}, 0)`);
          drawCtx.fillStyle = ng;
          drawCtx.fillRect(0, 0, width, height);
          drawCtx.restore();
        }

        // Feather top/bottom galactic poles seamlessly into deep space void
        const vig = drawCtx.createRadialGradient(
          width * 0.5, height * 0.5, Math.min(width, height) * 0.22,
          width * 0.5, height * 0.5, Math.max(width, height) * 0.78,
        );
        vig.addColorStop(0, 'rgba(3, 6, 15, 0)');
        vig.addColorStop(1, 'rgba(2, 4, 10, 0.48)');
        drawCtx.fillStyle = vig;
        drawCtx.fillRect(0, 0, width, height);
      } else {
        const g = drawCtx.createRadialGradient(width * 0.5, height * 0.5, 20, width * 0.5, height * 0.5, Math.max(width, height) * 0.78);
        g.addColorStop(0, '#0a1630');
        g.addColorStop(0.55, '#050b1a');
        g.addColorStop(1, '#02040a');
        drawCtx.fillStyle = g;
        drawCtx.fillRect(0, 0, width, height);
      }

      // 3. Spectral Starfield with warp streaking
      const count = Math.min(stars.length, Math.round(stars.length * Math.min(1.4, Math.max(0.35, starDensity * 0.85))));
      const cx0 = width * 0.5;
      const cy0 = height * 0.5;
      const starZoom = 1 + (safeFovZoom - 1) * 0.42;
      const soarDepth = soarVec[2] || 0;
      const soarYawPx = (soarVec[0] || 0) * 85;
      const soarPitchPx = (soarVec[1] || 0) * 65;
      for (let i = 0; i < count; i++) {
        const st = stars[i];
        const zCycle = (st.depth + soarDepth * 0.14) % 1;
        const zScale = soarDepth > 0.001 ? (0.45 + zCycle * 1.45) : 1.0;
        const baseRawX = (((st.x * width + parallax.x * 28 * st.depth + (camRot.x * 95 + soarYawPx) * st.depth + realTime * 1.4 * st.depth) % width) + width) % width;
        const baseRawY = (((st.y * height + parallax.y * 22 * st.depth + (camRot.y * 70 + soarPitchPx) * st.depth) % height) + height) % height;
        const sx = cx0 + (baseRawX - cx0) * starZoom * zScale;
        const sy = cy0 + (baseRawY - cy0) * starZoom * zScale;
        if (sx < -24 || sx > width + 24 || sy < -24 || sy > height + 24) continue;
        const tw = 0.82 + 0.18 * Math.sin(realTime * st.speed + st.phase);
        const alpha = st.alpha * tw;
        const [cr, cg, cb] = st.col;

        if (warp > 0.08) {
          const dx = sx - cx0;
          const dy = sy - cy0;
          const len = Math.min(48, warp * 28 * st.depth);
          const d = Math.hypot(dx, dy) || 1;
          drawCtx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${(alpha * 0.85).toFixed(3)})`;
          drawCtx.lineWidth = Math.max(0.8, st.r * 0.85);
          drawCtx.beginPath();
          drawCtx.moveTo(sx, sy);
          drawCtx.lineTo(sx + (dx / d) * len, sy + (dy / d) * len);
          drawCtx.stroke();
        } else {
          drawCtx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha.toFixed(3)})`;
          drawCtx.beginPath();
          drawCtx.arc(sx, sy, st.r, 0, Math.PI * 2);
          drawCtx.fill();
        }
      }

      // 4. Spiral Galaxy (10^21 m or portal preview)
      if (galParams.alpha > 0.01) {
        const gp = toScreen(galParams.x, galParams.y);
        const gr = galParams.radius * height;
        const m51 = getLoadedCosmosImage('galaxy');
        const gDisc = getLoadedCosmosImage('galaxy_disc');
        drawCtx.save();
        drawCtx.translate(gp.x, gp.y);
        drawCtx.rotate(-0.26);
        drawCtx.scale(1, Math.max(0.28, galParams.tilt || 0.54));
        drawCtx.rotate(-realTime * 0.016 - time * 0.012);
        // Elliptical clip prevents rectangular image edges from showing over the Milky Way in 2D Eco mode
        drawCtx.beginPath();
        drawCtx.arc(0, 0, gr * 0.94, 0, Math.PI * 2);
        drawCtx.clip();
        drawCtx.globalCompositeOperation = 'screen';
        if (m51) {
          drawCtx.globalAlpha = Math.min(1, galParams.alpha * 0.92);
          drawCtx.drawImage(m51, -gr * 1.15, -gr * 0.86, gr * 2.3, gr * 1.72);
        }
        if (gDisc) {
          drawCtx.globalAlpha = Math.min(1, galParams.alpha * 0.42);
          drawCtx.drawImage(gDisc, -gr * 1.05, -gr * 1.05, gr * 2.1, gr * 2.1);
        }
        const core = drawCtx.createRadialGradient(0, 0, 0, 0, 0, gr * 0.55);
        core.addColorStop(0, `rgba(255, 232, 186, ${(0.55 * galParams.alpha).toFixed(3)})`);
        core.addColorStop(0.5, `rgba(148, 188, 255, ${(0.20 * galParams.alpha).toFixed(3)})`);
        core.addColorStop(1, 'rgba(60, 90, 160, 0)');
        drawCtx.fillStyle = core;
        drawCtx.beginPath();
        drawCtx.arc(0, 0, gr * 0.55, 0, Math.PI * 2);
        drawCtx.fill();
        drawCtx.restore();
      }

      // 5. Cosmic Web (10^24 m or portal preview)
      if (webParams.alpha > 0.01) {
        const wp = toScreen(webParams.x, webParams.y);
        const wr = webParams.radius * Math.max(width, height) * 0.95;
        const webImg = getLoadedCosmosImage('web');
        drawCtx.save();
        if (webParams.radius < 0.5) {
          drawCtx.beginPath();
          drawCtx.arc(wp.x, wp.y, wr * 0.88, 0, Math.PI * 2);
          drawCtx.clip();
        }
        drawCtx.globalCompositeOperation = 'screen';
        if (webImg) {
          drawCtx.globalAlpha = Math.min(0.88, webParams.alpha * 0.72);
          drawCtx.drawImage(webImg, wp.x - wr, wp.y - wr, wr * 2, wr * 2);
          drawCtx.globalAlpha = Math.min(0.45, webParams.alpha * 0.36);
          drawCtx.translate(wp.x, wp.y);
          drawCtx.rotate(0.18 + Math.sin(realTime * 0.08) * 0.03);
          drawCtx.drawImage(webImg, -wr * 0.82, -wr * 0.82, wr * 1.64, wr * 1.64);
        } else {
          const wg = drawCtx.createRadialGradient(wp.x, wp.y, 10, wp.x, wp.y, wr * 0.65);
          wg.addColorStop(0, `rgba(130, 178, 255, ${(0.32 * webParams.alpha).toFixed(3)})`);
          wg.addColorStop(1, 'rgba(60, 80, 160, 0)');
          drawCtx.fillStyle = wg;
          drawCtx.beginPath();
          drawCtx.arc(wp.x, wp.y, wr * 0.65, 0, Math.PI * 2);
          drawCtx.fill();
        }
        drawCtx.restore();
      }

      // 6. Black Hole Horizon (10^7 m or portal preview)
      if (bhParams.strength > 0.01) {
        const bp = toScreen(bhParams.x, bhParams.y);
        drawBlackHole2D(drawCtx, bp.x, bp.y, bhParams.radius * height, bhParams.strength, realTime);
      }

      // 6b. Distant Deep-Sky Cosmic Events (drawn BEHIND foreground Solar planets for 3D depth)
      const allEvents = Array.isArray(eventDraws)
        ? eventDraws
        : (eventDraw ? [eventDraw] : []);
      const deepEvents = [];
      const localEvents = [];
      for (const ev of allEvents) {
        if (!ev || ev.alpha <= 0.002) continue;
        if (ev.layer === 'local') localEvents.push(ev);
        else deepEvents.push(ev);
      }

      let eventRenderedIn2D = false;
      for (const ev of deepEvents) {
        const inst = ev.instance || activeEvent;
        if (inst) {
          drawCosmicEventCanvas(drawCtx, width, height, inst, ev, ev.alpha);
          eventRenderedIn2D = true;
        }
      }

      // 7. Solar Bodies (depth-sorted Sun + 8 Planets + 3D Moons)
      if (solarAlpha > 0.01 && solarBodies.length) {
        drawCtx.save();
        drawCtx.globalAlpha = solarAlpha;
        const sorted = solarBodies.slice().sort((a, b) => a.camZ - b.camZ);
        for (const b of sorted) {
          if (b.bodyType === 0) drawSun2D(drawCtx, b, realTime);
          else if (b.bodyType === 9) {
            drawCtx.save();
            const r = Math.max(1.6, b.radiusPx);
            const g = drawCtx.createRadialGradient(
              b.screenX + (b.lightDir?.[0] || -0.5) * r * 0.35,
              b.screenY - (b.lightDir?.[1] || 0.25) * r * 0.35,
              r * 0.1,
              b.screenX, b.screenY, r,
            );
            const col = b.moonStyle === 1 ? '#e8c458' : (b.moonStyle === 2 ? '#d6e4f2' : (b.moonStyle === 3 ? '#e4a652' : '#bcc2cc'));
            g.addColorStop(0, col);
            g.addColorStop(0.75, col);
            g.addColorStop(1, 'rgba(18,22,30,0.92)');
            drawCtx.fillStyle = g;
            drawCtx.beginPath();
            drawCtx.arc(b.screenX, b.screenY, r, 0, Math.PI * 2);
            drawCtx.fill();
            drawCtx.restore();
          } else drawPlanet2D(drawCtx, b, realTime);
        }
        drawCtx.restore();
      }

      // 7b. Local / Focused Cosmic Events (drawn cleanly in front of planets)
      for (const ev of localEvents) {
        const inst = ev.instance || activeEvent;
        if (inst) {
          drawCosmicEventCanvas(drawCtx, width, height, inst, ev, ev.alpha);
          eventRenderedIn2D = true;
        }
      }

      if (ctx2d) {
        if (!sharedSingleCanvas) ctx2d.clearRect(0, 0, width, height);
        if (frameState?.hudDraw) frameState.hudDraw(ctx2d, width, height, { eventRenderedInGL: false, eventRenderedIn2D });
      }
      return;
    }

    if (ctx2d) {
      if (!sharedSingleCanvas) ctx2d.clearRect(0, 0, width, height);
      if (frameState?.hudDraw) frameState.hudDraw(ctx2d, width, height, { eventRenderedInGL: false, eventRenderedIn2D: false });
    }
  }

  return {
    mode: '2d',
    isWebGL: false,
    isSoftware: false,
    isMobile,
    renderFrame,
    resize,
    ensureScaleTextures,
    getSize: () => ({ width, height, dpr }),
    areTexturesReady: () => true,
    areRealTexturesReady: () => Boolean(getLoadedCosmosImage('earth_day') && getLoadedCosmosImage('milky')),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const id of stageTimers) clearTimeout(id);
      stageTimers.length = 0;
      if (idleHandle && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle);
        idleHandle = 0;
      }
      window.removeEventListener('resize', resize);
      for (const off of unsubs) off();
      unsubs.length = 0;
    },
  };
}
