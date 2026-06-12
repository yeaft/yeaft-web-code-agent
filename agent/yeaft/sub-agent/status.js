/**
 * status.js — Centralized status vocabulary for the sub-agent subsystem.
 *
 * The same string set used to be sprinkled across tools/agent.js,
 * tools/wait-agent.js, tools/send-message.js, tools/close-agent.js,
 * tools/list-agents.js and sub-agent/runner.js. Every time we added a
 * status (e.g. 'abandoned' for the idle watchdog) we had to chase 5+
 * files and update string lists. This module is the single source of
 * truth.
 *
 * Status lifecycle:
 *
 *   created  → running ↔ idle (after each turn ends without queued prompt)
 *            ↓        ↓
 *            failed   completed
 *            ↓        ↓
 *            closed   abandoned (idle too long; reaped by watchdog)
 *
 * - 'created'   : registry record exists but the driver hasn't taken a
 *                  step yet. Transient — flips to 'running' on first tick.
 * - 'running'   : the sub-engine is processing a prompt.
 * - 'idle'      : the previous turn ended cleanly and the queue is empty.
 *                  The driver is parked in waitUntilResumed().
 * - 'completed' : terminal success — typically set by tickAgent() when a
 *                  budget cutoff is hit cleanly with a partial_output.
 * - 'failed'    : terminal — driver/adapter/stream raised; agent.error set.
 * - 'closed'    : terminal — CloseAgent called (or driver finally{} reaped
 *                  a cleanly-finishing agent).
 * - 'abandoned' : terminal — idle watchdog tripped (no prompt arrived in
 *                  IDLE_ABANDON_MS). Distinct from 'closed' so the parent
 *                  can tell "the parent forgot about me" from "the parent
 *                  deliberately wrapped me up".
 */

export const STATUS = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  IDLE: 'idle',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CLOSED: 'closed',
  ABANDONED: 'abandoned',
});

const TERMINAL = new Set([STATUS.COMPLETED, STATUS.FAILED, STATUS.CLOSED, STATUS.ABANDONED]);
const INTERACTIVE = new Set([STATUS.CREATED, STATUS.RUNNING, STATUS.IDLE]);

/** Is this status a permanent terminal state? */
export function isTerminalAgentStatus(status) {
  return TERMINAL.has(status);
}

/** Is the agent still alive and interactable (not terminal)? */
export function isInteractiveAgentStatus(status) {
  return INTERACTIVE.has(status);
}

/** Can PromptAgent successfully queue a prompt at this status? */
export function isPromptableAgentStatus(status) {
  // Even 'created' is promptable — the mission is the implicit first prompt
  // and a SendMessage racing the driver simply gets dequeued after the
  // mission.
  return status === STATUS.CREATED || status === STATUS.RUNNING || status === STATUS.IDLE;
}

/**
 * Build the canonical human-facing label for a status. Used by UI nudges
 * and `next_steps` strings so we don't drift between modules.
 */
export function describeAgentStatus(status) {
  switch (status) {
    case STATUS.CREATED:    return 'just spawned';
    case STATUS.RUNNING:    return 'running a turn';
    case STATUS.IDLE:       return 'idle (turn ended, queue empty)';
    case STATUS.COMPLETED:  return 'completed (terminal)';
    case STATUS.FAILED:     return 'failed (terminal)';
    case STATUS.CLOSED:     return 'closed (terminal)';
    case STATUS.ABANDONED:  return 'abandoned by idle watchdog (terminal)';
    default:                return String(status || 'unknown');
  }
}
