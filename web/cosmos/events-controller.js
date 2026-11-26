/**
 * Yeaft Cosmos — Random-Interval Distant Cosmic Event Scheduler & Deep-Sky Telescope Controller
 *
 * Guarantees:
 * - Events never overwrite the foreground Solar System: every occurrence spawns at a
 *   random 3D deep-sky bearing (azimuth N/NE/E/SE/S/SW/W/NW, elevation, and distance)
 *   outside the solar plane, rendered at perspective-attenuated distant scale.
 * - Events are selected randomly without immediate back-to-back repeats, separated by
 *   quiet random cooldown intervals (default 75–165s), play once, and dissolve cleanly.
 * - Observation smoothly slews and zooms the telescope toward the distant coordinates
 *   and smoothly returns to the Solar System when the event finishes or is exited.
 * - Auto-zoom on trigger is user-configurable (`autoZoom`): when disabled, the event
 *   unfolds at its distant scale with a subtle directional indicator users can click to
 *   telescope in on demand.
 */

export const MIN_EVENT_INTERVAL_SEC = 75;
export const MAX_EVENT_INTERVAL_SEC = 165;
export const INITIAL_EVENT_MIN_SEC = 45;
export const INITIAL_EVENT_MAX_SEC = 95;

export const EVENT_DISTANT_MIN_SCALE = 0.20;
export const EVENT_DISTANT_MAX_SCALE = 0.44;
export const EVENT_CAMERA_RETURN_EPS = 0.015;

export const COSMIC_EVENTS = Object.freeze([
  {
    id: 'supernova',
    swatch: '#78d2ff',
    duration: 18,
    defaultZoom: 1.65,
    hasShock: true,
    anchor: { x: 0.62, y: 0.34 },
  },
  {
    id: 'planet-shatter',
    swatch: '#ff7d4d',
    duration: 18,
    defaultZoom: 1.85,
    hasShock: true,
    anchor: { x: 0.34, y: 0.62 },
  },
  {
    id: 'blackhole-birth',
    swatch: '#f6ba64',
    duration: 20,
    defaultZoom: 1.80,
    hasShock: true,
    anchor: { x: 0.56, y: 0.44 },
  },
  {
    id: 'kilonova',
    swatch: '#96b4ff',
    duration: 18,
    defaultZoom: 1.70,
    hasShock: true,
    anchor: { x: 0.44, y: 0.36 },
  },
  {
    id: 'solar-flare',
    swatch: '#ffaa44',
    duration: 16,
    defaultZoom: 1.50,
    hasShock: false,
    anchor: { x: 0.50, y: 0.51 },
  },
  {
    id: 'gamma-burst',
    swatch: '#c89bff',
    duration: 17,
    defaultZoom: 1.60,
    hasShock: true,
    anchor: { x: 0.64, y: 0.52 },
  },
  {
    id: 'tidal-disruption',
    swatch: '#ff9668',
    duration: 19,
    defaultZoom: 1.75,
    hasShock: false,
    anchor: { x: 0.38, y: 0.42 },
  },
  {
    id: 'comet-breakup',
    swatch: '#7ceeff',
    duration: 17,
    defaultZoom: 1.55,
    hasShock: false,
    anchor: { x: 0.48, y: 0.32 },
  },
]);

/**
 * 8-sector peripheral deep-sky ring surrounding the Solar System (clockwise from North).
 * Keeps distant phenomena clearly outside the central solar ecliptic and away from
 * the top-center event pill, top-right corner actions, and deep-sky portal labels.
 */
