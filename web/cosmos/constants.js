/**
 * Yeaft Cosmos — Planetary Definitions, Persisted Cosmic Constants & Agent-Orbit Bindings
 */

export const COSMOS_CONSTANTS_KEY = 'yeaft-cosmos-constants-v1';
export const COSMOS_BINDINGS_KEY = 'yeaft-cosmos-planet-bindings-v1';
export const COSMOS_BOOKS_KEY = 'yeaft-cosmos-galaxy-books-v1';
export const COSMOS_DRAWER_WIDTH_KEY = 'yeaft-cosmos-drawer-width-v1';

export const COSMOS_DRAWER_WIDTH = Object.freeze({
  min: 340,
  default: 460,
  max: 1280,
  minRemaining: 220,
});

/** Default allocation priority when binding Agents to planets. */
export const DEFAULT_PLANET_ORDER = Object.freeze([
  'earth', 'saturn', 'jupiter', 'mars', 'neptune', 'venus', 'uranus', 'mercury',
]);

export const PLANETS = Object.freeze([
  {
    id: 'mercury', bodyType: 1, texKey: 'mercury',
    orbitR: 0.148, ecc: 0.206, argPeri: 0.51, incl: 0.122,
    size: 13.0, speed: 0.185, phase: 5.52, spinRate: 0.14, tilt: 0.03, oblate: 1.0,
    atmo: [0.70, 0.72, 0.78],
    moons: [],
  },
  {
    id: 'venus', bodyType: 2, texKey: 'venus',
    orbitR: 0.220, ecc: 0.018, argPeri: 2.29, incl: 0.059,
    size: 21.5, speed: 0.125, phase: 2.38, spinRate: -0.09, tilt: 0.05, oblate: 1.0,
    atmo: [0.96, 0.80, 0.52],
    moons: [],
  },
  {
    id: 'earth', bodyType: 3, texKey: 'earth_day',
    orbitR: 0.312, ecc: 0.028, argPeri: 1.79, incl: 0.000,
    size: 34.0, speed: 0.082, phase: 0.58, spinRate: 0.26, tilt: 0.39, oblate: 0.996,
    atmo: [0.34, 0.70, 1.00],
    moons: [
      { id: 'moon', orbitR: 2.25, sizeRatio: 0.24, speed: 0.34, phase: 0.65, incl: 0.20, style: 0 },
    ],
  },
  {
    id: 'mars', bodyType: 4, texKey: 'mars',
    orbitR: 0.406, ecc: 0.093, argPeri: 5.00, incl: 0.032,
    size: 21.5, speed: 0.062, phase: 4.18, spinRate: 0.23, tilt: 0.43, oblate: 0.994,
    atmo: [0.92, 0.52, 0.32],
    moons: [
      { id: 'phobos', orbitR: 1.66, sizeRatio: 0.085, speed: 0.62, phase: 1.1, incl: 0.14, style: 4 },
      { id: 'deimos', orbitR: 2.30, sizeRatio: 0.062, speed: 0.34, phase: 3.9, incl: -0.16, style: 4 },
    ],
  },
  {
    id: 'jupiter', bodyType: 5, texKey: 'jupiter',
    orbitR: 0.548, ecc: 0.049, argPeri: 0.26, incl: 0.023,
    size: 47.0, speed: 0.038, phase: 2.74, spinRate: 0.36, tilt: 0.06, oblate: 0.935,
    atmo: [0.90, 0.78, 0.62],
    moons: [
      { id: 'io',       orbitR: 1.56, sizeRatio: 0.105, speed: 0.54, phase: 0.4, incl: 0.07, style: 1 },
      { id: 'europa',   orbitR: 1.94, sizeRatio: 0.095, speed: 0.38, phase: 2.1, incl: -0.09, style: 2 },
      { id: 'ganymede', orbitR: 2.42, sizeRatio: 0.132, speed: 0.25, phase: 4.3, incl: 0.11, style: 0 },
      { id: 'callisto', orbitR: 2.98, sizeRatio: 0.118, speed: 0.16, phase: 5.5, incl: -0.13, style: 4 },
    ],
  },
  {
    id: 'saturn', bodyType: 6, texKey: 'saturn',
    orbitR: 0.698, ecc: 0.056, argPeri: 1.61, incl: 0.043,
    size: 37.5, speed: 0.026, phase: 5.72, spinRate: 0.32, tilt: 0.45, oblate: 0.902,
    atmo: [0.92, 0.84, 0.66],
    moons: [
      { id: 'enceladus', orbitR: 2.66, sizeRatio: 0.085, speed: 0.44, phase: 1.4, incl: 0.06, style: 2 },
      { id: 'titan',     orbitR: 3.28, sizeRatio: 0.148, speed: 0.21, phase: 4.6, incl: -0.09, style: 3 },
    ],
  },
  {
    id: 'uranus', bodyType: 7, texKey: 'uranus',
    orbitR: 0.828, ecc: 0.046, argPeri: 2.98, incl: 0.014,
    size: 25.0, speed: 0.018, phase: 4.88, spinRate: -0.22, tilt: 1.42, oblate: 0.978,
    atmo: [0.56, 0.88, 0.96],
    moons: [
      { id: 'titania', orbitR: 2.30, sizeRatio: 0.095, speed: 0.32, phase: 0.9, incl: 0.78, style: 0 },
    ],
  },
  {
    id: 'neptune', bodyType: 8, texKey: 'neptune',
    orbitR: 0.956, ecc: 0.015, argPeri: 0.78, incl: 0.031,
    size: 24.5, speed: 0.013, phase: 3.56, spinRate: 0.24, tilt: 0.48, oblate: 0.982,
    atmo: [0.32, 0.56, 1.00],
    moons: [
      { id: 'triton', orbitR: 2.24, sizeRatio: 0.125, speed: -0.34, phase: 2.5, incl: 0.40, style: 2 },
    ],
  },
]);

