/**
 * Yeaft Cosmos — Zero-VDOM-Churn Stage Loop with Planet Focus Lock, 3D Moons,
 * Keplerian Orbits, Solar Apex Motion & Shared-Canvas Multi-Event Rendering
 *
 * Drives WebGL / High-Craft 2D + HUD rendering and directly updates DOM spatial node
 * transforms via refs so animation incurs zero Vue re-renders.
 */
import { PLANETS, keplerPos, scaleBand } from './constants.js';
import {
  STAR_SYSTEMS,
  getActiveStarSystem,
  tickVoyageState,
  getVoyageSkyUniforms,
  projectSoarBeacons,
} from './star-systems.js';
import { fillGpuParticles, drawCosmosHud } from './particle-hud.js';
import {
  tickCosmicEvents,
  computeEventFrames,
  getEventLens,
  getEventAmbient,
  getEventShockWave,
  getSolarTelescopeTransform,
  getFlightWarpEnergy,
} from './events-controller.js';
import {
  fillEventGpuParticles,
  drawCosmicEventHud,
  drawCosmicEventCanvas,
} from './events-renderer.js';

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

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
    const span = Math.min(safeW * 0.44, safeH * 0.35) * solarZoom;
    const baseTilt = Math.max(0.62, Math.min(1.12, (safeH / safeW) * 0.46));
    const tilt = Math.max(0.48, Math.min(1.22, baseTilt + camRotY * 0.34 + parallaxY * 0.03));
    const cx = safeW * 0.50 + centerShiftX + parallaxX * 8;
    const cy = safeH * 0.48 + parallaxY * 8;
    const sunRadius = Math.max(17, Math.min(safeW * 0.068, 30) * solarZoom);
    const planetScale = (Math.max(Math.min(safeW, safeH), 510) / 900) * Math.min(28.0, solarZoom);
    return { isPortrait, isCompact, cx, cy, span, tilt, sunRadius, planetScale };
  }

  const cx = safeW * 0.50 + centerShiftX + parallaxX * 14;
  const cy = safeH * 0.51 + parallaxY * 10;
  const span = Math.max(safeW * 0.56, safeH * 0.88) * solarZoom;
  const tilt = Math.max(0.24, Math.min(0.68, 0.40 + camRotY * 0.34 + parallaxY * 0.03));
  const sunRadius = Math.max(18, Math.min(safeW, safeH) * 0.068 * solarZoom);
  const planetScale = (Math.min(safeW, safeH) / 900) * Math.min(28.0, solarZoom);
  return { isPortrait, isCompact, cx, cy, span, tilt, sunRadius, planetScale };
}

/**
 * Near-linear Solar Apex trajectory when zoomed out beyond standard Solar System view
 * (subtle large-radius galactic curvature, never a tiny artificial circle).
 */
function sunGalacticOffset(tVal, gt) {
  if (gt <= 0.001) return { x: 0, y: 0, z: 0 };
  const s = (tVal % 120) - 60;
  const speed = 0.022;
  const dist = s * speed;
  // Heading along Solar Apex (~32 deg above ecliptic plane, very gentle curve)
  const curve = dist * dist * 0.018;
  return {
    x: (dist * 0.84 - curve * 0.42) * gt,
    z: (dist * 0.48 + curve * 0.72) * gt,
    y: (-dist * 0.24) * gt,
  };
}

