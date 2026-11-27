/**
 * Yeaft Cosmos — Multi-System Sightseeing Catalog & Interstellar Soaring Flight Controller
 *
 * Defines 5 distinct, astronomically inspired star systems (Sol, Alpha Centauri Binary,
 * TRAPPIST-1 Red Dwarf, Orion Nebula / Rigel Nursery, Sagittarius A* Galactic Core)
 * plus a pure, frame-rate-independent interstellar soaring & warp-transition state machine.
 */
import { PLANETS } from './constants.js';

export const SOAR_MIN_SPEED = 0.2;
export const SOAR_MAX_SPEED = 5.0;
export const SOAR_DEFAULT_SPEED = 1.25;

/**
 * 5 Curated Sightseeing Destinations.
 * - `sol` delegates its planetary bodies to `PLANETS` (the live Yeaft Agent workspace).
 * - Other systems provide self-contained Keplerian planets, moons, binary stars, or S-stars
 *   plus a custom deep-space skybox tint & celestial heading so every destination feels unique.
 */
export const STAR_SYSTEMS = Object.freeze([
  {
    id: 'sol',
    isHome: true,
    distanceLy: 0,
    spectral: 'G2V',
    accent: '#ffbe5c',
    skyTint: [1.0, 1.0, 1.0],
    skyYaw: 0.0,
    skyPitch: 0.0,
    beaconAz: 0.0,
    beaconEl: 0.0,
    hasComets: true,
    hasBelt: true,
    stars: [
      { id: 'sun', sizeRatio: 1.0, orbitR: 0, speed: 0, phase: 0, atmo: [1.0, 0.72, 0.36] },
    ],
    centralBlackHole: null,
    bodies: PLANETS,
  },
  {
    id: 'alpha-centauri',
    isHome: false,
    distanceLy: 4.37,
    spectral: 'G2V + K1V',
    accent: '#f5b062',
    skyTint: [1.10, 0.96, 0.86],
    skyYaw: 1.38,
    skyPitch: 0.22,
    beaconAz: 0.62,
    beaconEl: 0.14,
    hasComets: true,
    hasBelt: true,
    stars: [
      { id: 'alpha-cen-a', sizeRatio: 0.92, orbitR: 0.064, speed: 0.34, phase: 0.0, atmo: [1.0, 0.78, 0.42] },
      { id: 'alpha-cen-b', sizeRatio: 0.72, orbitR: 0.082, speed: 0.34, phase: Math.PI, atmo: [1.0, 0.50, 0.18] },
    ],
    centralBlackHole: null,
    bodies: [
      {
        id: 'proxima-d', bodyType: 1, texKey: 'mercury',
        orbitR: 0.24, ecc: 0.16, argPeri: 0.82, incl: 0.09,
        size: 16.5, speed: 0.16, phase: 1.15, spinRate: 0.18, tilt: 0.06, oblate: 1.0,
        atmo: [0.82, 0.72, 0.64],
        moons: [],
      },
      {
        id: 'proxima-b', bodyType: 4, texKey: 'mars',
        orbitR: 0.39, ecc: 0.07, argPeri: 2.35, incl: 0.04,
        size: 27.5, speed: 0.095, phase: 3.92, spinRate: 0.22, tilt: 0.28, oblate: 0.995,
        atmo: [0.96, 0.56, 0.34],
        moons: [
          { id: 'prox-m1', orbitR: 2.1, sizeRatio: 0.20, speed: 0.42, phase: 0.9, incl: 0.16, style: 0 },
        ],
      },
      {
        id: 'toliman-i', bodyType: 2, texKey: 'venus',
        orbitR: 0.56, ecc: 0.05, argPeri: 4.10, incl: 0.03,
        size: 31.0, speed: 0.058, phase: 0.48, spinRate: -0.14, tilt: 0.12, oblate: 0.992,
        atmo: [1.0, 0.84, 0.54],
        moons: [
          { id: 'tol-m1', orbitR: 2.25, sizeRatio: 0.14, speed: 0.32, phase: 2.4, incl: -0.10, style: 1 },
        ],
      },
      {
        id: 'rigil-prime', bodyType: 6, texKey: 'saturn',
        orbitR: 0.79, ecc: 0.06, argPeri: 1.45, incl: 0.05,
        size: 40.5, speed: 0.032, phase: 5.10, spinRate: 0.34, tilt: 0.42, oblate: 0.905,
        atmo: [0.98, 0.78, 0.52],
        moons: [
          { id: 'rig-m1', orbitR: 2.75, sizeRatio: 0.11, speed: 0.40, phase: 1.2, incl: 0.08, style: 2 },
          { id: 'rig-m2', orbitR: 3.35, sizeRatio: 0.15, speed: 0.22, phase: 4.1, incl: -0.11, style: 3 },
        ],
      },
    ],
  },
  {
    id: 'trappist-1',
    isHome: false,
    distanceLy: 40.7,
    spectral: 'M8V',
    accent: '#ff6e62',
    skyTint: [1.18, 0.74, 0.86],
    skyYaw: 2.72,
    skyPitch: -0.28,
    beaconAz: -0.78,
    beaconEl: 0.19,
    hasComets: false,
    hasBelt: false,
    stars: [
      { id: 'trappist-star', sizeRatio: 0.84, orbitR: 0, speed: 0, phase: 0, atmo: [1.0, 0.26, 0.14] },
    ],
    centralBlackHole: null,
    bodies: [
      {
        id: 'trappist-b', bodyType: 4, texKey: 'mars',
        orbitR: 0.18, ecc: 0.02, argPeri: 0.4, incl: 0.02,
        size: 16.5, speed: 0.22, phase: 0.35, spinRate: 0.16, tilt: 0.04, oblate: 1.0,
        atmo: [1.0, 0.42, 0.26],
        moons: [],
      },
      {
        id: 'trappist-c', bodyType: 1, texKey: 'mercury',
        orbitR: 0.26, ecc: 0.02, argPeri: 1.2, incl: 0.03,
        size: 18.0, speed: 0.165, phase: 2.05, spinRate: 0.14, tilt: 0.06, oblate: 1.0,
        atmo: [0.92, 0.54, 0.46],
        moons: [],
      },
      {
        id: 'trappist-d', bodyType: 2, texKey: 'venus',
        orbitR: 0.35, ecc: 0.03, argPeri: 2.6, incl: 0.02,
        size: 19.5, speed: 0.128, phase: 4.10, spinRate: 0.18, tilt: 0.08, oblate: 1.0,
        atmo: [0.98, 0.62, 0.42],
        moons: [],
      },
      {
        id: 'trappist-e', bodyType: 3, texKey: 'earth_day',
        orbitR: 0.46, ecc: 0.02, argPeri: 3.4, incl: 0.01,
        size: 28.5, speed: 0.098, phase: 0.92, spinRate: 0.21, tilt: 0.16, oblate: 0.996,
        atmo: [0.76, 0.48, 0.72],
        moons: [],
      },
      {
        id: 'trappist-f', bodyType: 7, texKey: 'uranus',
        orbitR: 0.58, ecc: 0.03, argPeri: 5.1, incl: 0.02,
        size: 25.5, speed: 0.072, phase: 2.88, spinRate: 0.19, tilt: 0.22, oblate: 0.992,
        atmo: [0.68, 0.78, 0.96],
        moons: [],
      },
      {
        id: 'trappist-g', bodyType: 4, texKey: 'mars',
        orbitR: 0.71, ecc: 0.02, argPeri: 0.9, incl: 0.03,
        size: 27.0, speed: 0.054, phase: 4.95, spinRate: 0.20, tilt: 0.19, oblate: 0.995,
        atmo: [0.92, 0.48, 0.44],
        moons: [],
      },
      {
        id: 'trappist-h', bodyType: 8, texKey: 'neptune',
        orbitR: 0.85, ecc: 0.04, argPeri: 2.2, incl: 0.04,
        size: 20.0, speed: 0.038, phase: 1.60, spinRate: 0.15, tilt: 0.14, oblate: 0.996,
        atmo: [0.54, 0.66, 0.98],
        moons: [],
      },
    ],
  },
  {
    id: 'orion-nursery',
    isHome: false,
    distanceLy: 860,
    spectral: 'B8Ia',
    accent: '#6cc8ff',
    skyTint: [0.74, 1.04, 1.28],
    skyYaw: 4.18,
    skyPitch: 0.36,
    beaconAz: 0.22,
    beaconEl: -0.22,
    hasComets: true,
    hasBelt: true,
    stars: [
      { id: 'rigel', sizeRatio: 1.24, orbitR: 0, speed: 0, phase: 0, atmo: [0.44, 0.78, 1.0] },
    ],
    centralBlackHole: null,
    bodies: [
      {
        id: 'rigel-ember', bodyType: 4, texKey: 'mars',
        orbitR: 0.24, ecc: 0.11, argPeri: 1.12, incl: 0.08,
        size: 20.0, speed: 0.155, phase: 5.20, spinRate: 0.28, tilt: 0.12, oblate: 1.0,
        atmo: [0.98, 0.56, 0.36],
        moons: [],
      },
      {
        id: 'orion-pelagia', bodyType: 3, texKey: 'earth_day',
        orbitR: 0.41, ecc: 0.04, argPeri: 2.90, incl: 0.03,
        size: 31.5, speed: 0.086, phase: 1.25, spinRate: 0.24, tilt: 0.34, oblate: 0.995,
        atmo: [0.34, 0.86, 1.0],
        moons: [
          { id: 'pel-m1', orbitR: 2.2, sizeRatio: 0.22, speed: 0.36, phase: 1.8, incl: 0.18, style: 2 },
        ],
      },
      {
        id: 'trapezium-ring', bodyType: 6, texKey: 'saturn',
        orbitR: 0.61, ecc: 0.05, argPeri: 0.45, incl: 0.05,
        size: 42.0, speed: 0.046, phase: 3.65, spinRate: 0.35, tilt: 0.48, oblate: 0.90,
        atmo: [0.58, 0.86, 1.0],
        moons: [
          { id: 'trap-m1', orbitR: 2.7, sizeRatio: 0.10, speed: 0.48, phase: 0.6, incl: 0.07, style: 2 },
          { id: 'trap-m2', orbitR: 3.3, sizeRatio: 0.14, speed: 0.24, phase: 3.9, incl: -0.10, style: 0 },
        ],
      },
      {
        id: 'nebula-cryo', bodyType: 7, texKey: 'uranus',
        orbitR: 0.78, ecc: 0.06, argPeri: 4.30, incl: 0.06,
        size: 28.5, speed: 0.028, phase: 5.70, spinRate: -0.22, tilt: 1.32, oblate: 0.978,
        atmo: [0.52, 0.92, 1.0],
        moons: [
          { id: 'cryo-m1', orbitR: 2.25, sizeRatio: 0.11, speed: 0.30, phase: 2.1, incl: 0.62, style: 2 },
        ],
      },
      {
        id: 'belt-drifter', bodyType: 8, texKey: 'neptune',
        orbitR: 0.93, ecc: 0.08, argPeri: 1.95, incl: 0.09,
        size: 26.0, speed: 0.019, phase: 2.40, spinRate: 0.25, tilt: 0.44, oblate: 0.982,
        atmo: [0.38, 0.62, 1.0],
        moons: [],
      },
    ],
  },
  {
    id: 'sgr-a',
    isHome: false,
    distanceLy: 26670,
    spectral: 'SMBH · 4.3M M☉',
    accent: '#f4c27a',
    skyTint: [1.16, 0.98, 0.76],
    skyYaw: 5.32,
    skyPitch: -0.16,
    beaconAz: -0.34,
    beaconEl: -0.18,
    hasComets: false,
    hasBelt: false,
    stars: [],
    centralBlackHole: { radiusFactor: 0.125, strength: 1.0 },
    bodies: [
      {
        id: 's-star-s2', bodyType: 0, texKey: 'sun',
        orbitR: 0.46, ecc: 0.68, argPeri: 0.58, incl: 0.24,
        size: 16.5, speed: 0.26, phase: 0.65, spinRate: 0.22, tilt: 0.10, oblate: 1.0,
        atmo: [0.52, 0.80, 1.0],
        moons: [],
      },
      {
        id: 's-star-s62', bodyType: 0, texKey: 'sun',
        orbitR: 0.34, ecc: 0.62, argPeri: 2.42, incl: -0.20,
        size: 14.0, speed: 0.36, phase: 2.85, spinRate: 0.25, tilt: 0.12, oblate: 1.0,
        atmo: [0.76, 0.90, 1.0],
        moons: [],
      },
      {
        id: 's-star-s4714', bodyType: 0, texKey: 'sun',
        orbitR: 0.62, ecc: 0.72, argPeri: 4.18, incl: 0.28,
        size: 15.0, speed: 0.19, phase: 4.40, spinRate: 0.20, tilt: 0.08, oblate: 1.0,
        atmo: [1.0, 0.82, 0.48],
        moons: [],
      },
      {
        id: 's-star-s0102', bodyType: 0, texKey: 'sun',
        orbitR: 0.54, ecc: 0.54, argPeri: 1.48, incl: -0.26,
        size: 13.5, speed: 0.22, phase: 5.55, spinRate: 0.18, tilt: 0.11, oblate: 1.0,
        atmo: [0.64, 0.84, 1.0],
        moons: [],
      },
      {
        id: 's-star-s38', bodyType: 0, texKey: 'sun',
        orbitR: 0.78, ecc: 0.58, argPeri: 5.35, incl: 0.16,
        size: 18.0, speed: 0.14, phase: 1.95, spinRate: 0.16, tilt: 0.09, oblate: 1.0,
        atmo: [1.0, 0.56, 0.24],
        moons: [],
      },
    ],
  },
]);