export const PLANET_MAP = Object.freeze(Object.fromEntries(PLANETS.map((p) => [p.id, p])));

/**
 * Evaluate a point on a planet's inclined Keplerian ellipse (Sun at focus).
 * @param {object} p Planet descriptor with orbitR, ecc, argPeri, incl
 * @param {number} E Eccentric anomaly (radians)
 * @returns {{ x: number, y: number, z: number }}
 */
export function keplerOrbitPoint(p, E) {
  const a = p.orbitR;
  const e = p.ecc || 0;
  const b = a * Math.sqrt(Math.max(0.01, 1 - e * e));
  const lx = a * (Math.cos(E) - e);
  const lz = b * Math.sin(E);
  const w = p.argPeri || 0;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  return {
    x: lx * cw - lz * sw,
    z: lx * sw + lz * cw,
    y: -lz * Math.sin(p.incl || 0),
  };
}

/**
 * Solve Kepler's equation M = E - e sin(E) via 3 Newton-Raphson iterations
 * and return the planet's 3D heliocentric position at `timeVal`.
 * @param {object} p Planet descriptor
 * @param {number} timeVal Simulation time
 * @returns {{ x: number, y: number, z: number, E: number }}
 */
export function keplerPos(p, timeVal) {
  const M = p.phase + timeVal * p.speed;
  const e = p.ecc || 0;
  let E = M + e * Math.sin(M);
  if (e > 0.001) {
    for (let i = 0; i < 3; i++) {
      E -= (E - e * Math.sin(E) - M) / Math.max(0.05, 1 - e * Math.cos(E));
    }
  }
  const pt = keplerOrbitPoint(p, E);
  pt.E = E;
  return pt;
}

export const BOOK_DOMAINS = Object.freeze([
  { id: 'auto',     arm: 0, color: '#8ac7ff' },
  { id: 'tech',     arm: 0, color: '#7cc4ff' },
  { id: 'business', arm: 1, color: '#f4c27a' },
  { id: 'social',   arm: 2, color: '#c4a6ff' },
  { id: 'history',  arm: 3, color: '#f29a78' },
]);

export const DEFAULT_GALAXY_BOOKS = Object.freeze([
  { id: 'b1', title: 'DDIA', arm: 0, r: 0.42, theta: 0.62, color: '#7cc4ff' },
  { id: 'b2', title: '聪明的投资者', arm: 1, r: 0.56, theta: 2.25, color: '#f4c27a' },
  { id: 'b3', title: '思考，快与慢', arm: 2, r: 0.48, theta: 3.84, color: '#c4a6ff' },
  { id: 'b4', title: '人类群星闪耀时', arm: 3, r: 0.62, theta: 5.32, color: '#f29a78' },
]);

