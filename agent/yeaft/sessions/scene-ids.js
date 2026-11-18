// Legacy profiles are used to source the shipped practices, not to route turns.
export const LEGACY_SCENE_PROFILES = Object.freeze({
  general: 'omni', software: 'software-omni', writing: 'writing-omni',
  'short-video': 'short-video-omni', investment: 'quant-omni',
});

export function isSessionSceneId(value) {
  return typeof value === 'string' && Object.hasOwn(LEGACY_SCENE_PROFILES, value);
}

// Compatibility marker for existing tool/event ownership and pre-scene clients.
// This is constant across scenes and does not resolve a library persona.
export const SESSION_ASSISTANT_ID = 'omni';
