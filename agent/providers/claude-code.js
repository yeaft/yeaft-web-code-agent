import { startClaudeQuery } from '../claude.js';

export const name = 'claude-code';

/**
 * Start (or resume) a Claude Code CLI session.
 * Returns the same state object that startClaudeQuery stores in ctx.conversations.
 */
export async function start(opts) {
  const state = await startClaudeQuery(
    opts.conversationId,
    opts.workDir,
    opts.resumeSessionId || null
  );
  state.providerName = name;
  return state;
}

/**
 * Claude CLI handles input via the persistent stdin Stream that
 * conversation.js manages directly, so this driver's sendInput is a no-op.
 * conversation.js's existing branch keeps owning the Claude path.
 */
export async function sendInput(_state, _prompt, _opts) {
  /* handled inline by conversation.js for the Claude branch */
}

export function abort(state) {
  if (state?.abortController) {
    try { state.abortController.abort(); } catch { /* noop */ }
  }
}

export default { name, start, sendInput, abort };