export const DEFAULT_COSMOS_CONSTANTS = Object.freeze({
  orbitSpeed: 1.0,
  starDensity: 1.18,
  skyBright: 1.05,
  orbitLines: 0.60,
  activeFlash: true,
  livePreviewMode: '2', // '2' | '3' | 'hover'
  showEventsCountdown: true,
  eventsAutoEnabled: true,
  eventsAutoZoom: false,
  renderQuality: 'auto', // 'auto' | 'high' | 'lite'
});

function getStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function clampNum(val, min, max, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function normalizeCosmosConstants(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = ['2', '3', 'hover'].includes(src.livePreviewMode) ? src.livePreviewMode : DEFAULT_COSMOS_CONSTANTS.livePreviewMode;
  const renderQuality = ['auto', 'high', 'lite'].includes(src.renderQuality) ? src.renderQuality : DEFAULT_COSMOS_CONSTANTS.renderQuality;
  return {
    orbitSpeed: clampNum(src.orbitSpeed, 0, 2.5, DEFAULT_COSMOS_CONSTANTS.orbitSpeed),
    starDensity: clampNum(src.starDensity, 0.35, 2.0, DEFAULT_COSMOS_CONSTANTS.starDensity),
    skyBright: clampNum(src.skyBright, 0.35, 1.8, DEFAULT_COSMOS_CONSTANTS.skyBright),
    orbitLines: clampNum(src.orbitLines, 0, 1.2, DEFAULT_COSMOS_CONSTANTS.orbitLines),
    activeFlash: src.activeFlash !== false,
    livePreviewMode: mode,
    showEventsCountdown: src.showEventsCountdown !== false,
    eventsAutoEnabled: src.eventsAutoEnabled !== false,
    eventsAutoZoom: src.eventsAutoZoom === true,
    renderQuality,
  };
}

export function loadCosmosConstants(storage) {
  const store = getStorage(storage);
  if (!store) return { ...DEFAULT_COSMOS_CONSTANTS };
  try {
    const raw = JSON.parse(store.getItem(COSMOS_CONSTANTS_KEY) || 'null');
    return normalizeCosmosConstants(raw);
  } catch {
    return { ...DEFAULT_COSMOS_CONSTANTS };
  }
}

export function saveCosmosConstants(constants, storage) {
  const clean = normalizeCosmosConstants(constants);
  const store = getStorage(storage);
  if (store) {
    try {
      store.setItem(COSMOS_CONSTANTS_KEY, JSON.stringify(clean));
    } catch { /* ignore storage quota errors */ }
  }
  return clean;
}

export function loadPlanetBindings(storage) {
  const store = getStorage(storage);
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(COSMOS_BINDINGS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [agentId, planetId] of Object.entries(parsed)) {
      if (agentId && PLANET_MAP[planetId]) out[agentId] = planetId;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePlanetBindings(bindings, storage) {
  const store = getStorage(storage);
  if (!store || !bindings || typeof bindings !== 'object') return;
  try {
    store.setItem(COSMOS_BINDINGS_KEY, JSON.stringify(bindings));
  } catch { /* ignore */ }
}

/**
 * Resolve deterministic one-to-one mapping between Agents and Planets.
 * Online agents get priority over offline agents when > 8 agents exist.
 * Returns `{ agentToPlanet: { [agentId]: planetId }, planetToAgent: { [planetId]: agentId } }`.
 */
export function resolvePlanetAssignments(agents, savedBindings = {}) {
  const list = Array.isArray(agents) ? agents : [];
  const sorted = list.slice().sort((a, b) => {
    const ao = a?.online ? 1 : 0;
    const bo = b?.online ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  const agentToPlanet = {};
  const planetToAgent = {};

  // Pass 1: honor valid, non-colliding saved bindings first.
  for (const agent of sorted) {
    const id = agent?.id;
    const saved = id ? savedBindings[id] : null;
    if (saved && PLANET_MAP[saved] && !planetToAgent[saved]) {
      agentToPlanet[id] = saved;
      planetToAgent[saved] = id;
    }
  }

  // Pass 2: allocate remaining unbound agents onto free planets in priority order.
  for (const agent of sorted) {
    const id = agent?.id;
    if (!id || agentToPlanet[id]) continue;
    const freePlanet = DEFAULT_PLANET_ORDER.find((pid) => !planetToAgent[pid]);
    if (!freePlanet) break;
    agentToPlanet[id] = freePlanet;
    planetToAgent[freePlanet] = id;
  }

  return { agentToPlanet, planetToAgent };
}

/**
 * Move or swap an Agent onto `targetPlanetId` and return the updated bindings map.
 */
export function moveOrSwapPlanetBinding(agents, currentBindings, agentId, targetPlanetId) {
  if (!agentId || !PLANET_MAP[targetPlanetId]) {
    return { bindings: { ...(currentBindings || {}) }, swappedWith: null, fromPlanetId: null, changed: false };
  }
  const { agentToPlanet, planetToAgent } = resolvePlanetAssignments(agents, currentBindings);
  const fromPlanetId = agentToPlanet[agentId] || null;
  if (fromPlanetId === targetPlanetId) {
    return { bindings: { ...(currentBindings || {}), ...agentToPlanet }, swappedWith: null, fromPlanetId, changed: false };
  }
  const occupantId = planetToAgent[targetPlanetId] || null;
  const next = { ...(currentBindings || {}), ...agentToPlanet };
  next[agentId] = targetPlanetId;
  if (occupantId && occupantId !== agentId) {
    if (fromPlanetId) next[occupantId] = fromPlanetId;
    else delete next[occupantId];
  }
  return {
    bindings: next,
    swappedWith: occupantId && occupantId !== agentId ? occupantId : null,
    fromPlanetId,
    changed: true,
  };
}

export function scaleBand(scaleLog) {
  if (scaleLog >= 22.4) return 'web';
  if (scaleLog >= 18.2) return 'galaxy';
  if (scaleLog >= 10.2) return 'solar';
  return 'horizon';
}

export function loadGalaxyBooks(storage) {
  const store = getStorage(storage);
  if (!store) return DEFAULT_GALAXY_BOOKS.map((b) => ({ ...b }));
  try {
    const parsed = JSON.parse(store.getItem(COSMOS_BOOKS_KEY) || 'null');
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch { /* fallback */ }
  return DEFAULT_GALAXY_BOOKS.map((b) => ({ ...b }));
}

export function saveGalaxyBooks(books, storage) {
  const store = getStorage(storage);
  if (!store || !Array.isArray(books)) return;
  try {
    store.setItem(COSMOS_BOOKS_KEY, JSON.stringify(books.slice(0, 64)));
  } catch { /* ignore */ }
}

export function clampCosmosDrawerWidth(width, viewportWidth = 1280) {
  const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const maxAllowed = Math.max(
    COSMOS_DRAWER_WIDTH.min,
    Math.min(COSMOS_DRAWER_WIDTH.max, Math.floor(vw - COSMOS_DRAWER_WIDTH.minRemaining)),
  );
  const numeric = Number(width);
  if (!Number.isFinite(numeric)) {
    return Math.min(maxAllowed, Math.max(COSMOS_DRAWER_WIDTH.min, Math.min(488, Math.round(vw * 0.34))));
  }
  return Math.round(Math.max(COSMOS_DRAWER_WIDTH.min, Math.min(maxAllowed, numeric)));
}

export function loadCosmosDrawerWidth(storage) {
  const store = getStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(COSMOS_DRAWER_WIDTH_KEY);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < COSMOS_DRAWER_WIDTH.min) return null;
    return Math.round(Math.min(COSMOS_DRAWER_WIDTH.max, n));
  } catch {
    return null;
  }
}

export function saveCosmosDrawerWidth(width, storage) {
  const store = getStorage(storage);
  if (!store) return null;
  if (width == null) {
    try { store.removeItem(COSMOS_DRAWER_WIDTH_KEY); } catch { /* ignore */ }
    return null;
  }
  const n = Number(width);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.round(Math.max(COSMOS_DRAWER_WIDTH.min, Math.min(COSMOS_DRAWER_WIDTH.max, n)));
  try { store.setItem(COSMOS_DRAWER_WIDTH_KEY, String(clamped)); } catch { /* ignore */ }
  return clamped;
}
