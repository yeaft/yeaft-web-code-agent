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
 * @property {ProviderCapabilities} capabilities
 *   Static feature flags the provider supports. UI uses these to decide which
 *   header buttons / panels to show, rather than string-matching provider names.
 * @property {(opts: StartOpts) => Promise<Object>} start
 * @property {(state: Object, prompt: string, opts?: Object) => Promise<void>} sendInput
 * @property {(state: Object) => void} abort
 * @property {(state: Object) => Promise<void>} [clear]
 *   Optional. Reset in-flight conversation state (e.g. start a new ACP session
 *   under the same conversationId). If not provided, the frontend falls back to
 *   a client-side message wipe only.
 * @property {() => Promise<FolderInfo[]>} listFolders
 *   Return the list of work-directories that this provider has sessions for.
 * @property {(workDir: string) => Promise<SessionInfo[]>} listSessions
 *   Return resumable sessions for a given work-directory.
 * @property {(workDir: string, sessionId: string, limit?: number) => Promise<HistoryMessage[]>} loadHistory
 *   Return the resumable transcript as an array of `claude_output`-compatible
 *   envelopes (the same shape the live stream would have produced).
 *
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} [compact]      provider supports /compact (auto + manual)
 * @property {boolean} [clear]        provider supports in-place /clear
 * @property {boolean} [expert]       provider supports the expert panel / subagent injection
 * @property {boolean} [mcp]          provider exposes MCP server toggles per conversation
 * @property {boolean} [subagents]    provider drives subagent watcher events
 * @property {boolean} [attachments]  provider accepts file / image attachments in prompts
 * @property {boolean} [askUser]      provider supports the round-trip ask-user permission prompt
 * @property {boolean} [modelPicker]  provider supports selecting a model from the web UI
 *
 * @typedef {Object} StartOpts
 * @property {string} conversationId
 * @property {string} workDir
 * @property {string|null} [resumeSessionId]
 * @property {string} [userId]
 * @property {string} [username]
 * @property {Object} [providerOptions]   per-provider knobs (model, allowAllTools, ...)
 *
 * @typedef {Object} FolderInfo
 * @property {string} name           opaque folder identifier (provider-specific)
 * @property {string} path           original cwd path
 * @property {number} sessionCount
 * @property {number} lastModified   epoch ms
 *
 * @typedef {Object} SessionInfo
 * @property {string} sessionId
 * @property {string} workDir
 * @property {string} title
 * @property {string} [preview]
 * @property {number} lastModified
 * @property {number} [size]
 *
 * @typedef {Object} HistoryMessage   a single claude_output `data` envelope
 */

export const PROVIDER_NAMES = Object.freeze(['claude-code', 'copilot']);
export const DEFAULT_PROVIDER = 'claude-code';
export function isValidProvider(name) {
  return typeof name === 'string' && PROVIDER_NAMES.includes(name);
}
