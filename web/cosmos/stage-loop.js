/**
 * Yeaft Cosmos — Zero-VDOM-Churn Stage Loop with Responsive Portrait Mobile Projection
 *
 * Drives WebGL / High-Craft 2D + HUD rendering and directly updates DOM spatial node
 * transforms via refs so animation incurs zero Vue re-renders.
 */
import { PLANETS, scaleBand } from './constants.js';
import { fillGpuParticles, drawCosmosHud } from './particle-hud.js';
import {
  tickCosmicEvents,
  computeEventFrame,
  getEventLens,
  getEventAmbient,
  getEventShockWave,
  getSolarTelescopeTransform,
} from './events-controller.js';
import {
  fillEventGpuParticles,
  drawCosmicEventHud,
  drawCosmicEventCanvas,
} from './events-renderer.js';

/**
 * Pure aspect-aware Solar System layout calculator.
 * - Desktop / landscape: panoramic wide-field framing with dramatic perspective tilt.
 * - Portrait mobile (e.g. 390x844): keeps all 8 planet orbits comfortably inside viewport
 *   width while unfolding them vertically down the tall phone screen.
 */
export function computeSolarProjectionLayout(w, h, opts = {}) {
  const {
    solarZoom = 1,
    centerShiftX = 0,
    parallaxX = 0,
    parallaxY = 0,
    camRotY = 0,
  } = opts;

  const safeW = Math.max(w || 1, 1);
  const safeH = Math.max(h || 1, 1);
  const isPortrait = safeH > safeW * 1.08;
  const isCompact = safeW < 768 || Math.min(safeW, safeH) < 600;

  if (isPortrait) {
    // Fit Neptune (orbitR = 0.955) within ~88% of phone width so outer planets never clip offscreen.
    const span = Math.min(safeW * 0.44, safeH * 0.35) * solarZoom;
    const baseTilt = Math.max(0.62, Math.min(1.12, (safeH / safeW) * 0.46));
    const tilt = Math.max(0.48, Math.min(1.22, baseTilt + camRotY * 0.34 + parallaxY * 0.03));
    const cx = safeW * 0.50 + centerShiftX + parallaxX * 8;
    const cy = safeH * 0.48 + parallaxY * 8;
    const sunRadius = Math.max(17, Math.min(safeW * 0.068, 30) * solarZoom);
    const planetScale = (Math.max(Math.min(safeW, safeH), 510) / 900) * Math.min(1.42, solarZoom);
    return { isPortrait, isCompact, cx, cy, span, tilt, sunRadius, planetScale };
  }

  const cx = safeW * 0.50 + centerShiftX + parallaxX * 14;
  const cy = safeH * 0.51 + parallaxY * 10;
  const span = Math.max(safeW * 0.56, safeH * 0.88) * solarZoom;
  const tilt = Math.max(0.24, Math.min(0.68, 0.40 + camRotY * 0.34 + parallaxY * 0.03));
  const sunRadius = Math.max(18, Math.min(safeW, safeH) * 0.068 * solarZoom);
  const planetScale = (Math.min(safeW, safeH) / 900) * Math.min(1.55, solarZoom);
  return { isPortrait, isCompact, cx, cy, span, tilt, sunRadius, planetScale };
}

