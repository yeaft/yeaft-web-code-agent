/**
 * Yeaft Cosmos — Inverse-Distance Cosmic Event Scheduler, Physical Telemetry & Telescope Controller
 *
 * Guarantees:
 * - Strict inverse-distance scaling (`apparentRadius ∝ 1 / effDist`, `distantScale ∝ 1 / distanceLy`):
 *   farther events appear proportionally smaller and more locked to the deep skybox; zooming
 *   the telescope halves effective optical distance and doubles apparent radius smoothly on a
 *   logarithmic approach curve.
 * - Events never overwrite the foreground Solar System: spontaneous events emerge softly in
 *   peripheral deep-sky quadrants behind the planets (authentic 3D depth occlusion), with
 *   smooth precursor build-up and graceful afterglow fade-out.
 * - Random events default to non-intrusive deep-sky unfolding (`autoZoom: false`) so they
 *   never abruptly hijack the user's Solar System workspace; clicking the event, its subtle
 *   beacon, or the top Observe button smoothly slews the telescope in and returns on exit.
 */

export const MIN_EVENT_INTERVAL_SEC = 75;
export const MAX_EVENT_INTERVAL_SEC = 165;
export const INITIAL_EVENT_MIN_SEC = 45;
export const INITIAL_EVENT_MAX_SEC = 95;

export const EVENT_DISTANT_MIN_SCALE = 0.16;
export const EVENT_DISTANT_MAX_SCALE = 0.44;
export const EVENT_CAMERA_RETURN_EPS = 0.015;

const DIST_NORM_MIN = 2.2;
const DIST_NORM_MAX = 6.0;
const DIST_SCALE_NUMERATOR = DIST_NORM_MIN * EVENT_DISTANT_MAX_SCALE; // 0.968 -> exact 0.44 at d=2.2, 0.161 at d=6.0
const DIST_LY_PER_NORM = 520;

export const COSMIC_EVENTS = Object.freeze([
  {
    id: 'supernova',
    eventType: 0,
    swatch: '#78d2ff',
    glowRgb: [0.42, 0.80, 1.0],
    duration: 21,
    defaultZoom: 1.55,
    hasShock: true,
    hasLens: false,
    intrinsicRadius: 0.45,
    obsDist: 1.72,
    unit: 'ly',
    unitScale: 420,
    baseAngle: 0.18,
    anchor: { x: 0.68, y: 0.30 },
  },
  {
    id: 'planet-shatter',
    eventType: 1,
    swatch: '#ff8a4c',
    glowRgb: [1.0, 0.56, 0.24],
    duration: 20,
    defaultZoom: 1.65,
    hasShock: true,
    hasLens: false,
    intrinsicRadius: 0.40,
    obsDist: 1.62,
    unit: 'AU',
    unitScale: 1.9,
    baseAngle: -0.14,
    anchor: { x: 0.30, y: 0.62 },
  },
  {
    id: 'blackhole-birth',
    eventType: 2,
    swatch: '#f6ba64',
    glowRgb: [1.0, 0.72, 0.36],
    duration: 22,
    defaultZoom: 1.60,
    hasShock: true,
    hasLens: true,
    intrinsicRadius: 0.43,
    obsDist: 1.64,
    unit: 'ly',
    unitScale: 780,
    baseAngle: -0.22,
    anchor: { x: 0.64, y: 0.46 },
  },
  {
    id: 'kilonova',
    eventType: 3,
    swatch: '#9cb8ff',
    glowRgb: [0.58, 0.84, 1.0],
    duration: 21,
    defaultZoom: 1.55,
    hasShock: true,
    hasLens: true,
    intrinsicRadius: 0.43,
    obsDist: 1.66,
    unit: 'Mly',
    unitScale: 21,
    baseAngle: 0.24,
    anchor: { x: 0.34, y: 0.32 },
  },
  {
    id: 'solar-flare',
    eventType: 4,
    swatch: '#ffad48',
    glowRgb: [1.0, 0.62, 0.22],
    duration: 19,
    defaultZoom: 1.50,
    hasShock: false,
    hasLens: false,
    intrinsicRadius: 0.40,
    obsDist: 1.62,
    unit: 'ly',
    unitScale: 145,
    baseAngle: -0.58,
    anchor: { x: 0.70, y: 0.34 },
  },
  {
    id: 'gamma-burst',
    eventType: 5,
    swatch: '#c89bff',
    glowRgb: [0.74, 0.56, 1.0],
    duration: 20,
    defaultZoom: 1.50,
    hasShock: true,
    hasLens: false,
    intrinsicRadius: 0.43,
    obsDist: 1.66,
    unit: 'Mly',
    unitScale: 52,
    baseAngle: -0.52,
    anchor: { x: 0.72, y: 0.54 },
  },
  {
    id: 'tidal-disruption',
    eventType: 6,
    swatch: '#ff9668',
    glowRgb: [1.0, 0.58, 0.30],
    duration: 21,
    defaultZoom: 1.60,
    hasShock: false,
    hasLens: true,
    intrinsicRadius: 0.42,
    obsDist: 1.60,
    unit: 'Mly',
    unitScale: 11.5,
    baseAngle: -0.18,
    anchor: { x: 0.32, y: 0.40 },
  },
  {
    id: 'comet-breakup',
    eventType: 7,
    swatch: '#7ceeff',
    glowRgb: [0.46, 0.88, 1.0],
    duration: 19,
    defaultZoom: 1.50,
    hasShock: false,
    hasLens: false,
    intrinsicRadius: 0.37,
    obsDist: 1.46,
    unit: 'AU',
    unitScale: 0.32,
    baseAngle: 0.08,
    anchor: { x: 0.46, y: 0.28 },
  },
]);

