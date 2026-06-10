/**
 * seed-default.js — First-boot default session (architecture §10 D1).
 *
 * When multi-VP mode is first enabled for a user, seed a default session with
 * the provided roster (typically `[defaultVpId]`). Idempotent: if the session
 * already exists on disk, returns the existing handle without overwriting.
 *
 * Separation from group-store.createSession:
 *   - createSession throws on duplicate; seed returns the existing handle.
 *   - seed picks a stable id `session_default` so UI can deep-link to it.
 *   - seed is the only place that writes the "default session exists" side
 *     effect during the bootstrap flow.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { openSession, createSession, loadSessionMeta } from './session-store.js';
import { seedSummaryIfMissingSync } from '../memory/store.js';

export const DEFAULT_SESSION_ID = 'session_default';

/**
 * Default memory root used when callers don't pass `options.memoryRoot`.
 * See `sessions/session-crud.js` and `vp/vp-crud.js` for the same default;
 * production code threads `<yeaftDir>/memory` through to keep test/prod
 * isolation honest.
 */
const DEFAULT_MEMORY_ROOT = join(homedir(), '.yeaft', 'memory');

/**
 * Build the default-session seed summary body. Pulled into a helper so
 * tests can pin the exact format. Mirrors `buildSessionSeedSummary` in
 * `session-crud.js` shape, with the "Default session" wording reserved for
 * the bootstrap path.
 *
 * @param {{ name?: string, roster?: string[], defaultVpId?: string|null }} spec
 * @returns {string}
 */
export function buildDefaultSessionSeedSummary(spec) {
  const name = String(spec?.name || 'Default').trim();
  const roster = Array.isArray(spec?.roster) ? spec.roster : [];
  const defaultVpId = spec?.defaultVpId || null;
  const lines = [`# ${name}`, ''];
  lines.push(`Default session with ${roster.length} member${roster.length === 1 ? '' : 's'}.`);
  if (roster.length > 0) lines.push('', `**Members:** ${roster.join(', ')}`);
  if (defaultVpId) lines.push('', `**Default VP:** ${defaultVpId}`);
  return lines.join('\n').trim();
}

/**
 * @param {string} yeaftDir
 * @param {{ defaultVpId?: string|null, roster?: string[], name?: string, memoryRoot?: string }} [spec]
 * @returns {{ group: import('./session-store.js').GroupHandle, created: boolean }}
 */
export function seedDefaultSession(yeaftDir, spec = {}) {
  const memoryRoot = spec.memoryRoot || DEFAULT_MEMORY_ROOT;
  const sessionsRoot = join(yeaftDir, 'sessions');
  if (!existsSync(sessionsRoot)) mkdirSync(sessionsRoot, { recursive: true });

  const existingDir = join(sessionsRoot, DEFAULT_SESSION_ID);
  if (existsSync(existingDir) && loadSessionMeta(existingDir)) {
    return { group: openSession(sessionsRoot, DEFAULT_SESSION_ID), created: false };
  }

  const roster = Array.isArray(spec.roster) && spec.roster.length
    ? spec.roster.slice()
    : (spec.defaultVpId ? [spec.defaultVpId] : []);
  const defaultVpId = spec.defaultVpId || roster[0] || null;
  const name = spec.name || 'Default';

  const group = createSession(sessionsRoot, {
    id: DEFAULT_SESSION_ID,
    name,
    roster,
    defaultVpId,
  });

  // Seed Layer-A resident summary so the very first session — even on a
  // brand-new install where only `session_default` exists — renders a non-
  // empty memory section in the system prompt. No-op once Dream-v2 (or
  // createSessionFromSpec) has already written one. Best-effort: a memory-
  // root permission failure must NOT break the bootstrap flow.
  try {
    seedSummaryIfMissingSync(
      { kind: 'group', id: DEFAULT_SESSION_ID },
      buildDefaultSessionSeedSummary({ name, roster, defaultVpId }),
      { root: memoryRoot },
    );
  } catch (err) {
    console.warn(`[seed-default] failed to seed summary.md for ${DEFAULT_SESSION_ID}:`, err?.message || err);
  }

  return { group, created: true };
}
