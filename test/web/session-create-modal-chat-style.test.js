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

describe('SessionCreateModal sessionsInDir — unified disk-scan list', () => {
  // Merged-list semantics (2026-06-09): the modal no longer has a
  // separate "registered sessions" panel. `sessionsInDir` is the single
  // source of truth — every disk-scanned session for the current workDir,
  // each tagged with `inSidebar` so the click handler can branch
  // resume-vs-restore without UI fragmentation.
  it('returns every scanned session tagged with inSidebar=true when present in sessionsStore', () => {
    const fn = SessionCreateModal.computed.sessionsInDir;
    const result = fn.call({
      scannedSessions: [
        { id: 's-registered', name: 'reg', createdAt: '2026-06-02T10:00:00Z' },
        { id: 's-disk-only', name: 'orphan', createdAt: '2026-06-01T10:00:00Z' },
      ],
      sessionsStore: { sessionList: [{ id: 's-registered' }, { id: 's-other' }] },
    });
    expect(result.map(s => ({ id: s.id, inSidebar: s.inSidebar }))).toEqual([
      { id: 's-registered', inSidebar: true },
      { id: 's-disk-only', inSidebar: false },
    ]);
  });

  it('flags every row inSidebar=false when sidebar is empty', () => {
    const fn = SessionCreateModal.computed.sessionsInDir;
    const result = fn.call({
      scannedSessions: [{ id: 's-a' }, { id: 's-b' }],
      sessionsStore: { sessionList: [] },
    });
    expect(result.every(s => s.inSidebar === false)).toBe(true);
  });

  it('survives a null sessionsStore (Pinia teardown race)', () => {
    const fn = SessionCreateModal.computed.sessionsInDir;
    const result = fn.call({
      scannedSessions: [{ id: 's-a' }],
      sessionsStore: null,
    });
    expect(result).toEqual([{ id: 's-a', inSidebar: false }]);
  });

  it('drops entries with no id (defensive — agent could send malformed payload)', () => {
    const fn = SessionCreateModal.computed.sessionsInDir;
    const result = fn.call({
      scannedSessions: [{ id: 's-good' }, { name: 'no-id' }, null],
      sessionsStore: { sessionList: [] },
    });
    expect(result.map(s => s.id)).toEqual(['s-good']);
  });

  it('returns empty array when scannedSessions is empty', () => {
    const fn = SessionCreateModal.computed.sessionsInDir;
    expect(fn.call({ scannedSessions: [], sessionsStore: { sessionList: [{ id: 'x' }] } })).toEqual([]);
  });
});

