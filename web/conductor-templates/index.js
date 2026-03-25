/**
 * Conductor V2 scenario template registry.
 * Exports scenario metadata and persona pools for each scenario type.
 */
import dev from './dev.js';
import writing from './writing.js';
import trading from './trading.js';
import video from './video.js';

const scenarios = { dev, writing, trading, video };

/** All scenarios as an ordered array for card display. */
export const scenarioList = [dev, writing, trading, video];

/**
 * Get scenario definition by id.
 * @param {string} scenarioId - 'dev' | 'writing' | 'trading' | 'video'
 * @returns {object|null}
 */
export function getScenario(scenarioId) {
  return scenarios[scenarioId] || null;
}

/**
 * Get persona pool for a given scenario.
 * @param {string} scenarioId
 * @returns {Array|null}
 */
export function getPersonas(scenarioId) {
  const s = scenarios[scenarioId];
  return s ? s.personas : null;
}
