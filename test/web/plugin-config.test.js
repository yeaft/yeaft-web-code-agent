// @vitest-environment happy-dom
import * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptPluginConfigReply, clearPluginState, loadPluginConfig, pluginCenterAgents, retryPluginConfig, savePluginConfig, setPluginEnabled,
} from '../../web/stores/helpers/plugin-config.js';

globalThis.Vue = Vue;
const storeOptions = {};
globalThis.Pinia = { defineStore: (id, options) => { storeOptions[id] = options; return () => ({}); } };
const { handleMessage } = await import('../../web/stores/helpers/messageHandler.js');

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function harness({ loaded = true, plugins = {} } = {}) {
  const sent = [];
  const store = Vue.reactive({
    agents: [{ id: 'a', online: true }, { id: 'b', online: true }],
    currentAgent: 'a', pluginCenterAgentId: 'a', pluginCenterOpen: true,
    ws: { readyState: 1 }, chatHistoryConnectionGeneration: 1,
    pluginConfigByAgent: Object.fromEntries(['a', 'b'].map(agentId => [agentId, {
      agentId, loaded, plugins, optimistic: plugins, draft: plugins,
      saving: false, error: null, retryIntent: null,
    }])),
    _pluginPending: {},
    sendWsMessage: vi.fn(msg => { sent.push(msg); return true; }),
  });
  const reply = (message = sent.at(-1), overrides = {}) => {
    handleMessage(store, {
      type: message.type === 'update_yeaft_plugins' ? 'yeaft_plugins_updated' : 'yeaft_plugins',
      requestId: message.requestId, agentId: message.agentId, plugins: message.plugins || {}, ...overrides,
    });
  };
  const toggle = (field, name, enabled, names, agentId = 'a') => (
    setPluginEnabled(store, field, name, enabled, names, agentId)
  );
  return { store, sent, reply, toggle };
}

// Drain only promise continuations, without firing request timeouts.
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

