/**
 * protocolPresets.js — Single source of truth for LLM protocol model presets.
 *
 * Consumed by both Yeaft Settings (YeaftSettings.js) and the legacy
 * LLM settings tab (LlmTab.js). When a user picks a protocol for a new
 * provider and the models list is empty, these presets are used to
 * pre-fill the field.
 *
 * Keep this list short — it's a starting point, not an exhaustive catalog.
 * Users are free to add/remove models afterward.
 */

export const PROTOCOL_PRESET_MODELS = {
  anthropic: [
    'claude-opus-4-8',
    'claude-opus-4.8',
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-3-20250414',
  ],
  openai: [
    'gpt-5',
    'gpt-4.1',
    'gpt-4.1-mini',
    'o3',
    'o4-mini',
  ],
  'openai-responses': [
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-5-pro',
  ],
};

/**
 * Return the preset model id list for a protocol, or an empty array
 * when the protocol is unknown.
 *
 * @param {string} protocol
 * @returns {string[]}
 */
export function getProtocolPresetModels(protocol) {
  return PROTOCOL_PRESET_MODELS[protocol] || [];
}
