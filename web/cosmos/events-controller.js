/**
 * Yeaft Cosmos — Multi-Event Staggered Scheduler, Distance-Correlated Cinematic Approach
 * & Shared-Canvas Telescope Controller
 *
 * Guarantees:
 * - Multiple cosmic events (up to MAX_CONCURRENT_EVENTS = 3) can unfold simultaneously on
 *   independent, staggered timelines in non-overlapping sky quadrants (never starting all at once).
 * - Strict inverse-distance scaling (`apparentRadius ∝ 1 / effDist`, `distantScale ∝ 1 / distanceLy`):
 *   farther events appear proportionally smaller and more locked to the deep skybox.
 * - Slower, distance-correlated S-curve approach (`easeInOutQuint`): local AU events glide in
 *   ~2.0s, galactic ly events in ~2.8s, extragalactic Mly events in ~3.3s with proportional
 *   deep-space star-warp and continuous logarithmic distance closure.
 * - Shared canvas with the Solar System: flying to an event smoothly pans the Solar System aside
 *   on the exact same canvas (no black-screen cut), supports 360° 3D drag orbit inspection, and
 *   scrolling out smoothly flies back to the Solar System while active events keep unfolding.
 */

export const MIN_EVENT_INTERVAL_SEC = 75;
export const MAX_EVENT_INTERVAL_SEC = 165;
export const INITIAL_EVENT_MIN_SEC = 45;
export const INITIAL_EVENT_MAX_SEC = 95;
export const OVERLAP_EVENT_MIN_SEC = 18;
export const OVERLAP_EVENT_MAX_SEC = 42;
export const MAX_CONCURRENT_EVENTS = 3;

export const EVENT_DISTANT_MIN_SCALE = 0.065;
export const EVENT_DISTANT_MAX_SCALE = 0.20;
export const EVENT_CAMERA_RETURN_EPS = 0.015;

const DIST_NORM_MIN = 3.2;
const DIST_NORM_MAX = 9.8;
const DIST_SCALE_NUMERATOR = DIST_NORM_MIN * EVENT_DISTANT_MAX_SCALE; // 0.64 -> 0.20 at d=3.2, 0.0653 at d=9.8
const DIST_LY_PER_NORM = 460;

function getUnitDepthBias(unit) {
  if (unit === 'Mly') return 0.72; // farther deep-sky extragalactic band
  if (unit === 'AU') return 0.20;  // nearer outer/inner Solar System band
  return 0.45;                     // mid-far galactic band
}

export const COSMIC_EVENTS = Object.freeze([
  {
    id: 'supernova',
    eventType: 0,
    layer: 'deep',
    swatch: '#78d2ff',
    glowRgb: [0.42, 0.80, 1.0],
    duration: 24,
    defaultZoom: 1.82,
    hasShock: true,
    hasLens: false,
    intrinsicRadius: 0.46,
    obsDist: 1.66,
    unit: 'ly',
    unitScale: 420,
    baseAngle: 0.18,
    anchor: { x: 0.68, y: 0.30 },
  },
  {
    id: 'planet-shatter',
    eventType: 1,
    layer: 'local',
    swatch: '#ff8a4c',
    glowRgb: [1.0, 0.56, 0.24],
    duration: 22,
    defaultZoom: 1.88,
    hasShock: true,
    hasLens: false,
    intrinsicRadius: 0.42,
    obsDist: 1.58,
    unit: 'AU',
    unitScale: 1.9,
    baseAngle: -0.14,
    anchor: { x: 0.30, y: 0.62 },
  },
  {
    id: 'blackhole-birth',
    eventType: 2,
    layer: 'deep',
    swatch: '#f6ba64',
    glowRgb: [1.0, 0.72, 0.36],
    duration: 25,
    defaultZoom: 1.86,
    hasShock: true,
    hasLens: true,
    intrinsicRadius: 0.45,
    obsDist: 1.60,
    unit: 'ly',
    unitScale: 780,
    baseAngle: -0.22,
    anchor: { x: 0.64, y: 0.46 },
  },
  {
    id: 'kilonova',
    eventType: 3,
    layer: 'deep',
    swatch: '#9cb8ff',
    glowRgb: [0.58, 0.84, 1.0],
    duration: 24,
    defaultZoom: 1.82,
    hasShock: true,
    hasLens: true,
    intrinsicRadius: 0.44,
    obsDist: 1.62,
    unit: 'Mly',
    unitScale: 21,
    baseAngle: 0.24,
    anchor: { x: 0.34, y: 0.32 },
  },
  {
    id: 'solar-flare',
    eventType: 4,
    layer: 'deep',
    swatch: '#ffad48',
    glowRgb: [1.0, 0.62, 0.22],
    duration: 21,
    defaultZoom: 1.78,
    hasShock: false,
    hasLens: false,
    intrinsicRadius: 0.42,
    obsDist: 1.58,
    unit: 'ly',
    unitScale: 145,
    baseAngle: -0.58,
    anchor: { x: 0.70, y: 0.34 },
  },
  {
    id: 'gamma-burst',
    eventType: 5,
    layer: 'deep',
    swatch: '#c89bff',
    glowRgb: [0.74, 0.56, 1.0],
    duration: 23,
    defaultZoom: 1.76,
    hasShock: true,
    hasLens: false,
    intrinsicRadius: 0.44,
    obsDist: 1.62,
    unit: 'Mly',
    unitScale: 52,
    baseAngle: -0.52,
    anchor: { x: 0.72, y: 0.54 },
  },
  {
    id: 'tidal-disruption',
    eventType: 6,
    layer: 'deep',
    swatch: '#ff9668',
    glowRgb: [1.0, 0.58, 0.30],
    duration: 24,
    defaultZoom: 1.84,
    hasShock: false,
    hasLens: true,
    intrinsicRadius: 0.44,
    obsDist: 1.56,
    unit: 'Mly',
    unitScale: 11.5,
    baseAngle: -0.18,
    anchor: { x: 0.32, y: 0.40 },
  },
  {
    id: 'comet-breakup',
    eventType: 7,
    layer: 'local',
    swatch: '#7ceeff',
    glowRgb: [0.46, 0.88, 1.0],
    duration: 21,
    defaultZoom: 1.74,
    hasShock: false,
    hasLens: false,
    intrinsicRadius: 0.39,
    obsDist: 1.44,
    unit: 'AU',
    unitScale: 0.32,
    baseAngle: 0.08,
    anchor: { x: 0.46, y: 0.28 },
  },
]);