export function stepCosmosFrame(now, ctx) {
  const {
    engine, anim, eventSim, voyage, pools, webGraph, getWebGraph, gpuParticles, eventGpuParticles,
    constants, domRefs, getAgentsByPlanet, getGalaxyBooks,
    getUiState, onBandChange, onSyncEvents, onSyncVoyage, onUpdateHoverPos, formatEventLabel,
  } = ctx;

  const dt = Math.min(0.05, Math.max(0.001, (now - anim.lastTs) / 1000));
  anim.lastTs = now;

  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionMul = reducedMotion ? 0.12 : 1.0;

  const ui = getUiState();
  const pf = anim.planetFocus || (anim.planetFocus = {
    planetId: null,
    blend: 0,
    zoom: 1.0,
    targetZoom: 1.0,
    inspectYaw: 0,
    inspectPitch: 0,
    targetInspectYaw: 0,
    targetInspectPitch: 0,
  });

  const braking = Boolean(ui.hoverPlanetId || ui.dragActive || ui.drawerOpen || pf.planetId);
  const targetBrake = pf.planetId ? 0.14 : (braking ? 0.08 : 1.0);
  if (typeof anim.orbitBrake !== 'number') anim.orbitBrake = 1.0;
  anim.orbitBrake += (targetBrake - anim.orbitBrake) * Math.min(1, dt * 6.0);

  anim.realTime += dt * motionMul;
  anim.time += dt * constants.orbitSpeed * anim.orbitBrake * motionMul;
  anim.focusedPlanetId = ui.focusedPlanetId;

  // Smooth Planet Focus lock & 0.8x-24x zoom interpolation
  const goalPfBlend = pf.planetId ? 1.0 : 0.0;
  const pfRate = reducedMotion ? 16.0 : (pf.planetId ? 4.8 : 5.2);
  pf.blend += (goalPfBlend - pf.blend) * Math.min(1, dt * pfRate);
  if (Math.abs(pf.blend - goalPfBlend) < 0.002) pf.blend = goalPfBlend;
  const goalPfZoom = pf.planetId ? pf.targetZoom : 1.0;
  pf.zoom += (goalPfZoom - pf.zoom) * Math.min(1, dt * (reducedMotion ? 16.0 : 6.2));
  pf.inspectYaw += ((pf.planetId ? pf.targetInspectYaw : 0) - pf.inspectYaw) * Math.min(1, dt * 7.0);
  pf.inspectPitch += ((pf.planetId ? pf.targetInspectPitch : 0) - pf.inspectPitch) * Math.min(1, dt * 7.0);

  // Tick Interstellar Soaring & Multi-System Warp transitions
  const voyageTick = voyage
    ? tickVoyageState(voyage, dt, { reducedMotion })
    : { systemChanged: false, warpFinished: false };
  if (voyageTick.systemChanged || voyageTick.warpFinished) {
    if (voyageTick.systemChanged && pf.planetId) {
      pf.planetId = null;
      pf.lastPlanetId = null;
      pf.blend = 0;
      pf.zoom = 1.0;
      pf.targetZoom = 1.0;
    }
    onSyncVoyage?.();
  }
  const activeSys = getActiveStarSystem(voyage);
  const isHomeSystem = Boolean(activeSys.isHome);
  const activeBodies = activeSys.bodies || PLANETS;
  const soarBlend = voyage ? voyage.soarBlend : 0;
  const isWarpingSystem = Boolean(voyage?.warp);

  tickCosmicEvents(eventSim, dt * (reducedMotion ? 0.5 : 1.0), {
    showCountdown: constants.showEventsCountdown && ui.currentBand === 'solar' && isHomeSystem && !voyage?.soaring && !isWarpingSystem,
    autoEnabled: constants.eventsAutoEnabled && isHomeSystem && !voyage?.soaring && !isWarpingSystem,
    autoZoom: constants.eventsAutoZoom === true,
    canAutoZoom: ui.currentBand === 'solar' && isHomeSystem && !voyage?.soaring && !isWarpingSystem && !ui.drawerOpen && !ui.quickOpen && !ui.dragActive && !pf.planetId,
    cameraDt: dt,
    reducedMotion,
  });

  if (now - anim.lastEventUiSync >= 200) {
    anim.lastEventUiSync = now;
    onSyncEvents();
  }

  const prevScale = anim.scaleLog;
  anim.scaleLog += (anim.targetScaleLog - anim.scaleLog) * Math.min(1, dt * 6.4);
  const flightWarp = reducedMotion ? 0 : getFlightWarpEnergy(eventSim);
  const voyageWarp = reducedMotion ? 0 : (voyage?.warpEnergy || 0);
  anim.warpEnergy = Math.max(
    anim.warpEnergy * Math.exp(-dt * 4.5),
    Math.min(1.0, (Math.abs(anim.scaleLog - prevScale) / Math.max(dt, 0.001)) * 0.11),
    flightWarp,
    voyageWarp,
  );

  anim.parallax.x += (anim.parallax.tx - anim.parallax.x) * Math.min(1, dt * 4.2);
  anim.parallax.y += (anim.parallax.ty - anim.parallax.y) * Math.min(1, dt * 4.2);
  anim.camRot.x += (anim.camRot.tx - anim.camRot.x) * Math.min(1, dt * 5.2);
  anim.camRot.y += (anim.camRot.ty - anim.camRot.y) * Math.min(1, dt * 5.2);

  const { width: w, height: h, dpr } = engine.getSize();
  const aspect = w / Math.max(h, 1);

  const panelW = Number.isFinite(ui.drawerWidth) && ui.drawerWidth > 0
    ? ui.drawerWidth
    : (ui.workbenchWidened ? Math.min(760, w * 0.50) : Math.min(488, w * 0.34));
  anim.targetCenterShiftX = (ui.drawerOpen && w > 820) ? -Math.min(panelW * 0.50, w * 0.36) : 0;
  anim.centerShiftX += (anim.targetCenterShiftX - anim.centerShiftX) * Math.min(1, dt * 6.5);
  const shiftDenom = Math.max(Math.min(panelW * 0.50, w * 0.36), 1);
  const panelScaleFactor = 1.0 - Math.min(1, Math.abs(anim.centerShiftX) / shiftDenom) * 0.14;

  const s = anim.scaleLog;
  const band = scaleBand(s);
  if (ui.currentBand !== band) onBandChange(band);

  engine.ensureScaleTextures?.(Math.max(s, anim.targetScaleLog));

  const telescope = getSolarTelescopeTransform(eventSim, w, h);
  const observing = Boolean(eventSim.active?.observing);
  const telescopeHidden = observing || telescope.focus > 0.25;

  const baseSolarAlpha = s >= 10.2 && s <= 16.8 ? Math.min(1, Math.min((s - 10.2) / 1.4, (16.8 - s) / 1.8)) : 0;
  const voyageVisMul = voyage ? voyage.systemAlphaMul : 1.0;
  const solarAlpha = baseSolarAlpha * telescope.alphaMul * voyageVisMul;
  const galFullAlpha = (s >= 17.6 && s <= 23.0 ? Math.min(1, Math.min((s - 17.6) / 1.5, (23.0 - s) / 1.3)) : 0) * (1 - soarBlend);
  const webFullAlpha = (s >= 22.0 ? Math.min(1, (s - 22.0) / 1.2) : 0) * (1 - soarBlend);
  const bhFullStrength = (s <= 10.6 ? Math.min(1, (10.6 - s) / 1.8) : 0) * (1 - soarBlend);

  const pfZoomFactor = 1.0 + (pf.zoom - 1.0) * pf.blend;
  const voyageZoomMul = voyage ? voyage.systemZoomMul : 1.0;
  const baseSolarZoom = Math.pow(1.42, 13.0 - s) * panelScaleFactor * telescope.zoomMul * voyageZoomMul;
  const solarZoom = baseSolarZoom * pfZoomFactor;

  const layout = computeSolarProjectionLayout(w, h, {
    solarZoom,
    centerShiftX: anim.centerShiftX,
    parallaxX: anim.parallax.x * (1.0 - pf.blend * 0.85),
    parallaxY: anim.parallax.y * (1.0 - pf.blend * 0.85),
    camRotY: anim.camRot.y,
  });
  const { isPortrait, isCompact, span, tilt, sunRadius, planetScale } = layout;

  const yawCos = Math.cos(anim.camRot.x * 0.38);
  const yawSin = Math.sin(anim.camRot.x * 0.38);
  const galTravel = pf.blend > 0.05 ? 0 : smoothstep(13.25, 15.4, s);
  const sunOffNow = sunGalacticOffset(anim.time, galTravel);

  // Base stage center before Planet Focus shift
  let stageCx = layout.cx + telescope.offsetX;
  let stageCy = layout.cy + telescope.offsetY;

  // Compute Planet Focus camera offset so the focused planet locks smoothly to stage center
  let focusShiftX = 0;
  let focusShiftY = 0;
  if (pf.blend > 0.002) {
    const focusP = activeBodies.find((p) => p.id === (pf.planetId || pf.lastPlanetId));
    if (focusP) {
      pf.lastPlanetId = focusP.id;
      const wp = keplerPos(focusP, anim.time);
      const rx = wp.x * yawCos - wp.z * yawSin;
      const rz = wp.x * yawSin + wp.z * yawCos;
      const persp = 1.0 / (1.0 - rz * 0.26);
      focusShiftX = -rx * span * persp * pf.blend;
      focusShiftY = -(rz * span * tilt + wp.y * span) * persp * pf.blend;
    }
  }

  const cx = stageCx + focusShiftX;
  const cy = stageCy + focusShiftY;

  const projectSolar = (ux, uz, uy = 0, gOff = sunOffNow) => {
    const wx = ux + (gOff?.x || 0) - sunOffNow.x;
    const wz = uz + (gOff?.z || 0) - sunOffNow.z;
    const wy = uy + (gOff?.y || 0) - sunOffNow.y;
    const rx = wx * yawCos - wz * yawSin;
    const rz = wx * yawSin + wz * yawCos;
    const persp = 1.0 / (1.0 - Math.max(-0.85, Math.min(0.85, rz * 0.26)));
    return {
      x: cx + rx * span * persp,
      y: cy + (rz * span * tilt + wy * span) * persp,
      rx,
      rz,
      persp,
    };
  };

  const sunPt = projectSolar(0, 0, 0, sunOffNow);
  anim.solarSunScreen = { x: sunPt.x, y: sunPt.y, r: sunRadius };

  const solarBodies = [];
  const agentsByPlanet = getAgentsByPlanet();

  if (solarAlpha > 0.004) {
    // Render active system's central star(s): single star, binary stars, or none (Sgr A* SMBH)
    for (const star of (activeSys.stars || [])) {
      const sAng = star.phase + anim.time * (star.speed || 0);
      const sxWorld = (star.orbitR || 0) * Math.cos(sAng);
      const szWorld = (star.orbitR || 0) * Math.sin(sAng);
      const sPt = projectSolar(sxWorld, szWorld, 0, sunOffNow);
      solarBodies.push({
        bodyType: 0,
        texKey: 'sun',
        screenX: sPt.x,
        screenY: sPt.y,
        radiusPx: sunRadius * (star.sizeRatio || 1.0) * (sPt.persp || 1.0),
        camZ: sPt.rz || 0,
        spin: anim.time * 0.075 + (star.phase || 0),
        tilt: 0.11,
        oblate: 1.0,
        lightDir: [0, 0, 1],
        atmo: star.atmo || [1, 0.72, 0.36],
        highlight: 0,
      });
    }

    for (const p of activeBodies) {
      const wp = keplerPos(p, anim.time);
      const pt = projectSolar(wp.x, wp.z, wp.y, sunOffNow);
      const sx = pt.x;
      const sy = pt.y;
      const rx = pt.rx;
      const rz = pt.rz;
      const persp = pt.persp;
      const isFocusedPlanet = pf.planetId === p.id;
      const rPx = Math.max(isCompact ? 5.5 : 4.5, p.size * planetScale * persp);

      const lx = -rx;
      const ly = 0.24;
      const lz = -rz * 0.62 + 0.54;
      const lLen = Math.hypot(lx, ly, lz) || 1;
      const lightDir = [lx / lLen, ly / lLen, lz / lLen];
      const isHovered = anim.hoverPlanetId === p.id;
      const isSelected = (isHomeSystem && ui.focusedPlanetId === p.id) || isFocusedPlanet;
      const isDrop = isHomeSystem && ui.dragOverPlanetId === p.id;
      const closeup = isFocusedPlanet
        ? Math.max(0, Math.min(1.5, (pf.zoom - 1.05) / 3.4))
        : Math.max(0, Math.min(0.45, (rPx - 58) / 110));

      anim.planetScreen[p.id] = { x: sx, y: sy, r: rPx, z: rz };
      solarBodies.push({
        bodyType: p.bodyType, texKey: p.texKey, screenX: sx, screenY: sy, radiusPx: rPx, camZ: rz,
        spin: anim.realTime * p.spinRate + p.phase * 1.3 + (isFocusedPlanet ? pf.inspectYaw : 0),
        tilt: p.tilt,
        pitch: isFocusedPlanet ? pf.inspectPitch : 0,
        closeup,
        oblate: p.oblate,
        lightDir,
        atmo: p.atmo,
        highlight: isDrop ? 1.0 : (isSelected ? (closeup > 0.6 ? 0.25 : 0.84) : (isHovered ? 0.58 : 0)),
      });

      // 3D WebGL Natural Moons (depth-sorted around parent planet)
      if (Array.isArray(p.moons) && p.moons.length > 0 && rPx >= 12) {
        for (const m of p.moons) {
          const mRad = rPx * m.sizeRatio;
          if (mRad < 1.35) continue;
          const mAng = m.phase + anim.realTime * m.speed + (isFocusedPlanet ? pf.inspectYaw * 0.85 : 0);
          const mOrbPx = rPx * m.orbitR;
          const mx = Math.cos(mAng) * mOrbPx;
          const mz = Math.sin(mAng) * mOrbPx;
          const mTilt = Math.max(0.18, Math.min(0.85, tilt + (m.incl || 0) + (isFocusedPlanet ? pf.inspectPitch * 0.45 : 0)));
          const my = mz * mTilt;
          const mCamZ = rz + (mz / Math.max(span, 1)) * 0.12 + (mz >= 0 ? 0.002 : -0.002);
          solarBodies.push({
            bodyType: 9,
            texKey: 'mercury',
            screenX: sx + mx,
            screenY: sy + my,
            radiusPx: mRad,
            camZ: mCamZ,
            spin: -mAng + Math.PI,
            tilt: 0.08,
            pitch: isFocusedPlanet ? pf.inspectPitch * 0.5 : 0,
            closeup: Math.min(1.0, mRad / 28),
            oblate: 1.0,
            lightDir,
            atmo: [0.8, 0.84, 0.92],
            highlight: 0,
            moonStyle: m.style || 0,
          });
        }
      }

      if (isHomeSystem) {
        const nodeEl = domRefs.planets[p.id];
        if (nodeEl) {
          const deepCloseup = isFocusedPlanet && pf.zoom > 3.2;
          nodeEl.style.display = telescopeHidden ? 'none' : 'block';
          nodeEl.style.opacity = String(solarAlpha);
          nodeEl.style.transform = `translate(${sx}px, ${sy}px)`;
          nodeEl.style.zIndex = String(Math.round(50 + rz * 25));

          const hitEl = domRefs.hits[p.id];
          if (hitEl) {
            const hitD = deepCloseup ? 0 : Math.max(isCompact ? 48 : 46, Math.min(220, rPx * (p.bodyType === 6 ? 3.2 : 2.3)));
            hitEl.style.width = `${hitD}px`;
            hitEl.style.height = `${hitD}px`;
          }
          const tagOffY = Math.min(h * 0.40, rPx * (p.bodyType === 6 ? 1.24 : 1.16) + (isCompact ? 10 : 12));
          const tagEl = domRefs.tags[p.id];
          if (tagEl) {
            tagEl.style.display = deepCloseup ? 'none' : '';
            const tagClampX = isCompact
              ? (sx < 62 ? 62 - sx : (sx > w - 62 ? w - 62 - sx : 0))
              : 0;
            tagEl.style.transform = tagClampX !== 0
              ? `translate(calc(-50% + ${Math.round(tagClampX)}px), ${tagOffY}px)`
              : `translate(-50%, ${tagOffY}px)`;
          }
        }
      } else {
        const sEl = domRefs.sightseeingNodes?.[p.id];
        if (sEl) {
          const deepCloseup = isFocusedPlanet && pf.zoom > 3.2;
          sEl.style.display = (deepCloseup || solarAlpha < 0.08) ? 'none' : 'block';
          sEl.style.opacity = String(solarAlpha);
          sEl.style.transform = `translate(${sx}px, ${sy}px)`;
          sEl.style.zIndex = String(Math.round(50 + rz * 25));
          const sTag = domRefs.sightseeingTags?.[p.id];
          if (sTag) {
            const tagOffY = Math.min(h * 0.40, rPx * (p.bodyType === 6 ? 1.24 : 1.16) + (isCompact ? 10 : 12));
            sTag.style.transform = `translate(-50%, ${tagOffY}px)`;
          }
        }
      }
    }

    if (!isHomeSystem) {
      for (const p of PLANETS) {
        const nodeEl = domRefs.planets[p.id];
        if (nodeEl) nodeEl.style.display = 'none';
      }
    } else if (domRefs.sightseeingNodes) {
      for (const el of Object.values(domRefs.sightseeingNodes)) {
        if (el) el.style.display = 'none';
      }
    }

    if (isHomeSystem && ui.hoverPlanetId) onUpdateHoverPos(ui.hoverPlanetId);
  } else {
    for (const p of PLANETS) {
      const nodeEl = domRefs.planets[p.id];
      if (nodeEl) nodeEl.style.display = 'none';
    }
    if (domRefs.sightseeingNodes) {
      for (const el of Object.values(domRefs.sightseeingNodes)) {
        if (el) el.style.display = 'none';
      }
    }
  }

  // Deep-sky portals & non-solar spatial nodes (Black Hole Horizon is entered ONLY via Sun zoom — no corner BH portal!)
  const portalOpacity = (telescopeHidden || pf.blend > 0.25 || !isHomeSystem) ? 0 : solarAlpha * (1.0 - pf.blend * 4.0);
  const galPortalX = (isPortrait ? 0.29 : 0.40) * aspect;
  const galPortalY = -0.35;
  const webPortalX = (isPortrait ? -0.29 : -0.40) * aspect;
  const webPortalY = -0.35;

  const galParams = galFullAlpha > 0.01
    ? { x: 0, y: 0, radius: (isPortrait ? 0.62 : 0.96) * Math.pow(1.18, 21.0 - s), alpha: galFullAlpha, tilt: 0.54 + anim.camRot.y * 0.16 }
    : { x: galPortalX, y: galPortalY, radius: isPortrait ? 0.072 : 0.095, alpha: portalOpacity * 0.72, tilt: 0.52 };
  const webParams = webFullAlpha > 0.01
    ? { x: 0, y: 0, radius: 1.05, alpha: webFullAlpha }
    : { x: webPortalX, y: webPortalY, radius: isPortrait ? 0.068 : 0.085, alpha: portalOpacity * 0.52 };
  const sgrBh = activeSys.centralBlackHole;
  const sgrBhStrength = sgrBh ? solarAlpha * (sgrBh.strength || 1.0) : 0;
  const bhParams = bhFullStrength > 0.01
    ? { x: 0, y: 0, radius: (isPortrait ? 0.125 : 0.178) * Math.pow(1.14, 7.0 - s), strength: bhFullStrength }
    : (sgrBhStrength > 0.01
      ? {
        x: (sunPt.x / Math.max(w, 1) - 0.5) * aspect,
        y: 0.5 - sunPt.y / Math.max(h, 1),
        radius: Math.max(0.032, Math.min(0.24, (isPortrait ? 0.082 : (sgrBh.radiusFactor || 0.125)) * Math.min(1.8, solarZoom))),
        strength: sgrBhStrength,
      }
      : { x: 0, y: 0, radius: 0.01, strength: 0 });

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
  if (domRefs.portals['to-horizon']) domRefs.portals['to-horizon'].style.display = 'none';

  const homeEl = domRefs.homeBeacon.value;
  if (homeEl) {
    if (galFullAlpha > 0.12) {
      // Orion Arm polar coordinate orbiting the galactic core
      const gRadHome = Math.min(w, h) * 0.52;
      const gTiltHome = 0.54 + anim.camRot.y * 0.16;
      const gSpinHome = -anim.realTime * 0.016 - anim.time * 0.012;
      const sunGalAng = 2.48 + gSpinHome;
      const hx = w * 0.5 + anim.parallax.x * 12 + Math.cos(sunGalAng) * 0.44 * gRadHome;
      const hy = h * 0.5 + anim.parallax.y * 8 + Math.sin(sunGalAng) * 0.44 * gRadHome * gTiltHome;
      homeEl.style.display = 'inline-flex';
      homeEl.style.opacity = String(galFullAlpha);
      homeEl.style.left = `${hx}px`;
      homeEl.style.top = `${hy}px`;
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

  // Update floating in-flight Star System Beacons (Zero-VDOM-churn direct DOM positioning)
  if (domRefs.soarBeacons) {
    const projectedBeacons = projectSoarBeacons(voyage, w, h, anim.camRot);
    const visibleMap = Object.create(null);
    for (const b of projectedBeacons) visibleMap[b.id] = b;
    for (const sys of STAR_SYSTEMS) {
      const el = domRefs.soarBeacons[sys.id];
      if (!el) continue;
      const b = visibleMap[sys.id];
      if (!b) {
        el.style.display = 'none';
      } else {
        el.style.display = 'inline-flex';
        el.style.opacity = String(b.alpha);
        el.style.transform = `translate(${b.x}px, ${b.y}px) translate(-50%, -50%)`;
      }
    }
  }

  const bhCenter = toScreen(bhParams.x, bhParams.y);
  const densityScale = !engine.isWebGL ? 0 : (engine.isMobile ? 0.55 : 1.0);
  const particleCount = fillGpuParticles(gpuParticles, pools, anim, {
    w, h, dpr, cx: sunPt.x, cy: sunPt.y, span, tilt,
    solarAlpha: activeSys.hasBelt ? solarAlpha : 0,
    galAlpha: galFullAlpha,
    bhStrength: bhParams.strength, bhCx: bhCenter.x, bhCy: bhCenter.y, bhRadiusPx: bhParams.radius * h,
    densityScale,
  });

  // Multi-Event Shared-Canvas Render Frame Descriptors (ZERO reticle circles!)
  const portalAvoidPoints = [
    toScreen(galPortalX, galPortalY),
    toScreen(webPortalX, webPortalY),
  ];
  const eventVisibilityAlpha = (isHomeSystem && !voyage?.soaring && !isWarpingSystem) ? baseSolarAlpha : 0;
  const eventDraws = (eventVisibilityAlpha > 0.01 && (eventSim.events?.length > 0 || eventSim.active))
    ? computeEventFrames(
      eventSim,
      w,
      h,
      anim.centerShiftX,
      portalAvoidPoints,
      eventVisibilityAlpha,
      anim.camRot,
      anim.parallax,
      baseSolarZoom,
    )
    : [];
  anim.lastEventFrames = eventDraws;
  const primaryEventDraw = eventDraws.find((e) => e.observing) || eventDraws[eventDraws.length - 1] || null;

  const eventParticleCount = (eventDraws.length > 0 && engine.isWebGL && eventGpuParticles)
    ? fillEventGpuParticles(eventGpuParticles, eventDraws, w, h, dpr, densityScale)
    : 0;
  const eventLens = eventDraws.length > 0 ? getEventLens(eventDraws, w, h) : [0, 0, 0, 0];
  const eventAmbient = eventDraws.length > 0 ? getEventAmbient(eventDraws) : [0, 0, 0, 0];

  if (domRefs.eventBeacon?.value) {
    domRefs.eventBeacon.value.style.display = 'none';
  }

  const effectiveCamRot = {
    x: anim.camRot.x + (eventSim.camYawOffset || 0),
    y: anim.camRot.y + (eventSim.camPitchOffset || 0),
  };

  const activeWebGraph = webFullAlpha > 0.04 ? (webGraph || getWebGraph?.() || null) : null;
  const solarProj = {
    project: projectSolar,
    sunPt,
    galTravel,
    sunGalacticOffset,
  };

  const { skyTint, soarVec } = getVoyageSkyUniforms(voyage);

  engine.renderFrame({
    time: anim.time,
    realTime: anim.realTime,
    scaleLog: s,
    parallax: anim.parallax,
    camRot: effectiveCamRot,
    warp: anim.warpEnergy,
    fovZoom: eventSim.fovZoom,
    skyTint,
    soarVec,
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
    eventDraw: primaryEventDraw,
    eventDraws,
    activeEvent: eventSim.active,
    eventParticleData: eventGpuParticles,
    eventParticleCount,
    solarBodies,
    solarAlpha,
    hudDraw: (c2d, cw, ch, renderInfo = {}) => {
      drawCosmosHud(c2d, cw, ch, anim, activeWebGraph, galaxyBooks, agentsByPlanet, {
        cx: sunPt.x,
        cy: sunPt.y,
        span,
        tilt,
        solarAlpha,
        galAlpha: galFullAlpha,
        webAlpha: webFullAlpha,
        solarProj,
        planetFocusId: pf.planetId,
        planetZoom: pf.zoom,
        activeBodies,
        hasComets: activeSys.hasComets !== false,
        isHomeSystem,
        soarBlend,
        soarPhase: voyage?.flightPhase || 0,
        voyageWarp,
      }, (ec, ew, eh) => {
        if (eventDraws.length === 0) return;
        const renderedSet = renderInfo.renderedEventUids;
        for (const ev of eventDraws) {
          const alreadyRendered = renderedSet
            ? renderedSet.has(ev.uid || ev.id)
            : Boolean(renderInfo.eventRenderedInGL || renderInfo.eventRenderedIn2D);
          if (!alreadyRendered) {
            const inst = ev.instance || eventSim.active;
            if (inst) drawCosmicEventCanvas(ec, ew, eh, inst, ev, ev.alpha);
          }
        }
        drawCosmicEventHud(ec, ew, eh, eventDraws, anim.centerShiftX, {
          hoveredUid: eventSim.hoveredUid,
          formatLabel: formatEventLabel,
        });
      });
    },
  });
}
