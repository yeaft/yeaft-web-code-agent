/**
 * session-create-modal-agent-scope.test.js — regression for the Yeaft
 * "选了目录却刷不出 session" bug.
 *
 * Root cause (three linked defects in web/components/SessionCreateModal.js):
 *
 *   1. form.agentId was seeded ONLY in mounted(). The agent roster arrives
 *      asynchronously over the WebSocket, so on a cold page load
 *      agentOptions is empty at mount → form.agentId stays null. A
 *      <select> bound to null still visually shows its first <option>
 *      ("server"), so the user sees an agent picked while the model is
 *      empty.
 *   2. The scan then went out with `agentId: form.agentId || null`. The
 *      server falls back to client.currentAgent (the top-left agent list)
 *      when agentId is empty, scanning the WRONG agent's disk → empty
 *      session list.
 *   3. The folder list (folderAggregates) aggregated sessions across ALL
 *      agents, so it showed folders the selected agent couldn't scan.
 *
 * What this pins:
 *   - seedAgentDefault() re-seeds form.agentId once agents hydrate, and
 *     leaves an already-valid online choice alone.
 *   - folderAggregates / agentSessions are scoped to form.agentId.
 *   - loadRestoreCandidates sends the SELECTED agentId (never null) and
 *     refuses to scan when no agent resolves.
 *
 * Unit-only: we pull computed/methods off the component definition and
 * invoke them against a hand-built `this`, mirroring llm-tab-model-refs.
 */
import { describe, it, expect } from 'vitest';

// SessionCreateModal transitively imports stores (via VpAvatar) that do
// `const { defineStore } = Pinia` at module-eval time against a global
// Pinia. Shim it before importing so the import chain doesn't throw.
// We only test pure computed/methods logic, so a no-op defineStore is fine.
globalThis.Pinia = globalThis.Pinia || {};
if (typeof globalThis.Pinia.defineStore !== 'function') {
  globalThis.Pinia.defineStore = () => () => ({});
}

const { default: SessionCreateModal } = await import('../../web/components/SessionCreateModal.js');

const { seedAgentDefault, loadRestoreCandidates } = SessionCreateModal.methods;
const { folderAggregates, agentSessions, agentSignature } = SessionCreateModal.computed;

describe('SessionCreateModal — seedAgentDefault', () => {
  it('seeds form.agentId once agents hydrate (cold-load: empty at mount)', () => {
    const ctx = {
      form: { agentId: null },
      chat: { currentAgent: null },
      agentOptions: [
        { id: 'server', online: true },
        { id: 'laptop', online: true },
      ],
    };
    seedAgentDefault.call(ctx);
    // No preferred → first online wins.
    expect(ctx.form.agentId).toBe('server');
  });

  it('prefers the chat currentAgent when it is online', () => {
    const ctx = {
      form: { agentId: null },
      chat: { currentAgent: 'laptop' },
      agentOptions: [
        { id: 'server', online: true },
        { id: 'laptop', online: true },
      ],
    };
    seedAgentDefault.call(ctx);
    expect(ctx.form.agentId).toBe('laptop');
  });

  it('does NOT clobber an already-valid online selection (user choice wins)', () => {
    const ctx = {
      form: { agentId: 'laptop' },
      chat: { currentAgent: 'server' },
      agentOptions: [
        { id: 'server', online: true },
        { id: 'laptop', online: true },
      ],
    };
    seedAgentDefault.call(ctx);
    expect(ctx.form.agentId).toBe('laptop');
  });

  it('re-seeds when the current selection has gone offline / stale', () => {
    const ctx = {
      form: { agentId: 'laptop' },
      chat: { currentAgent: null },
      agentOptions: [
        { id: 'server', online: true },
        { id: 'laptop', online: false }, // went offline
      ],
    };
    seedAgentDefault.call(ctx);
    expect(ctx.form.agentId).toBe('server');
  });

  it('leaves agentId null when nothing is online (canSubmit gates the form)', () => {
    const ctx = {
      form: { agentId: null },
      chat: { currentAgent: null },
      agentOptions: [{ id: 'server', online: false }],
    };
    seedAgentDefault.call(ctx);
    expect(ctx.form.agentId).toBe(null);
  });

  it('is a no-op when the roster is empty (still loading)', () => {
    const ctx = {
      form: { agentId: null },
      chat: { currentAgent: 'server' },
      agentOptions: [],
    };
    seedAgentDefault.call(ctx);
    expect(ctx.form.agentId).toBe(null);
  });
});