/**
 * 8-sector peripheral deep-sky ring surrounding the Solar System (clockwise from North).
 */
const DISTANT_SECTORS = Object.freeze([
  { id: 'n',  x: 0.50, y: 0.13, jitterX: 0.08, jitterY: 0.02,  yaw:  0.00, pitch: -0.28, azDeg:   0 },
  { id: 'ne', x: 0.87, y: 0.18, jitterX: 0.04, jitterY: 0.035, yaw: -0.42, pitch: -0.24, azDeg:  45 },
  { id: 'e',  x: 0.91, y: 0.48, jitterX: 0.025, jitterY: 0.07, yaw: -0.50, pitch:  0.02, azDeg:  90 },
  { id: 'se', x: 0.78, y: 0.86, jitterX: 0.045, jitterY: 0.025, yaw: -0.36, pitch:  0.26, azDeg: 135 },
  { id: 's',  x: 0.50, y: 0.88, jitterX: 0.08, jitterY: 0.02,  yaw:  0.00, pitch:  0.29, azDeg: 180 },
  { id: 'sw', x: 0.22, y: 0.86, jitterX: 0.045, jitterY: 0.025, yaw:  0.36, pitch:  0.26, azDeg: 225 },
  { id: 'w',  x: 0.11, y: 0.62, jitterX: 0.025, jitterY: 0.06, yaw:  0.48, pitch:  0.08, azDeg: 270 },
  { id: 'nw', x: 0.22, y: 0.16, jitterX: 0.045, jitterY: 0.03, yaw:  0.36, pitch: -0.24, azDeg: 315 },
]);