export function stepCosmosFrame(now, ctx) {
  const {
    engine, anim, eventSim, pools, webGraph, getWebGraph, gpuParticles, eventGpuParticles,
    constants, domRefs, getAgentsByPlanet, getGalaxyBooks,
    getUiState, onBandChange, onSyncEvents, onUpdateHoverPos,
  } = ctx;

  const dt = Math.min(0.05, Math.max(0.001, (now - anim.lastTs) / 1000));
  anim.lastTs = now;

  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionMul = reducedMotion ? 0.12 : 1.0;

  const ui = getUiState();
  const braking = Boolean(ui.hoverPlanetId || ui.dragActive || ui.drawerOpen);
  const targetBrake = braking ? 0.08 : 1.0;
  if (typeof anim.orbitBrake !== 'number') anim.orbitBrake = 1.0;
  anim.orbitBrake += (targetBrake - anim.orbitBrake) * Math.min(1, dt * 6.0);

  anim.realTime += dt * motionMul;
  anim.time += dt * constants.orbitSpeed * anim.orbitBrake * motionMul;
  anim.focusedPlanetId = ui.focusedPlanetId;

  const prevFocus = eventSim.focusProgress || 0;
  tickCosmicEvents(eventSim, dt * (reducedMotion ? 0.5 : 1.0), {
    showCountdown: constants.showEventsCountdown && ui.currentBand === 'solar',
    autoEnabled: constants.eventsAutoEnabled,
    autoZoom: constants.eventsAutoZoom === true,
    canAutoZoom: ui.currentBand === 'solar' && !ui.drawerOpen && !ui.quickOpen && !ui.dragActive,
    cameraDt: reducedMotion ? Math.max(dt * 8, 0.28) : dt,
  });

  if (now - anim.lastEventUiSync >= 240) {
    anim.lastEventUiSync = now;
    onSyncEvents();
  }

  const prevScale = anim.scaleLog;
  anim.scaleLog += (anim.targetScaleLog - anim.scaleLog) * Math.min(1, dt * 6.4);
  const focusVel = Math.abs((eventSim.focusProgress || 0) - prevFocus) / Math.max(dt, 0.001);
  anim.warpEnergy = Math.max(
    anim.warpEnergy * Math.exp(-dt * 4.5),
    Math.min(1.0, (Math.abs(anim.scaleLog - prevScale) / Math.max(dt, 0.001)) * 0.11),
    reducedMotion ? 0 : Math.min(0.62, focusVel * 0.24),
  );

  anim.parallax.x += (anim.parallax.tx - anim.parallax.x) * Math.min(1, dt * 4.2);
  anim.parallax.y += (anim.parallax.ty - anim.parallax.y) * Math.min(1, dt * 4.2);
  anim.camRot.x += (anim.camRot.tx - anim.camRot.x) * Math.min(1, dt * 5.2);
  anim.camRot.y += (anim.camRot.ty - anim.camRot.y) * Math.min(1, dt * 5.2);

  const { width: w, height: h, dpr } = engine.getSize();
  const aspect = w / Math.max(h, 1);

  const panelW = ui.workbenchWidened ? Math.min(760, w * 0.50) : Math.min(488, w * 0.34);
  anim.targetCenterShiftX = (ui.drawerOpen && w > 820) ? -panelW * 0.50 : 0;
  anim.centerShiftX += (anim.targetCenterShiftX - anim.centerShiftX) * Math.min(1, dt * 6.5);
  const panelScaleFactor = 1.0 - Math.min(1, Math.abs(anim.centerShiftX) / Math.max(panelW * 0.5, 1)) * 0.14;

  const s = anim.scaleLog;
  const band = scaleBand(s);
  if (ui.currentBand !== band) onBandChange(band);

  // Lazily prefetch Galaxy / Cosmic Web real textures as soon as user zooms near those scales.
  engine.ensureScaleTextures?.(Math.max(s, anim.targetScaleLog));

  const telescope = getSolarTelescopeTransform(eventSim, w, h);
  const observing = Boolean(eventSim.active?.observing);
  const telescopeHidden = observing || telescope.focus > 0.25;

  const baseSolarAlpha = s >= 10.2 && s <= 16.8 ? Math.min(1, Math.min((s - 10.2) / 1.4, (16.8 - s) / 1.8)) : 0;
  const solarAlpha = baseSolarAlpha * telescope.alphaMul;
  const galFullAlpha = s >= 17.6 && s <= 23.0 ? Math.min(1, Math.min((s - 17.6) / 1.5, (23.0 - s) / 1.3)) : 0;
  const webFullAlpha = s >= 22.0 ? Math.min(1, (s - 22.0) / 1.2) : 0;
  const bhFullStrength = s <= 10.6 ? Math.min(1, (10.6 - s) / 1.8) : 0;

  const solarZoom = Math.pow(1.42, 13.0 - s) * panelScaleFactor * telescope.zoomMul;
  const layout = computeSolarProjectionLayout(w, h, {
    solarZoom,
    centerShiftX: anim.centerShiftX,
    parallaxX: anim.parallax.x,
    parallaxY: anim.parallax.y,
    camRotY: anim.camRot.y,
  });
  const { isPortrait, isCompact, span, tilt, sunRadius, planetScale } = layout;
  const cx = layout.cx + telescope.offsetX;
  const cy = layout.cy + telescope.offsetY;

  const yawCos = Math.cos(anim.camRot.x * 0.38);
  const yawSin = Math.sin(anim.camRot.x * 0.38);
  anim.solarSunScreen = { x: cx, y: cy, r: sunRadius };

  const solarBodies = [];
  const agentsByPlanet = getAgentsByPlanet();

  if (solarAlpha > 0.004) {
    solarBodies.push({
      bodyType: 0, texKey: 'sun', screenX: cx, screenY: cy, radiusPx: sunRadius,
      camZ: 0, spin: anim.time * 0.075, tilt: 0.11, oblate: 1.0, lightDir: [0, 0, 1], atmo: [1, 0.72, 0.36], highlight: 0,
    });

    for (const p of PLANETS) {
      const ang = p.phase + anim.time * p.speed;
      const ux = Math.cos(ang) * p.orbitR;
      const uz = Math.sin(ang) * p.orbitR;
      const rx = ux * yawCos - uz * yawSin;
      const rz = ux * yawSin + uz * yawCos;
      const persp = 1.0 / (1.0 - rz * 0.26);
      const sx = cx + rx * span * persp;
      const sy = cy + rz * span * tilt * persp;
      const rPx = Math.max(isCompact ? 5.5 : 4.5, p.size * planetScale * persp);

      const lx = -rx;
      const ly = 0.24;
      const lz = -rz * 0.62 + 0.54;
      const lLen = Math.hypot(lx, ly, lz) || 1;
      const isHovered = anim.hoverPlanetId === p.id;
      const isSelected = ui.focusedPlanetId === p.id;
      const isDrop = ui.dragOverPlanetId === p.id;

      anim.planetScreen[p.id] = { x: sx, y: sy, r: rPx, z: rz };
      solarBodies.push({
        bodyType: p.bodyType, texKey: p.texKey, screenX: sx, screenY: sy, radiusPx: rPx, camZ: rz,
        spin: anim.realTime * p.spinRate + p.phase * 1.3, tilt: p.tilt, oblate: p.oblate,
        lightDir: [lx / lLen, ly / lLen, lz / lLen], atmo: p.atmo,
        highlight: isDrop ? 1.0 : (isSelected ? 0.84 : (isHovered ? 0.58 : 0)),
      });

      const nodeEl = domRefs.planets[p.id];
      if (nodeEl) {
        nodeEl.style.display = telescopeHidden ? 'none' : 'block';
        nodeEl.style.opacity = String(solarAlpha);
        nodeEl.style.transform = `translate(${sx}px, ${sy}px)`;
        nodeEl.style.zIndex = String(Math.round(50 + rz * 25));

        const hitEl = domRefs.hits[p.id];
        if (hitEl) {
          const hitD = Math.max(isCompact ? 48 : 46, rPx * (p.bodyType === 6 ? 3.2 : 2.3));
          hitEl.style.width = `${hitD}px`;
          hitEl.style.height = `${hitD}px`;
        }
        const tagOffY = rPx * (p.bodyType === 6 ? 1.24 : 1.16) + (isCompact ? 10 : 12);
        const tagEl = domRefs.tags[p.id];
        if (tagEl) {
          const tagClampX = isCompact
            ? (sx < 62 ? 62 - sx : (sx > w - 62 ? w - 62 - sx : 0))
            : 0;
          tagEl.style.transform = tagClampX !== 0
            ? `translate(calc(-50% + ${Math.round(tagClampX)}px), ${tagOffY}px)`
            : `translate(-50%, ${tagOffY}px)`;
        }

        const liveEl = domRefs.liveCards[p.id];
        if (liveEl) {
          const hideForQuickOnCompact = isCompact && Boolean(ui.quickOpen);
          const canShow = !telescopeHidden && !ui.dragActive && !hideForQuickOnCompact && (!ui.drawerOpen || sx < w - panelW - 115);
          liveEl.style.display = canShow ? 'flex' : 'none';
          if (canShow) {
            const halfCard = isCompact ? 92 : 120;
            const clampX = sx < halfCard ? halfCard - sx : (sx > w - halfCard ? w - halfCard - sx : 0);
            liveEl.style.transform = `translate(calc(-50% + ${Math.round(clampX)}px), ${tagOffY + 27}px)`;
          }
        }
      }
    }

    if (ui.hoverPlanetId) onUpdateHoverPos(ui.hoverPlanetId);
  } else {
    for (const p of PLANETS) {
      const nodeEl = domRefs.planets[p.id];
      if (nodeEl) nodeEl.style.display = 'none';
    }
  }

  // Deep-sky portals & non-solar spatial nodes (portrait-aware safe placement)
  const portalOpacity = telescopeHidden ? 0 : solarAlpha;
  const galPortalX = (isPortrait ? 0.29 : 0.40) * aspect;
  const galPortalY = isPortrait ? -0.35 : -0.35;
  const webPortalX = (isPortrait ? -0.29 : -0.40) * aspect;
  const webPortalY = isPortrait ? -0.35 : -0.35;
  const bhPortalX = (isPortrait ? -0.28 : -0.39) * aspect;
  const bhPortalY = isPortrait ? 0.34 : 0.34;

  const galParams = galFullAlpha > 0.01
    ? { x: 0, y: 0, radius: (isPortrait ? 0.62 : 0.96) * Math.pow(1.18, 21.0 - s), alpha: galFullAlpha, tilt: 0.54 + anim.camRot.y * 0.16 }
    : { x: galPortalX, y: galPortalY, radius: isPortrait ? 0.072 : 0.095, alpha: portalOpacity * 0.72, tilt: 0.52 };
  const webParams = webFullAlpha > 0.01
    ? { x: 0, y: 0, radius: 1.05, alpha: webFullAlpha }
    : { x: webPortalX, y: webPortalY, radius: isPortrait ? 0.068 : 0.085, alpha: portalOpacity * 0.52 };
  const bhParams = bhFullStrength > 0.01
    ? { x: 0, y: 0, radius: (isPortrait ? 0.125 : 0.178) * Math.pow(1.14, 7.0 - s), strength: bhFullStrength }
    : { x: bhPortalX, y: bhPortalY, radius: isPortrait ? 0.014 : 0.017, strength: portalOpacity * 0.92 };

  const toScreen = (nx, ny) => ({ x: (nx / aspect + 0.5) * w, y: (0.5 - ny) * h });
  const placePortal = (id, nx, ny, vis) => {
    const el = domRefs.portals[id];
    if (!el) return;
    const hideBottomForQuick = isCompact && Boolean(ui.quickOpen) && ny < 0;
    if (vis < 0.08 || hideBottomForQuick || (ui.drawerOpen && nx > 0.15)) {
      el.style.display = 'none';
      return;
    }
    const pt = toScreen(nx, ny);
    el.style.display = 'flex';
    el.style.opacity = String(vis);
    el.style.left = `${pt.x}px`;
    el.style.top = `${pt.y}px`;
  };
  placePortal('to-galaxy', galPortalX, galPortalY, portalOpacity);
  placePortal('to-web', webPortalX, webPortalY, portalOpacity);
  placePortal('to-horizon', bhPortalX, bhPortalY, portalOpacity);

  const homeEl = domRefs.homeBeacon.value;
  if (homeEl) {
    if (galFullAlpha > 0.12) {
      homeEl.style.display = 'inline-flex';
      homeEl.style.opacity = String(galFullAlpha);
      homeEl.style.left = `${w * (isPortrait ? 0.50 : 0.27)}px`;
      homeEl.style.top = `${h * (isPortrait ? 0.72 : 0.67)}px`;
    } else if (webFullAlpha > 0.12) {
      homeEl.style.display = 'inline-flex';
      homeEl.style.opacity = String(webFullAlpha);
      homeEl.style.left = `${w * 0.50}px`;
      homeEl.style.top = `${h - 36}px`;
    } else {
      homeEl.style.display = 'none';
    }
  }

  const galaxyBooks = getGalaxyBooks();
  const gRad = Math.min(w, h) * 0.52;
  const gTilt = 0.54 + anim.camRot.y * 0.16;
  const gSpin = -anim.realTime * 0.016 - anim.time * 0.012;
  for (const b of galaxyBooks) {
    const el = domRefs.books[b.id];
    if (!el) continue;
    if (galFullAlpha < 0.15) {
      el.style.display = 'none';
      continue;
    }
    const ang = b.theta + gSpin;
    el.style.display = 'inline-flex';
    el.style.opacity = String(galFullAlpha * 0.92);
    el.style.left = `${w * 0.5 + anim.parallax.x * 12 + Math.cos(ang) * b.r * gRad}px`;
    el.style.top = `${h * 0.5 + anim.parallax.y * 8 + Math.sin(ang) * b.r * gRad * gTilt - 18}px`;
  }

  const bhCenter = toScreen(bhParams.x, bhParams.y);
  const densityScale = !engine.isWebGL ? 0 : (engine.isMobile ? 0.55 : 1.0);
  const particleCount = fillGpuParticles(gpuParticles, pools, anim, {
    w, h, dpr, cx, cy, span, tilt, solarAlpha, galAlpha: galFullAlpha,
    bhStrength: bhParams.strength, bhCx: bhCenter.x, bhCy: bhCenter.y, bhRadiusPx: bhParams.radius * h,
    densityScale,
  });

  // Distant cosmic event spatial beacon & WebGL render frame descriptor
  const portalAvoidPoints = [
    toScreen(galPortalX, galPortalY),
    toScreen(webPortalX, webPortalY),
    toScreen(bhPortalX, bhPortalY),
  ];
  const eventVisibilityAlpha = baseSolarAlpha;
  const eventDraw = (eventSim.active && eventVisibilityAlpha > 0.01)
    ? computeEventFrame(
      eventSim,
      w,
      h,
      anim.centerShiftX,
      portalAvoidPoints,
      eventVisibilityAlpha,
      anim.camRot,
      anim.parallax,
    )
    : null;
  const eventParticleCount = (eventDraw && engine.isWebGL && eventGpuParticles)
    ? fillEventGpuParticles(eventGpuParticles, eventDraw, w, h, dpr, densityScale)
    : 0;
  const eventLens = eventDraw ? getEventLens(eventDraw, w, h) : [0, 0, 0, 0];
  const eventAmbient = eventDraw ? getEventAmbient(eventDraw) : [0, 0, 0, 0];

  const beaconEl = domRefs.eventBeacon?.value;
  if (beaconEl) {
    const showBeacon = Boolean(
      eventSim.active
      && eventDraw
      && eventVisibilityAlpha > 0.05
      && band === 'solar'
      && !observing
      && telescope.focus < 0.22
      && (!ui.drawerOpen || eventDraw.restX < w - panelW - 88)
      && !(isCompact && ui.quickOpen && eventDraw.restY > h * 0.62)
    );
    if (showBeacon) {
      const edgePadX = isCompact ? 115 : 150;
      const edgePadBottom = isCompact ? 130 : 110;
      const reticleSize = Math.round(Math.max(30, Math.min(72, eventDraw.eventRadiusPx * 1.1)));
      beaconEl.style.display = 'inline-flex';
      beaconEl.style.opacity = String(Math.max(0, Math.min(1, (1 - telescope.focus * 4.5) * eventVisibilityAlpha)));
      beaconEl.style.left = `${Math.round(eventDraw.restX)}px`;
      beaconEl.style.top = `${Math.round(eventDraw.restY)}px`;
      beaconEl.style.setProperty('--beacon-size', `${reticleSize}px`);
      beaconEl.classList.toggle('is-left-edge', eventDraw.restX < edgePadX);
      beaconEl.classList.toggle('is-right-edge', eventDraw.restX > w - edgePadX);
      beaconEl.classList.toggle('is-bottom-edge', eventDraw.restY > h - edgePadBottom);
    } else {
      beaconEl.style.display = 'none';
    }
  }

  const effectiveCamRot = {
    x: anim.camRot.x + (eventSim.camYawOffset || 0),
    y: anim.camRot.y + (eventSim.camPitchOffset || 0),
  };

  const activeWebGraph = webFullAlpha > 0.04 ? (webGraph || getWebGraph?.() || null) : null;

  engine.renderFrame({
    time: anim.time,
    realTime: anim.realTime,
    scaleLog: s,
    parallax: anim.parallax,
    camRot: effectiveCamRot,
    warp: anim.warpEnergy,
    fovZoom: eventSim.fovZoom,
    shockWave: eventVisibilityAlpha > 0.01
      ? getEventShockWave(eventSim, w, h, anim.centerShiftX, portalAvoidPoints, eventVisibilityAlpha, anim.camRot, anim.parallax)
      : [0, 0, 0, 0],
    eventLens,
    eventAmbient,
    skyBright: constants.skyBright,
    starDensity: constants.starDensity,
    bhParams,
    galParams,
    webParams,
    particleData: gpuParticles,
    particleCount,
    eventDraw,
    activeEvent: eventSim.active,
    eventParticleData: eventGpuParticles,
    eventParticleCount,
    solarBodies,
    solarAlpha,
    hudDraw: (c2d, cw, ch, renderInfo = {}) => {
      drawCosmosHud(c2d, cw, ch, anim, activeWebGraph, galaxyBooks, agentsByPlanet, {
        cx, cy, span, tilt, solarAlpha, galAlpha: galFullAlpha, webAlpha: webFullAlpha,
      }, (ec, ew, eh) => {
        if (!eventDraw || !eventSim.active) return;
        if (!renderInfo.eventRenderedInGL && !renderInfo.eventRenderedIn2D) {
          drawCosmicEventCanvas(ec, ew, eh, eventSim.active, eventDraw, eventDraw.alpha);
        }
        drawCosmicEventHud(ec, ew, eh, eventDraw, anim.centerShiftX);
      });
    },
  });
}
