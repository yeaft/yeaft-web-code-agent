import { EFFORT_LEVELS } from '../effort.js';
import { getPersona, listPersonaIds } from '../personas.js';

/** Read old/hand-edited config defensively. A missing key uses the preset default. */
export function normalizeSubAgentPersonaEfforts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(listPersonaIds().flatMap(id => {
    const effort = Object.hasOwn(value, id) ? value[id] : null;
    return EFFORT_LEVELS.includes(effort) ? [[id, effort]] : [];
  }));
}

/** Validate a replacement before the Agent's atomic config write. */
export function validateSubAgentPersonaEfforts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('subAgentPersonaEfforts must be a map of persona to effort');
  }
  const normalized = normalizeSubAgentPersonaEfforts(value);
  for (const id of Object.keys(value)) {
    if (!getPersona(id)) throw new Error(`Unknown sub-agent persona: ${id}`);
    if (!Object.hasOwn(normalized, id)) {
      throw new Error(`Invalid effort for sub-agent persona "${id}". Valid efforts: ${EFFORT_LEVELS.join(', ')}`);
    }
  }
  return normalized;
}

/** Use the same defaults and tiers in Settings as in runtime selection. */
export function publicSubAgentEffortSettings(value) {
  return {
    subAgentPersonaEfforts: normalizeSubAgentPersonaEfforts(value),
    subAgentEffortSettings: {
      personas: listPersonaIds().map(id => ({ id, defaultEffort: getPersona(id).defaultEffort })),
      levels: [...EFFORT_LEVELS],
    },
  };
}
