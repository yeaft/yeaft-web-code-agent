/**
 * fix-session-restore-modal-unify — pin the merged "Restore from disk" flow.
 *
 * Originally this test pinned the standalone "restore" panel and its
 * `restoreCandidates` computed (disk-scan minus sidebar). The duplicate-list
 * merge on 2026-06-09 collapsed the two stacked panels into one
 * `sessionsInDir` list with a per-row `inSidebar` flag — the partition
 * coverage moved to `session-create-modal-chat-style.test.js`. This file
 * now only pins the wire contracts that still matter:
 *   - `loadRestoreCandidates`: forwards a `scan_workdir` CRUD request with
 *     the correct workDir + agentId envelope, stores the result.
 *   - `onRestoreClick`: forwards a `restore` CRUD request and emits
 *     `created` + `close` on success.
 *
 * Mounting trick: same Pinia stub as the sibling chat-style test.
 */
import { beforeAll, describe, expect, it } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

let SessionCreateModal;
beforeAll(async () => {
  SessionCreateModal = (await import('../../web/components/SessionCreateModal.js')).default;
});

describe('SessionCreateModal loadRestoreCandidates — wire envelope', () => {
  it('forwards { workDir } payload and { agentId } envelope to chat.sessionCrudRequest', async () => {
    const calls = [];
    const ctx = {
      form: { workDir: '/repo/myproj', agentId: 'agt_alice' },
      chat: {
        sessionCrudRequest: async (op, payload, envelope) => {
          calls.push({ op, payload, envelope });
          return { ok: true, sessions: [{ id: 's1', name: 'on-disk' }] };
        },
      },
      scannedSessions: [],
      restoreScanning: false,
      restoreError: '',
      $t: (k) => k,
    };
    await SessionCreateModal.methods.loadRestoreCandidates.call(ctx);
    expect(calls).toEqual([{
      op: 'scan_workdir',
      payload: { workDir: '/repo/myproj' },
      envelope: { agentId: 'agt_alice' },
    }]);
    expect(ctx.scannedSessions.map(s => s.id)).toEqual(['s1']);
    expect(ctx.restoreError).toBe('');
  });

  it('falls back to `groups` payload key (wire-compat with old agents)', async () => {
    const ctx = {
      form: { workDir: '/r', agentId: null },
      chat: { sessionCrudRequest: async () => ({ ok: true, groups: [{ id: 'g1' }] }) },
      scannedSessions: [],
      restoreScanning: false,
      restoreError: '',
      $t: (k) => k,
    };
    await SessionCreateModal.methods.loadRestoreCandidates.call(ctx);
    expect(ctx.scannedSessions.map(s => s.id)).toEqual(['g1']);
  });

  it('clears state and bails out when workDir is empty', async () => {
    const ctx = {
      form: { workDir: '   ', agentId: 'agt_alice' },
      chat: { sessionCrudRequest: async () => { throw new Error('should not be called'); } },
      scannedSessions: [{ id: 'stale' }],
      restoreScanning: false,
      restoreError: '',
      $t: (k) => k,
    };
    await SessionCreateModal.methods.loadRestoreCandidates.call(ctx);
    expect(ctx.scannedSessions).toEqual([]);
  });

  it('sets restoreError when chat returns ok:false', async () => {
    const ctx = {
      form: { workDir: '/repo', agentId: null },
      chat: { sessionCrudRequest: async () => ({ ok: false, error: { code: 'ENOENT', message: 'no such dir' } }) },
      scannedSessions: [],
      restoreScanning: false,
      restoreError: '',
      $t: (k, args) => `${k}:${args?.message || ''}`,
    };
    await SessionCreateModal.methods.loadRestoreCandidates.call(ctx);
    expect(ctx.restoreError).toBe('yeaft.restore.modal.scanError:no such dir');
    expect(ctx.scannedSessions).toEqual([]);
  });

  it('skips re-firing when a scan is already inflight (single-inflight guard)', async () => {
    // Fowler I1 + Torvalds M3: rapid agentId / workDir watcher fires
    // would otherwise stack scan_workdir requests at the agent. The
    // guard returns early when restoreScanning is already true.
    let callCount = 0;
    const ctx = {
      form: { workDir: '/repo', agentId: null },
      chat: { sessionCrudRequest: async () => { callCount++; return { ok: true, sessions: [] }; } },
      scannedSessions: [],
      restoreScanning: true, // already inflight
      restoreError: '',
      $t: (k) => k,
    };
    await SessionCreateModal.methods.loadRestoreCandidates.call(ctx);
    expect(callCount).toBe(0);
  });
});

describe('SessionCreateModal onRestoreClick — wire envelope + emits', () => {
  it('forwards { sessionId, workDir } payload + { agentId } envelope, then emits created + close', async () => {
    const calls = [];
    const emitted = [];
    const ctx = {
      form: { workDir: '/repo/myproj', agentId: 'agt_alice' },
      restoring: null,
      restoreError: '',
      chat: {
        currentAgent: 'agt_alice',
        sessionCrudRequest: async (op, payload, envelope) => {
          calls.push({ op, payload, envelope });
          return { ok: true, session: { id: 's-restored', name: 'restored' } };
        },
        setActiveSessionFilter: () => {},
      },
      sessionsStore: { setActive: () => {} },
      $emit: (name, payload) => emitted.push([name, payload]),
      $t: (k) => k,
    };
    await SessionCreateModal.methods.onRestoreClick.call(ctx, { id: 's-restored' });
    expect(calls).toEqual([{
      op: 'restore',
      payload: { sessionId: 's-restored', workDir: '/repo/myproj' },
      envelope: { agentId: 'agt_alice' },
    }]);
    expect(emitted.map(e => e[0])).toEqual(['created', 'close']);
  });

  it('does not fire a second request while one is inflight (single-inflight guard)', async () => {
    let callCount = 0;
    const ctx = {
      form: { workDir: '/repo', agentId: null },
      restoring: 's-restored', // already inflight
      restoreError: '',
      chat: { sessionCrudRequest: async () => { callCount++; return { ok: true }; } },
      $emit: () => {},
      $t: (k) => k,
    };
    await SessionCreateModal.methods.onRestoreClick.call(ctx, { id: 's-different' });
    expect(callCount).toBe(0);
  });

  it('sets restoreError when chat returns ok:false', async () => {
    const ctx = {
      form: { workDir: '/repo', agentId: null },
      restoring: null,
      restoreError: '',
      chat: { sessionCrudRequest: async () => ({ ok: false, error: { message: 'workdir registry locked' } }) },
      sessionsStore: { setActive: () => {} },
      $emit: () => {},
      $t: (k, args) => `${k}:${args?.message || ''}`,
    };
    await SessionCreateModal.methods.onRestoreClick.call(ctx, { id: 's-fail' });
    expect(ctx.restoreError).toBe('yeaft.restore.modal.restoreError:workdir registry locked');
    expect(ctx.restoring).toBeNull();
  });
});