/**
 * 8-sector peripheral deep-sky ring surrounding the Solar System (clockwise from North).
 * Keeps distant phenomena clearly outside the central solar ecliptic and away from
 * the top-center event pill, top-right corner actions, and deep-sky portals.
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

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function easeOutCubic(t) {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

/**
 * Sample a random 3D deep-sky location around the outer skybox (never overlapping the
 * central Solar System). Enforces strict inverse-distance scaling (`distantScale ∝ 1 / distanceLy`).
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

  // Sample depth with a slight mid-far bias so spontaneous events feel poised and unobtrusive.
  const rawDepth = clamp(rng(), 0, 1);
  const depth = Math.pow(rawDepth, 0.85);
  // Physical normalized distance d in [2.2, 6.0]: apparent scale = 0.968 / d (strict 1/d law!).
  const distNorm = DIST_NORM_MIN + depth * (DIST_NORM_MAX - DIST_NORM_MIN);
  const distantScale = Number(clamp(DIST_SCALE_NUMERATOR / distNorm, EVENT_DISTANT_MIN_SCALE, EVENT_DISTANT_MAX_SCALE).toFixed(3));
  const distanceLy = Math.round(distNorm * DIST_LY_PER_NORM);

  const yaw = Number((sector.yaw + (0.5 - x) * 0.24).toFixed(3));
  const pitch = Number((sector.pitch + (y - 0.5) * 0.18).toFixed(3));
  const elevDeg = Math.round((0.5 - y) * 76);

  return {
    sector: sector.id,
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    depth: Number(depth.toFixed(3)),
    distNorm: Number(distNorm.toFixed(3)),
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

/**
 * Format event-specific astronomical distance readout (AU / ly / Mly) scaled by effective distance.
 */
export function formatEventPhysicalDistance(def, effDist, isEn = false) {
  if (!def) return formatEventDistance(1200, isEn);
  const d = Math.max(0.15, Number(effDist) || def.obsDist || 1.6);
  const val = d * (def.unitScale || 420);
  if (def.unit === 'AU') {
    return `${val.toFixed(2)} AU`;
  }
  if (def.unit === 'Mly') {
    const m = Math.max(1, Math.round(val));
    return isEn ? `${m} Mly` : `${m} 百万光年`;
  }
  return formatEventDistance(val, isEn);
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
    autoZoom: opts.autoZoom === true,
    // Smooth telescope camera transition state (returns cleanly to 0 / 1.0 after observation)
    focusProgress: 0,
    fovZoom: 1.0,
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
    if (sim.active.elapsed / sim.active.duration > 0.84) {
      sim.active.elapsed = sim.active.duration * 0.14;
    }
    return sim.active;
  }

  const location = pickRandomDistantLocation(sim.lastSector, rng);
  sim.lastPlayedIdx = idx;
  sim.lastSector = location.sector;
  sim.lastLocation = location;
  sim.nextIdx = pickRandomEventIndex(idx, rng);
  sim.countdown = pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
  const effectiveObserve = shouldFocus || (autoZoom === true);
  const ambientDist = def.obsDist / Math.max(location.distantScale, 0.1);

  sim.active = {
    def,
    location,
    elapsed: 0.01,
    duration: def.duration,
    paused: false,
    targetZoom: def.defaultZoom,
    observing: effectiveObserve,
    ambientDist,
    effDist: ambientDist,
    angle: def.baseAngle + (effectiveObserve ? 0 : (rng() - 0.5) * 0.42),
    seed: Number(rng().toFixed(4)),
  };
  return sim.active;
}