const DISTANT_SECTORS = Object.freeze([
  { id: 'n',  x: 0.50, y: 0.16, jitterX: 0.08, jitterY: 0.025, yaw:  0.00, pitch: -0.26, azDeg:   0 },
  { id: 'ne', x: 0.84, y: 0.20, jitterX: 0.05, jitterY: 0.04,  yaw: -0.40, pitch: -0.22, azDeg:  45 },
  { id: 'e',  x: 0.89, y: 0.50, jitterX: 0.03, jitterY: 0.07,  yaw: -0.48, pitch:  0.02, azDeg:  90 },
  { id: 'se', x: 0.71, y: 0.84, jitterX: 0.05, jitterY: 0.03,  yaw: -0.34, pitch:  0.24, azDeg: 135 },
  { id: 's',  x: 0.50, y: 0.85, jitterX: 0.08, jitterY: 0.025, yaw:  0.00, pitch:  0.28, azDeg: 180 },
  { id: 'sw', x: 0.29, y: 0.84, jitterX: 0.05, jitterY: 0.03,  yaw:  0.34, pitch:  0.24, azDeg: 225 },
  { id: 'w',  x: 0.16, y: 0.67, jitterX: 0.03, jitterY: 0.05,  yaw:  0.46, pitch:  0.10, azDeg: 270 },
  { id: 'nw', x: 0.29, y: 0.17, jitterX: 0.05, jitterY: 0.03,  yaw:  0.34, pitch: -0.22, azDeg: 315 },
]);

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function easeOutCubic(t) {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

/**
 * Sample a random 3D deep-sky location around the outer skybox (never overlapping the
 * central Solar System). Avoids repeating the immediately preceding compass sector.
 */
export function pickRandomDistantLocation(excludeSectorId = null, rng = Math.random) {
  const n = DISTANT_SECTORS.length;
  let idx = Math.floor(rng() * n) % n;
  if (excludeSectorId && DISTANT_SECTORS[idx].id === excludeSectorId) {
    idx = (idx + 1 + Math.floor(rng() * (n - 1))) % n;
  }
  const sector = DISTANT_SECTORS[idx];
  const jx = (rng() * 2 - 1) * sector.jitterX;
  const jy = (rng() * 2 - 1) * sector.jitterY;
  const x = clamp(sector.x + jx, 0.08, 0.92);
  const y = clamp(sector.y + jy, 0.11, 0.89);

  // Depth in [0, 1]: 0 = outer local neighborhood (~180 ly), 1 = deep extragalactic space (~12,000 ly)
  const depth = clamp(rng(), 0, 1);
  // Perspective scale factor when viewed from the Solar System without telescoping in
  const distantScale = Number((EVENT_DISTANT_MAX_SCALE - depth * (EVENT_DISTANT_MAX_SCALE - EVENT_DISTANT_MIN_SCALE)).toFixed(3));
  // Subtle camera yaw/pitch offset for 3D skybox slew when telescoping in
  const yaw = Number((sector.yaw + (0.5 - x) * 0.24).toFixed(3));
  const pitch = Number((sector.pitch + (y - 0.5) * 0.18).toFixed(3));
  // Astronomical distance readout for subtle telemetry display (log-spaced light-years)
  const distanceLy = Math.round(160 * Math.pow(72, depth));
  // Vertical elevation angle in degrees (-38° .. +38°), positive = north/up of ecliptic
  const elevDeg = Math.round((0.5 - y) * 76);

  return {
    sector: sector.id,
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    depth: Number(depth.toFixed(3)),
    distantScale,
    yaw,
    pitch,
    distanceLy,
    azDeg: sector.azDeg,
    elevDeg,
  };
}

export function formatEventDistance(distanceLy, isEn = false) {
  const ly = Math.max(1, Math.round(Number(distanceLy) || 1000));
  if (ly >= 1000) {
    const kly = (ly / 1000).toFixed(1).replace(/\.0$/, '');
    return isEn ? `${kly}k ly` : `${kly} 千光年`;
  }
  return isEn ? `${ly} ly` : `${ly} 光年`;
}

export function pickRandomEventIndex(excludeIndex = -1, rng = Math.random) {
  const n = COSMIC_EVENTS.length;
  if (n <= 1) return 0;
  let idx = Math.floor(rng() * n) % n;
  if (idx === excludeIndex) {
    idx = (idx + 1 + Math.floor(rng() * (n - 1))) % n;
  }
  return idx;
}

export function pickRandomCooldownSec(minSec = MIN_EVENT_INTERVAL_SEC, maxSec = MAX_EVENT_INTERVAL_SEC, rng = Math.random) {
  const lo = Math.max(5, Number(minSec) || MIN_EVENT_INTERVAL_SEC);
  const hi = Math.max(lo, Number(maxSec) || MAX_EVENT_INTERVAL_SEC);
  return Math.round(lo + rng() * (hi - lo));
}

export function formatEventCountdown(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `T-${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function createCosmicEventState(opts = {}) {
  const rng = opts.rng || Math.random;
  const firstIdx = pickRandomEventIndex(-1, rng);
  return {
    active: null,
    nextIdx: firstIdx,
    lastPlayedIdx: -1,
    lastSector: null,
    countdown: pickRandomCooldownSec(INITIAL_EVENT_MIN_SEC, INITIAL_EVENT_MAX_SEC, rng),
    autoEnabled: opts.autoEnabled !== false,
    autoZoom: opts.autoZoom !== false,
    // Smooth telescope camera transition state (returns cleanly to 0 / 1.0 after observation)
    focusProgress: 0, // 0 = Solar System home view, 1 = fully telescoped into distant event
    fovZoom: 1.0,
    panX: 0,
    panY: 0,
    camYawOffset: 0,
    camPitchOffset: 0,
    lastLocation: null,
  };
}

export function startCosmicEvent(
  sim,
  eventId = null,
  { observe = false, autoZoom = null, rng = Math.random } = {},
) {
  let idx = eventId ? COSMIC_EVENTS.findIndex((e) => e.id === eventId) : sim.nextIdx;
  if (idx < 0 || idx >= COSMIC_EVENTS.length) idx = pickRandomEventIndex(sim.lastPlayedIdx, rng);
  const def = COSMIC_EVENTS[idx];
  const shouldFocus = Boolean(observe);

  // Clicking to focus an already-running distant event slews smoothly to its existing coordinates
  if (sim.active && sim.active.def.id === def.id && shouldFocus) {
    sim.active.observing = true;
    sim.active.paused = false;
    sim.active.targetZoom = Math.max(sim.active.targetZoom, def.defaultZoom);
    return sim.active;
  }

  const location = pickRandomDistantLocation(sim.lastSector, rng);
  sim.lastPlayedIdx = idx;
  sim.lastSector = location.sector;
  sim.lastLocation = location;
  sim.nextIdx = pickRandomEventIndex(idx, rng);
  sim.countdown = pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
  const effectiveObserve = shouldFocus || (autoZoom === true);

  sim.active = {
    def,
    location,
    elapsed: 0.01,
    duration: def.duration,
    paused: false,
    targetZoom: def.defaultZoom,
    observing: effectiveObserve,
  };
  return sim.active;
}

/** Slew the telescope in to observe the currently unfolding distant event. */
export function focusActiveCosmicEvent(sim) {
  if (!sim.active) return null;
  sim.active.observing = true;
  sim.active.paused = false;
  sim.active.targetZoom = Math.max(sim.active.targetZoom || 1.0, sim.active.def.defaultZoom);
  return sim.active;
}

/** Pull camera smoothly back to the Solar System while letting the distant event finish in place. */
export function unfocusCosmicEvent(sim) {
  if (!sim.active || !sim.active.observing) return false;
  sim.active.observing = false;
  sim.active.paused = false;
  return true;
}

/** Immediately stop any running/observed cosmic event and smoothly return camera to the Solar System. */
export function stopCosmicEvent(sim, { rng = Math.random } = {}) {
  const wasActive = Boolean(sim.active);
  sim.active = null;
  sim.nextIdx = pickRandomEventIndex(sim.lastPlayedIdx, rng);
  sim.countdown = pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
  return wasActive;
}

export function setCosmicEventZoom(sim, zoom) {
  if (!sim.active) return;
  sim.active.targetZoom = clamp(Number(zoom) || 1.0, 0.75, 3.4);
}

export function tickCosmicEvents(
  sim,
  dt,
  {
    showCountdown = true,
    autoEnabled = true,
    autoZoom = sim.autoZoom !== false,
    canAutoZoom = true,
    cameraDt = dt,
    rng = Math.random,
  } = {},
) {
  sim.autoEnabled = Boolean(autoEnabled);
  sim.autoZoom = Boolean(autoZoom);

  if (sim.active) {
    if (!sim.active.paused) {
      sim.active.elapsed += dt;
      // Single-shot completion: finish naturally, release telescope back to Solar System, and enter quiet cooldown.
      if (sim.active.elapsed >= sim.active.duration) {
        sim.active = null;
        sim.nextIdx = pickRandomEventIndex(sim.lastPlayedIdx, rng);
        sim.countdown = pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
      }
    }
  } else if (showCountdown && autoEnabled) {
    sim.countdown -= dt;
    if (sim.countdown <= 0) {
      startCosmicEvent(sim, null, {
        observe: Boolean(autoZoom && canAutoZoom),
        rng,
      });
    }
  }

  const camStep = Math.max(0, Number(cameraDt) || 0);
  const isObserving = Boolean(sim.active && sim.active.observing);
  const goalFocus = isObserving ? 1.0 : 0.0;
  // Slightly swifter pull-in and serene, cinematic return back to Solar System
  const focusRate = isObserving ? 3.2 : 2.6;
  sim.focusProgress += (goalFocus - sim.focusProgress) * Math.min(1, camStep * focusRate);
  if (Math.abs(sim.focusProgress - goalFocus) < 0.002) {
    sim.focusProgress = goalFocus;
  }

  const loc = sim.active?.location || sim.lastLocation;
  const goalZoom = isObserving ? sim.active.targetZoom : 1.0;
  sim.fovZoom += (goalZoom - sim.fovZoom) * Math.min(1, camStep * (isObserving ? 3.8 : 3.2));

  const goalPanX = isObserving && loc ? (0.5 - loc.x) : 0;
  const goalPanY = isObserving && loc ? (0.5 - loc.y) : 0;
  sim.panX += (goalPanX - sim.panX) * Math.min(1, camStep * 3.4);
  sim.panY += (goalPanY - sim.panY) * Math.min(1, camStep * 3.4);

  const goalYaw = isObserving && loc ? loc.yaw : 0;
  const goalPitch = isObserving && loc ? loc.pitch : 0;
  sim.camYawOffset += (goalYaw - sim.camYawOffset) * Math.min(1, camStep * 3.1);
  sim.camPitchOffset += (goalPitch - sim.camPitchOffset) * Math.min(1, camStep * 3.1);
}

/**
 * Compute viewport coordinates and perspective scale for the active distant cosmic event.
 * - When `focusProgress === 0`: event sits at its distant outer-sky bearing at `location.distantScale` (0.20–0.44),
 *   well clear of the foreground Solar System and corner deep-sky portals.
 * - When `focusProgress -> 1`: camera slews and zooms cleanly toward the distant coordinates so the event
 *   expands to full observation scale centered in the telescope viewport.
 */
export function getEventScreenPosition(sim, w, h, centerShiftX = 0, avoidPoints = null) {
  if (!sim.active) return null;
  const loc = sim.active.location || sim.active.def.anchor;
  const safeW = Math.max(w || 1, 1);
  const safeH = Math.max(h || 1, 1);
  const isCompact = safeW < 768 || Math.min(safeW, safeH) < 600;
  const f = easeOutCubic(sim.focusProgress || 0);

  // Distant rest coordinates clamped inside safe visual margins so the phenomenon
  // and its concentric reticle beacon always lock onto the exact same pixel.
  const marginX = isCompact ? 68 : 104;
  const marginTop = 84;
  const marginBottom = isCompact ? 96 : 74;
  let restX = clamp(loc.x * safeW + centerShiftX * 0.25, marginX, Math.max(marginX, safeW - marginX));
  let restY = clamp(loc.y * safeH, marginTop, Math.max(marginTop, safeH - marginBottom));

  // Gently nudge away from corner deep-sky portals (Event Horizon / Cosmic Web / Galaxy Library)
  // so distant phenomena never visually collide with portal graphics on any aspect ratio.
  if (Array.isArray(avoidPoints) && avoidPoints.length > 0) {
    const minClear = isCompact ? 92 : 126;
    for (const pt of avoidPoints) {
      if (!pt) continue;
      const dx = restX - pt.x;
      const dy = restY - pt.y;
      const dist = Math.hypot(dx, dy);
      if (dist < minClear) {
        // Push horizontally toward the center line first so we stay on the outer sky ring
        const pushX = pt.x < safeW * 0.5 ? 1 : -1;
        const pushY = pt.y < safeH * 0.5 ? 0.35 : -0.35;
        const pLen = Math.hypot(pushX, pushY) || 1;
        const shift = minClear - dist + 8;
        restX = clamp(restX + (pushX / pLen) * shift, marginX, Math.max(marginX, safeW - marginX));
        restY = clamp(restY + (pushY / pLen) * shift, marginTop, Math.max(marginTop, safeH - marginBottom));
      }
    }
  }

  // Centered telescope coordinates when zoomed in
  const centerX = safeW * 0.5 + centerShiftX * 0.55;
  const centerY = safeH * 0.5;

  const x = restX + (centerX - restX) * f;
  const y = restY + (centerY - restY) * f;

  const distantScale = typeof loc.distantScale === 'number' ? loc.distantScale : 0.30;
  const focusedScale = Math.max(0.75, sim.fovZoom || 1.0);
  const scale = distantScale + (focusedScale - distantScale) * f;

  return {
    x,
    y,
    restX,
    restY,
    scale,
    distantScale,
    focusProgress: f,
    isDistant: f < 0.35,
    sector: loc.sector || 'ne',
    distanceLy: loc.distanceLy || 1200,
    depth: typeof loc.depth === 'number' ? loc.depth : 0.5,
  };
}

/**
 * Compute how the foreground Solar System should gently drift and recede while the
 * telescope slews away to observe a distant deep-sky event, then glide right back.
 */
export function getSolarTelescopeTransform(sim, w, h) {
  const f = easeOutCubic(sim.focusProgress || 0);
  if (f <= EVENT_CAMERA_RETURN_EPS) {
    return { active: false, focus: 0, offsetX: 0, offsetY: 0, zoomMul: 1, alphaMul: 1 };
  }
  const loc = sim.active?.location || sim.lastLocation || { x: 0.84, y: 0.19 };
  const dirX = loc.x - 0.5;
  const dirY = loc.y - 0.5;
  const norm = Math.hypot(dirX, dirY) || 1;
  // As camera pans toward (dirX, dirY) and zooms into deep space, the nearby Solar System
  // smoothly sweeps behind/opposite the telescope vector and fades out cleanly.
  const travel = Math.min(w || 1280, h || 720) * 0.72 * f;
  return {
    active: true,
    focus: f,
    offsetX: -(dirX / norm) * travel,
    offsetY: -(dirY / norm) * travel,
    zoomMul: Math.max(0.38, 1.0 - f * 0.52),
    alphaMul: Math.max(0.0, 1.0 - Math.min(1, f * 1.28)),
  };
}

export function getEventShockWave(sim, w, h, centerShiftX = 0, avoidPoints = null) {
  if (!sim.active || !sim.active.def.hasShock) return [0, 0, 0, 0];
  const p = sim.active.elapsed / sim.active.duration;
  if (p < 0.16 || p > 0.86) return [0, 0, 0, 0];
  const pos = getEventScreenPosition(sim, w, h, centerShiftX, avoidPoints);
  if (!pos) return [0, 0, 0, 0];
  const aspect = w / Math.max(h, 1);
  const sp = (p - 0.16) / 0.70;
  // Distant events ripple only locally around their far-away epicenter; focused view shows full lensing
  const radiusMul = 0.24 + pos.focusProgress * 0.76;
  const strengthMul = 0.20 + pos.focusProgress * 0.72;
  return [
    (pos.x / w - 0.5) * aspect,
    0.5 - pos.y / h,
    sp * 0.62 * pos.scale * radiusMul,
    Math.sin(sp * Math.PI) * strengthMul,
  ];
}
