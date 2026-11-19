// Session scenes in menu order. IDs are stored in Session config.json, so an ID
// keeps its meaning forever: 'short-video' is the stored ID of the content
// creation scene, which grew out of the original short-video scene.
export const SESSION_SCENE_IDS = Object.freeze([
  'general', 'software', 'frontend', 'writing', 'short-video', 'video-editing',
  'primary-education', 'investment',
]);

// Scenes added after the original five. The Agent advertises each one, so a
// newer Web never offers a scene that an older Agent would reject.
export const SESSION_SCENE_CAPABILITIES = Object.freeze({
  frontend: 'session_scene_frontend',
  'video-editing': 'session_scene_video_editing',
  'primary-education': 'session_scene_primary_education',
});

// Legacy profiles are used to source the shipped practices, not to route turns.
// Only the original scenes have a stock VP; later scenes are Session-only.
export const LEGACY_SCENE_PROFILES = Object.freeze({
  general: 'omni', software: 'software-omni', writing: 'writing-omni',
  'short-video': 'short-video-omni', investment: 'quant-omni',
});

export function isSessionSceneId(value) {
  return typeof value === 'string' && SESSION_SCENE_IDS.includes(value);
}

// Compatibility marker for existing tool/event ownership and pre-scene clients.
// This is constant across scenes and does not resolve a library persona.
export const SESSION_ASSISTANT_ID = 'omni';