/** Slew the telescope in to observe the currently unfolding distant event. */
export function focusActiveCosmicEvent(sim) {
  if (!sim.active) return null;
  sim.active.observing = true;
  sim.active.paused = false;
  sim.active.targetZoom = Math.max(sim.active.targetZoom || 1.0, sim.active.def.defaultZoom);
  if (sim.active.duration > 0 && sim.active.elapsed / sim.active.duration > 0.84) {
    sim.active.elapsed = sim.active.duration * 0.14;
  }
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

export function scrubCosmicEvent(sim, frac) {
  if (!sim.active) return;
  const clamped = clamp(Number(frac) || 0, 0.005, 0.99);
  sim.active.elapsed = clamped * sim.active.duration;
}

export function tickCosmicEvents(
  sim,
  dt,
  {
    showCountdown = true,
    autoEnabled = true,
    autoZoom = sim.autoZoom === true,
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
  const focusRate = isObserving ? 3.0 : 2.5;
  sim.focusProgress += (goalFocus - sim.focusProgress) * Math.min(1, camStep * focusRate);
  if (Math.abs(sim.focusProgress - goalFocus) < 0.002) {
    sim.focusProgress = goalFocus;
  }

  const loc = sim.active?.location || sim.lastLocation;
  const goalZoom = isObserving ? sim.active.targetZoom : 1.0;
  sim.fovZoom += (goalZoom - sim.fovZoom) * Math.min(1, camStep * (isObserving ? 3.8 : 3.2));

  const goalYaw = isObserving && loc ? loc.yaw : 0;
  const goalPitch = isObserving && loc ? loc.pitch : 0;
  sim.camYawOffset += (goalYaw - sim.camYawOffset) * Math.min(1, camStep * 3.1);
  sim.camPitchOffset += (goalPitch - sim.camPitchOffset) * Math.min(1, camStep * 3.1);

  if (sim.active) {
    const f = easeOutCubic(sim.focusProgress || 0);
    const distantScale = typeof loc?.distantScale === 'number' ? loc.distantScale : 0.28;
    const ambientDist = sim.active.def.obsDist / Math.max(distantScale, 0.1);
    const focusedDist = sim.active.def.obsDist / Math.max(0.75, sim.fovZoom || 1.0);
    sim.active.ambientDist = ambientDist;
    sim.active.effDist = Math.exp(
      Math.log(Math.max(ambientDist, 0.2)) * (1 - f) + Math.log(Math.max(focusedDist, 0.2)) * f,
    );
  }
}

/**
 * Compute viewport coordinates and strict inverse-distance perspective scale for the active event.
 * - At `focusProgress === 0`: `scale === distantScale = obsDist / ambientDist`, strictly inversely
 *   proportional to distance (`scale(2d) = 0.5 * scale(d)`).
 * - As `focusProgress -> 1`: effective optical distance interpolates logarithmically to
 *   `obsDist / fovZoom`, gliding the phenomenon smoothly to the telescope center.
 */
export function getEventScreenPosition(sim, w, h, centerShiftX = 0, avoidPoints = null, camRot = null, parallax = null) {
  if (!sim.active) return null;
  const def = sim.active.def;
  const loc = sim.active.location || def.anchor;
  const safeW = Math.max(w || 1, 1);
  const safeH = Math.max(h || 1, 1);
  const isCompact = safeW < 768 || Math.min(safeW, safeH) < 600;
  const f = easeOutCubic(sim.focusProgress || 0);

  const distantScale = typeof loc.distantScale === 'number' ? loc.distantScale : 0.30;
  const focusedScale = Math.max(0.75, sim.fovZoom || 1.0);
  const ambientDist = (def.obsDist || 1.6) / Math.max(distantScale, 0.1);
  const focusedDist = (def.obsDist || 1.6) / focusedScale;
  // Exact logarithmic inverse-distance interpolation: equals distantScale at f=0 and focusedScale at f=1.
  const effDist = Math.exp(Math.log(ambientDist) * (1 - f) + Math.log(focusedDist) * f);
  const scale = (def.obsDist || 1.6) / effDist;

  // Depth-dependent skybox parallax (farther events stay more locked to the background Milky Way).
  const pDepth = clamp(1.1 / Math.max(effDist, 1.0), 0.08, 0.45) * (1 - f);
  const skyShiftX = camRot || parallax
    ? (-(camRot?.x || 0) * 0.16 - (parallax?.x || 0) * 0.022) * safeW * pDepth
    : 0;
  const skyShiftY = camRot || parallax
    ? (-(camRot?.y || 0) * 0.12 - (parallax?.y || 0) * 0.018) * safeH * pDepth
    : 0;

  const marginX = isCompact ? 68 : 104;
  const marginTop = 84;
  const marginBottom = isCompact ? 96 : 74;
  let restX = clamp(loc.x * safeW + centerShiftX * 0.25 + skyShiftX, marginX, Math.max(marginX, safeW - marginX));
  let restY = clamp(loc.y * safeH + skyShiftY, marginTop, Math.max(marginTop, safeH - marginBottom));

  if (Array.isArray(avoidPoints) && avoidPoints.length > 0) {
    const minClear = isCompact ? 92 : 126;
    for (const pt of avoidPoints) {
      if (!pt) continue;
      const dx = restX - pt.x;
      const dy = restY - pt.y;
      const dist = Math.hypot(dx, dy);
      if (dist < minClear) {
        const pushX = pt.x < safeW * 0.5 ? 1 : -1;
        const pushY = pt.y < safeH * 0.5 ? 0.35 : -0.35;
        const pLen = Math.hypot(pushX, pushY) || 1;
        const shift = minClear - dist + 8;
        restX = clamp(restX + (pushX / pLen) * shift, marginX, Math.max(marginX, safeW - marginX));
        restY = clamp(restY + (pushY / pLen) * shift, marginTop, Math.max(marginTop, safeH - marginBottom));
      }
    }
  }

  const centerX = safeW * 0.5 + centerShiftX * 0.55;
  const centerY = safeH * 0.5;

  const x = restX + (centerX - restX) * f;
  const y = restY + (centerY - restY) * f;

  const minDim = Math.min(safeW, safeH);
  const eventRadiusPx = ((def.intrinsicRadius || 0.42) / effDist) * minDim;

  return {
    x,
    y,
    restX,
    restY,
    scale,
    distantScale,
    effDist,
    ambientDist,
    eventRadiusPx,
    focusProgress: f,
    isDistant: f < 0.35,
    sector: loc.sector || 'ne',
    distanceLy: loc.distanceLy || 1200,
    depth: typeof loc.depth === 'number' ? loc.depth : 0.5,
  };
}

/**
 * Compute complete WebGL shader + GPU particle + HUD render frame descriptor.
 */
export function computeEventFrame(
  sim,
  w,
  h,
  centerShiftX = 0,
  avoidPoints = null,
  visibilityAlpha = 1.0,
  camRot = null,
  parallax = null,
) {
  if (!sim.active || visibilityAlpha <= 0.005) return null;
  const pos = getEventScreenPosition(sim, w, h, centerShiftX, avoidPoints, camRot, parallax);
  if (!pos) return null;

  const ev = sim.active;
  const def = ev.def;
  const p = clamp(ev.elapsed / ev.duration, 0, 1);
  const obs = pos.focusProgress;

  // Subtle depth attenuation when very distant so far-away events blend organically into deep space.
  const distCrisp = clamp(0.76 + (1.35 / Math.max(pos.effDist, 1.0)) * 0.24, 0.78, 1.0);
  const alpha = clamp(visibilityAlpha * (obs + (1.0 - obs) * distCrisp), 0, 1);

  let quadPad = 2.45;
  if (def.id === 'gamma-burst') quadPad = 4.4;
  else if (def.id === 'solar-flare') quadPad = 3.6;
  else if (def.id === 'comet-breakup') quadPad = 2.85;
  else if (def.id === 'blackhole-birth' || def.id === 'tidal-disruption') quadPad = 2.65;

  const quadRadiusPx = Math.min(Math.max(w, h) * 1.15, Math.max(38, pos.eventRadiusPx * quadPad));
  const sunRadiusPx = pos.eventRadiusPx * 0.34;
  // Distant events live behind Solar System planets; zoomed-in observation renders cleanly in front.
  const layer = obs > 0.72 ? 'local' : 'deep';

  return {
    ...pos,
    id: def.id,
    eventType: def.eventType,
    layer,
    quadRadiusPx,
    sunRadiusPx,
    progress: p,
    elapsed: ev.elapsed,
    alpha,
    obsBlend: obs,
    distNorm: pos.effDist,
    angle: typeof ev.angle === 'number' ? ev.angle : (def.baseAngle || 0),
    seed: typeof ev.seed === 'number' ? ev.seed : 0.42,
    def,
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

export function getEventLens(evDraw, w, h) {
  if (!evDraw || evDraw.alpha <= 0.01) return [0, 0, 0, 0];
  const aspect = w / Math.max(h, 1);
  const nx = (evDraw.x / Math.max(w, 1) - 0.5) * aspect;
  const ny = 0.5 - evDraw.y / Math.max(h, 1);
  const radNorm = evDraw.eventRadiusPx / Math.max(h, 1);

  if (!evDraw.def?.hasLens) {
    return [nx, ny, radNorm * 0.65, 0.0];
  }

  const p = evDraw.progress;
  let lensStr = 0;
  let rsNorm = radNorm * 0.25;
  if (evDraw.id === 'blackhole-birth') {
    const birthP = Math.max(0, (p - 0.22) / 0.78);
    lensStr = smoothstep(0.0, 0.16, birthP) * smoothstep(1.0, 0.76, p) * 0.92;
    rsNorm = radNorm * 0.25 * smoothstep(0.0, 0.18, birthP);
  } else if (evDraw.id === 'tidal-disruption') {
    lensStr = smoothstep(0.0, 0.16, p) * smoothstep(1.0, 0.76, p) * 0.84;
    rsNorm = radNorm * 0.21;
  } else if (evDraw.id === 'kilonova') {
    const mPeak = p >= 0.36 ? Math.exp(-Math.pow((p - 0.44) / 0.14, 2)) * smoothstep(0.36, 0.42, p) : 0;
    lensStr = mPeak * 0.38;
    rsNorm = radNorm * 0.16;
  }
  return [nx, ny, rsNorm, lensStr * evDraw.alpha];
}

export function getEventAmbient(evDraw) {
  if (!evDraw || evDraw.alpha <= 0.01) return [0, 0, 0, 0];
  const p = evDraw.progress;
  const env = smoothstep(0.0, 0.16, p) * smoothstep(1.0, 0.74, p);
  const peak = evDraw.id === 'supernova'
    ? (0.42 + 0.85 * Math.exp(-Math.pow((p - 0.23) / 0.10, 2)))
    : (evDraw.id === 'kilonova'
      ? (0.36 + 0.75 * Math.exp(-Math.pow((p - 0.43) / 0.11, 2)))
      : (evDraw.id === 'gamma-burst'
        ? (0.48 + 0.65 * Math.exp(-Math.pow((p - 0.28) / 0.14, 2)))
        : 0.42));
  const [r, g, b] = evDraw.def?.glowRgb || [0.5, 0.8, 1.0];
  const strength = env * peak * evDraw.alpha * (0.38 + 0.62 * evDraw.obsBlend);
  return [r, g, b, strength];
}

export function getEventShockWave(sim, w, h, centerShiftX = 0, avoidPoints = null, visibilityAlpha = 1.0, camRot = null, parallax = null) {
  if (!sim.active || !sim.active.def.hasShock || visibilityAlpha <= 0.01) return [0, 0, 0, 0];
  const p = sim.active.elapsed / sim.active.duration;
  const startP = sim.active.def.id === 'kilonova' ? 0.36 : 0.18;
  if (p < startP || p > 0.90) return [0, 0, 0, 0];
  const pos = getEventScreenPosition(sim, w, h, centerShiftX, avoidPoints, camRot, parallax);
  if (!pos) return [0, 0, 0, 0];
  const aspect = w / Math.max(h, 1);
  const sp = (p - startP) / (0.90 - startP);
  const maxR = (pos.eventRadiusPx / Math.max(h, 1)) * 2.1;
  const amp = Math.sin(sp * Math.PI) * (0.30 + 0.56 * pos.focusProgress) * clamp(maxR * 1.4, 0.20, 1.0) * clamp(visibilityAlpha, 0, 1);
  return [
    (pos.x / w - 0.5) * aspect,
    0.5 - pos.y / h,
    sp * maxR,
    amp,
  ];
}