export const STAR_SYSTEM_MAP = Object.freeze(
  Object.fromEntries(STAR_SYSTEMS.map((sys) => [sys.id, sys])),
);

export function getStarSystemById(id) {
  return STAR_SYSTEM_MAP[id] || STAR_SYSTEMS[0];
}

export function getActiveStarSystem(voyage) {
  return getStarSystemById(voyage?.systemId || 'sol');
}

export function formatSystemDistance(distanceLy, isEn = false) {
  const d = Number(distanceLy) || 0;
  if (d <= 0) return isEn ? '0 ly · Home' : '0 光年 · 母星';
  if (d >= 1000) {
    const formatted = Math.round(d).toLocaleString('en-US');
    return isEn ? `${formatted} ly` : `${formatted} 光年`;
  }
  const formatted = d < 100 ? d.toFixed(d < 10 ? 2 : 1) : String(Math.round(d));
  return isEn ? `${formatted} ly` : `${formatted} 光年`;
}

/**
 * Compute warp duration correlated with physical distance between two star systems.
 */
export function computeSystemWarpDuration(fromId, toId) {
  const fromSys = getStarSystemById(fromId);
  const toSys = getStarSystemById(toId);
  const maxDist = Math.max(fromSys.distanceLy || 0, toSys.distanceLy || 0, 1);
  const logD = Math.log10(maxDist + 1);
  return Math.max(2.0, Math.min(3.5, 1.85 + logD * 0.34));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function easeInOutCubic(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Create mutable runtime state for interstellar soaring & multi-system sightseeing.
 */
export function createVoyageState() {
  return {
    systemId: 'sol',
    soaring: false,
    soarBlend: 0,
    soarSpeed: SOAR_DEFAULT_SPEED,
    targetSoarSpeed: SOAR_DEFAULT_SPEED,
    autoPilot: true,
    flightPhase: 0,
    headingYaw: 0,
    headingPitch: 0,
    skyTint: [1.0, 1.0, 1.0],
    skyYaw: 0,
    skyPitch: 0,
    warp: null, // { fromId, toId, elapsed, duration, swapped }
    warpEnergy: 0,
    systemAlphaMul: 1.0,
    systemZoomMul: 1.0,
  };
}

export function setSoarSpeed(voyage, nextSpeed) {
  if (!voyage) return SOAR_DEFAULT_SPEED;
  const clamped = clamp(Number(nextSpeed) || SOAR_DEFAULT_SPEED, SOAR_MIN_SPEED, SOAR_MAX_SPEED);
  voyage.targetSoarSpeed = clamped;
  return clamped;
}

export function toggleSoarMode(voyage, forceState = null) {
  if (!voyage) return false;
  const next = typeof forceState === 'boolean' ? forceState : !voyage.soaring;
  voyage.soaring = next;
  if (next) {
    // Abort any in-flight warp cleanly so soaring and warping never run simultaneously
    voyage.warp = null;
    voyage.autoPilot = true;
    voyage.targetSoarSpeed = clamp(voyage.targetSoarSpeed || SOAR_DEFAULT_SPEED, SOAR_MIN_SPEED, SOAR_MAX_SPEED);
  }
  return voyage.soaring;
}

export function toggleSoarAutoPilot(voyage, forceState = null) {
  if (!voyage) return false;
  voyage.autoPilot = typeof forceState === 'boolean' ? forceState : !voyage.autoPilot;
  return voyage.autoPilot;
}

/**
 * Start a smooth interstellar warp transition to `targetSystemId`.
 * Automatically exits free-flight soaring upon arrival so the destination star system unfolds cleanly.
 */
export function startSystemWarp(voyage, targetSystemId) {
  if (!voyage || !STAR_SYSTEM_MAP[targetSystemId]) return false;
  // Already warping to this exact destination -> do not restart from elapsed = 0
  if (voyage.warp && voyage.warp.toId === targetSystemId) {
    return false;
  }
  // Clicking the origin system before midpoint cancels the outbound warp cleanly
  if (voyage.warp && !voyage.warp.swapped && targetSystemId === voyage.systemId) {
    voyage.warp = null;
    return false;
  }
  if (voyage.systemId === targetSystemId && !voyage.warp) {
    voyage.soaring = false;
    return false;
  }
  const fromId = voyage.systemId;
  const duration = computeSystemWarpDuration(fromId, targetSystemId);
  const alreadyHidden = voyage.soarBlend > 0.72 || (voyage.warp && voyage.warp.swapped) || voyage.systemAlphaMul < 0.12;
  const fromAlpha = alreadyHidden ? 0 : clamp(voyage.systemAlphaMul ?? 1.0, 0, 1);
  voyage.soaring = false;
  if (alreadyHidden) {
    // Skip fade-out phase when already deep in soaring/mid-warp so departed system never ghosts back in
    voyage.soarBlend = 0;
    voyage.systemId = targetSystemId;
    voyage.warp = {
      fromId,
      toId: targetSystemId,
      elapsed: duration * 0.5,
      duration,
      swapped: true,
      fromAlpha: 0,
      pendingSwapNotify: true,
    };
  } else {
    voyage.warp = {
      fromId,
      toId: targetSystemId,
      elapsed: 0,
      duration,
      swapped: false,
      fromAlpha,
      pendingSwapNotify: false,
    };
  }
  return true;
}

export function getNextStarSystemId(currentId) {
  const idx = STAR_SYSTEMS.findIndex((s) => s.id === currentId);
  const nextIdx = (idx + 1 + STAR_SYSTEMS.length) % STAR_SYSTEMS.length;
  return STAR_SYSTEMS[nextIdx].id;
}

/**
 * Advance interstellar soaring & warp transition state by `dt` seconds.
 * Returns `{ systemChanged: boolean, warpFinished: boolean }`.
 */
export function tickVoyageState(voyage, dt, opts = {}) {
  if (!voyage) return { systemChanged: false, warpFinished: false };
  const safeDt = Math.max(0.001, Math.min(0.05, Number(dt) || 0.016));
  const reducedMotion = Boolean(opts.reducedMotion);
  const motionMul = reducedMotion ? 0.25 : 1.0;

  let systemChanged = false;
  let warpFinished = false;

  // 1. Smooth Soar Mode blend & forward cruise phase
  const goalSoar = voyage.soaring ? 1.0 : 0.0;
  const blendRate = reducedMotion ? 14.0 : 3.2;
  voyage.soarBlend += (goalSoar - voyage.soarBlend) * Math.min(1, safeDt * blendRate);
  if (Math.abs(voyage.soarBlend - goalSoar) < 0.002) voyage.soarBlend = goalSoar;

  voyage.soarSpeed += (voyage.targetSoarSpeed - voyage.soarSpeed) * Math.min(1, safeDt * 5.5);

  if (voyage.soarBlend > 0.002) {
    voyage.flightPhase += safeDt * (0.28 + voyage.soarSpeed * 0.62) * voyage.soarBlend * motionMul;
    if (voyage.autoPilot) {
      // Gentle scenic autopilot curve gliding across Milky Way & Veil Nebula
      voyage.headingYaw += safeDt * 0.072 * (0.5 + voyage.soarSpeed * 0.25) * voyage.soarBlend * motionMul;
      const targetPitch = Math.sin(voyage.flightPhase * 0.24) * 0.34;
      voyage.headingPitch += (targetPitch - voyage.headingPitch) * Math.min(1, safeDt * 1.4);
    }
  }

  // 2. Active Interstellar Warp Transition
  let warpEnergy = 0;
  let warpAlphaMul = 1.0;
  let warpZoomMul = 1.0;

  if (voyage.warp) {
    const w = voyage.warp;
    if (w.pendingSwapNotify) {
      w.pendingSwapNotify = false;
      systemChanged = true;
    }
    w.elapsed += safeDt * (reducedMotion ? 2.4 : 1.0);
    const p = clamp(w.elapsed / Math.max(w.duration, 0.2), 0, 1);

    // Forward starlight rush during warp
    voyage.flightPhase += safeDt * (1.2 + Math.sin(p * Math.PI) * 4.4) * motionMul;
    warpEnergy = Math.pow(Math.sin(p * Math.PI), 0.78) * 0.96;

    if (p < 0.5) {
      const outT = easeInOutCubic(p / 0.5);
      const startAlpha = typeof w.fromAlpha === 'number' ? w.fromAlpha : 1.0;
      warpAlphaMul = startAlpha * (1.0 - outT);
      warpZoomMul = 1.0 + outT * 1.65;
    } else {
      if (!w.swapped) {
        w.swapped = true;
        voyage.systemId = w.toId;
        systemChanged = true;
      }
      const inT = easeInOutCubic((p - 0.5) / 0.5);
      warpAlphaMul = inT;
      warpZoomMul = 0.24 + inT * 0.76;
    }

    if (p >= 1.0) {
      voyage.warp = null;
      warpAlphaMul = 1.0;
      warpZoomMul = 1.0;
      warpEnergy = 0;
      warpFinished = true;
    }
  }

  // 3. Smoothly blend sky atmosphere tint & skybox heading toward active star system
  const sys = getActiveStarSystem(voyage);
  const skyRate = Math.min(1, safeDt * (voyage.warp ? 3.8 : 2.6));
  for (let i = 0; i < 3; i++) {
    voyage.skyTint[i] += (sys.skyTint[i] - voyage.skyTint[i]) * skyRate;
  }
  voyage.skyYaw += (sys.skyYaw - voyage.skyYaw) * skyRate;
  voyage.skyPitch += (sys.skyPitch - voyage.skyPitch) * skyRate;

  // 4. Combine soar cruise streaks & warp streaks
  const soarStreak = voyage.soarBlend * clamp((voyage.soarSpeed - 0.35) / 4.2, 0.06, 0.72);
  voyage.warpEnergy = Math.max(warpEnergy, soarStreak);

  // Pull local star system smoothly aside during free-flight soaring
  const soarVis = 1.0 - easeInOutCubic(voyage.soarBlend);
  voyage.systemAlphaMul = warpAlphaMul * soarVis;
  voyage.systemZoomMul = warpZoomMul * (1.0 + voyage.soarBlend * 0.85);

  return { systemChanged, warpFinished };
}

/**
 * Return shader-ready uniforms for background skybox tint & 3D soar fly-through vector.
 */
export function getVoyageSkyUniforms(voyage) {
  if (!voyage) {
    return {
      skyTint: [1.0, 1.0, 1.0],
      soarVec: [0.0, 0.0, 0.0],
    };
  }
  return {
    skyTint: [voyage.skyTint[0], voyage.skyTint[1], voyage.skyTint[2]],
    soarVec: [
      voyage.skyYaw + voyage.headingYaw,
      voyage.skyPitch + voyage.headingPitch,
      voyage.flightPhase,
    ],
  };
}

/**
 * Project clickable destination beacons into screen space while soaring in free flight.
 */
export function projectSoarBeacons(voyage, width, height, camRot = { x: 0, y: 0 }) {
  if (!voyage || voyage.soarBlend < 0.32 || voyage.warp) return [];
  const safeW = Math.max(width || 1, 1);
  const safeH = Math.max(height || 1, 1);
  const viewYaw = (camRot?.x || 0) * 0.55 + voyage.headingYaw * 0.65;
  const viewPitch = (camRot?.y || 0) * 0.42 + voyage.headingPitch * 0.65;
  const out = [];

  for (const sys of STAR_SYSTEMS) {
    if (sys.id === voyage.systemId) continue;
    // Wrap relative azimuth into [-PI, PI]
    let dAz = (sys.beaconAz - viewYaw) % (Math.PI * 2);
    if (dAz > Math.PI) dAz -= Math.PI * 2;
    if (dAz < -Math.PI) dAz += Math.PI * 2;
    const dEl = sys.beaconEl - viewPitch;

    if (Math.abs(dAz) > 1.05 || Math.abs(dEl) > 0.72) continue;
    const nx = dAz / 1.05;
    const ny = dEl / 0.72;
    const marginX = Math.min(82, safeW * 0.25);
    const rawX = safeW * (0.5 + nx * 0.40);
    const x = clamp(rawX, marginX, safeW - marginX);
    const y = clamp(safeH * (0.48 - ny * 0.34), 76, safeH - 96);
    const edgeFade = Math.max(0, 1 - Math.hypot(nx, ny) * 0.62);
    const alpha = clamp((voyage.soarBlend - 0.32) / 0.68, 0, 1) * clamp(edgeFade, 0.25, 1);
    if (alpha > 0.08) {
      out.push({
        id: sys.id,
        accent: sys.accent,
        distanceLy: sys.distanceLy,
        spectral: sys.spectral,
        x: Math.round(x),
        y: Math.round(y),
        alpha: Number(alpha.toFixed(3)),
      });
    }
  }
  return out;
}
