// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';

import { CONFIG } from '../../server/config.js';
import {
  agents,
  pendingAgentConnections,
  pendingAgentSettingsRequests,
  registerAgentSettingsRequest,
  webClients,
} from '../../server/context.js';
import { handleClientMisc } from '../../server/handlers/client-misc.js';
import { handleAgentConnection } from '../../server/ws-agent.js';
import { MockWebSocket, WS_OPEN } from '../helpers/mockWs.js';

const stores = new Map();
function defineStore(id, options) {
  return () => {
    if (stores.has(id)) return stores.get(id);
    const store = Vue.reactive({ ...(options.state?.() || {}) });
    for (const [name, action] of Object.entries(options.actions || {})) store[name] = action.bind(store);
    stores.set(id, store);
    return store;
  };
}
globalThis.Pinia = { ...(globalThis.Pinia || {}), defineStore, useSessionsStore: () => ({}) };

const { useChatStore } = await import('../../web/stores/chat.js');
const { handleMessage } = await import('../../web/stores/helpers/messageHandler.js');

function freshStore() {
  stores.clear();
  const store = useChatStore();
  store.agents = [
    { id: 'agent-a', online: true, version: '1.0.0', dreamEnabled: true },
    { id: 'agent-b', online: true, version: '1.0.0', dreamEnabled: false },
  ];
  store.currentAgent = 'agent-a';
  store.sendWsMessage = vi.fn();
  return store;
}

