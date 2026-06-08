/**
 * session-restore.test.js — feat-yeaft-session-restore (plan rosy-snuggling-waterfall.md).
 *
 * Covers the two new session-crud utilities + their wire handlers:
 *
 *   scanWorkdirSessions(defaultYeaftDir, workDir)
 *     - Walks `<workDir>/.yeaft/sessions/`, reads meta of each session dir.
 *     - Stamps `alreadyRegistered: bool` so the UI can disable rows the user
 *       already sees in the sidebar.
 *     - Returns `[]` for missing / unreadable / empty dirs (never throws).
 *     - Sort: newest createdAt first.
 *
 *   restoreSessionToRegistry(defaultYeaftDir, sessionId, workDir)
 *     - Validates `<workDir>/.yeaft/sessions/<id>/group.json` exists.
 *     - Writes the (id → workDir) entry into the central registry.
 *     - Idempotent — re-restore returns the meta, no throw.
 *     - Restored session then shows up in `snapshotSessions()`.
 *
 *   handleYeaftScanWorkdirSessions(msg) / handleYeaftRestoreSession(msg)
 *     - Both emit `session_crud_result` with op = 'scan_workdir' / 'restore'.
 *     - Restore success ALSO triggers `sendSessionSnapshotBroadcast()`
 *       (which broadcasts a `session_list_updated` so sidebars refresh
 *       hands-off — that's the "no manual refresh needed" piece in the
 *       plan).
 *
 * Why this matters: when the central `group-workdirs.json` is lost / wiped /
 * copied from another machine, sessions on disk become invisible to the
 * sidebar. Restore re-registers the (id, workDir) pair so snapshotSessions
 * picks them up again. See plan §"根因" for the full repro.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outbound = [];
vi.mock('../../../../agent/connection/buffer.js', () => ({
  sendToServer: (msg) => { outbound.push(msg); },
  flushMessageBuffer: () => {},
}));

import ctx from '../../../../agent/context.js';
import {
  scanWorkdirSessions,
  restoreSessionToRegistry,
  registerSessionWorkDir,
  readWorkDirRegistry,
  snapshotSessions,
  SessionCrudError,
  sessionsRoot,
} from '../../../../agent/yeaft/sessions/session-crud.js';
import { createSession } from '../../../../agent/yeaft/sessions/session-store.js';
import {
  handleYeaftScanWorkdirSessions,
  handleYeaftRestoreSession,
} from '../../../../agent/yeaft/web-bridge.js';

// Tiny seed helper that mimics what `createSessionFromSpec` writes on disk
// but without the memory / config side effects we don't care about here.
// Tests need full control over the `createdAt` field to verify sort order.
function seedSession(workDir, { id, name, createdAt }) {
  const dir = join(workDir, '.yeaft', 'sessions', id);
  mkdirSync(dir, { recursive: true });
  // Reuse the real `createSession` writer for forward-compat — if the
  // GROUP_FILE schema changes, this test still produces a valid record.
  const handle = createSession(join(workDir, '.yeaft', 'sessions'), {
    id, name, roster: ['alice'], defaultVpId: 'alice',
  });
  if (createdAt) {
    const meta = handle.getMeta();
    handle.saveMeta({ ...meta, createdAt });
  }
  handle.close();
}

function lastCrud() {
  for (let i = outbound.length - 1; i >= 0; i--) {
    const ev = outbound[i] && outbound[i].event;
    if (ev && ev.type === 'session_crud_result') return ev;
  }
  return null;
}

function findSnapshotBroadcast() {
  for (let i = outbound.length - 1; i >= 0; i--) {
    const ev = outbound[i] && outbound[i].event;
    if (ev && ev.type === 'session_list_updated') return ev;
  }
  return null;
}

let defaultYeaftDir;
let workDir;
beforeEach(() => {
  defaultYeaftDir = mkdtempSync(join(tmpdir(), 'restore-default-'));
  workDir = mkdtempSync(join(tmpdir(), 'restore-work-'));
  mkdirSync(join(defaultYeaftDir, 'sessions'), { recursive: true });
  ctx.CONFIG = { ...(ctx.CONFIG || {}), yeaftDir: defaultYeaftDir };
  outbound.length = 0;
});
afterEach(() => {
  rmSync(defaultYeaftDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe('scanWorkdirSessions', () => {
  it('Case A: returns every session in the workdir (utility is layer-pure — no registry decoration)', () => {
    seedSession(workDir, { id: 'grp_a1', name: 'A1', createdAt: '2026-06-01T10:00:00Z' });
    seedSession(workDir, { id: 'grp_a2', name: 'A2', createdAt: '2026-06-02T10:00:00Z' });
    seedSession(workDir, { id: 'grp_a3', name: 'A3', createdAt: '2026-06-03T10:00:00Z' });

    const out = scanWorkdirSessions(workDir);

    expect(out).toHaveLength(3);
    // Sort: newest createdAt first.
    expect(out.map(s => s.id)).toEqual(['grp_a3', 'grp_a2', 'grp_a1']);
    for (const s of out) {
      // Utility is layer-pure: it does NOT touch the registry, so
      // `alreadyRegistered` is the handler's job, NOT the utility's.
      // See handleYeaftScanWorkdirSessions test below for the decorated shape.
      expect(s).not.toHaveProperty('alreadyRegistered');
      expect(s.workDir).toBeTruthy();
    }
  });

  it('Case C: returns [] for an empty .yeaft/sessions dir', () => {
    mkdirSync(join(workDir, '.yeaft', 'sessions'), { recursive: true });
    expect(scanWorkdirSessions(workDir)).toEqual([]);
  });

  it('Case D: returns [] when the workdir has no .yeaft dir at all', () => {
    expect(scanWorkdirSessions(workDir)).toEqual([]);
  });

  it('skips dotfile entries like legacy .archived-* dirs', () => {
    seedSession(workDir, { id: 'grp_live', name: 'Live', createdAt: '2026-06-01T10:00:00Z' });
    // Drop a soft-archive sibling dir — must be excluded.
    mkdirSync(join(workDir, '.yeaft', 'sessions', '.archived-2024-01-grp_old'), { recursive: true });
    writeFileSync(
      join(workDir, '.yeaft', 'sessions', '.archived-2024-01-grp_old', 'group.json'),
      JSON.stringify({ id: 'grp_old', name: 'Old' }),
    );

    const out = scanWorkdirSessions(workDir);
    expect(out.map(s => s.id)).toEqual(['grp_live']);
  });

  it('returns [] when given an empty workDir string', () => {
    expect(scanWorkdirSessions('')).toEqual([]);
  });
});

describe('restoreSessionToRegistry', () => {
  it('Case E: throws not_found when the session does not exist on disk', () => {
    expect(() => restoreSessionToRegistry(defaultYeaftDir, 'grp_ghost', workDir))
      .toThrow(SessionCrudError);
    try {
      restoreSessionToRegistry(defaultYeaftDir, 'grp_ghost', workDir);
    } catch (e) {
      expect(e.code).toBe('not_found');
      expect(e.sessionId).toBe('grp_ghost');
    }
  });

  // I1 (review finding): "dir exists but group.json broken" is a
  // distinct failure mode from "dir missing entirely". The UI uses
  // this to tell the user "your file is corrupted" instead of "you
  // picked the wrong workdir" — silently collapsing both into
  // not_found would force the user to re-pick the same workdir
  // before realizing the issue is the file itself.
  it('Case E2: throws corrupt_meta when the dir exists but group.json is broken', () => {
    // Seed a session dir without a parseable group.json.
    const brokenDir = join(workDir, '.yeaft', 'sessions', 'grp_broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'group.json'), 'not-json{');

    try {
      restoreSessionToRegistry(defaultYeaftDir, 'grp_broken', workDir);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('corrupt_meta');
      expect(e.sessionId).toBe('grp_broken');
    }
  });

  it('throws invalid_session_id when sessionId is missing', () => {
    try {
      restoreSessionToRegistry(defaultYeaftDir, '', workDir);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('invalid_session_id');
    }
  });

  it('throws invalid_workdir when workDir is empty', () => {
    try {
      restoreSessionToRegistry(defaultYeaftDir, 'grp_x', '');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('invalid_workdir');
    }
  });

  it('Case F: registers (id,workDir) and exposes the session via snapshotSessions', () => {
    seedSession(workDir, { id: 'grp_f1', name: 'F1', createdAt: '2026-06-01T10:00:00Z' });

    // Pre: snapshot from default yeaftDir does NOT see the session.
    const before = snapshotSessions(defaultYeaftDir);
    expect(before.find(s => s.id === 'grp_f1')).toBeUndefined();

    const meta = restoreSessionToRegistry(defaultYeaftDir, 'grp_f1', workDir);
    expect(meta.id).toBe('grp_f1');
    expect(meta.name).toBe('F1');
    expect(meta.workDir).toBeTruthy();

    // Registry actually persisted.
    const registry = readWorkDirRegistry(defaultYeaftDir);
    expect(registry.grp_f1).toBe(meta.workDir);

    // Snapshot now includes it.
    const after = snapshotSessions(defaultYeaftDir);
    expect(after.find(s => s.id === 'grp_f1')).toBeTruthy();
  });

  it('Case G: idempotent — calling twice succeeds, registry has a single entry', () => {
    seedSession(workDir, { id: 'grp_g1', name: 'G1', createdAt: '2026-06-01T10:00:00Z' });

    const meta1 = restoreSessionToRegistry(defaultYeaftDir, 'grp_g1', workDir);
    const meta2 = restoreSessionToRegistry(defaultYeaftDir, 'grp_g1', workDir);

    expect(meta1.id).toBe(meta2.id);
    expect(meta1.workDir).toBe(meta2.workDir);

    const registry = readWorkDirRegistry(defaultYeaftDir);
    expect(Object.keys(registry).filter(k => k === 'grp_g1')).toHaveLength(1);
  });
});

describe('handleYeaftScanWorkdirSessions', () => {
  it('Case H: emits session_crud_result with op=scan_workdir + sessions array', () => {
    seedSession(workDir, { id: 'grp_h1', name: 'H1', createdAt: '2026-06-01T10:00:00Z' });
    seedSession(workDir, { id: 'grp_h2', name: 'H2', createdAt: '2026-06-02T10:00:00Z' });

    handleYeaftScanWorkdirSessions({ requestId: 'r-scan-1', workDir });

    const ev = lastCrud();
    expect(ev).toBeTruthy();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('scan_workdir');
    expect(ev.requestId).toBe('r-scan-1');
    expect(Array.isArray(ev.sessions)).toBe(true);
    expect(ev.sessions.map(s => s.id).sort()).toEqual(['grp_h1', 'grp_h2']);
  });

  // Lock in the layer split: utility scans the FS, handler folds in
  // `alreadyRegistered` by reading the central registry. Old version
  // did both in the utility (Fowler review finding — handler is the
  // right layer because the flag couples the per-workdir scan to a
  // specific agent's registry).
  it('Case H2: decorates alreadyRegistered=true for sessions already in the registry', () => {
    seedSession(workDir, { id: 'grp_h2a', name: 'H2a', createdAt: '2026-06-01T10:00:00Z' });
    seedSession(workDir, { id: 'grp_h2b', name: 'H2b', createdAt: '2026-06-02T10:00:00Z' });
    seedSession(workDir, { id: 'grp_h2c', name: 'H2c', createdAt: '2026-06-03T10:00:00Z' });
    registerSessionWorkDir(defaultYeaftDir, 'grp_h2b', workDir);

    handleYeaftScanWorkdirSessions({ requestId: 'r-h2', workDir });
    const ev = lastCrud();
    const byId = Object.fromEntries(ev.sessions.map(s => [s.id, s]));

    expect(byId.grp_h2a.alreadyRegistered).toBe(false);
    expect(byId.grp_h2b.alreadyRegistered).toBe(true);
    expect(byId.grp_h2c.alreadyRegistered).toBe(false);
  });

  it('emits ok=false with invalid_workdir code when workDir is missing', () => {
    handleYeaftScanWorkdirSessions({ requestId: 'r-scan-bad', workDir: '' });

    const ev = lastCrud();
    expect(ev.ok).toBe(false);
    expect(ev.op).toBe('scan_workdir');
    expect(ev.error?.code).toBe('invalid_workdir');
  });
});

describe('handleYeaftRestoreSession', () => {
  it('Case I: emits session_crud_result + session_list_updated on success', () => {
    seedSession(workDir, { id: 'grp_i1', name: 'I1', createdAt: '2026-06-01T10:00:00Z' });

    handleYeaftRestoreSession({ requestId: 'r-restore-1', sessionId: 'grp_i1', workDir });

    const crud = lastCrud();
    expect(crud).toBeTruthy();
    expect(crud.ok).toBe(true);
    expect(crud.op).toBe('restore');
    expect(crud.requestId).toBe('r-restore-1');
    expect(crud.session.id).toBe('grp_i1');

    // sendSessionSnapshotBroadcast() should have fired alongside.
    const snap = findSnapshotBroadcast();
    expect(snap).toBeTruthy();
    expect(Array.isArray(snap.sessions)).toBe(true);
    expect(snap.sessions.find(s => s.id === 'grp_i1')).toBeTruthy();
  });

  it('emits ok=false + does NOT broadcast snapshot when sessionId is missing', () => {
    handleYeaftRestoreSession({ requestId: 'r-restore-bad', sessionId: '', workDir });

    const ev = lastCrud();
    expect(ev.ok).toBe(false);
    expect(ev.op).toBe('restore');
    expect(ev.error?.code).toBe('invalid_session_id');

    // Snapshot must NOT have been broadcast for a failed op.
    expect(findSnapshotBroadcast()).toBeNull();
  });

  it('emits ok=false with not_found when the session dir does not exist', () => {
    handleYeaftRestoreSession({ requestId: 'r-restore-missing', sessionId: 'grp_zzz', workDir });

    const ev = lastCrud();
    expect(ev.ok).toBe(false);
    expect(ev.op).toBe('restore');
    expect(ev.error?.code).toBe('not_found');
  });
});

// Smoke test that exercises the full register path: scan finds the session,
// caller restores it, second scan sees alreadyRegistered=true. Pins the
// UX contract from the plan: "再次打开 Restore modal、选同一个 dir → 那个
// 刚恢复的 session 旁边显示 '已在 sidebar 中'，无法再点".
//
// Uses the handler (not the utility) because `alreadyRegistered` decoration
// now lives in the handler layer — `scanWorkdirSessions(workDir)` itself
// is layer-pure and doesn't read the registry.
describe('scan → restore → re-scan flow', () => {
  it('flips alreadyRegistered to true on the second scan (via handler)', () => {
    seedSession(workDir, { id: 'grp_flow', name: 'Flow', createdAt: '2026-06-01T10:00:00Z' });

    handleYeaftScanWorkdirSessions({ requestId: 'r-flow-1', workDir });
    const first = lastCrud();
    expect(first.ok).toBe(true);
    expect(first.sessions[0].alreadyRegistered).toBe(false);

    handleYeaftRestoreSession({ requestId: 'r-flow-2', sessionId: 'grp_flow', workDir });

    handleYeaftScanWorkdirSessions({ requestId: 'r-flow-3', workDir });
    const second = lastCrud();
    expect(second.ok).toBe(true);
    expect(second.sessions[0].alreadyRegistered).toBe(true);
  });
});

// Sanity: sessionsRoot helper still resolves what we think it does, so the
// "skip .archived-* dirs" test doesn't silently pass on a wrong path.
describe('sessionsRoot helper', () => {
  it('resolves to <yeaftDir>/sessions', () => {
    expect(sessionsRoot('/tmp/yeaft')).toBe(join('/tmp/yeaft', 'sessions'));
  });
});
