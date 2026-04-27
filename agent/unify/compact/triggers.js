/**
 * compact/triggers.js — DESIGN.md §4.1.
 *
 * Pure functions: do I need to compact, and which triggers fired?
 * Caller (orchestrator) decides what to do next; this module never
 * touches disk or messages.
 */

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_TOKEN_RATIO = 0.9;
const DEFAULT_IDLE_MS = 2 * 60 * 1000;

/**
 * @param {{
 *   messages: object[],
 *   tokenCount: number,
 *   contextLimit: number,
 *   lastActivityAt?: number,
 *   now?: number,
 *   explicit?: boolean,
 *   maxMessages?: number,
 *   tokenRatio?: number,
 *   idleMs?: number,
 * }} state
 * @returns {{ trigger: boolean, reasons: string[] }}
 */
export function evaluateCompactTriggers(state = {}) {
  const reasons = [];
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const tokenCount = Number.isFinite(state.tokenCount) ? state.tokenCount : 0;
  const contextLimit = Number.isFinite(state.contextLimit) && state.contextLimit > 0
    ? state.contextLimit : 0;
  const tokenRatio = Number.isFinite(state.tokenRatio) ? state.tokenRatio : DEFAULT_TOKEN_RATIO;
  const maxMessages = Number.isFinite(state.maxMessages) ? state.maxMessages : DEFAULT_MAX_MESSAGES;
  const idleMs = Number.isFinite(state.idleMs) ? state.idleMs : DEFAULT_IDLE_MS;

  if (state.explicit) reasons.push('explicit');

  if (contextLimit > 0 && tokenCount > tokenRatio * contextLimit) {
    reasons.push('token_threshold');
  }

  if (messages.length > maxMessages) {
    reasons.push('message_count');
  }

  if (Number.isFinite(state.lastActivityAt) && Number.isFinite(state.now)) {
    if (state.now - state.lastActivityAt > idleMs) {
      reasons.push('idle');
    }
  }

  return { trigger: reasons.length > 0, reasons };
}
