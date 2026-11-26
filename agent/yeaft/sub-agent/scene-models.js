import { SESSION_SCENE_IDS, isSessionSceneId } from '../sessions/scene-ids.js';
import { parseModelRef } from '../models.js';

function cleanRef(value) {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  const { providerName, modelId } = parseModelRef(ref);
  return providerName && modelId ? ref : null;
}

/** Shape-only read: keep unavailable targets visible in settings so they can be repaired. */
export function normalizeSubAgentSceneModels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(SESSION_SCENE_IDS.flatMap(scene => {
    const ref = Object.hasOwn(value, scene) ? cleanRef(value[scene]) : null;
    return ref ? [[scene, ref]] : [];
  }));
}

export function findSceneModelEntry(ref, catalog, ambiguousRefs) {
  if (!cleanRef(ref) || !Array.isArray(catalog) || ambiguousRefs?.includes(ref)) return null;
  const matches = catalog.filter(entry => entry?.ref === ref
    || (!entry?.ref && entry?.provider && entry?.id && `${entry.provider}/${entry.id}` === ref));
  return matches.length === 1 ? matches[0] : null;
}

/** Validate a replacement inside the config lock, against the resulting catalog. */
export function validateSubAgentSceneModels(value, previous, catalog, ambiguousRefs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('subAgentSceneModels must be a map of scene to provider/model');
  }
  const retained = normalizeSubAgentSceneModels(previous);
  for (const [scene, valueRef] of Object.entries(value)) {
    if (!isSessionSceneId(scene)) throw new Error(`Unknown sub-agent scene: ${scene}`);
    const ref = cleanRef(valueRef);
    if (!ref || (retained[scene] !== ref && !findSceneModelEntry(ref, catalog, ambiguousRefs))) {
      throw new Error(`Sub-agent scene "${scene}" must target an available, unambiguous provider/model`);
    }
  }
  return normalizeSubAgentSceneModels(value);
}