describe('SessionCreateModal selectSession — unified dispatch', () => {
  it('routes inSidebar=true rows to resumeExisting (no restore call)', () => {
    let resumed = null;
    let restored = null;
    const ctx = {
      resumeExisting: (s) => { resumed = s; },
      onRestoreClick: (s) => { restored = s; },
    };
    SessionCreateModal.methods.selectSession.call(ctx, { id: 's-reg', inSidebar: true });
    expect(resumed).toEqual({ id: 's-reg', inSidebar: true });
    expect(restored).toBeNull();
  });

  it('routes inSidebar=false rows to onRestoreClick (no resume call)', () => {
    let resumed = null;
    let restored = null;
    const ctx = {
      resumeExisting: (s) => { resumed = s; },
      onRestoreClick: (s) => { restored = s; },
    };
    SessionCreateModal.methods.selectSession.call(ctx, { id: 's-orphan', inSidebar: false });
    expect(restored).toEqual({ id: 's-orphan', inSidebar: false });
    expect(resumed).toBeNull();
  });

  it('is a no-op for sessions without an id (defensive guard)', () => {
    let resumed = null;
    let restored = null;
    const ctx = {
      resumeExisting: (s) => { resumed = s; },
      onRestoreClick: (s) => { restored = s; },
    };
    SessionCreateModal.methods.selectSession.call(ctx, { name: 'no-id' });
    SessionCreateModal.methods.selectSession.call(ctx, null);
    expect(resumed).toBeNull();
    expect(restored).toBeNull();
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
  it('sets active, fires setActiveSessionFilter with force, and emits close — does NOT create', () => {
    const emitted = [];
    let activated = null;
    const filterCalls = [];
    const ctx = {
      sessionsStore: { setActive: (id) => { activated = id; } },
      chat: {
        currentAgent: 'agent-1',
        setActiveSessionFilter: (id, opts) => { filterCalls.push([id, opts]); },
      },
      $emit: (name, payload) => emitted.push([name, payload]),
    };
    SessionCreateModal.methods.resumeExisting.call(ctx, { id: 's7' });
    expect(activated).toBe('s7');
    // setActiveSessionFilter is the action that actually triggers
    // yeaft_load_history — without it, the modal closes but the main
    // pane stays empty (this is the bug the user reported).
    expect(filterCalls).toEqual([['s7', { force: true }]]);
    expect(emitted).toEqual([['close', undefined]]);
  });

  it('switches the active agent when the session belongs to a different agent', () => {
    const ctx = {
      sessionsStore: { setActive: () => {} },
      chat: {
        currentAgent: 'agent-1',
        selected: null,
        selectAgent(id) { this.selected = id; },
        setActiveSessionFilter: () => {},
      },
      $emit: () => {},
    };
    SessionCreateModal.methods.resumeExisting.call(ctx, { id: 's7', agentId: 'agent-2' });
    expect(ctx.chat.selected).toBe('agent-2');
  });

  it('does not switch agent when the session is already on the current agent', () => {
    const ctx = {
      sessionsStore: { setActive: () => {} },
      chat: {
        currentAgent: 'agent-1',
        selected: null,
        selectAgent(id) { this.selected = id; },
        setActiveSessionFilter: () => {},
      },
      $emit: () => {},
    };
    SessionCreateModal.methods.resumeExisting.call(ctx, { id: 's7', agentId: 'agent-1' });
    expect(ctx.chat.selected).toBeNull();
  });

  it('survives a null chat / null sessionsStore (defensive guards)', () => {
    // Teardown race: Pinia store can be null when modal closes mid-unmount.
    // Each call is independently guarded; an emit('close') still has to fire
    // so the host doesn't get stuck with a dangling modal.
    const emitted = [];
    const ctx = {
      sessionsStore: null,
      chat: null,
      $emit: (name, payload) => emitted.push([name, payload]),
    };
    expect(() => {
      SessionCreateModal.methods.resumeExisting.call(ctx, { id: 's7' });
    }).not.toThrow();
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

  it('auto-derives displayName from workDir basename when name is blank', async () => {
    const calls = [];
    const ctx = ctxWith(
      { name: '   ', vpIds: ['omni'], defaultVpId: 'omni', workDir: '/repo/my-project', agentId: 'agent-1' },
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
    expect(calls[0].displayName).toBe('my-project');
  });

  it('auto-derives displayName from i18n "untitled" key when both name and workDir are blank', async () => {
    const calls = [];
    const ctx = ctxWith(
      { name: '', vpIds: ['omni'], defaultVpId: 'omni', workDir: '', agentId: 'agent-1' },
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
    expect(calls[0].displayName).toBe('yeaft.session.create.untitled');
  });
});

describe('SessionCreateModal vpRosterSummary', () => {
  const fn = () => SessionCreateModal.computed.vpRosterSummary;

  it('returns the "no VPs" placeholder when nothing is selected', () => {
    const ctx = {
      form: { vpIds: [] },
      vpLabelFor: (id) => id,
      $t: (k) => k,
    };
    expect(fn().call(ctx)).toBe('yeaft.session.create.vpNone');
  });

  it('joins ≤3 names with the localized comma', () => {
    const ctx = {
      form: { vpIds: ['omni', 'rat'] },
      vpLabelFor: (id) => `Label-${id}`,
      $t: (k) => k === 'common.comma' ? ', ' : k,
    };
    expect(fn().call(ctx)).toBe('Label-omni, Label-rat');
  });

  it('still joins inline at exactly 3 names (boundary)', () => {
    // The doc comment says "3 is the inclusive threshold" — pin it so an
    // off-by-one regression flips into "N selected" without anyone noticing.
    const ctx = {
      form: { vpIds: ['omni', 'rat', 'ox'] },
      vpLabelFor: (id) => `Label-${id}`,
      $t: (k) => k === 'common.comma' ? ', ' : k,
    };
    expect(fn().call(ctx)).toBe('Label-omni, Label-rat, Label-ox');
  });

  it('renders "N selected" once more than 3 VPs are picked', () => {
    const ctx = {
      form: { vpIds: ['a', 'b', 'c', 'd', 'e'] },
      vpLabelFor: (id) => id,
      $t: (k, args) => k === 'yeaft.session.create.vpCount' ? `${args.n} selected` : k,
    };
    expect(fn().call(ctx)).toBe('5 selected');
  });
});

describe('SessionCreateModal handleOutsideRosterClick', () => {
  it('closes the popup when the click is outside the roster root', () => {
    const ctx = {
      vpRosterOpen: true,
      $refs: { vpRosterRoot: { contains: () => false } },
    };
    SessionCreateModal.methods.handleOutsideRosterClick.call(ctx, { target: {} });
    expect(ctx.vpRosterOpen).toBe(false);
  });

  it('keeps the popup open when the click is inside the roster root', () => {
    const ctx = {
      vpRosterOpen: true,
      $refs: { vpRosterRoot: { contains: () => true } },
    };
    SessionCreateModal.methods.handleOutsideRosterClick.call(ctx, { target: {} });
    expect(ctx.vpRosterOpen).toBe(true);
  });

  it('is a no-op when the popup is already closed', () => {
    const ctx = {
      vpRosterOpen: false,
      // $refs.vpRosterRoot intentionally missing — should never be read.
      $refs: {},
    };
    SessionCreateModal.methods.handleOutsideRosterClick.call(ctx, { target: {} });
    expect(ctx.vpRosterOpen).toBe(false);
  });
});
