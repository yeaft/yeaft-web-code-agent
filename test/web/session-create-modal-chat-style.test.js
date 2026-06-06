/**
 * SessionCreateModal — chat-style layout contracts.
 *
 * The rewrite (task-session-create-chat-style) reshaped the wizard to
 * mirror Chat's new-conversation modal: top control rows + a content
 * area that switches between folder-aggregation and resume-list when
 * a workDir is picked. This file pins the data behaviors that drive
 * that content area, plus the create-flow handoff to
 * `chat.createYeaftSession`.
 *
 * Same Pinia-stub trick as the sibling workdir-picker test — we don't
 * mount Vue, we exercise the computed getters + onSubmit logic on a
 * hand-built `this` context.
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

const SESSIONS_FIXTURE = [
  { id: 's1', name: 'alpha', workDir: '/repo/a', createdAt: '2026-06-01T10:00:00Z' },
  { id: 's2', name: 'beta',  workDir: '/repo/a', createdAt: '2026-06-02T10:00:00Z' },
  { id: 's3', name: 'gamma', workDir: '/repo/b', createdAt: '2026-06-03T10:00:00Z' },
  { id: 's4', name: 'orphan', workDir: '',       createdAt: '2026-06-04T10:00:00Z' },
];

function ctxWith(form, overrides = {}) {
  return {
    form,
    allSessions: SESSIONS_FIXTURE,
    sessionsStore: { setActive: () => {} },
    chat: { createYeaftSession: () => ({ ok: true, group: {} }) },
    vpList: [{ vpId: 'omni' }, { vpId: 'rat' }],
    vpStore: { vpList: [{ vpId: 'omni' }, { vpId: 'rat' }] },
    agentOptions: [{ id: 'agent-1', online: true }],
    vpPickerTouched: false,
    busy: false,
    ...overrides,
  };
}

describe('SessionCreateModal folderAggregates', () => {
  it('groups sessions by workDir, skips empty workDirs, and sorts by path', () => {
    const fn = SessionCreateModal.computed.folderAggregates;
    const result = fn.call({ allSessions: SESSIONS_FIXTURE });
    expect(result).toEqual([
      { path: '/repo/a', count: 2 },
      { path: '/repo/b', count: 1 },
    ]);
  });

  it('returns empty list when there are no sessions', () => {
    const fn = SessionCreateModal.computed.folderAggregates;
    expect(fn.call({ allSessions: [] })).toEqual([]);
  });
});

describe('SessionCreateModal sessionsForCurrentDir', () => {
  it('filters by exact workDir and sorts newest first', () => {
    const fn = SessionCreateModal.computed.sessionsForCurrentDir;
    const result = fn.call({
      form: { workDir: '/repo/a' },
      allSessions: SESSIONS_FIXTURE,
    });
    expect(result.map(s => s.id)).toEqual(['s2', 's1']);
  });

  it('returns empty when workDir is empty (folder panel handles that case)', () => {
    const fn = SessionCreateModal.computed.sessionsForCurrentDir;
    expect(fn.call({ form: { workDir: '' }, allSessions: SESSIONS_FIXTURE })).toEqual([]);
  });
});

describe('SessionCreateModal applyDefaultSelection', () => {
  it('pre-checks Omni and pins it as the default VP when present', () => {
    const ctx = {
      vpPickerTouched: false,
      form: { vpIds: [], defaultVpId: null },
      vpList: [{ vpId: 'omni' }, { vpId: 'rat' }],
    };
    SessionCreateModal.methods.applyDefaultSelection.call(ctx);
    expect(ctx.form.vpIds).toEqual(['omni']);
    expect(ctx.form.defaultVpId).toBe('omni');
  });

  it('falls back to the first VP when Omni is missing', () => {
    const ctx = {
      vpPickerTouched: false,
      form: { vpIds: [], defaultVpId: null },
      vpList: [{ vpId: 'rat' }, { vpId: 'ox' }],
    };
    SessionCreateModal.methods.applyDefaultSelection.call(ctx);
    expect(ctx.form.vpIds).toEqual(['rat']);
    expect(ctx.form.defaultVpId).toBe('rat');
  });

  it('does nothing once the user has touched the picker', () => {
    const ctx = {
      vpPickerTouched: true,
      form: { vpIds: [], defaultVpId: null },
      vpList: [{ vpId: 'omni' }],
    };
    SessionCreateModal.methods.applyDefaultSelection.call(ctx);
    expect(ctx.form.vpIds).toEqual([]);
  });
});

describe('SessionCreateModal toggleVp default-star bookkeeping', () => {
  it('seeds defaultVpId on first add and re-elects when default is removed', () => {
    const ctx = { vpPickerTouched: false, form: { vpIds: [], defaultVpId: null } };
    SessionCreateModal.methods.toggleVp.call(ctx, 'omni', true);
    expect(ctx.form.vpIds).toEqual(['omni']);
    expect(ctx.form.defaultVpId).toBe('omni');

    SessionCreateModal.methods.toggleVp.call(ctx, 'rat', true);
    // defaultVpId stays on omni because it's still in the roster.
    expect(ctx.form.defaultVpId).toBe('omni');

    SessionCreateModal.methods.toggleVp.call(ctx, 'omni', false);
    // omni left the roster -> defaultVpId follows to the next survivor.
    expect(ctx.form.vpIds).toEqual(['rat']);
    expect(ctx.form.defaultVpId).toBe('rat');
  });
});

describe('SessionCreateModal resumeExisting', () => {
  it('sets the clicked session active and emits close — does NOT create', () => {
    const emitted = [];
    let activated = null;
    const ctx = {
      sessionsStore: { setActive: (id) => { activated = id; } },
      $emit: (name, payload) => emitted.push([name, payload]),
    };
    SessionCreateModal.methods.resumeExisting.call(ctx, { id: 's7' });
    expect(activated).toBe('s7');
    expect(emitted).toEqual([['close', undefined]]);
  });
});

describe('SessionCreateModal onSubmit', () => {
  it('forwards displayName, vpIds, defaultVpId, workDir, agentId to chat.createYeaftSession', async () => {
    const calls = [];
    const ctx = ctxWith(
      { name: 'My Session', vpIds: ['omni', 'rat'], defaultVpId: 'rat', workDir: '/repo', agentId: 'agent-1' },
      {
        canSubmit: true,
        chat: {
          createYeaftSession: (args) => { calls.push(args); return { ok: true, group: { id: 'new' } }; },
        },
        $emit: () => {},
        $t: (k) => k,
      },
    );
    await SessionCreateModal.methods.onSubmit.call(ctx);
    expect(calls).toEqual([{
      displayName: 'My Session',
      vpIds: ['omni', 'rat'],
      defaultVpId: 'rat',
      workDir: '/repo',
      agentId: 'agent-1',
    }]);
  });

  it('falls back to first roster VP when defaultVpId is not in roster', async () => {
    const calls = [];
    const ctx = ctxWith(
      { name: '', vpIds: ['omni', 'rat'], defaultVpId: 'ghost', workDir: '', agentId: 'agent-1' },
      {
        canSubmit: true,
        chat: {
          createYeaftSession: (args) => { calls.push(args); return { ok: true }; },
        },
        $emit: () => {},
        $t: (k) => k,
      },
    );
    await SessionCreateModal.methods.onSubmit.call(ctx);
    expect(calls[0].defaultVpId).toBe('omni');
  });
});