describe('Agent-scoped settings lifecycle', () => {
  const originalSkipAuth = CONFIG.skipAuth;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    CONFIG.skipAuth = originalSkipAuth;
    for (const agent of agents.values()) {
      if (agent._syncTimeout) clearTimeout(agent._syncTimeout);
    }
    for (const pending of pendingAgentConnections.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
    }
    agents.clear();
    pendingAgentConnections.clear();
    pendingAgentSettingsRequests.clear();
    webClients.clear();
  });

  it('correlates telemetry calls, times them out, and ignores stale replies', async () => {
    const store = freshStore();
    const first = store.loadTelemetrySettings('agent-a');
    const firstRequest = store.sendWsMessage.mock.calls[0][0];
    const second = store.loadTelemetrySettings('agent-a');
    const secondRequest = store.sendWsMessage.mock.calls[1][0];
    expect(firstRequest.requestId).toBeTruthy();
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);

    handleMessage(store, { type: 'telemetry_settings', agentId: 'agent-a', requestId: secondRequest.requestId, enabled: false });
    await expect(second).resolves.toMatchObject({ enabled: false });
    expect(store.telemetrySettingsByAgent['agent-a']).toMatchObject({ enabled: false });

    handleMessage(store, { type: 'telemetry_settings', agentId: 'agent-a', requestId: firstRequest.requestId, enabled: true });
    await expect(first).resolves.toMatchObject({ enabled: true });
    expect(store.telemetrySettingsByAgent['agent-a']).toMatchObject({ enabled: false });

    const timedOut = store.updateTelemetrySettings({ enabled: true }, 'agent-b');
    const timeoutExpectation = expect(timedOut).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15001);
    await timeoutExpectation;
    expect(Object.keys(store._telemetryPending)).toHaveLength(0);
  });

  it('does not settle concurrent browser mutations from identity-less legacy replies', async () => {
    const firstBrowser = freshStore();
    const firstUpdate = firstBrowser.updateTelemetrySettings({ enabled: false }, 'agent-a');
    const firstRequestId = firstBrowser.sendWsMessage.mock.calls.at(-1)[0].requestId;

    const secondBrowser = freshStore();
    const secondUpdate = secondBrowser.updateTelemetrySettings({ enabled: true }, 'agent-a');
    const secondRequestId = secondBrowser.sendWsMessage.mock.calls.at(-1)[0].requestId;

    const legacyReply = { type: 'telemetry_settings_updated', agentId: 'agent-a', enabled: false };
    handleMessage(firstBrowser, legacyReply);
    handleMessage(secondBrowser, legacyReply);
    expect(Object.keys(firstBrowser._telemetryPending)).toEqual([firstRequestId]);
    expect(Object.keys(secondBrowser._telemetryPending)).toEqual([secondRequestId]);

    handleMessage(firstBrowser, { ...legacyReply, requestId: firstRequestId });
    handleMessage(secondBrowser, { ...legacyReply, requestId: secondRequestId, enabled: true });
    await expect(firstUpdate).resolves.toMatchObject({ enabled: false });
    await expect(secondUpdate).resolves.toMatchObject({ enabled: true });
  });

  it('times out identity-less telemetry replies even when only one request is pending', async () => {
    const soleBrowser = freshStore();
    const soleUpdate = soleBrowser.updateTelemetrySettings({ enabled: false }, 'agent-a');
    handleMessage(soleBrowser, { type: 'telemetry_settings_updated', agentId: 'agent-a', enabled: false });
    const soleTimeout = expect(soleUpdate).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15001);
    await soleTimeout;

    const firstBrowser = freshStore();
    const firstUpdate = firstBrowser.updateTelemetrySettings({ enabled: false }, 'agent-a');
    const secondBrowser = freshStore();
    const secondUpdate = secondBrowser.updateTelemetrySettings({ enabled: true }, 'agent-a');
    const legacyReply = { type: 'telemetry_settings_updated', agentId: 'agent-a', enabled: false };
    handleMessage(firstBrowser, legacyReply);
    handleMessage(secondBrowser, legacyReply);
    expect(Object.keys(firstBrowser._telemetryPending)).toHaveLength(1);
    expect(Object.keys(secondBrowser._telemetryPending)).toHaveLength(1);

    const firstTimeout = expect(firstUpdate).rejects.toThrow(/timed out/i);
    const secondTimeout = expect(secondUpdate).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15001);
    await firstTimeout;
    await secondTimeout;
  });

  it('keeps restart and upgrade lifecycle in shared Agent-scoped state and fences duplicates', () => {
    const store = freshStore();
    expect(store.restartAgent('agent-a')).toBe(true);
    expect(store.restartAgent('agent-a')).toBe(false);
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    expect(store.agentOperations['agent-a'].restart.pending).toBe(true);

    const restartRequestId = store.agentOperations['agent-a'].restart.requestId;
    handleMessage(store, { type: 'restart_agent_ack', agentId: 'agent-a', requestId: 'stale-restart' });
    expect(store.agentOperations['agent-a'].restart.acknowledged).toBe(false);
    handleMessage(store, { type: 'restart_agent_ack', agentId: 'agent-a', requestId: restartRequestId });
    expect(store.agentOperations['agent-a'].restart.acknowledged).toBe(true);
    handleMessage(store, { type: 'agent_list', agents: [{ id: 'agent-a', online: true, version: '1.0.0' }] });
    expect(store.agentOperations['agent-a'].restart.pending).toBe(true);
    handleMessage(store, { type: 'agent_list', agents: [{ id: 'agent-a', online: false, version: '1.0.0' }] });
    expect(store.agentOperations['agent-a'].restart.pending).toBe(true);
    handleMessage(store, { type: 'agent_list', agents: [{ id: 'agent-a', online: true, version: '1.0.0' }] });
    expect(store.agentOperations['agent-a'].restart.pending).toBe(false);

    expect(store.upgradeAgent('agent-a')).toBe(true);
    expect(store.upgradeAgent('agent-a')).toBe(false);
    const upgradeRequestId = store.agentOperations['agent-a'].upgrade.requestId;
    handleMessage(store, { type: 'upgrade_agent_ack', agentId: 'agent-a', requestId: 'stale-upgrade', success: false, error: 'stale' });
    expect(store.agentOperations['agent-a'].upgrade).toMatchObject({ pending: true, error: null });
    handleMessage(store, { type: 'upgrade_agent_ack', agentId: 'agent-a', requestId: upgradeRequestId, success: false, error: 'nope' });
    expect(store.agentOperations['agent-a'].upgrade).toMatchObject({ pending: false, error: 'nope' });
  });

  it('upgrades only safe online Agents and settles the batch after terminal outcomes', () => {
    const store = freshStore();
    store.agents = [
      { id: 'agent-a', online: true, version: '1.0.0', capabilities: ['remote_upgrade_safe'] },
      { id: 'agent-b', online: true, version: '1.0.0', capabilities: ['remote_upgrade_safe'] },
      { id: 'agent-offline', online: false, version: '1.0.0', capabilities: ['remote_upgrade_safe'] },
      { id: 'agent-container', online: true, version: '1.0.0', capabilities: ['remote_upgrade_safe', 'container_agent'] },
      { id: 'agent-legacy', online: true, version: '1.0.0', capabilities: [] },
    ];
    const completed = vi.fn();
    window.addEventListener('agent-upgrade-batch-complete', completed);

    expect(store.getUpgradableAgents().map(agent => agent.id)).toEqual(['agent-a', 'agent-b']);
    expect(store.upgradeAllAgents()).toBe(2);
    expect(store.upgradeAllAgents()).toBeNull();
    expect(store.sendWsMessage.mock.calls.map(([message]) => message.agentId)).toEqual(['agent-a', 'agent-b']);
    expect(new Set(store.sendWsMessage.mock.calls.map(([message]) => message.requestId)).size).toBe(2);
    const batchId = store.agentUpgradeBatch.id;
    expect(store.agentUpgradeBatch).toMatchObject({ pending: true, skippedCount: 3, agentIds: ['agent-a', 'agent-b'] });
    expect(store.agentOperations['agent-a'].upgrade.batchId).toBe(batchId);
    expect(store.agentOperations['agent-b'].upgrade.batchId).toBe(batchId);

    handleMessage(store, {
      type: 'upgrade_agent_ack', agentId: 'agent-a', requestId: 'stale', success: true, alreadyLatest: true,
    });
    expect(store.agentUpgradeBatch.results).toEqual({});

    handleMessage(store, {
      type: 'upgrade_agent_ack', agentId: 'agent-a', requestId: store.agentOperations['agent-a'].upgrade.requestId,
      success: true, alreadyLatest: true, version: '1.0.0',
    });
    expect(store.agentUpgradeBatch.results['agent-a']).toMatchObject({ status: 'already_latest', version: '1.0.0' });
    expect(store.agentUpgradeBatch.pending).toBe(true);
    expect(completed).not.toHaveBeenCalled();

    handleMessage(store, {
      type: 'upgrade_agent_ack', agentId: 'agent-b', requestId: store.agentOperations['agent-b'].upgrade.requestId,
      success: true,
    });
    expect(store.agentOperations['agent-b'].upgrade).toMatchObject({ pending: true, acknowledged: true });
    handleMessage(store, {
      type: 'agent_list',
      agents: store.agents.map(agent => agent.id === 'agent-b' ? { ...agent, version: '1.0.1' } : agent),
    });

    expect(store.agentUpgradeBatch.pending).toBe(false);
    expect(store.agentUpgradeBatch.results['agent-b']).toMatchObject({ status: 'upgraded' });
    expect(completed).toHaveBeenCalledTimes(1);
    window.removeEventListener('agent-upgrade-batch-complete', completed);
  });

  it('records a bulk upgrade timeout as a failed terminal result', async () => {
    const store = freshStore();
    store.agents = [
      { id: 'agent-a', online: true, version: '1.0.0', capabilities: ['remote_upgrade_safe'] },
    ];
    const completed = vi.fn();
    window.addEventListener('agent-upgrade-batch-complete', completed);

    expect(store.upgradeAllAgents()).toBe(1);
    await vi.advanceTimersByTimeAsync(120001);

    expect(store.agentUpgradeBatch).toMatchObject({ pending: false, skippedCount: 0 });
    expect(store.agentUpgradeBatch.results['agent-a']).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(completed).toHaveBeenCalledTimes(1);
    window.removeEventListener('agent-upgrade-batch-complete', completed);
  });

  it('settles a synthesized Dream rejection through the web handler', async () => {
    CONFIG.skipAuth = true;
    const store = freshStore();
    expect(store.setDreamEnabled('agent-a', false)).toBe(true);
    const requestId = store.agentDreamState['agent-a'].requestId;
    const client = {
      authenticated: true,
      userId: 'user-1',
      role: 'user',
      ws: { readyState: WS_OPEN, send: payload => handleMessage(store, JSON.parse(payload)) },
    };
    webClients.set('browser-origin', client);
    agents.set('agent-a', {
      id: 'agent-a', ownerId: 'user-1',
      ws: { readyState: WS_OPEN, send() { throw new Error('must not dispatch duplicate'); } },
    });
    expect(registerAgentSettingsRequest({
      agentId: 'agent-a', operation: 'dream', requestId, clientId: 'browser-origin',
    })).toBe(true);

    await handleClientMisc('browser-origin', client, {
      type: 'set_dream_enabled', agentId: 'agent-a', enabled: false, requestId,
    }, async () => true);

    expect(store.agentDreamState['agent-a']).toMatchObject({
      pending: false,
      authoritative: true,
      error: 'Request rejected: too many pending requests or duplicate requestId.',
    });
    expect(store.agents[0].dreamEnabled).toBe(true);
  });

  it('settles a synthesized Dream disconnect reply through the web handler', async () => {
    vi.useRealTimers();
    CONFIG.skipAuth = true;
    const store = freshStore();
    store.agents[0].dreamEnabled = false;
    expect(store.setDreamEnabled('agent-a', true)).toBe(true);
    const requestId = store.agentDreamState['agent-a'].requestId;
    const client = {
      authenticated: true,
      userId: 'user-1',
      role: 'user',
      ws: { readyState: WS_OPEN, send: payload => handleMessage(store, JSON.parse(payload)) },
    };
    webClients.set('browser-origin', client);
    const socket = new MockWebSocket(WS_OPEN);
    const url = new URL('ws://localhost/?type=agent&id=agent-a&name=agent-a&instanceId=agent-a&capabilities=plaintext-ok');
    handleAgentConnection(socket, url);
    const challenge = socket.getLastMessage();
    socket.simulateMessage({
      type: 'auth', tempId: challenge.tempId, secret: '', capabilities: ['plaintext-ok'], version: '1.0.0',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(registerAgentSettingsRequest({
      agentId: 'agent-a', operation: 'dream', requestId, clientId: 'browser-origin',
    })).toBe(true);

    socket.close(1000, 'test disconnect');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(store.agentDreamState['agent-a']).toMatchObject({
      pending: false,
      authoritative: false,
      error: 'Agent disconnected before completing the request.',
    });
  });

  it('treats a missing Dream state as disabled while a toggle is pending', () => {
    const store = freshStore();
    delete store.agents[0].dreamEnabled;

    expect(store.setDreamEnabled('agent-a', true)).toBe(true);
    expect(store.agentDreamState['agent-a']).toMatchObject({
      pending: true,
      requested: true,
      authoritative: false,
    });
  });

  it('uses authoritative Dream state on failure and rejects rapid toggles', async () => {
    const store = freshStore();
    expect(store.setDreamEnabled('agent-a', false)).toBe(true);
    expect(store.setDreamEnabled('agent-a', true)).toBe(false);
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: true, requested: false });
    expect(store.agents[0].dreamEnabled).toBe(true);
    const failedRequestId = store.agentDreamState['agent-a'].requestId;

    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', requestId: 'stale-dream', enabled: false });
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: true, error: null });
    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', requestId: failedRequestId, enabled: true, error: 'write failed' });
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: false, error: 'write failed' });
    expect(store.agents[0].dreamEnabled).toBe(true);

    expect(store.setDreamEnabled('agent-a', false)).toBe(true);
    const successRequestId = store.agentDreamState['agent-a'].requestId;
    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', requestId: 'stale-dream-2', enabled: false });
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: true, requested: false });
    expect(store.agents[0].dreamEnabled).toBe(true);
    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', requestId: successRequestId, enabled: false });
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: false, error: null });
    expect(store.agents[0].dreamEnabled).toBe(false);

    expect(store.setDreamEnabled('agent-a', true)).toBe(true);
    await vi.advanceTimersByTimeAsync(15001);
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: false, error: 'timeout' });
    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', enabled: true });
    expect(store.agents[0].dreamEnabled).toBe(false);
  });
});