describe('Agent-scoped Plugin Center auto-save', () => {
  it('coalesces synchronous toggles and serializes later same/different-field changes without losing intent', async () => {
    const h = harness();
    const done = h.toggle('tools', 'shell', false, ['shell', 'read']);
    h.toggle('tools', 'shell', true, ['shell', 'read']);
    h.toggle('skills', 'review', false, [{ id: 'user:review', name: 'review' }, { id: 'user:plan', name: 'plan' }]);
    expect(h.store.pluginConfigByAgent.a.optimistic).toEqual({ tools: ['read', 'shell'], skills: ['plan'] });
    expect(h.store.pluginConfigByAgent.a.saving).toBe(true);
    await flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].plugins).toEqual({ tools: ['read', 'shell'], skills: ['plan'] });
    h.toggle('tools', 'read', false, ['shell', 'read']);
    h.toggle('mcpServers', 'db', false, ['db', 'search']);
    expect(h.sent).toHaveLength(1);
    h.reply(h.sent[0]);
    await flush();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].plugins).toEqual({ tools: ['shell'], skills: ['plan'], mcpServers: ['search'] });
    expect(h.store.pluginConfigByAgent.a.optimistic).toEqual(h.sent[1].plugins);
    h.reply(h.sent[1]);
    await done;
    expect(h.store.pluginConfigByAgent.a).toMatchObject({ saving: false, plugins: h.sent[1].plugins, error: null });
  });

  it('finishes saves after closing the page and keeps simultaneous Agent saves isolated', async () => {
    const h = harness();
    const a = h.toggle('tools', 'shell', false, ['shell', 'read']);
    h.store.pluginCenterOpen = false;
    h.store.pluginCenterAgentId = h.store.currentAgent = 'b';
    const b = h.toggle('tools', 'read', false, ['shell', 'read'], 'b');
    await flush();
    h.reply(h.sent[1]);
    await b;
    expect(h.store.pluginConfigByAgent.b.plugins).toEqual({ tools: ['shell'] });
    expect(h.store.pluginConfigByAgent.a.saving).toBe(true);
    h.reply(h.sent[0]);
    await a;
    expect(h.store.pluginConfigByAgent.a.plugins).toEqual({ tools: ['read'] });
    expect(h.store.pluginConfigByAgent.b.plugins).toEqual({ tools: ['shell'] });
  });

  it('rolls back a rejection, retains an Agent-attributed error across reload, and rebases explicit retry', async () => {
    const h = harness({ plugins: { tools: ['shell', 'read'] } });
    const done = h.toggle('tools', 'shell', false, ['shell', 'read']);
    await flush();
    h.toggle('skills', 'review', false, ['review', 'plan']);
    h.reply(h.sent[0], { error: 'disk denied', plugins: {} });
    await done;
    expect(h.store.pluginConfigByAgent.a).toMatchObject({
      saving: false, optimistic: { tools: ['shell', 'read'] },
      error: 'disk denied', errorAgentId: 'a', retryIntent: { agentId: 'a' },
    });
    expect(h.store.pluginConfigByAgent.b.error).toBeNull();
    const reload = loadPluginConfig(h.store, 'a');
    h.reply(h.sent.at(-1), { plugins: { tools: ['shell', 'read'], mcpServers: ['new-server'] } });
    await reload;
    expect(h.store.pluginConfigByAgent.a.error).toBe('disk denied');
    expect(h.sent.filter(msg => msg.type === 'update_yeaft_plugins')).toHaveLength(1);
    const retry = retryPluginConfig(h.store, 'a');
    await flush();
    expect(h.sent.at(-1).type).toBe('get_yeaft_plugins');
    // New input while reconciliation is running belongs to this drain too.
    h.toggle('tools', 'shell', true, ['shell', 'read']);
    h.toggle('tools', 'shell', false, ['shell', 'read']);
    h.reply(h.sent.at(-1), { plugins: { tools: ['shell', 'read'], mcpServers: ['new-server'] } });
    await flush();
    expect(h.sent.at(-1).plugins).toEqual({ tools: ['read'], skills: ['plan'], mcpServers: ['new-server'] });
    h.reply();
    await retry;
    expect(h.store.pluginConfigByAgent.a).toMatchObject({ error: null, retryIntent: null, saving: false });
  });

  it('fences old reads, unknown replies, wrong Agent/kind, and read callbacks overtaken by an edit', async () => {
    const h = harness();
    const old = loadPluginConfig(h.store, 'a');
    const latest = loadPluginConfig(h.store, 'a');
    h.reply(h.sent[0], { plugins: { tools: ['old'] } });
    h.reply(h.sent[1], { agentId: 'b', plugins: { tools: ['wrong-agent'] } });
    h.reply(h.sent[1], { type: 'yeaft_plugins_updated', plugins: { tools: ['wrong-kind'] } });
    h.reply(h.sent[1], { requestId: 'unknown', plugins: { tools: ['unknown'] } });
    await old;
    expect(h.store.pluginConfigByAgent.a.plugins).toEqual({});
    h.reply(h.sent[1], { plugins: { tools: ['shell', 'read'] } });
    await latest;
    const inFlight = loadPluginConfig(h.store, 'a');
    h.reply(h.sent[2], { plugins: { tools: ['superseded'] } });
    const save = h.toggle('tools', 'shell', false, ['shell', 'read']);
    await inFlight;
    await flush();
    expect(h.sent.at(-1).type).toBe('get_yeaft_plugins');
    h.reply(h.sent.at(-1), { plugins: { tools: ['shell', 'remote-only-tool'], skills: [] } });
    await flush();
    expect(h.sent.at(-1).plugins).toEqual({ tools: ['remote-only-tool'], skills: [] });
    h.reply();
    await save;
    h.reply(h.sent[2], { plugins: { tools: ['duplicate'] } });
    expect(h.store.pluginConfigByAgent.a.plugins).toEqual({ tools: ['remote-only-tool'], skills: [] });
    // Managed-skill creation can enqueue an enable while a cached refresh is
    // pending. Rebase in the store, not merely in ordinary switch controls.
    const refresh = loadPluginConfig(h.store, 'a');
    const oldRefresh = h.sent.at(-1);
    const enabling = h.toggle('skills', 'new-skill', true, []);
    await flush();
    h.reply(oldRefresh, { plugins: { skills: [] } });
    await refresh;
    h.reply(h.sent.at(-1), { plugins: { tools: ['newer-remote-tool'] } });
    await flush();
    // Missing skills means all are enabled; never narrow it to only new-skill.
    expect(h.sent.at(-1).plugins).toEqual({ tools: ['newer-remote-tool'] });
    h.reply(); await enabling;
  });

  it('times out uncertain writes, ignores late replies, and reads before retrying against current config', async () => {
    vi.useFakeTimers();
    const h = harness({ plugins: { tools: ['shell', 'read'] } });
    const done = h.toggle('tools', 'shell', false, ['shell', 'read']);
    await flush();
    const timedOut = h.sent[0];
    await vi.advanceTimersByTimeAsync(10_001);
    await done;
    expect(h.store.pluginConfigByAgent.a).toMatchObject({
      error: 'timeout', uncertain: true, optimistic: { tools: ['shell', 'read'] },
    });
    h.reply(timedOut, { plugins: { tools: ['stale'] } });
    expect(h.store.pluginConfigByAgent.a.plugins).toEqual({ tools: ['shell', 'read'] });
    const retry = retryPluginConfig(h.store, 'a');
    await flush();
    expect(h.sent.at(-1).type).toBe('get_yeaft_plugins');
    // The timed-out write may have succeeded; preserve newer remote changes.
    h.reply(h.sent.at(-1), { plugins: { tools: ['read', 'new-tool'], skills: ['plan'] } });
    await flush();
    expect(h.sent.at(-1).plugins).toEqual({ tools: ['read', 'new-tool'], skills: ['plan'] });
    h.reply();
    await retry;
    expect(h.store.pluginConfigByAgent.a.uncertain).toBe(false);
  });

  it('does not queue offline edits or replay an interrupted drain on a new connection', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.store.agents[0].online = false;
    await h.toggle('tools', 'shell', false, ['shell', 'read']);
    expect(h.sent).toHaveLength(0);
    h.store.agents[0].online = true;
    h.store.ws = { readyState: 1 };
    h.store.chatHistoryConnectionGeneration++;
    await flush();
    expect(h.sent).toHaveLength(0);
    const retry = retryPluginConfig(h.store, 'a');
    await flush();
    h.reply(h.sent[0]);
    await flush();
    const interrupted = h.sent[1];
    h.toggle('skills', 'review', false, ['review', 'plan']);
    h.store.ws = { readyState: 1 };
    h.store.chatHistoryConnectionGeneration++;
    h.reply(interrupted);
    await vi.advanceTimersByTimeAsync(10_001);
    await retry;
    expect(h.sent).toHaveLength(2);
    expect(h.store.pluginConfigByAgent.a).toMatchObject({ saving: false, uncertain: true, errorAgentId: 'a' });
    expect(h.store.pluginConfigByAgent.a.plugins).toEqual({});
  });

  it('expires reads and rejects malformed successes without treating them as enable-all config', async () => {
    vi.useFakeTimers();
    const h = harness({ plugins: { tools: ['read'] } });
    const load = loadPluginConfig(h.store, 'a');
    await vi.advanceTimersByTimeAsync(10_001);
    await load;
    expect(acceptPluginConfigReply(h.store, {
      type: 'yeaft_plugins', agentId: 'a', requestId: h.sent[0].requestId, plugins: {},
    })).toBe(false);
    const second = loadPluginConfig(h.store, 'a');
    h.reply(h.sent[1], { plugins: null });
    await second;
    expect(h.store.pluginConfigByAgent.a).toMatchObject({
      plugins: { tools: ['read'] }, error: 'Invalid plugin configuration reply',
    });
  });

  it('clears private caches and retires queued/in-flight work across reset and same-store login', async () => {
    const h = harness();
    const auth = { ...storeOptions.auth.state(), ...storeOptions.auth.actions,
      startSessionRefresh: vi.fn(), stopSessionRefresh: vi.fn() };
    h.store.clearPluginState = () => clearPluginState(h.store);
    vi.stubGlobal('Pinia', { ...globalThis.Pinia, useChatStore: () => h.store });
    h.store.pluginCatalogByKey = { a: { catalog: { skills: [{ name: 'private' }] } } };
    const done = h.toggle('tools', 'shell', false, ['shell', 'read']);
    await flush();
    h.toggle('skills', 'review', false, ['review', 'plan']);
    const oldRequest = h.sent[0];
    auth.reset();
    await done;
    expect(h.store.pluginConfigByAgent).toEqual({});
    expect(h.store.pluginCatalogByKey).toEqual({});
    expect(h.store._pluginPending).toEqual({});
    expect(h.store.pluginCenterOpen).toBe(false);
    h.reply(oldRequest);
    await flush();
    expect(h.store.pluginConfigByAgent).toEqual({});
    expect(h.sent).toHaveLength(1);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, token: 'bob', userId: 'bob' }) })));
    expect(await auth.login('bob', 'password')).toBe(true);
    expect(h.store.pluginConfigByAgent).toEqual({});
    const next = h.toggle('tools', 'read', false, ['shell', 'read']);
    await flush();
    expect(h.sent[1].type).toBe('get_yeaft_plugins');
    h.reply(h.sent[1], { plugins: { tools: ['read', 'new-tool'], skills: [] } });
    await flush();
    expect(h.sent[2].plugins).toEqual({ tools: ['new-tool'], skills: [] });
    h.reply(h.sent[2]);
    await next;
    // A new auth generation without an explicit logout clears too.
    expect(await auth.login('bob', 'password')).toBe(true);
    expect(h.store.pluginConfigByAgent).toEqual({});
    // Even a drain which has not sent its first request cannot restart later.
    const queued = h.toggle('tools', 'shell', false, ['shell']);
    auth.reset();
    await queued;
    expect(h.sent).toHaveLength(3);
    expect(h.store.pluginConfigByAgent).toEqual({});
  });

  it('keeps legacy whole-config save/load promises compatible and loads before an initial edit', async () => {
    const h = harness({ loaded: false });
    const done = savePluginConfig(h.store, { skills: ['plan'] }, 'a');
    await flush();
    expect(h.sent[0].type).toBe('get_yeaft_plugins');
    const loadDuringSave = loadPluginConfig(h.store, 'a');
    expect(loadDuringSave).toBe(done);
    h.reply(h.sent[0], { plugins: { tools: ['remote'] } });
    await flush();
    expect(h.sent[1].plugins).toEqual({ skills: ['plan'] });
    h.reply(h.sent[1]);
    expect(await done).toMatchObject({ plugins: { skills: ['plan'] }, error: null });
    const restoreAll = savePluginConfig(h.store, {}, 'a');
    await flush();
    expect(h.sent[2].plugins).toEqual({});
    h.reply(h.sent[2]);
    expect(await restoreAll).toMatchObject({ plugins: {}, error: null });
    h.store.agents = [];
    expect(pluginCenterAgents(h.store)).toEqual([
      expect.objectContaining({ id: 'a', online: false }),
    ]);
    expect(h.store.pluginConfigByAgent.a.agent).not.toHaveProperty('online');
    h.store.agents = [{ id: 'a', name: 'reconnected', online: true }];
    expect(pluginCenterAgents(h.store)).toEqual(h.store.agents);
  });
});