let eventUidSeq = 1;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smooth cubic S-curve for immediate yet graceful "approaching from afar" camera flight. */
export function easeInOutQuint(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5
    ? 4 * x * x * x
    : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Compute normalized cosmological distance depth in [0.18, 1.0]:
 * - Local AU events: ~0.22 - 0.38 (closer, faster approach, stronger parallax)
 * - Galactic ly events: ~0.54 - 0.76 (mid-depth Milky Way voyage)
 * - Extragalactic Mly events: ~0.78 - 1.00 (longest deep-space approach & star-warp)
 */
export function computeEventDistDepth(def, location) {
  const localDepth = clamp(typeof location?.depth === 'number' ? location.depth : 0.5, 0, 1);
  if (def?.unit === 'AU') return Number((0.20 + localDepth * 0.18).toFixed(3));
  if (def?.unit === 'Mly') return Number((0.78 + localDepth * 0.22).toFixed(3));
  return Number((0.52 + localDepth * 0.24).toFixed(3));
}

/**
 * Distance-correlated flight duration in seconds.
 * Farther phenomena take noticeably longer to fly to so the user feels traversing real space.
 */
export function computeEventFlightDuration(distDepth, returning = false) {
  const d = clamp(Number(distDepth) || 0.55, 0.15, 1.0);
  if (returning) return Number((1.35 + d * 0.90).toFixed(2));
  return Number((1.65 + d * 1.70).toFixed(2));
}

/**
 * Sample a random 3D deep-sky location around the outer skybox (never overlapping the
 * central Solar System or any excluded sectors). Enforces strict inverse-distance scaling.
 */
export function pickRandomDistantLocation(excludeSectors = null, rng = Math.random, unit = null) {
  const excluded = new Set(
    Array.isArray(excludeSectors)
      ? excludeSectors.filter(Boolean)
      : (excludeSectors ? [excludeSectors] : []),
  );
  const available = DISTANT_SECTORS.filter((s) => !excluded.has(s.id));
  const pool = available.length > 0 ? available : DISTANT_SECTORS;
  const sector = pool[Math.floor(rng() * pool.length) % pool.length];

  const jx = (rng() * 2 - 1) * sector.jitterX;
  const jy = (rng() * 2 - 1) * sector.jitterY;
  const x = clamp(sector.x + jx, 0.08, 0.92);
  const y = clamp(sector.y + jy, 0.11, 0.89);

  // Mid-far depth distribution, biased by astronomical scale (AU nearer, ly mid, Mly farthest).
  const rawDepth = clamp(rng(), 0, 1);
  const depth = unit
    ? clamp(getUnitDepthBias(unit) * 0.55 + Math.pow(rawDepth, 0.85) * 0.55, 0.04, 1.0)
    : Math.pow(rawDepth, 0.85);
  // Physical normalized distance d in [3.2, 9.8]: apparent scale = 0.64 / d (strict 1/d law).
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

export function pickRandomEventIndex(excludeIndices = -1, rng = Math.random) {
  const n = COSMIC_EVENTS.length;
  if (n <= 1) return 0;
  const excluded = new Set(
    Array.isArray(excludeIndices)
      ? excludeIndices
      : (typeof excludeIndices === 'number' && excludeIndices >= 0 ? [excludeIndices] : []),
  );
  const candidates = [];
  for (let i = 0; i < n; i++) {
    if (!excluded.has(i)) candidates.push(i);
  }
  const pool = candidates.length > 0 ? candidates : Array.from({ length: n }, (_, i) => i);
  return pool[Math.floor(rng() * pool.length) % pool.length];
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

function syncActivePointer(sim) {
  if (!Array.isArray(sim.events)) sim.events = [];
  const focused = sim.events.find((e) => e.observing && !e.exiting) || null;
  if (focused) {
    sim.active = focused;
    sim.focusedUid = focused.uid;
    return focused;
  }
  const live = sim.events.filter((e) => !e.exiting);
  sim.active = live.length > 0 ? live[live.length - 1] : null;
  sim.focusedUid = null;
  return sim.active;
}

export function createCosmicEventState(opts = {}) {
  const rng = opts.rng || Math.random;
  const firstIdx = pickRandomEventIndex(-1, rng);
  return {
    events: [],
    active: null,
    focusedUid: null,
    lastFocusedUid: null,
    nextIdx: firstIdx,
    lastPlayedIdx: -1,
    lastSector: null,
    countdown: pickRandomCooldownSec(INITIAL_EVENT_MIN_SEC, INITIAL_EVENT_MAX_SEC, rng),
    autoEnabled: opts.autoEnabled !== false,
    autoZoom: opts.autoZoom === true,
    // Smooth distance-correlated S-curve camera flight state
    flightT: 0,
    focusProgress: 0,
    fovZoom: 1.0,
    camYawOffset: 0,
    camPitchOffset: 0,
    lastLocation: null,
    lastDistDepth: 0.6,
    hoveredUid: null,
    exitCooldownUntil: 0,
  };
}

function getExcludedIndices(sim) {
  const indices = [];
  if (sim.lastPlayedIdx >= 0) indices.push(sim.lastPlayedIdx);
  for (const ev of (sim.events || [])) {
    const i = COSMIC_EVENTS.findIndex((c) => c.id === ev.def.id);
    if (i >= 0) indices.push(i);
  }
  return indices;
}

function getExcludedSectors(sim) {
  const sectors = [];
  if (sim.lastSector) sectors.push(sim.lastSector);
  for (const ev of (sim.events || [])) {
    if (ev.location?.sector) sectors.push(ev.location.sector);
  }
  return sectors;
}

export function startCosmicEvent(
  sim,
  eventId = null,
  { observe = false, autoZoom = null, rng = Math.random } = {},
) {
  if (!Array.isArray(sim.events)) sim.events = [];
  let idx = eventId ? COSMIC_EVENTS.findIndex((e) => e.id === eventId) : sim.nextIdx;
  if (idx < 0 || idx >= COSMIC_EVENTS.length) idx = pickRandomEventIndex(getExcludedIndices(sim), rng);
  const def = COSMIC_EVENTS[idx];
  const shouldFocus = Boolean(observe);

  // Focusing an already-running event flies smoothly to its existing coordinates without restarting others
  const existing = sim.events.find((e) => !e.exiting && e.def.id === def.id);
  if (existing) {
    if (shouldFocus) {
      for (const other of sim.events) {
        if (other !== existing) other.observing = false;
      }
      existing.observing = true;
      existing.paused = false;
      existing.targetZoom = Math.max(existing.targetZoom || 1.0, def.defaultZoom);
      if (existing.elapsed / existing.duration > 0.84) {
        existing.elapsed = existing.duration * 0.14;
      }
      sim.lastLocation = existing.location;
      sim.lastDistDepth = existing.distDepth;
      sim.lastFocusedUid = existing.uid;
    }
    syncActivePointer(sim);
    return existing;
  }

  // Enforce concurrency cap by gracefully evicting the oldest non-observed ambient event
  if (sim.events.length >= MAX_CONCURRENT_EVENTS) {
    const dropIdx = sim.events.findIndex((e) => !e.observing);
    if (dropIdx >= 0) sim.events.splice(dropIdx, 1);
  }

  const location = pickRandomDistantLocation(getExcludedSectors(sim), rng, def.unit);
  sim.lastPlayedIdx = idx;
  sim.lastSector = location.sector;
  const effectiveObserve = shouldFocus || (autoZoom === true);
  if (effectiveObserve) {
    for (const other of sim.events) other.observing = false;
    sim.lastLocation = location;
  } else if (!sim.lastLocation) {
    sim.lastLocation = location;
  }

  const ambientDist = def.obsDist / Math.max(location.distantScale, 0.04);
  const distDepth = computeEventDistDepth(def, location);
  const flightDuration = computeEventFlightDuration(distDepth, false);
  if (effectiveObserve) sim.lastDistDepth = distDepth;

  const instance = {
    uid: `ev_${eventUidSeq++}`,
    def,
    location,
    elapsed: 0.01,
    duration: def.duration,
    paused: false,
    zoom: effectiveObserve ? def.defaultZoom : 1.0,
    targetZoom: def.defaultZoom,
    observing: effectiveObserve,
    ambientDist,
    effDist: ambientDist,
    distDepth,
    flightDuration,
    angle: def.baseAngle + (effectiveObserve ? 0 : (rng() - 0.5) * 0.42),
    seed: Number(rng().toFixed(4)),
    viewYaw: 0,
    viewPitch: 0,
    targetViewYaw: 0,
    targetViewPitch: 0,
    exitFade: 1.0,
    exiting: false,
  };

  sim.events.push(instance);
  if (effectiveObserve) sim.lastFocusedUid = instance.uid;
  sim.nextIdx = pickRandomEventIndex(getExcludedIndices(sim), rng);
  // Schedule next staggered event (shorter overlap window if below concurrency cap)
  sim.countdown = sim.events.length < MAX_CONCURRENT_EVENTS
    ? pickRandomCooldownSec(OVERLAP_EVENT_MIN_SEC, OVERLAP_EVENT_MAX_SEC, rng)
    : pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
  syncActivePointer(sim);
  return instance;
}

/** Slew/fly the camera to observe a specific concurrent event by UID (or current primary active). */
export function focusCosmicEventByUid(sim, uid = null) {
  if (!Array.isArray(sim.events) || sim.events.length === 0) return null;
  const target = uid
    ? sim.events.find((e) => e.uid === uid && !e.exiting)
    : (sim.active && !sim.active.exiting ? sim.active : sim.events[sim.events.length - 1]);
  if (!target) return null;
  for (const other of sim.events) {
    if (other !== target) other.observing = false;
  }
  target.observing = true;
  target.paused = false;
  target.targetZoom = Math.max(target.targetZoom || 1.0, target.def.defaultZoom);
  if (target.duration > 0 && target.elapsed / target.duration > 0.84) {
    target.elapsed = target.duration * 0.14;
  }
  sim.lastLocation = target.location;
  sim.lastDistDepth = target.distDepth;
  sim.lastFocusedUid = target.uid;
  syncActivePointer(sim);
  return target;
}

/** Slew the telescope in to observe the currently unfolding distant event. */
export function focusActiveCosmicEvent(sim) {
  return focusCosmicEventByUid(sim, sim.active?.uid || null);
}

/** Pull camera smoothly back to the Solar System while letting all active events finish in place. */
export function unfocusCosmicEvent(sim) {
  const focused = (sim.events || []).find((e) => e.observing);
  if (!focused) return false;
  focused.observing = false;
  focused.paused = false;
  focused.targetViewYaw = 0;
  focused.targetViewPitch = 0;
  sim.exitCooldownUntil = Date.now() + 320;
  syncActivePointer(sim);
  return true;
}

/** Immediately stop running/observed cosmic event(s) and smoothly return camera to the Solar System. */
export function stopCosmicEvent(sim, { uid = null, rng = Math.random } = {}) {
  if (!Array.isArray(sim.events)) sim.events = [];
  if (uid) {
    const idx = sim.events.findIndex((e) => e.uid === uid);
    if (idx < 0) return false;
    sim.events.splice(idx, 1);
    syncActivePointer(sim);
    return true;
  }
  const wasActive = sim.events.length > 0 || Boolean(sim.active);
  sim.events = [];
  sim.active = null;
  sim.focusedUid = null;
  sim.lastFocusedUid = null;
  sim.hoveredUid = null;
  sim.nextIdx = pickRandomEventIndex(sim.lastPlayedIdx, rng);
  sim.countdown = pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
  return wasActive;
}

export function setCosmicEventZoom(sim, zoom, { allowExit = false } = {}) {
  const target = (sim.events || []).find((e) => e.observing) || sim.active;
  if (!target) return { exited: false };
  const val = Number(zoom);
  if (allowExit && Number.isFinite(val) && val < 0.62) {
    unfocusCosmicEvent(sim);
    return { exited: true };
  }
  target.targetZoom = clamp(Number.isFinite(val) ? val : 1.0, 0.55, 4.5);
  return { exited: false };
}

export function setCosmicEventViewAngles(sim, yaw, pitch) {
  const target = (sim.events || []).find((e) => e.observing) || sim.active;
  if (!target) return;
  target.targetViewYaw = Number(yaw) || 0;
  target.targetViewPitch = clamp(Number(pitch) || 0, -0.88, 0.88);
}

export function resetCosmicEventView(sim) {
  const target = (sim.events || []).find((e) => e.observing) || sim.active;
  if (!target) return;
  target.targetViewYaw = 0;
  target.targetViewPitch = 0;
  target.targetZoom = target.def.defaultZoom;
}

export function scrubCosmicEvent(sim, frac) {
  const target = (sim.events || []).find((e) => e.observing) || sim.active;
  if (!target) return;
  const clamped = clamp(Number(frac) || 0, 0.005, 0.99);
  target.elapsed = clamped * target.duration;
}

export function getFlightWarpEnergy(sim) {
  const t = clamp(sim?.flightT || 0, 0, 1);
  if (t <= 0.01 || t >= 0.99) return 0;
  const distDepth = clamp(sim?.lastDistDepth ?? 0.6, 0.15, 1.0);
  return Math.sin(t * Math.PI) * (0.14 + 0.52 * distDepth);
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
    reducedMotion = false,
    rng = Math.random,
  } = {},
) {
  if (!Array.isArray(sim.events)) sim.events = [];
  sim.autoEnabled = Boolean(autoEnabled);
  sim.autoZoom = Boolean(autoZoom);

  // 1. Tick every concurrent event independently
  const remaining = [];
  let finishedAny = false;
  for (const ev of sim.events) {
    if (!ev.paused) {
      ev.elapsed += dt;
    }
    if (ev.elapsed >= ev.duration) {
      finishedAny = true;
      continue;
    }
    ev.zoom += (ev.targetZoom - ev.zoom) * Math.min(1, dt * 4.8);
    ev.viewYaw += ((ev.targetViewYaw || 0) - (ev.viewYaw || 0)) * Math.min(1, dt * 6.5);
    ev.viewPitch += ((ev.targetViewPitch || 0) - (ev.viewPitch || 0)) * Math.min(1, dt * 6.5);
    remaining.push(ev);
  }
  sim.events = remaining;
  if (finishedAny) {
    sim.nextIdx = pickRandomEventIndex(getExcludedIndices(sim), rng);
    if (sim.events.length === 0) {
      sim.countdown = pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
    }
  }

  // 2. Staggered spontaneous spawning (continues even while 1..2 events are already live!)
  if (showCountdown && autoEnabled && sim.events.length < MAX_CONCURRENT_EVENTS) {
    sim.countdown -= dt;
    if (sim.countdown <= 0) {
      const alreadyObserving = sim.events.some((e) => e.observing);
      startCosmicEvent(sim, null, {
        observe: Boolean(!alreadyObserving && autoZoom && canAutoZoom),
        rng,
      });
    }
  }

  const focused = sim.events.find((e) => e.observing) || null;
  syncActivePointer(sim);

  // 3. Slower, distance-correlated S-curve camera flight
  const camStep = Math.max(0, Number(cameraDt) || 0);
  const isObserving = Boolean(focused);
  const activeDepth = focused?.distDepth ?? sim.lastDistDepth ?? 0.6;
  const flightDur = reducedMotion
    ? 0.22
    : computeEventFlightDuration(activeDepth, !isObserving);

  const prevT = clamp(sim.flightT || 0, 0, 1);
  if (isObserving) {
    sim.flightT = Math.min(1, prevT + camStep / Math.max(flightDur, 0.05));
  } else {
    sim.flightT = Math.max(0, prevT - camStep / Math.max(flightDur, 0.05));
  }
  sim.focusProgress = easeInOutQuint(sim.flightT);
  if (sim.flightT <= 0.001) {
    sim.focusProgress = 0;
    if (!isObserving) sim.lastFocusedUid = null;
  }
  if (sim.flightT >= 0.999) sim.focusProgress = 1;

  const f = sim.focusProgress;
  const loc = focused?.location || sim.lastLocation;
  const goalZoom = isObserving ? focused.targetZoom : 1.0;
  sim.fovZoom += (goalZoom - sim.fovZoom) * Math.min(1, camStep * (isObserving ? 3.2 : 3.4));

  const goalYaw = isObserving && loc ? loc.yaw : 0;
  const goalPitch = isObserving && loc ? loc.pitch : 0;
  sim.camYawOffset = goalYaw * f;
  sim.camPitchOffset = goalPitch * f;

  // 4. Update each event's effective optical distance (logarithmic inverse-distance approach)
  for (const ev of sim.events) {
    const distantScale = typeof ev.location?.distantScale === 'number' ? ev.location.distantScale : 0.12;
    const ambientDist = ev.def.obsDist / Math.max(distantScale, 0.04);
    ev.ambientDist = ambientDist;
    if (ev.observing) {
      const focusedDist = ev.def.obsDist / Math.max(0.55, ev.zoom || sim.fovZoom || 1.0);
      ev.effDist = Math.exp(
        Math.log(Math.max(ambientDist, 0.2)) * (1 - f) + Math.log(Math.max(focusedDist, 0.2)) * f,
      );
    } else {
      ev.effDist = ambientDist;
    }
  }
}

/**
 * Compute viewport coordinates and strict inverse-distance perspective scale for a specific event.
 */
function computeSingleEventPosition(
  sim,
  ev,
  w,
  h,
  centerShiftX = 0,
  avoidPoints = null,
  camRot = null,
  parallax = null,
  solarZoom = 1.0,
  eventScaleMul = 1.0,
) {
  if (!ev) return null;
  const def = ev.def;
  const loc = ev.location || def.anchor;
  const safeW = Math.max(w || 1, 1);
  const safeH = Math.max(h || 1, 1);
  const isCompact = safeW < 768 || Math.min(safeW, safeH) < 600;
  const isFocused = Boolean(
    ev.observing
    || ((sim.focusProgress || 0) > 0 && (sim.lastFocusedUid ? ev.uid === sim.lastFocusedUid : ev === sim.active)),
  );
  const f = isFocused ? clamp(sim.focusProgress || 0, 0, 1) : 0;
  const globalObs = clamp(sim.focusProgress || 0, 0, 1);

  const distantScale = typeof loc.distantScale === 'number' ? loc.distantScale : 0.12;
  const focusedScale = Math.max(0.55, (isFocused ? sim.fovZoom : ev.zoom) || 1.0);
  const safeScaleMul = clamp(Number(eventScaleMul) || 1.0, 0.5, 1.8);
  // Keep physical optical distance (`ambientDist`/`effDist`) independent of visual `eventScaleMul`
  // so distance readouts, parallax, opacity, and depth layering stay physically consistent.
  const ambientDist = (def.obsDist || 1.6) / Math.max(distantScale, 0.04);
  const focusedDist = (def.obsDist || 1.6) / focusedScale;

  // Distance-correlated scale coupling: local AU events scale with Solar System zoom
  const localScaleMul = def.layer === 'local'
    ? (1.0 / clamp(solarZoom || 1.0, 0.25, 3.0))
    : 1.0;
  const baseAmbientDist = ambientDist * (1.0 + (localScaleMul - 1.0) * (1.0 - f));
  const effDist = Math.exp(Math.log(Math.max(baseAmbientDist, 0.2)) * (1 - f) + Math.log(Math.max(focusedDist, 0.2)) * f);
  const visualScaleMul = Math.pow(safeScaleMul, 1 - f);
  const scale = ((def.obsDist || 1.6) / effDist) * visualScaleMul;

  // Distance-correlated skybox parallax: nearer AU events shift more with Solar tilt; Mly events lock deep
  const pDepth = clamp(1.25 / Math.max(effDist, 0.9), 0.06, 0.55) * (1 - f);
  const skyShiftX = camRot || parallax
    ? (-(camRot?.x || 0) * 0.16 - (parallax?.x || 0) * 0.022) * safeW * pDepth
    : 0;
  const skyShiftY = camRot || parallax
    ? (-(camRot?.y || 0) * 0.12 - (parallax?.y || 0) * 0.018) * safeH * pDepth
    : 0;

  // When observing ANOTHER event, ambient sibling events gently pan aside on the shared canvas
  let siblingPanX = 0;
  let siblingPanY = 0;
  if (!isFocused && globalObs > 0.005 && sim.lastLocation) {
    const fdx = sim.lastLocation.x - 0.5;
    const fdy = sim.lastLocation.y - 0.5;
    siblingPanX = -fdx * safeW * 0.85 * globalObs;
    siblingPanY = -fdy * safeH * 0.85 * globalObs;
  }

  const marginX = isCompact ? 68 : 104;
  const marginTop = 84;
  const marginBottom = isCompact ? 96 : 74;
  let restX = clamp(loc.x * safeW + centerShiftX * 0.25 + skyShiftX, marginX, Math.max(marginX, safeW - marginX)) + siblingPanX;
  let restY = clamp(loc.y * safeH + skyShiftY, marginTop, Math.max(marginTop, safeH - marginBottom)) + siblingPanY;

  if (!isFocused && globalObs <= 0.01 && Array.isArray(avoidPoints) && avoidPoints.length > 0) {
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
  const eventRadiusPx = ((def.intrinsicRadius || 0.42) / effDist) * visualScaleMul * minDim;

  return {
    x,
    y,
    restX,
    restY,
    scale,
    distantScale,
    effDist,
    ambientDist: baseAmbientDist,
    eventRadiusPx,
    focusProgress: f,
    isDistant: f < 0.35,
    sector: loc.sector || 'ne',
    distanceLy: loc.distanceLy || 1200,
    depth: typeof loc.depth === 'number' ? loc.depth : 0.5,
  };
}

/**
 * Backward-compatible single-event screen position helper for `sim.active`.
 */
export function getEventScreenPosition(sim, w, h, centerShiftX = 0, avoidPoints = null, camRot = null, parallax = null, solarZoom = 1.0, eventScaleMul = 1.0) {
  if (!sim?.active) return null;
  return computeSingleEventPosition(sim, sim.active, w, h, centerShiftX, avoidPoints, camRot, parallax, solarZoom, eventScaleMul);
}

/**
 * Compute complete WebGL shader + GPU particle + HUD render descriptors for ALL concurrent events.
 */
export function computeEventFrames(
  sim,
  w,
  h,
  centerShiftX = 0,
  avoidPoints = null,
  visibilityAlpha = 1.0,
  camRot = null,
  parallax = null,
  solarZoom = 1.0,
  eventScaleMul = 1.0,
) {
  const list = Array.isArray(sim?.events) && sim.events.length > 0
    ? sim.events
    : (sim?.active ? [sim.active] : []);
  if (list.length === 0 || visibilityAlpha <= 0.005) return [];

  const frames = [];
  for (const ev of list) {
    if (!ev) continue;
    const pos = computeSingleEventPosition(sim, ev, w, h, centerShiftX, avoidPoints, camRot, parallax, solarZoom, eventScaleMul);
    if (!pos) continue;
    const def = ev.def;
    const p = clamp(ev.elapsed / ev.duration, 0, 1);
    const obs = pos.focusProgress;
    // Farther ambient events blend softly into the deep-sky field; observing lifts to full luminous fidelity.
    const distCrisp = clamp(0.46 + (3.6 / Math.max(pos.effDist, 2.0)) * 0.34, 0.46, 0.80);
    const alpha = clamp(visibilityAlpha * (ev.exitFade ?? 1.0) * (obs + (1.0 - obs) * distCrisp), 0, 1);

    let quadPad = 2.60;
    if (def.id === 'gamma-burst') quadPad = 4.6;
    else if (def.id === 'solar-flare') quadPad = 3.8;
    else if (def.id === 'comet-breakup') quadPad = 3.0;
    else if (def.id === 'blackhole-birth' || def.id === 'tidal-disruption') quadPad = 2.75;

    const quadRadiusPx = Math.min(Math.max(w, h) * 1.18, Math.max(44, pos.eventRadiusPx * quadPad));
    const sunRadiusPx = pos.eventRadiusPx * (0.28 + 0.07 * obs);
    const layer = (obs > 0.42 || (def.layer === 'local' && pos.effDist < 12.5)) ? 'local' : 'deep';

    frames.push({
      ...pos,
      uid: ev.uid || def.id,
      id: def.id,
      eventType: def.eventType,
      layer,
      observing: Boolean(ev.observing),
      quadRadiusPx,
      sunRadiusPx,
      progress: p,
      elapsed: ev.elapsed,
      alpha,
      obsBlend: obs,
      distNorm: pos.effDist,
      distDepth: ev.distDepth ?? 0.6,
      angle: typeof ev.angle === 'number' ? ev.angle : (def.baseAngle || 0),
      seed: typeof ev.seed === 'number' ? ev.seed : 0.42,
      viewYaw: ev.viewYaw || 0,
      viewPitch: ev.viewPitch || 0,
      def,
      instance: ev,
    });
  }
  return frames;
}

/**
 * Backward-compatible single-event frame descriptor helper (returns focused or primary event).
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
  solarZoom = 1.0,
  eventScaleMul = 1.0,
) {
  const frames = computeEventFrames(sim, w, h, centerShiftX, avoidPoints, visibilityAlpha, camRot, parallax, solarZoom, eventScaleMul);
  if (frames.length === 0) return null;
  return frames.find((f) => f.observing) || frames[frames.length - 1];
}

/**
 * Hit-test all live ambient (non-observed) cosmic events on the shared canvas.
 * Returns the closest hit frame or null.
 */
export function hitTestAmbientEvent(frames, clientX, clientY) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const ev of frames) {
    if (!ev || ev.observing || ev.alpha < 0.08) continue;
    const hitR = clamp(ev.eventRadiusPx * 0.95, 28, 92);
    const d = Math.hypot(clientX - ev.x, clientY - ev.y);
    if (d <= hitR && d < bestDist) {
      bestDist = d;
      best = ev;
    }
  }
  return best;
}

/**
 * Shared-canvas Solar System camera shift when flying toward / zooming into an event:
 * Instead of cutting/fading the Solar System to black, the Solar System physically glides
 * off-screen in the opposite direction of the event's sky coordinates and smoothly returns
 * as you zoom back out!
 */
export function getSolarTelescopeTransform(sim, w, h) {
  const f = clamp(sim?.focusProgress || 0, 0, 1);
  if (f <= EVENT_CAMERA_RETURN_EPS) {
    return { active: false, focus: 0, offsetX: 0, offsetY: 0, zoomMul: 1, alphaMul: 1 };
  }
  const focused = (sim.events || []).find((e) => e.observing)
    || (sim.lastFocusedUid ? (sim.events || []).find((e) => e.uid === sim.lastFocusedUid) : null);
  const loc = focused?.location || sim.lastLocation || { x: 0.84, y: 0.19 };
  const zoom = focused?.zoom || sim.fovZoom || 1.5;
  const dirX = loc.x - 0.5;
  const dirY = loc.y - 0.5;
  const distFromCenter = Math.hypot(dirX, dirY);
  const ux = distFromCenter > 0.05 ? dirX / distFromCenter : 0.78;
  const uy = distFromCenter > 0.05 ? dirY / distFromCenter : -0.62;
  const safeW = w || 1280;
  const safeH = h || 720;
  const pull = f * (0.92 + Math.max(0, zoom - 0.65) * 0.68);
  const offsetX = -(dirX * 1.65 + ux * 0.36) * safeW * pull;
  const offsetY = -(dirY * 1.65 + uy * 0.32) * safeH * pull;
  const zoomMul = 1.0 / (1.0 + Math.max(0, zoom - 0.75) * 0.42 * f);
  // Keep Solar System visibly panning aside on the shared canvas (no black-screen cut)
  const alphaMul = clamp(1.0 - smoothstep(0.86, 1.0, f) * 0.35, 0.65, 1.0);
  return {
    active: true,
    focus: f,
    offsetX,
    offsetY,
    zoomMul,
    alphaMul,
  };
}

export function getEventLens(evDraw, w, h) {
  const target = Array.isArray(evDraw)
    ? (evDraw.find((e) => e.observing) || evDraw.find((e) => e.def?.hasLens) || evDraw[0])
    : evDraw;
  if (!target || target.alpha <= 0.01) return [0, 0, 0, 0];
  const aspect = w / Math.max(h, 1);
  const nx = (target.x / Math.max(w, 1) - 0.5) * aspect;
  const ny = 0.5 - target.y / Math.max(h, 1);
  const radNorm = target.eventRadiusPx / Math.max(h, 1);

  if (!target.def?.hasLens) {
    return [nx, ny, radNorm * 0.65, 0.0];
  }

  const p = target.progress;
  let lensStr = 0;
  let rsNorm = radNorm * 0.25;
  if (target.id === 'blackhole-birth') {
    const birthP = Math.max(0, (p - 0.22) / 0.78);
    lensStr = smoothstep(0.0, 0.16, birthP) * smoothstep(1.0, 0.76, p) * 0.92;
    rsNorm = radNorm * 0.25 * smoothstep(0.0, 0.18, birthP);
  } else if (target.id === 'tidal-disruption') {
    lensStr = smoothstep(0.0, 0.16, p) * smoothstep(1.0, 0.76, p) * 0.84;
    rsNorm = radNorm * 0.21;
  } else if (target.id === 'kilonova') {
    const mPeak = p >= 0.36 ? Math.exp(-Math.pow((p - 0.44) / 0.14, 2)) * smoothstep(0.36, 0.42, p) : 0;
    lensStr = mPeak * 0.38;
    rsNorm = radNorm * 0.16;
  }
  return [nx, ny, rsNorm, lensStr * target.alpha];
}

export function getEventAmbient(evDraw) {
  const target = Array.isArray(evDraw)
    ? (evDraw.find((e) => e.observing) || evDraw[evDraw.length - 1])
    : evDraw;
  if (!target || target.alpha <= 0.01) return [0, 0, 0, 0];
  const p = target.progress;
  const env = smoothstep(0.0, 0.16, p) * smoothstep(1.0, 0.74, p);
  const peak = target.id === 'supernova'
    ? (0.42 + 0.85 * Math.exp(-Math.pow((p - 0.23) / 0.10, 2)))
    : (target.id === 'kilonova'
      ? (0.36 + 0.75 * Math.exp(-Math.pow((p - 0.43) / 0.11, 2)))
      : (target.id === 'gamma-burst'
        ? (0.48 + 0.65 * Math.exp(-Math.pow((p - 0.28) / 0.14, 2)))
        : 0.42));
  const [r, g, b] = target.def?.glowRgb || [0.5, 0.8, 1.0];
  const strength = env * peak * target.alpha * (0.38 + 0.62 * target.obsBlend);
  return [r, g, b, strength];
}

export function getEventShockWave(sim, w, h, centerShiftX = 0, avoidPoints = null, visibilityAlpha = 1.0, camRot = null, parallax = null) {
  const target = (sim?.events || []).find((e) => e.observing)
    || (sim?.lastFocusedUid ? (sim.events || []).find((e) => e.uid === sim.lastFocusedUid) : sim?.active);
  // Never draw a distracting shockwave circle on the Solar System ambient view
  if (!target || !target.def?.hasShock || visibilityAlpha <= 0.01 || (sim.focusProgress || 0) <= 0.08) {
    return [0, 0, 0, 0];
  }
  const p = target.elapsed / target.duration;
  const startP = target.def.id === 'kilonova' ? 0.36 : 0.18;
  if (p < startP || p > 0.90) return [0, 0, 0, 0];
  const pos = computeSingleEventPosition(sim, target, w, h, centerShiftX, avoidPoints, camRot, parallax);
  if (!pos) return [0, 0, 0, 0];
  const aspect = w / Math.max(h, 1);
  const sp = (p - startP) / (0.90 - startP);
  const maxR = (pos.eventRadiusPx / Math.max(h, 1)) * 2.1;
  const amp = Math.sin(sp * Math.PI) * (0.54 * pos.focusProgress) * clamp(maxR * 1.4, 0.20, 1.0) * clamp(visibilityAlpha, 0, 1);
  return [
    (pos.x / w - 0.5) * aspect,
    0.5 - pos.y / h,
    sp * maxR,
    amp,
  ];
}
