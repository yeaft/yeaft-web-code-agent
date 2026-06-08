/**
 * SessionRestoreModal — method contract test (feat-yeaft-session-restore).
 *
 * Mirrors test/web/session-create-modal-workdir-picker.test.js: doesn't
 * mount Vue (the modal uses Teleport + folder-picker mixin, which together
 * are hostile to a plain JSDOM mount), just calls the component's methods
 * directly with a stub `this` and asserts the wire payload + state
 * transitions.
 *
 * Pins the parts of the contract the agent depends on:
 *   - `loadSessions` calls `chat.sessionCrudRequest('scan_workdir', …)`
 *   - `onRestoreClick` calls `chat.sessionCrudRequest('restore', …)`,
 *     emits `restored` + `close` on success
 *   - alreadyRegistered rows are a silent no-op
 *   - errors land in `restoreError` / `scanError` (no throw)
 *   - `folderPickerSetWorkDir` auto-scans (matches plan UX: "当选择了
 *     dir 后，就应该加载存在的所有 sessions")
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Stub Pinia before dynamic-importing the component (the mixin pulls
// path-segments + the modal pulls Teleport implicitly).
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});

let SessionRestoreModal;
beforeAll(async () => {
  SessionRestoreModal = (await import('../../../web/components/SessionRestoreModal.js')).default;
});

// Tiny stub helpers.
function makeChat({ scanResult, restoreResult } = {}) {
  const calls = [];
  return {
    calls,
    sessionCrudRequest(op, data, opts) {
      calls.push({ op, data, opts });
      if (op === 'scan_workdir') return Promise.resolve(scanResult || { ok: true, sessions: [] });
      if (op === 'restore') return Promise.resolve(restoreResult || { ok: true, session: data });
      return Promise.resolve({ ok: false, error: { code: 'unsupported' } });
    },
    sendWsMessage() {},
  };
}

function makeCtx(overrides = {}) {
  const emits = [];
  const ctx = {
    form: { workDir: '/repo', agentId: 'agent-1' },
    sessions: [],
    scanning: false,
    restoring: null,
    scanError: '',
    restoreError: '',
    chat: makeChat(),
    // i18n: just echo the key — assertions on message content are below.
    $t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    $emit: (name, payload) => emits.push({ name, payload }),
    emits,
  };
  return { ...ctx, ...overrides };
}

describe('SessionRestoreModal.loadSessions', () => {
  afterEach(() => vi.useRealTimers());

  it('Case 1: calls sessionCrudRequest("scan_workdir", { workDir }) with agentId', async () => {
    const chat = makeChat({
      scanResult: {
        ok: true,
        sessions: [
          { id: 'grp_a', name: 'A', alreadyRegistered: false },
          { id: 'grp_b', name: 'B', alreadyRegistered: true },
        ],
      },
    });
    const ctx = makeCtx({ chat });

    await SessionRestoreModal.methods.loadSessions.call(ctx);

    expect(chat.calls).toEqual([{
      op: 'scan_workdir',
      data: { workDir: '/repo' },
      opts: { agentId: 'agent-1' },
    }]);
    expect(ctx.sessions).toEqual([
      { id: 'grp_a', name: 'A', alreadyRegistered: false },
      { id: 'grp_b', name: 'B', alreadyRegistered: true },
    ]);
    expect(ctx.scanning).toBe(false);
    expect(ctx.scanError).toBe('');
  });

  it('writes scanError + leaves sessions empty when the agent returns ok=false', async () => {
    const chat = makeChat({
      scanResult: { ok: false, error: { code: 'invalid_workdir', message: 'workDir required' } },
    });
    const ctx = makeCtx({ chat, sessions: [{ id: 'stale' }] });

    await SessionRestoreModal.methods.loadSessions.call(ctx);

    expect(ctx.sessions).toEqual([]);
    expect(ctx.scanError).toContain('workDir required');
    expect(ctx.scanning).toBe(false);
  });

  it('no-ops when workDir is empty (does not call the agent)', async () => {
    const chat = makeChat();
    const ctx = makeCtx({ chat, form: { workDir: '', agentId: 'agent-1' } });

    await SessionRestoreModal.methods.loadSessions.call(ctx);

    expect(chat.calls).toEqual([]);
    expect(ctx.sessions).toEqual([]);
  });

  it('caught error from sessionCrudRequest sets scanError without throwing', async () => {
    const chat = {
      sessionCrudRequest: () => Promise.reject(new Error('boom')),
    };
    const ctx = makeCtx({ chat });

    await SessionRestoreModal.methods.loadSessions.call(ctx);

    expect(ctx.scanError).toContain('boom');
    expect(ctx.scanning).toBe(false);
  });
});

describe('SessionRestoreModal.onRestoreClick', () => {
  it('Case 4: calls sessionCrudRequest("restore", { sessionId, workDir }) and emits restored + close', async () => {
    const chat = makeChat({
      restoreResult: { ok: true, session: { id: 'grp_x', name: 'X', workDir: '/repo' } },
    });
    const ctx = makeCtx({ chat });

    await SessionRestoreModal.methods.onRestoreClick.call(ctx, {
      id: 'grp_x',
      name: 'X',
      alreadyRegistered: false,
    });

    expect(chat.calls).toEqual([{
      op: 'restore',
      data: { sessionId: 'grp_x', workDir: '/repo' },
      opts: { agentId: 'agent-1' },
    }]);
    const events = ctx.emits.map(e => e.name);
    expect(events).toContain('restored');
    expect(events).toContain('close');
    const restoredPayload = ctx.emits.find(e => e.name === 'restored').payload;
    expect(restoredPayload.id).toBe('grp_x');
    expect(ctx.restoring).toBeNull();
    expect(ctx.restoreError).toBe('');
  });

  it('Case 5: silent no-op when session.alreadyRegistered is true', async () => {
    const chat = makeChat();
    const ctx = makeCtx({ chat });

    await SessionRestoreModal.methods.onRestoreClick.call(ctx, {
      id: 'grp_dup',
      name: 'Dup',
      alreadyRegistered: true,
    });

    expect(chat.calls).toEqual([]);
    expect(ctx.emits).toEqual([]);
    expect(ctx.restoreError).toBe('');
  });

  it('Case 6: agent returns ok=false → restoreError populated, no emit', async () => {
    const chat = makeChat({
      restoreResult: { ok: false, error: { code: 'not_found', message: 'grp_zzz' } },
    });
    const ctx = makeCtx({ chat });

    await SessionRestoreModal.methods.onRestoreClick.call(ctx, {
      id: 'grp_zzz',
      name: 'Zzz',
      alreadyRegistered: false,
    });

    expect(ctx.restoreError).toContain('grp_zzz');
    expect(ctx.emits).toEqual([]);
    expect(ctx.restoring).toBeNull();
  });

  it('does not start a second restore when one is already in flight', async () => {
    let resolveOuter;
    const chat = {
      sessionCrudRequest: () => new Promise((res) => { resolveOuter = res; }),
    };
    const ctx = makeCtx({ chat, restoring: 'grp_busy' });

    // Should bail immediately because `restoring` is truthy.
    await SessionRestoreModal.methods.onRestoreClick.call(ctx, {
      id: 'grp_new',
      alreadyRegistered: false,
    });

    expect(ctx.restoring).toBe('grp_busy');
    expect(ctx.emits).toEqual([]);
    if (resolveOuter) resolveOuter({ ok: true, session: {} });
  });

  it('writes generic restoreError when sessionCrudRequest rejects', async () => {
    const chat = {
      sessionCrudRequest: () => Promise.reject(new Error('socket closed')),
    };
    const ctx = makeCtx({ chat });

    await SessionRestoreModal.methods.onRestoreClick.call(ctx, {
      id: 'grp_y',
      alreadyRegistered: false,
    });

    expect(ctx.restoreError).toContain('socket closed');
    expect(ctx.emits).toEqual([]);
  });
});

describe('SessionRestoreModal.folderPickerSetWorkDir', () => {
  it('Case 2: stores the path on form.workDir and triggers loadSessions', async () => {
    const chat = makeChat({
      scanResult: { ok: true, sessions: [] },
    });
    const ctx = makeCtx({ chat, form: { workDir: '', agentId: 'agent-1' } });
    // folderPickerSetWorkDir calls `this.loadSessions()` internally — bind
    // the real loadSessions onto ctx so the call resolves.
    ctx.loadSessions = SessionRestoreModal.methods.loadSessions.bind(ctx);

    SessionRestoreModal.methods.folderPickerSetWorkDir.call(ctx, '/picked');
    // loadSessions is async; flush microtasks so the awaited
    // sessionCrudRequest call lands.
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.form.workDir).toBe('/picked');
    expect(chat.calls[0].op).toBe('scan_workdir');
    expect(chat.calls[0].data.workDir).toBe('/picked');
  });
});

describe('SessionRestoreModal.folderPickerInitialDir', () => {
  it('falls back to defaultWorkDir when form.workDir is empty', () => {
    const ctx = makeCtx({
      form: { workDir: '', agentId: 'agent-1' },
      defaultWorkDir: '/seeded',
    });
    expect(SessionRestoreModal.methods.folderPickerInitialDir.call(ctx)).toBe('/seeded');
  });
  it('prefers form.workDir when set', () => {
    const ctx = makeCtx({
      form: { workDir: '/typed', agentId: 'agent-1' },
      defaultWorkDir: '/seeded',
    });
    expect(SessionRestoreModal.methods.folderPickerInitialDir.call(ctx)).toBe('/typed');
  });
});
