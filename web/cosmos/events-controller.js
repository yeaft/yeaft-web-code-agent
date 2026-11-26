/**
 * Yeaft Cosmos — Random-Interval Cosmic Event Scheduler & Telescope Controller
 *
 * Guarantees:
 * - Events are selected randomly without immediate back-to-back repeats.
 * - Quiet random cooldown intervals separate consecutive events (default 75–165s).
 * - Each event plays once and dissolves cleanly back into serene space (no endless loop).
 * - Users can stop an active event immediately or pause/resume automatic random triggers.
 */

export const MIN_EVENT_INTERVAL_SEC = 75;
export const MAX_EVENT_INTERVAL_SEC = 165;
export const INITIAL_EVENT_MIN_SEC = 45;
export const INITIAL_EVENT_MAX_SEC = 95;

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
    countdown: pickRandomCooldownSec(INITIAL_EVENT_MIN_SEC, INITIAL_EVENT_MAX_SEC, rng),
    autoEnabled: opts.autoEnabled !== false,
    fovZoom: 1.0,
    panX: 0,
    panY: 0,
  };
}

export function startCosmicEvent(sim, eventId = null, { observe = false, rng = Math.random } = {}) {
  let idx = eventId ? COSMIC_EVENTS.findIndex((e) => e.id === eventId) : sim.nextIdx;
  if (idx < 0 || idx >= COSMIC_EVENTS.length) idx = pickRandomEventIndex(sim.lastPlayedIdx, rng);
  const def = COSMIC_EVENTS[idx];

  if (sim.active && sim.active.def.id === def.id && observe) {
    sim.active.observing = true;
    sim.active.paused = false;
    sim.active.targetZoom = Math.max(sim.active.targetZoom, def.defaultZoom);
    return sim.active;
  }

  sim.lastPlayedIdx = idx;
  sim.nextIdx = pickRandomEventIndex(idx, rng);
  sim.countdown = pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
  sim.active = {
    def,
    elapsed: 0.01,
    duration: def.duration,
    paused: false,
    targetZoom: observe ? def.defaultZoom : 1.0,
    observing: Boolean(observe),
  };
  return sim.active;
}

/** Immediately stop any running/observed cosmic event and restore a quiet cooldown interval. */
export function stopCosmicEvent(sim, { rng = Math.random } = {}) {
  const wasActive = Boolean(sim.active);
  sim.active = null;
  sim.nextIdx = pickRandomEventIndex(sim.lastPlayedIdx, rng);
  sim.countdown = pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
  return wasActive;
}

export function setCosmicEventZoom(sim, zoom) {
  if (!sim.active) return;
  sim.active.targetZoom = Math.max(0.65, Math.min(3.4, Number(zoom) || 1.0));
}

export function tickCosmicEvents(sim, dt, { showCountdown = true, autoEnabled = true, rng = Math.random } = {}) {
  sim.autoEnabled = autoEnabled;

  if (sim.active) {
    if (!sim.active.paused) {
      sim.active.elapsed += dt;
      // Single-shot completion: finish naturally and enter a random quiet interval (never loops endlessly).
      if (sim.active.elapsed >= sim.active.duration) {
        sim.active = null;
        sim.nextIdx = pickRandomEventIndex(sim.lastPlayedIdx, rng);
        sim.countdown = pickRandomCooldownSec(MIN_EVENT_INTERVAL_SEC, MAX_EVENT_INTERVAL_SEC, rng);
      }
    }
  } else if (showCountdown && autoEnabled) {
    sim.countdown -= dt;
    if (sim.countdown <= 0) {
      startCosmicEvent(sim, null, { observe: false, rng });
    }
  }

  const goalZoom = (sim.active && sim.active.observing) ? sim.active.targetZoom : 1.0;
  sim.fovZoom += (goalZoom - sim.fovZoom) * Math.min(1, dt * 5.2);
  const goalPanX = (sim.active && sim.active.observing) ? (0.5 - sim.active.def.anchor.x) : 0;
  const goalPanY = (sim.active && sim.active.observing) ? (0.5 - sim.active.def.anchor.y) : 0;
  sim.panX += (goalPanX - sim.panX) * Math.min(1, dt * 4.6);
  sim.panY += (goalPanY - sim.panY) * Math.min(1, dt * 4.6);
}

export function getEventScreenPosition(sim, w, h, centerShiftX = 0) {
  if (!sim.active) return null;
  const def = sim.active.def;
  const z = sim.fovZoom;
  const cx = w * 0.5 + centerShiftX * 0.55;
  const cy = h * 0.5;
  const baseX = def.anchor.x * w + centerShiftX * 0.55;
  const baseY = def.anchor.y * h;
  return {
    x: cx + (baseX - cx + sim.panX * w) * z,
    y: cy + (baseY - cy + sim.panY * h) * z,
    scale: z,
  };
}

export function getEventShockWave(sim, w, h, centerShiftX = 0) {
  if (!sim.active || !sim.active.def.hasShock) return [0, 0, 0, 0];
  const p = sim.active.elapsed / sim.active.duration;
  if (p < 0.16 || p > 0.86) return [0, 0, 0, 0];
  const pos = getEventScreenPosition(sim, w, h, centerShiftX);
  if (!pos) return [0, 0, 0, 0];
  const aspect = w / Math.max(h, 1);
  const sp = (p - 0.16) / 0.70;
  return [
    (pos.x / w - 0.5) * aspect,
    0.5 - pos.y / h,
    sp * 0.62 * sim.fovZoom,
    Math.sin(sp * Math.PI) * (sim.active.observing ? 0.92 : 0.48),
  ];
}
