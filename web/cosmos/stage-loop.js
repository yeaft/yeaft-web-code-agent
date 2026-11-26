/**
 * Yeaft Cosmos — Zero-VDOM-Churn 60fps Stage Loop
 *
 * Drives WebGL + 2D HUD rendering and directly updates DOM spatial node transforms via refs
 * so 60fps orbital animation incurs zero Vue re-renders.
 */
import { PLANETS, scaleBand } from './constants.js';
import { fillGpuParticles, drawCosmosHud } from './particle-hud.js';
import {
  tickCosmicEvents,
  getEventScreenPosition,
  getEventShockWave,
} from './events-controller.js';
import { drawCosmicEventCanvas } from './events-renderer.js';

export function stepCosmosFrame(now, ctx) {
  const {
    engine, anim, eventSim, pools, webGraph, gpuParticles,
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

  tickCosmicEvents(eventSim, dt * motionMul, {
    showCountdown: constants.showEventsCountdown && ui.currentBand === 'solar',
    autoEnabled: constants.eventsAutoEnabled,
  });

  if (now - anim.lastEventUiSync >= 240) {
    anim.lastEventUiSync = now;
    onSyncEvents();
  }

  const prevScale = anim.scaleLog;
  anim.scaleLog += (anim.targetScaleLog - anim.scaleLog) * Math.min(1, dt * 6.4);
  anim.warpEnergy = Math.max(
    anim.warpEnergy * Math.exp(-dt * 4.5),
    Math.min(1.0, (Math.abs(anim.scaleLog - prevScale) / Math.max(dt, 0.001)) * 0.11),
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

  const observing = Boolean(eventSim.active?.observing);
  const obsDim = observing ? 0.14 : 1.0;

  const solarAlpha = (s >= 10.2 && s <= 16.8 ? Math.min(1, Math.min((s - 10.2) / 1.4, (16.8 - s) / 1.8)) : 0) * obsDim;
  const galFullAlpha = s >= 17.6 && s <= 23.0 ? Math.min(1, Math.min((s - 17.6) / 1.5, (23.0 - s) / 1.3)) : 0;
  const webFullAlpha = s >= 22.0 ? Math.min(1, (s - 22.0) / 1.2) : 0;
  const bhFullStrength = s <= 10.6 ? Math.min(1, (10.6 - s) / 1.8) : 0;

  const solarZoom = Math.pow(1.42, 13.0 - s) * panelScaleFactor;
  const cx = w * 0.50 + anim.centerShiftX + anim.parallax.x * 14;
  const cy = h * 0.51 + anim.parallax.y * 10;
  const span = Math.max(w * 0.56, h * 0.88) * solarZoom;
  const tilt = Math.max(0.24, Math.min(0.68, 0.40 + anim.camRot.y * 0.34 + anim.parallax.y * 0.03));
  const yawCos = Math.cos(anim.camRot.x * 0.38);
  const yawSin = Math.sin(anim.camRot.x * 0.38);
  const sunRadius = Math.max(18, Math.min(w, h) * 0.068 * solarZoom);
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
      const ux = Math.cos(ang) * p.orbitR, uz = Math.sin(ang) * p.orbitR;
      const rx = ux * yawCos - uz * yawSin, rz = ux * yawSin + uz * yawCos;
      const persp = 1.0 / (1.0 - rz * 0.26);
      const sx = cx + rx * span * persp, sy = cy + rz * span * tilt * persp;
      const rPx = Math.max(4.5, p.size * (Math.min(w, h) / 900) * persp * Math.min(1.55, solarZoom));

      const lx = -rx, ly = 0.24, lz = -rz * 0.62 + 0.54;
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
        nodeEl.style.display = observing ? 'none' : 'block';
        nodeEl.style.opacity = String(solarAlpha);
        nodeEl.style.transform = `translate(${sx}px, ${sy}px)`;
        nodeEl.style.zIndex = String(Math.round(50 + rz * 25));

        const hitEl = domRefs.hits[p.id];
        if (hitEl) {
          const hitD = Math.max(46, rPx * (p.bodyType === 6 ? 3.2 : 2.3));
          hitEl.style.width = `${hitD}px`;
          hitEl.style.height = `${hitD}px`;
        }
        const tagOffY = rPx * (p.bodyType === 6 ? 1.24 : 1.16) + 12;
        const tagEl = domRefs.tags[p.id];
        if (tagEl) tagEl.style.transform = `translate(-50%, ${tagOffY}px)`;

        const liveEl = domRefs.liveCards[p.id];
        if (liveEl) {
          const canShow = !observing && !ui.dragActive && (!ui.drawerOpen || sx < w - panelW - 115);
          liveEl.style.display = canShow ? 'flex' : 'none';
          if (canShow) {
            const clampX = sx < 120 ? 120 - sx : (sx > w - 125 ? w - 125 - sx : 0);
            liveEl.style.transform = `translate(calc(-50% + ${clampX}px), ${tagOffY + 27}px)`;
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

  // Deep-sky portals & non-solar spatial nodes
  const portalOpacity = observing ? 0 : solarAlpha;
  const galPortalX = 0.40 * aspect, galPortalY = -0.35;
  const webPortalX = -0.40 * aspect, webPortalY = -0.35;
  const bhPortalX = -0.39 * aspect, bhPortalY = 0.34;

  const galParams = galFullAlpha > 0.01
    ? { x: 0, y: 0, radius: 0.96 * Math.pow(1.18, 21.0 - s), alpha: galFullAlpha, tilt: 0.54 + anim.camRot.y * 0.16 }
    : { x: galPortalX, y: galPortalY, radius: 0.095, alpha: portalOpacity * 0.72, tilt: 0.52 };
  const webParams = webFullAlpha > 0.01
    ? { x: 0, y: 0, radius: 1.05, alpha: webFullAlpha }
    : { x: webPortalX, y: webPortalY, radius: 0.085, alpha: portalOpacity * 0.52 };
  const bhParams = bhFullStrength > 0.01
    ? { x: 0, y: 0, radius: 0.178 * Math.pow(1.14, 7.0 - s), strength: bhFullStrength }
    : { x: bhPortalX, y: bhPortalY, radius: 0.017, strength: portalOpacity * 0.92 };

  const toScreen = (nx, ny) => ({ x: (nx / aspect + 0.5) * w, y: (0.5 - ny) * h });
  const placePortal = (id, nx, ny, vis) => {
    const el = domRefs.portals[id];
    if (!el) return;
    if (vis < 0.08 || (ui.drawerOpen && nx > 0.15)) {
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
      homeEl.style.left = `${w * 0.27}px`;
      homeEl.style.top = `${h * 0.67}px`;
    } else if (webFullAlpha > 0.12) {
      homeEl.style.display = 'inline-flex';
      homeEl.style.opacity = String(webFullAlpha);
      homeEl.style.left = `${w * 0.50}px`;
      homeEl.style.top = `${h - 32}px`;
    } else {
      homeEl.style.display = 'none';
    }
  }

  const galaxyBooks = getGalaxyBooks();
  const gRad = Math.min(w, h) * 0.52, gTilt = 0.54 + anim.camRot.y * 0.16;
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
  const particleCount = fillGpuParticles(gpuParticles, pools, anim, {
    w, h, dpr, cx, cy, span, tilt, solarAlpha, galAlpha: galFullAlpha,
    bhStrength: bhParams.strength, bhCx: bhCenter.x, bhCy: bhCenter.y, bhRadiusPx: bhParams.radius * h,
  });

  engine.renderFrame({
    time: anim.time,
    realTime: anim.realTime,
    scaleLog: s,
    parallax: anim.parallax,
    camRot: anim.camRot,
    warp: anim.warpEnergy,
    fovZoom: eventSim.fovZoom,
    shockWave: getEventShockWave(eventSim, w, h, anim.centerShiftX),
    skyBright: constants.skyBright,
    starDensity: constants.starDensity,
    bhParams,
    galParams,
    webParams,
    particleData: gpuParticles,
    particleCount,
    solarBodies,
    solarAlpha,
    hudDraw: (c2d, cw, ch) => {
      drawCosmosHud(c2d, cw, ch, anim, webGraph, galaxyBooks, agentsByPlanet, {
        cx, cy, span, tilt, solarAlpha, galAlpha: galFullAlpha, webAlpha: webFullAlpha,
      }, (ec, ew, eh) => {
        if (!eventSim.active) return;
        const pos = getEventScreenPosition(eventSim, ew, eh, anim.centerShiftX);
        if (pos) drawCosmicEventCanvas(ec, ew, eh, eventSim.active, pos, anim.solarSunScreen);
      });
    },
  });
}