describe('SessionCreateModal — agentSignature watcher key (offline detection)', () => {
  // Review (both personas, Important): the re-seed watcher must key on
  // agent identity+online, NOT agentOptions.length — the UI keeps offline
  // agents in the list, so an agent going offline leaves the length
  // unchanged. agentSignature is the watched value; these pin that it
  // actually changes when online flips (so the watcher fires) and that a
  // re-seed then moves form.agentId off the dead agent.
  it('signature changes when an agent flips online→offline (length unchanged)', () => {
    const before = agentSignature.call({
      agentOptions: [{ id: 'server', online: true }, { id: 'laptop', online: true }],
    });
    const after = agentSignature.call({
      agentOptions: [{ id: 'server', online: false }, { id: 'laptop', online: true }],
    });
    expect(before).not.toBe(after); // a length watcher would see no change
  });

  it('signature changes on a simultaneous up/down swap (length unchanged)', () => {
    const before = agentSignature.call({
      agentOptions: [{ id: 'server', online: true }, { id: 'laptop', online: false }],
    });
    const after = agentSignature.call({
      agentOptions: [{ id: 'server', online: false }, { id: 'laptop', online: true }],
    });
    expect(before).not.toBe(after);
  });

  it('re-seeds form.agentId off an agent that just went offline', () => {
    // Simulate the orchestration: form.agentId was seeded to "server",
    // which then goes offline. The agentSignature watcher fires
    // seedAgentDefault, which must move the selection to an online agent.
    const ctx = {
      form: { agentId: 'server' },
      chat: { currentAgent: null },
      agentOptions: [{ id: 'server', online: false }, { id: 'laptop', online: true }],
    };
    seedAgentDefault.call(ctx); // what the watcher calls
    expect(ctx.form.agentId).toBe('laptop');
  });
});

describe('SessionCreateModal — folder list scoped to selected agent', () => {
  const sessions = [
    { id: 's1', agentId: 'server', workDir: '/home/hyi/Projects/cwc' },
    { id: 's2', agentId: 'server', workDir: '/home/hyi/Projects/cwc' },
    { id: 's3', agentId: 'laptop', workDir: '/home/other/proj' },
  ];

  it('agentSessions only includes rows owned by form.agentId', () => {
    const ctx = { form: { agentId: 'server' }, allSessions: sessions };
    const rows = agentSessions.call(ctx);
    expect(rows.map(s => s.id)).toEqual(['s1', 's2']);
  });

  it('folderAggregates lists only the selected agent\'s workdirs', () => {
    const ctx = {
      form: { agentId: 'server' },
      allSessions: sessions,
      agentSessions: agentSessions.call({ form: { agentId: 'server' }, allSessions: sessions }),
    };
    const folders = folderAggregates.call(ctx);
    expect(folders).toEqual([{ path: '/home/hyi/Projects/cwc', count: 2 }]);
    // The other agent's folder must NOT leak in.
    expect(folders.some(f => f.path === '/home/other/proj')).toBe(false);
  });

  it('keeps legacy rows without an agentId (single-agent setups)', () => {
    const legacy = [{ id: 'x', agentId: null, workDir: '/legacy' }];
    const ctx = { form: { agentId: 'server' }, allSessions: legacy };
    expect(agentSessions.call(ctx).map(s => s.id)).toEqual(['x']);
  });
});

describe('SessionCreateModal — scan sends the selected agentId, never null', () => {
  function mkCtx(formAgentId, folderPickerAgentId) {
    const calls = [];
    return {
      calls,
      restoreScanning: false,
      form: { agentId: formAgentId, workDir: '/home/hyi/Projects/cwc' },
      folderPickerAgentId,
      scannedSessions: [],
      restoreError: '',
      $t: (_k, vars) => (vars && vars.message) || _k,
      chat: {
        async sessionCrudRequest(op, data, opts) {
          calls.push({ op, data, opts });
          return { ok: true, sessions: [] };
        },
      },
    };
  }

  it('forwards form.agentId on the scan_workdir request', async () => {
    const ctx = mkCtx('server', 'server');
    await loadRestoreCandidates.call(ctx);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].op).toBe('scan_workdir');
    expect(ctx.calls[0].opts).toEqual({ agentId: 'server' });
  });

  it('refuses to scan (no request) when form.agentId is empty — no currentAgent fallback', async () => {
    // Even if a folderPickerAgentId (currentAgent-derived) is available,
    // the scan must NOT borrow it: the modal's scan follows ONLY the
    // user's in-modal selection, decoupled from the top-left agent list.
    const ctx = mkCtx(null, 'laptop');
    await loadRestoreCandidates.call(ctx);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.restoreError).toBeTruthy();
  });

  it('refuses to scan (no request) when no agent resolves — never sends null', async () => {
    const ctx = mkCtx(null, '');
    await loadRestoreCandidates.call(ctx);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.restoreError).toBeTruthy();
  });
});

describe('SessionCreateModal — restore guards null agentId too', () => {
  const { onRestoreClick } = SessionCreateModal.methods;

  function mkCtx(formAgentId) {
    const calls = [];
    return {
      calls,
      restoring: null,
      form: { agentId: formAgentId, workDir: '/home/hyi/Projects/cwc' },
      restoreError: '',
      sessionsStore: { setActive() {} },
      $emit() {},
      $t: (_k, vars) => (vars && vars.message) || _k,
      chat: {
        currentAgent: 'server',
        selectAgent() {},
        setActiveSessionFilter() {},
        async sessionCrudRequest(op, data, opts) {
          calls.push({ op, data, opts });
          return { ok: true, session: { id: data.sessionId, agentId: opts.agentId } };
        },
      },
    };
  }

  it('restores with the selected agentId', async () => {
    const ctx = mkCtx('server');
    await onRestoreClick.call(ctx, { id: 'sess-1' });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].op).toBe('restore');
    expect(ctx.calls[0].opts).toEqual({ agentId: 'server' });
  });

  it('refuses to restore (no request) when form.agentId is empty — never sends null', async () => {
    const ctx = mkCtx(null);
    await onRestoreClick.call(ctx, { id: 'sess-1' });
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.restoreError).toBeTruthy();
  });
});
