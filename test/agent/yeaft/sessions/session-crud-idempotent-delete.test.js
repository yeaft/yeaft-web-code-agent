/**
 * session-crud-idempotent-delete.test.js — Pin the contract that
 * `deleteSession` and `archiveSession` are idempotent: deleting an absent
 * session must NOT throw `not_found`. The server's shadow-row cleanup only
 * fires on `session_crud_result { ok: true, op: 'delete' }`, so any orphan
 * row in `yeaft_sessions` (e.g. legacy pre-PR-#905 deterministic ids that
 * the agent no longer carries because the on-disk dir is gone) would
 * otherwise be un-deletable from the UI.
 *
 * Repro of the user report: opened "Yeaft — 会话设置" → 危险操作 on an old
 * session named `Yeaft`, clicked 删除会话, got "会话操作失败：not_found:
 * grp_yeaft". The on-disk dir was already gone; the server shadow row
 * persisted; user had no UI path to clear it.
 *
 * The plan (graceful-wibbling-lamport.md):
 *   - deleteSession(absent)  → { ok, deleted: false, legacyCleanedUp: 0, alreadyGone: true }
 *   - archiveSession(absent) → { ok, archivedAs: null, alreadyGone: true }
 *   - deleteSession(present) → { ok, deleted: true, alreadyGone: false }
 *   - deleteSession(absent) still tears down stray memory dir (best-effort)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  archiveSession,
  deleteSession,
  createSessionFromSpec,
  sessionsRoot,
} from '../../../../agent/yeaft/sessions/session-crud.js';

let yeaftDir;
beforeEach(() => {
  yeaftDir = mkdtempSync(join(tmpdir(), 'session-idemp-'));
  mkdirSync(join(yeaftDir, 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(yeaftDir, { recursive: true, force: true });
});

describe('deleteSession idempotency (orphan session fix)', () => {
  it('returns { ok, alreadyGone: true } when the session has no on-disk dir', () => {
    // Mirrors the user repro: server shadow row for `grp_yeaft` survives but
    // the agent's <yeaftDir>/sessions/grp_yeaft does not exist.
    expect(existsSync(join(sessionsRoot(yeaftDir), 'grp_yeaft'))).toBe(false);

    const result = deleteSession(yeaftDir, 'grp_yeaft');

    expect(result.sessionId).toBe('grp_yeaft');
    expect(result.deleted).toBe(false);
    expect(result.legacyCleanedUp).toBe(0);
    expect(result.alreadyGone).toBe(true);
  });

  it('returns { ok, deleted: true, alreadyGone: false } for a present session', () => {
    const meta = createSessionFromSpec(yeaftDir, {
      name: `Live_${Date.now()}`,
      roster: ['alice'],
      defaultVpId: 'alice',
    });
    expect(existsSync(join(sessionsRoot(yeaftDir), meta.id))).toBe(true);

    const result = deleteSession(yeaftDir, meta.id);

    expect(result.sessionId).toBe(meta.id);
    expect(result.deleted).toBe(true);
    expect(result.alreadyGone).toBe(false);
    expect(existsSync(join(sessionsRoot(yeaftDir), meta.id))).toBe(false);
  });

  it('tears down a stale memory scope dir even when the session is already gone', () => {
    // The orphan-recreate problem we're guarding against: the on-disk
    // session dir is gone, but the memory scope dir for it survived a
    // prior incomplete cleanup. If we leave it behind, a future
    // createSessionFromSpec that picks the same id (legacy deterministic
    // ids like `grp_yeaft` are exactly this cohort) would inherit a stale
    // `summary.md` via `seedSummaryIfMissingSync`.
    const memScope = join(yeaftDir, 'memory', 'group', 'grp_ghost');
    mkdirSync(memScope, { recursive: true });
    writeFileSync(join(memScope, 'summary.md'), '# stale ghost summary\n');

    const result = deleteSession(yeaftDir, 'grp_ghost');

    expect(result.alreadyGone).toBe(true);
    expect(existsSync(memScope)).toBe(false);
    expect(existsSync(join(sessionsRoot(yeaftDir), 'grp_ghost'))).toBe(false);
  });

  it('cleans only the legacy archive dirs when no live session exists', () => {
    // Branch: `!liveExists && legacyDirs.length > 0`. The id has no live
    // dir but a stale soft-archive dir lingers from the pre-Bug-8 flow.
    // Expected: legacy dirs are swept, `deleted: false` (no live dir was
    // removed), `alreadyGone: false` (we did clean something).
    const root = sessionsRoot(yeaftDir);
    const legacyA = join(root, '.archived-2024-01-01T00-00-00-0000Z-aaaa-grp_legacy');
    const legacyB = join(root, '.archived-2024-02-02T00-00-00-0000Z-bbbb-grp_legacy');
    mkdirSync(legacyA, { recursive: true });
    mkdirSync(legacyB, { recursive: true });
    writeFileSync(join(legacyA, 'meta.json'), '{}');

    const result = deleteSession(yeaftDir, 'grp_legacy');

    expect(result.sessionId).toBe('grp_legacy');
    expect(result.deleted).toBe(false);
    expect(result.legacyCleanedUp).toBe(2);
    expect(result.alreadyGone).toBe(false);
    expect(existsSync(legacyA)).toBe(false);
    expect(existsSync(legacyB)).toBe(false);
  });
});

describe('archiveSession idempotency', () => {
  it('returns { ok, archivedAs: null, alreadyGone: true } when the session has no on-disk dir', () => {
    expect(existsSync(join(sessionsRoot(yeaftDir), 'grp_yeaft'))).toBe(false);

    const result = archiveSession(yeaftDir, 'grp_yeaft');

    expect(result.sessionId).toBe('grp_yeaft');
    expect(result.archivedAs).toBeNull();
    expect(result.alreadyGone).toBe(true);
  });

  it('actually archives a present session (regression guard for happy path)', () => {
    const meta = createSessionFromSpec(yeaftDir, {
      name: `Arch_${Date.now()}`,
      roster: ['alice'],
      defaultVpId: 'alice',
    });
    const srcDir = join(sessionsRoot(yeaftDir), meta.id);
    expect(existsSync(srcDir)).toBe(true);

    const result = archiveSession(yeaftDir, meta.id);

    expect(result.sessionId).toBe(meta.id);
    expect(result.alreadyGone).toBe(false);
    expect(typeof result.archivedAs).toBe('string');
    expect(result.archivedAs).toMatch(/\.archived-/);
    expect(existsSync(srcDir)).toBe(false);
    expect(existsSync(result.archivedAs)).toBe(true);
  });
});
