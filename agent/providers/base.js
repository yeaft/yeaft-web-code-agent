/**
 * Chat provider abstraction.
 *
 * Wire-protocol note: `claude_output` is now a PROTOCOL name, not a
 * vendor name. Every driver MUST emit events on
 * `ctx.sendToServer({ type: 'claude_output', conversationId, data })`,
 * where `data` follows the Claude stream-json envelope:
 *   - { type: 'assistant', message: { role, content: [...] } }
 *   - { type: 'user',      message: { role, content: [...] } }
 *   - { type: 'result',    subtype, session_id, is_error, ... }
 *   - { type: 'system',    subtype, ... }
 *
 * Non-Claude drivers (e.g. Copilot) MUST translate their native event
 * streams into this envelope so the existing renderer needs no changes.
 *
 * @typedef {Object} ChatProvider
 * @property {string} name
 * @property {(opts: StartOpts) => Promise<Object>} start
 * @property {(state: Object, prompt: string, opts?: Object) => Promise<void>} sendInput
 * @property {(state: Object) => void} abort
 *
 * @typedef {Object} StartOpts
 * @property {string} conversationId
 * @property {string} workDir
 * @property {string|null} [resumeSessionId]
 * @property {string} [userId]
 * @property {string} [username]
 */

export const PROVIDER_NAMES = Object.freeze(['claude-code', 'copilot']);
export const DEFAULT_PROVIDER = 'claude-code';
export function isValidProvider(name) {
  return typeof name === 'string' && PROVIDER_NAMES.includes(name);
}
