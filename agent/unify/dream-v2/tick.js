/**
 * dream-v2/tick.js — DESIGN.md §9.14 dream cadence.
 *
 * Hourly tick:
 *   1. For each registered scope, compute current signature.
 *   2. Read the scope cursor; if no diff, skip.
 *   3. On diff (or `force`), call the supplied `refresh(scope)` hook,
 *      which is responsible for rewriting `summary.md` / `index.md`.
 *      Any errors per scope are captured; other scopes still run.
 *   4. Write the new cursor.
 *
 * Phase 6 is intentionally refresh-only (DESIGN.md §8 line 395:
 * "Thin: skip pruning/demotion; refresh-only in v1"). The `refresh`
 * hook gets to decide what "refresh" means; this file just sequences
 * the diff-gated calls.
 */

import { computeScopeSig } from './scope-sig.js';
import { readCursor, writeCursor, shouldRunDream } from './diff-gate.js';

/**
 * @typedef {{ kind: 'user'|'group'|'vp'|'task', id?: string, scopeDir: string }} ScopeRef
 */

/**
 * @param {{
 *   root: string,
 *   scopes: ScopeRef[],
 *   refresh: (scope: ScopeRef) => Promise<void>,
 *   force?: boolean,
 *   computeSig?: (scope: ScopeRef) => Promise<string>,
 *   now?: () => string,
 * }} args
 * @returns {Promise<{
 *   ran: Array<{ scopeDir: string, reason: string }>,
 *   skipped: Array<{ scopeDir: string, reason: string }>,
 *   errors: Array<{ scopeDir: string, error: Error }>,
 * }>}
 */
export async function runDreamTick({
  root, scopes, refresh, force = false,
  computeSig, now,
}) {
  if (!root) throw new Error('runDreamTick: root required');
  if (!Array.isArray(scopes)) throw new Error('runDreamTick: scopes array required');
  if (typeof refresh !== 'function') throw new Error('runDreamTick: refresh fn required');

  const sigOf = typeof computeSig === 'function'
    ? computeSig
    : (s) => computeScopeSig({ root, scopeDir: s.scopeDir });
  const stamp = typeof now === 'function' ? now : () => new Date().toISOString();

  const ran = [];
  const skipped = [];
  const errors = [];

  for (const scope of scopes) {
    if (!scope || !scope.scopeDir) continue;
    let sig;
    try {
      sig = await sigOf(scope);
    } catch (err) {
      errors.push({ scopeDir: scope.scopeDir, error: err });
      continue;
    }
    const last = await readCursor({ root, scopeDir: scope.scopeDir });
    const decision = force
      ? { skip: false, reason: 'forced' }
      : shouldRunDream(last, sig);

    if (decision.skip) {
      skipped.push({ scopeDir: scope.scopeDir, reason: decision.reason });
      continue;
    }

    try {
      await refresh(scope);
      ran.push({ scopeDir: scope.scopeDir, reason: decision.reason });
    } catch (err) {
      errors.push({ scopeDir: scope.scopeDir, error: err });
      // Do NOT advance the cursor on failure — next tick should retry.
      continue;
    }

    // Recompute the sig AFTER refresh in case the refresh hook itself
    // wrote files; this is the value we want to compare against next tick.
    let postSig;
    try {
      postSig = await sigOf(scope);
    } catch {
      postSig = sig;
    }
    await writeCursor({
      root, scopeDir: scope.scopeDir, sig: postSig, tickAt: stamp(),
    });
  }

  return { ran, skipped, errors };
}
