/**
 * routing/ — VP-side @-forward dispatch (task-334d).
 *
 * Layered on top of 334b Group Coordinator:
 *   - loop-guard: chain-depth + rate-window protection
 *   - router:     route_forward → coordinator.ingest wrapper with guard,
 *                  self-reject, task.members forwarding, and causedBy chain.
 *
 * See agent/unify/tools/route-forward.js for the VP-facing tool.
 */

export {
  createLoopGuard,
  extendCausedBy,
  MAX_CHAIN_DEPTH,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_HITS_PER_WINDOW,
  DEFAULT_MAX_KEYS,
  DEFAULT_TTL_MULTIPLIER,
} from './loop-guard.js';
export { createRouter } from './router.js';
