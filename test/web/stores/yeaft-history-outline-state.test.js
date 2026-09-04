import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkItemStore } from '../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../agent/yeaft/work-center/controller.js';
import { WorkCenterService } from '../../../agent/yeaft/work-center/service.js';
import { resolvePlanningWorkflowSnapshot } from '../../../agent/yeaft/work-center/workflow.js';
import {
  projectActionMessagePage,
  projectWorkCenterEvent,
} from '../../../agent/yeaft/work-center/projection.js';

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

function createStoreFactory(_id, options) {
  let instance = null;
  return () => {
    if (instance) return instance;
    instance = { ...(typeof options.state === 'function' ? options.state() : {}) };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, { enumerable: true, get() { return getter(instance); } });
    }
    for (const [name, action] of Object.entries(options.actions || {})) instance[name] = action.bind(instance);
    return instance;
  };
}

globalThis.Pinia = { defineStore: createStoreFactory };
const sessionsStore = {
  sessionById: (id, agentId) => ({ id, agentId: agentId || (id === 'same' ? 'agent-a' : 'agent-a') }),
};
globalThis.window = {
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  Pinia: { useSessionsStore: () => sessionsStore },
};
globalThis.document = { addEventListener: vi.fn(), removeEventListener: vi.fn(), documentElement: { setAttribute() {}, classList: { toggle() {} } } };

const { useChatStore } = await import('../../../web/stores/chat.js');
const { handleAssistantOutputFrame } = await import('../../../web/stores/helpers/assistantOutput.js');
const { handleYeaftHistoryWindow: mergeYeaftHistoryWindow } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');
const {
  applyWorkItemSummary,
  mergeActionMessages,
  mergeWorkItemSummary,
  workCenterActionMessageKey,
  workCenterActionRequestScopeKey,
  workItemDetailRefreshIdentity,
} = await import('../../../web/stores/helpers/work-center.js');
const { yeaftHistoryIdentityKey } = await import('../../../web/stores/helpers/yeaft-history-identity.js');
const { sliceScopedYeaftMessagesByRecentTurns } = await import('../../../web/stores/helpers/yeaft-message-window.js');
const { revealOutlineResult } = await import('../../../web/utils/message-search-navigation.js');

function indexedHistoryResult(overrides = {}) {
  return {
    agentId: 'agent-a',
    sessionId: 'same',
    entryId: 'entry-m42',
    indexGeneration: 7,
    entryStartSeq: 42,
    messageId: 'm42',
    seq: 42,
    sourceMessageIds: ['m42'],
    ...overrides,
  };
}

function indexedHistoryResponse(request, overrides = {}) {
  return {
    agentId: 'agent-a',
    sessionId: 'same',
    requestId: request.requestId,
    entryId: request.entryId,
    indexGeneration: request.indexGeneration,
    entryStartSeq: request.entryStartSeq,
    entryEndSeq: request.anchorSeq,
    sourceMessageIds: [request.anchorMessageId],
    anchorMessageId: request.anchorMessageId,
    anchorSeq: request.anchorSeq,
    ...overrides,
  };
}

function primeStore() {
  const store = useChatStore();
  store.currentView = 'yeaft';
  store.currentAgent = 'agent-a';
  store.currentAgentInfo = { id: 'agent-a', version: '1.0.201', capabilities: ['session_history_outline'] };
  store.agents = [{ id: 'agent-a', version: '1.0.201', capabilities: ['session_history_outline'] }];
  store.yeaftActiveSessionFilter = 'same';
  store.yeaftSessionAgentById = { same: 'agent-a' };
  store.yeaftHistoryOutlineBySession = {};
  store._yeaftHistoryOutlineTimeouts = {};
  store.messagesMap = {};
  store.yeaftHistoryCacheState = {};
  store.yeaftHistoryFocusWindowBySession = {};
  store._yeaftHistoryWindowPendingByKey = {};
  store.yeaftConversationId = 'conv-a';
  store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-a' };
  const sent = [];
  store.sendWsMessage = msg => sent.push(msg);
  store._sent = sent;
  return store;
}

const consolidatedHistoryScenarios = [];
function historyScenario(name, run) { consolidatedHistoryScenarios.push({ name, run }); }
async function runConsolidatedHistoryScenarios() {
  for (const scenario of consolidatedHistoryScenarios) {
    try { await scenario.run(); }
    catch (error) { error.message = `[${scenario.name}] ${error.message}`; throw error; }
  }
}

describe('Yeaft history outline state', () => {
  beforeEach(() => vi.useFakeTimers());

  it('keeps automatic page-restore history out of the manual message refresh spinner', async () => {
    const store = primeStore();
    store.yeaftSessionHistoryState = {};
    store._yeaftManualHistoryRefresh = null;

    const automatic = store.beginYeaftHistoryLoad({
      agentId: 'agent-a', sessionId: 'same', mode: 'recent', preserveLoaded: false,
    });
    expect(store.yeaftLoadingMoreHistory).toBe(true);
    expect(store.yeaftManualHistoryRefreshLoading).toBe(false);

    expect(store.reloadYeaftMessages()).toBe(automatic.requestId);
    expect(store.yeaftManualHistoryRefreshLoading).toBe(true);
    expect(store._sent).toEqual([]);

    store.finishYeaftHistoryLoad({
      agentId: 'agent-a', sessionId: 'same', requestId: automatic.requestId,
    }, { loaded: true, hasMore: false, oldestSeq: 1 }, 'chunk');
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftManualHistoryRefreshLoading).toBe(false);

    expect(store.reloadYeaftMessages()).toBe(true);
    expect(store.yeaftManualHistoryRefreshLoading).toBe(true);
    expect(store._sent.at(-1)).toMatchObject({
      type: 'yeaft_load_history', agentId: 'agent-a', sessionId: 'same',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.yeaftManualHistoryRefreshLoading).toBe(false);
  });

  it('sends sender-only searches, rejects stale responses, and tracks unread Sessions', () => {
    const store = primeStore();
    store.activeVpTurns = {
      'turn-unread': { sessionId: 'other', vpId: 'linus', isStreaming: true },
    };
    store.yeaftSessionAgentById = { same: 'agent-a', other: 'agent-b' };

    store.handleYeaftOutput({
      agentId: 'agent-b',
      conversationId: 'conv-b',
      event: {
        type: 'vp_turn_end',
        reason: 'end_turn',
        turnId: 'turn-unread',
        sessionId: 'other',
        vpId: 'linus',
      },
    });

    expect(store.isYeaftSessionUnread('other', 'agent-b')).toBe(true);
    expect(store.isYeaftSessionUnread('other', 'agent-a')).toBe(false);
    store.setActiveSessionFilter('other', { agentId: 'agent-b' });
    expect(store.isYeaftSessionUnread('other', 'agent-b')).toBe(false);

    store.currentAgent = 'agent-a';
    store.currentView = 'yeaft';
    store.yeaftActiveSessionFilter = 'same';
    expect(store.markYeaftSessionUnread('same', 'agent-a')).toBe(false);
    store.yeaftSessionAgentById = { same: 'agent-a', other: 'agent-a' };
    store.activeVpTurns = {
      'turn-aborted': { sessionId: 'other', vpId: 'linus', isStreaming: true },
    };
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: {
        type: 'vp_turn_end',
        reason: 'aborted',
        turnId: 'turn-aborted',
        sessionId: 'other',
        vpId: 'linus',
      },
    });
    expect(store.isYeaftSessionUnread('same', 'agent-a')).toBe(false);
    expect(store.isYeaftSessionUnread('other', 'agent-a')).toBe(false);

    store.currentAgentInfo.capabilities.push('session_history_search');
    store.agents[0].capabilities.push('session_history_search');
    expect(store.searchYeaftHistory('', { senderKey: 'vp:linus' })).toBe(true);
    const first = store._sent.at(-1);
    expect(first).toMatchObject({
      type: 'yeaft_search_history', query: '', senderKey: 'vp:linus', sessionId: 'same',
    });
    expect(store.searchYeaftHistory('中')).toBe(true);
    expect(store._sent.at(-1)).toMatchObject({ type: 'yeaft_search_history', query: '中' });
    expect(store.searchYeaftHistory('😀')).toBe(true);
    expect(store._sent.at(-1)).toMatchObject({ type: 'yeaft_search_history', query: '😀' });

    store.yeaftHistorySearchState.nextBeforeSeq = 40;
    expect(store.searchYeaftHistory('', { senderKey: 'user', append: true })).toBe(true);
    const second = store._sent.at(-1);
    expect(second).toMatchObject({ query: '', senderKey: 'user' });
    expect(second).not.toHaveProperty('beforeSeq');
    expect(store.handleYeaftHistorySearchResult({
      agentId: 'agent-a', sessionId: 'same', requestId: second.requestId,
      query: '', senderKey: 'vp:linus', results: [],
    })).toBe(false);
  });

  it('reloads an outdated search locator before revealing an uncached message', async () => {
    const store = primeStore();
    store.currentAgentInfo.capabilities.push('session_history_search', 'session_history_window_prefetch');
    store.agents[0].capabilities.push('session_history_search', 'session_history_window_prefetch');
    const staleResult = indexedHistoryResult({ indexGeneration: 6, snippet: 'target text' });
    store.yeaftHistorySearchState = {
      requestId: null,
      agentId: 'agent-a',
      sessionId: 'same',
      query: 'target text',
      senderKey: '',
      loading: false,
      results: [staleResult],
      hasMore: false,
      nextBeforeSeq: null,
      nextCursor: null,
      error: null,
    };

    const clicked = store.revealYeaftHistoryResult(staleResult);
    const staleRequest = store._sent.at(-1);
    expect(staleRequest).toMatchObject({
      type: 'yeaft_load_history_window',
      indexGeneration: 6,
      anchorMessageId: 'm42',
    });
    expect(store.handleYeaftHistoryWindow({
      ...indexedHistoryResponse(staleRequest),
      error: 'stale_result',
      messages: [],
    }, null)).toBe(false);
    await Promise.resolve();

    const refresh = store._sent.at(-1);
    expect(refresh).toMatchObject({
      type: 'yeaft_search_history',
      query: 'target text',
      senderKey: '',
      sessionId: 'same',
    });
    expect(store.handleYeaftHistorySearchResult({
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: refresh.requestId,
      query: 'target text',
      senderKey: '',
      results: [indexedHistoryResult({ indexGeneration: 7, snippet: 'target text' })],
      hasMore: false,
    })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    const retry = store._sent.at(-1);
    expect(retry).toMatchObject({
      type: 'yeaft_load_history_window',
      indexGeneration: 7,
      anchorMessageId: 'm42',
    });
    const response = indexedHistoryResponse(retry, {
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);

    await expect(clicked).resolves.toBe(true);
    expect(store.isYeaftMessageCached('same', 'm42')).toBe(true);
    expect(store._yeaftHistoryRevealLeases).toEqual({});
  });

  it('does not retry a permanent unloaded-window failure', async () => {
    const store = primeStore();
    store.currentAgentInfo.capabilities.push('session_history_search', 'session_history_window_prefetch');
    store.agents[0].capabilities.push('session_history_search', 'session_history_window_prefetch');
    const result = indexedHistoryResult();
    store.yeaftHistorySearchState = {
      requestId: null, agentId: 'agent-a', sessionId: 'same', query: 'target text', senderKey: '',
      loading: false, results: [result], hasMore: false, nextBeforeSeq: null, error: null,
    };

    const clicked = store.revealYeaftHistoryResult(result);
    const request = store._sent.at(-1);
    store.handleYeaftHistoryWindow({
      ...indexedHistoryResponse(request), error: 'window_load_failed', messages: [],
    }, null);

    await expect(clicked).resolves.toBe(false);
    expect(store._sent).toHaveLength(1);
  });

  it('refreshes an outline locator after its search panel has closed', async () => {
    const store = primeStore();
    store.currentAgentInfo.capabilities.push('session_history_window_prefetch');
    store.agents[0].capabilities.push('session_history_window_prefetch');
    const staleResult = indexedHistoryResult({ indexGeneration: 6 });
    store.yeaftHistoryOutlineBySession[yeaftHistoryIdentityKey('agent-a', 'same')] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [staleResult], hasMore: false, nextBeforeSeq: null, totalCount: 1, error: null,
    };
    store.yeaftHistorySearchState = {
      requestId: null, agentId: 'agent-a', sessionId: 'same', query: '', senderKey: '',
      loading: false, results: [], hasMore: false, nextBeforeSeq: null, error: null,
    };

    const clicked = store.revealYeaftHistoryResult(staleResult);
    const staleRequest = store._sent.at(-1);
    store.handleYeaftHistoryWindow({
      ...indexedHistoryResponse(staleRequest), error: 'stale_result', messages: [],
    }, null);
    await Promise.resolve();

    const refresh = store._sent.at(-1);
    expect(refresh).toMatchObject({ type: 'yeaft_load_history_outline', sessionId: 'same' });
    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: refresh.requestId,
      results: [indexedHistoryResult({ indexGeneration: 7 })],
      hasMore: false,
    })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    const retry = store._sent.at(-1);
    expect(retry).toMatchObject({
      type: 'yeaft_load_history_window', indexGeneration: 7, anchorMessageId: 'm42',
    });
    const response = indexedHistoryResponse(retry, {
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    store.handleYeaftHistoryWindow(response, conversationId);
    await expect(clicked).resolves.toBe(true);
  });

  it('binds stale outline relocation to an exact Session refresh already in flight', async () => {
    const store = primeStore();
    store.currentAgentInfo.capabilities.push('session_history_window_prefetch');
    store.agents[0].capabilities.push('session_history_window_prefetch');
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    const staleResult = indexedHistoryResult({ indexGeneration: 6 });
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [staleResult], hasMore: false, nextBeforeSeq: null, totalCount: 1, error: null,
    };
    store.yeaftHistorySearchState = {
      requestId: null, agentId: 'agent-a', sessionId: 'same', query: '', senderKey: '',
      loading: false, results: [], hasMore: false, nextBeforeSeq: null, error: null,
    };

    expect(store.loadYeaftHistoryOutline({
      force: true,
      targetSessionId: 'same',
      targetAgentId: 'agent-a',
    })).toBe(true);
    const inFlightRefresh = store._sent.at(-1);
    const clicked = store.revealYeaftHistoryResult(staleResult);
    const staleRequest = store._sent.at(-1);
    expect(staleRequest).toMatchObject({
      type: 'yeaft_load_history_window', indexGeneration: 6, anchorMessageId: 'm42',
    });
    store.handleYeaftHistoryWindow({
      ...indexedHistoryResponse(staleRequest), error: 'stale_result', messages: [],
    }, null);
    await Promise.resolve();

    expect(store._sent.filter(msg => msg.type === 'yeaft_load_history_outline')).toHaveLength(1);
    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: inFlightRefresh.requestId,
      results: [indexedHistoryResult({ indexGeneration: 7 })],
      hasMore: false,
    })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    const retry = store._sent.at(-1);
    expect(retry).toMatchObject({
      type: 'yeaft_load_history_window', indexGeneration: 7, anchorMessageId: 'm42',
    });
    const response = indexedHistoryResponse(retry, {
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    store.handleYeaftHistoryWindow(response, conversationId);
    await expect(clicked).resolves.toBe(true);
  });

  it('cancels a stale-result refresh before exact Session history cleanup', async () => {
    const store = primeStore();
    store.currentAgentInfo.capabilities.push('session_history_search', 'session_history_window_prefetch');
    store.agents[0].capabilities.push('session_history_search', 'session_history_window_prefetch');
    const staleResult = indexedHistoryResult({ indexGeneration: 6 });
    store.yeaftHistorySearchState = {
      requestId: null, agentId: 'agent-a', sessionId: 'same', query: 'target text', senderKey: '',
      loading: false, results: [staleResult], hasMore: false, nextBeforeSeq: null, error: null,
    };

    const clicked = store.revealYeaftHistoryResult(staleResult);
    const staleRequest = store._sent.at(-1);
    store.handleYeaftHistoryWindow({
      ...indexedHistoryResponse(staleRequest), error: 'stale_result', messages: [],
    }, null);
    await Promise.resolve();
    expect(Object.keys(store._yeaftHistoryResultRefreshByRequestId)).toHaveLength(1);

    store.clearYeaftHistoryMemory({ agentId: 'agent-a', sessionId: 'same' });
    await expect(clicked).resolves.toBe(false);
    expect(store._yeaftHistoryResultRefreshByRequestId).toEqual({});
  });

  it('loads and expands an uncached old anchor through the click action', async () => {
    await runConsolidatedHistoryScenarios();
    const store = primeStore();
    store.currentAgentInfo.capabilities.push('session_history_search', 'session_history_window_prefetch');
    store.agents[0].capabilities.push('session_history_search', 'session_history_window_prefetch');
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: index % 2 ? 'assistant' : 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));
    store.yeaftMessageWindowState = { [yeaftHistoryIdentityKey('agent-a', 'same')]: { visibleTurns: 5 } };

    const renderedReveal = vi.fn(() => store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')].visibleTurns > 5);
    const clicked = revealOutlineResult({
      result: indexedHistoryResult(),
      revealWindow: candidate => store.revealYeaftHistoryResult(candidate),
      nextTick: vi.fn().mockResolvedValue(undefined),
      revealMessage: renderedReveal,
      isMobile: false,
    });
    const request = store._sent.at(-1);
    const response = indexedHistoryResponse(request, {
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);

    expect(conversationId).toBe('conv-a');
    expect(store.messagesMap['conv-a'].some(row => row.persistedMessageId === 'm42' || row.messageId === 'm42')).toBe(true);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(clicked).resolves.toBe(true);
    expect(renderedReveal).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm42' }));
    expect(store.isYeaftMessageCached('same', 'm42')).toBe(true);
    expect(store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')].visibleTurns).toBeGreaterThan(5);
  });

  historyScenario('isolates render windows and reveal leases for the same Session id on different Agents', () => {
    const store = primeStore();
    const keyA = yeaftHistoryIdentityKey('agent-a', 'same');
    const keyB = yeaftHistoryIdentityKey('agent-b', 'same');
    store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-a', 'agent-b': 'conv-b' };

    store.yeaftMessageWindowState = {
      [keyA]: { visibleTurns: 5 },
      [keyB]: { visibleTurns: 17 },
    };
    store.expandYeaftMessageWindow('same', 3, 'agent-a');

    expect(store.yeaftMessageWindowState[keyA].visibleTurns).toBe(8);
    expect(store.yeaftMessageWindowState[keyB].visibleTurns).toBe(17);

    const leaseA = store.beginYeaftHistoryReveal({ agentId: 'agent-a', sessionId: 'same' });
    const leaseB = store.beginYeaftHistoryReveal({ agentId: 'agent-b', sessionId: 'same' });
    store.finishYeaftHistoryReveal(leaseA);
    store.pruneYeaftMessageWindow('same', 'agent-b');
    expect(store.yeaftMessageWindowState[keyB].visibleTurns).toBe(17);

    const newerLeaseB = store.beginYeaftHistoryReveal({ agentId: 'agent-b', sessionId: 'same' });
    expect(store.finishYeaftHistoryReveal(leaseB)).toBe(false);
    store.pruneYeaftMessageWindow('same', 'agent-b');
    expect(store.yeaftMessageWindowState[keyB].visibleTurns).toBe(17);
    expect(store.finishYeaftHistoryReveal(newerLeaseB)).toBe(true);
    store.pruneYeaftMessageWindow('same', 'agent-b');
    expect(store.yeaftMessageWindowState[keyB].visibleTurns).toBe(Number.POSITIVE_INFINITY);
  });

  historyScenario('routes same-id background frames only to their owning Agent outline', () => {
    const store = primeStore();
    const keyA = yeaftHistoryIdentityKey('agent-a', 'same');
    const keyB = yeaftHistoryIdentityKey('agent-b', 'same');
    store.agents.push({
      id: 'agent-b', version: '1.0.201', capabilities: ['session_history_outline'],
    });
    store.yeaftConversationIdsByAgent = {
      'agent-a': 'conv-a',
      'agent-b': 'conv-b',
    };
    store.messagesMap = { 'conv-a': [], 'conv-b': [] };
    store.yeaftHistoryOutlineBySession = {
      [keyA]: {
        agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
        results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
      },
      [keyB]: {
        agentId: 'agent-b', sessionId: 'same', loaded: true, loading: false,
        results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
      },
    };
    store.executionStatusMap = {};
    store.conversations = [];
    store.processingConversations = {};
    store.activeVpTurns = {};
    store.vpStatuses = {};
    store._turnCompletedConvs = new Set();
    store._currentYeaftSessionId = 'same';
    store._currentYeaftTurnId = 'turn-b';
    store._currentYeaftVpId = 'maker';

    store.handleYeaftOutput({
      agentId: 'agent-b',
      conversationId: 'conv-b',
      sessionId: 'same',
      turnId: 'turn-b',
      vpId: 'maker',
      data: {
        type: 'user',
        message: {
          id: 'm101',
          content: 'B user echo',
          clientMessageId: 'client-b',
        },
      },
    });
    expect(store.yeaftHistoryOutlineBySession[keyA].results).toEqual([]);
    expect(store.yeaftHistoryOutlineBySession[keyB].results)
      .toEqual([expect.objectContaining({ messageId: 'm101', snippet: 'B user echo' })]);

    store.messagesMap['conv-b'].push({
      id: 'm102', messageId: 'm102', type: 'assistant', content: 'B background answer',
      sessionId: 'same', turnId: 'turn-b', speakerVpId: 'maker',
    });
    store.handleYeaftOutput({
      agentId: 'agent-b',
      conversationId: 'conv-b',
      sessionId: 'same',
      turnId: 'turn-b',
      vpId: 'maker',
      data: { type: 'result', result_text: '' },
    });
    expect(store.yeaftHistoryOutlineBySession[keyA].results).toEqual([]);
    expect(store.yeaftHistoryOutlineBySession[keyB].results)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ messageId: 'm102', snippet: 'B background answer' }),
      ]));

    const beforeA = structuredClone(store.yeaftHistoryOutlineBySession[keyA]);
    const beforeB = structuredClone(store.yeaftHistoryOutlineBySession[keyB]);
    store.handleYeaftOutput({
      conversationId: 'conv-b',
      sessionId: 'same',
      turnId: 'turn-b-late',
      data: {
        type: 'user', message: { id: 'm103', content: 'unknown late frame' },
      },
    });
    expect(store.messagesMap['conv-b']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm103', content: 'unknown late frame' }),
    ]));
    expect(store.yeaftHistoryOutlineBySession[keyA]).toEqual(beforeA);
    expect(store.yeaftHistoryOutlineBySession[keyB]).toEqual(beforeB);
  });

  historyScenario('rejects stale or failed anchor windows before they mutate the cache', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = [];
    const before = store.messagesMap['conv-a'].slice();

    store.handleMessage({
      type: 'yeaft_history_window',
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: 'unknown-window',
      messages: [{ id: 'm1', role: 'assistant', content: 'must not land' }],
    });
    expect(store.messagesMap['conv-a']).toEqual(before);

    const pending = store.loadYeaftHistoryWindow(indexedHistoryResult({ entryId: 'entry-old' }));
    const request = store._sent.at(-1);
    store.handleMessage({
      type: 'yeaft_history_window',
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: request.requestId,
      entryId: 'entry-old',
      error: 'stale_result',
      messages: [{ id: 'm42', role: 'assistant', content: 'stale body' }],
    });

    await expect(pending).resolves.toBe(false);
    expect(store.messagesMap['conv-a']).toEqual(before);
  });

  it('retries transient outline index responses before surfacing an error', async () => {
    const store = primeStore();
    expect(store.loadYeaftHistoryOutline()).toBe(true);
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    const first = store._sent.at(-1);

    expect(store.handleYeaftHistoryOutline({
      type: 'yeaft_history_outline',
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: first.requestId,
      results: [],
      error: 'index_building',
    })).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      requestId: first.requestId,
      loading: true,
      retryAttempt: 0,
      error: null,
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(store._sent).toHaveLength(2);
    const second = store._sent.at(-1);
    expect(second.requestId).not.toBe(first.requestId);
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      requestId: second.requestId,
      loading: true,
      retryAttempt: 1,
      error: null,
    });

    expect(store.handleYeaftHistoryOutline({
      type: 'yeaft_history_outline',
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: second.requestId,
      results: [{ messageId: 'm42', seq: 42, snippet: 'ready' }],
      hasMore: false,
    })).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      loaded: true,
      loading: false,
      error: null,
      results: [expect.objectContaining({ messageId: 'm42' })],
    });
  });

  it('upgrades an append retry to a newest-page refresh when invalidated during backoff', async () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [{ messageId: 'm20', seq: 20 }], hasMore: true,
      nextBeforeSeq: 20, nextCursor: { generation: 7, beforeEntryStartSeq: 20 },
      totalCount: null, error: null,
    };
    expect(store.loadYeaftHistoryOutline({ append: true })).toBe(true);
    const first = store._sent.at(-1);
    expect(first).toMatchObject({
      cursor: { generation: 7, beforeEntryStartSeq: 20 },
    });
    expect(first).not.toHaveProperty('beforeSeq');
    store.handleYeaftHistoryOutline({
      type: 'yeaft_history_outline', agentId: 'agent-a', sessionId: 'same',
      requestId: first.requestId, results: [], error: 'index_building',
    });

    expect(store.invalidateYeaftHistoryOutline('same', 'agent-a')).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[key].refreshPending).toBe(true);
    await vi.advanceTimersByTimeAsync(150);

    const retry = store._sent.at(-1);
    expect(retry.requestId).not.toBe(first.requestId);
    expect(retry).not.toHaveProperty('beforeSeq');
    expect(retry).not.toHaveProperty('cursor');
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      loading: true,
      requestAppend: false,
      refreshPending: false,
      retryAttempt: 1,
    });
    store.handleYeaftHistoryOutline({
      type: 'yeaft_history_outline', agentId: 'agent-a', sessionId: 'same',
      requestId: retry.requestId, results: [{ messageId: 'm21', seq: 21 }], hasMore: true,
    });
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      loaded: true,
      loading: false,
      results: [expect.objectContaining({ messageId: 'm21' })],
    });
  });

  it('preserves an append cursor across a transient retry without invalidation', async () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [{ messageId: 'm20', seq: 20 }], hasMore: true,
      nextBeforeSeq: 20, nextCursor: { generation: 7, beforeEntryStartSeq: 20 },
      totalCount: null, error: null,
    };
    store.loadYeaftHistoryOutline({ append: true });
    const first = store._sent.at(-1);
    store.handleYeaftHistoryOutline({
      type: 'yeaft_history_outline', agentId: 'agent-a', sessionId: 'same',
      requestId: first.requestId, results: [], error: 'stale_result',
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(store._sent.at(-1)).toMatchObject({
      cursor: { generation: 7, beforeEntryStartSeq: 20 },
    });
    expect(store._sent.at(-1)).not.toHaveProperty('beforeSeq');
    expect(store.yeaftHistoryOutlineBySession[key].requestAppend).toBe(true);
  });

  it('surfaces a transient outline error after bounded retries are exhausted', async () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.loadYeaftHistoryOutline();
    for (const delay of [150, 300, 600, 1_000]) {
      const request = store._sent.at(-1);
      store.handleYeaftHistoryOutline({
        type: 'yeaft_history_outline', agentId: 'agent-a', sessionId: 'same',
        requestId: request.requestId, results: [], error: 'index_building',
      });
      await vi.advanceTimersByTimeAsync(delay);
    }
    const finalRequest = store._sent.at(-1);
    store.handleYeaftHistoryOutline({
      type: 'yeaft_history_outline', agentId: 'agent-a', sessionId: 'same',
      requestId: finalRequest.requestId, results: [], error: 'index_building',
    });

    expect(store._sent).toHaveLength(5);
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      loaded: false,
      loading: false,
      retryAttempt: 4,
      error: 'index_building',
    });
  });

  it('creates a fresh fenced request when the user retries a failed outline', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    expect(store.loadYeaftHistoryOutline()).toBe(true);
    const failedRequest = store._sent.at(-1);
    expect(store.handleYeaftHistoryOutline({
      type: 'yeaft_history_outline', agentId: 'agent-a', sessionId: 'same',
      requestId: failedRequest.requestId, results: [], error: 'index_unavailable',
    })).toBe(true);

    expect(store.loadYeaftHistoryOutline({ force: true })).toBe(true);
    const retryRequest = store._sent.at(-1);
    expect(retryRequest.requestId).not.toBe(failedRequest.requestId);
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      requestId: retryRequest.requestId, loading: true, retryAttempt: 0, error: null,
    });
    expect(store.handleYeaftHistoryOutline({
      type: 'yeaft_history_outline', agentId: 'agent-a', sessionId: 'same',
      requestId: failedRequest.requestId, results: [{ messageId: 'stale' }],
    })).toBe(false);
    expect(store.yeaftHistoryOutlineBySession[key].requestId).toBe(retryRequest.requestId);
  });

  it('surfaces non-retryable outline failures immediately', () => {
    const store = primeStore();
    expect(store.loadYeaftHistoryOutline()).toBe(true);
    const request = store._sent.at(-1);

    expect(store.handleYeaftHistoryOutline({
      type: 'yeaft_history_outline',
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: request.requestId,
      results: [],
      error: 'index_unavailable',
    })).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[yeaftHistoryIdentityKey('agent-a', 'same')]).toMatchObject({
      loaded: false,
      loading: false,
      error: 'index_unavailable',
    });
    expect(store._sent).toHaveLength(1);
  });

  it('revalidates the exact history request immediately before merging rows', async () => {
    const store = primeStore();
    store.messagesMap = { 'conv-a': [] };
    const pending = store.loadYeaftHistoryWindow(indexedHistoryResult());
    const request = store._sent.at(-1);
    const response = {
      type: 'yeaft_history_window',
      ...indexedHistoryResponse(request),
      messages: [{ id: 'm42', role: 'assistant', content: 'must not land' }],
    };
    const originalPendingWindow = store.pendingYeaftHistoryWindow.bind(store);
    let checks = 0;
    store.pendingYeaftHistoryWindow = vi.fn((msg) => {
      checks += 1;
      const match = originalPendingWindow(msg);
      if (checks === 1) store.clearYeaftHistoryMemory();
      return match;
    });

    store.handleMessage(response);

    await expect(pending).resolves.toBe(false);
    expect(store.pendingYeaftHistoryWindow).toHaveBeenCalledTimes(2);
    expect(store.messagesMap['conv-a']).toEqual([]);
  });

  it('cancels delayed history windows before owner cleanup or exact Session deletion', async () => {
    const store = primeStore();
    store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-a', 'agent-b': 'conv-b' };
    store.messagesMap = { 'conv-a': [], 'conv-b': [] };

    const ownerPending = store.loadYeaftHistoryWindow(indexedHistoryResult());
    const ownerRequest = store._sent.at(-1);
    store.clearYeaftHistoryMemory();
    await expect(ownerPending).resolves.toBe(false);
    store.handleMessage({
      type: 'yeaft_history_window',
      ...indexedHistoryResponse(ownerRequest),
      messages: [{ id: 'm42', role: 'assistant', content: 'late owner plaintext' }],
    });
    expect(store.messagesMap['conv-a']).toEqual([]);

    const agentAResult = indexedHistoryResult({ agentId: 'agent-a' });
    const agentBResult = indexedHistoryResult({ agentId: 'agent-b' });
    const agentAPending = store.loadYeaftHistoryWindow(agentAResult);
    const agentARequest = store._sent.at(-1);
    const agentBPending = store.loadYeaftHistoryWindow(agentBResult);
    const agentBRequest = store._sent.at(-1);

    store.clearYeaftHistoryMemory({ agentId: 'agent-a', sessionId: 'same' });
    await expect(agentAPending).resolves.toBe(false);
    expect(store.pendingYeaftHistoryWindow(indexedHistoryResponse(agentARequest))).toBeNull();
    expect(store.pendingYeaftHistoryWindow(
      indexedHistoryResponse(agentBRequest, { agentId: 'agent-b' }),
    )).not.toBeNull();

    store.handleMessage({
      type: 'yeaft_history_window',
      ...indexedHistoryResponse(agentARequest),
      messages: [{ id: 'm42', role: 'assistant', content: 'late deleted plaintext' }],
    });
    expect(store.messagesMap['conv-a']).toEqual([]);

    store.handleMessage({
      type: 'yeaft_history_window',
      ...indexedHistoryResponse(agentBRequest, { agentId: 'agent-b' }),
      messages: [{ id: 'm42', role: 'assistant', content: 'live Agent B history' }],
    });
    await expect(agentBPending).resolves.toBe(true);
    expect(store.messagesMap['conv-b']).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'live Agent B history', sessionId: 'same' }),
    ]));
  });

  it('reuses one bounded history-window request across hover prefetch and click', async () => {
    const store = primeStore();
    const result = indexedHistoryResult();

    const prefetched = store.loadYeaftHistoryWindow(result);
    const clicked = store.loadYeaftHistoryWindow(result);

    expect(clicked).toBe(prefetched);
    expect(store._sent).toHaveLength(1);
    const request = store._sent[0];
    expect(request).toMatchObject({
      entryId: result.entryId,
      indexGeneration: result.indexGeneration,
      entryStartSeq: result.entryStartSeq,
      anchorMessageId: result.messageId,
      anchorSeq: result.seq,
      beforeTurns: 5,
      afterTurns: 5,
      maxRows: 200,
      maxBytes: 512 * 1024,
    });

    const response = indexedHistoryResponse(request, {
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(prefetched).resolves.toBe(true);
    expect(store._yeaftHistoryWindowPendingByKey).toEqual({});
  });

  it('keeps prefetch cache-only, then expands an already-prefetched anchor on click', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: index % 2 ? 'assistant' : 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));
    const initialWindow = { visibleTurns: 5 };
    store.yeaftMessageWindowState = { [yeaftHistoryIdentityKey('agent-a', 'same')]: initialWindow };

    const prefetched = store.loadYeaftHistoryWindow(indexedHistoryResult());
    const request = store._sent.at(-1);
    const response = indexedHistoryResponse(request, {
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(prefetched).resolves.toBe(true);

    expect(store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')]).toBe(initialWindow);
    expect(store.isYeaftMessageCached('same', 'm42')).toBe(true);
    const renderedReveal = vi.fn(() => {
      const focus = store.yeaftHistoryFocusWindowBySession[yeaftHistoryIdentityKey('agent-a', 'same')];
      return !!focus && store.messagesMap['conv-a'].some(row => (
        row._historyWindowKey === focus.windowKey && (row.messageId || row.id) === 'm42'
      ));
    });
    const clicked = revealOutlineResult({
      result: indexedHistoryResult(),
      revealWindow: candidate => store.revealYeaftHistoryResult(candidate),
      nextTick: vi.fn().mockResolvedValue(undefined),
      revealMessage: renderedReveal,
      isMobile: false,
    });
    const validationRequest = store._sent.at(-1);
    const validationResponse = indexedHistoryResponse(validationRequest, {
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    });
    const validationConversationId = mergeYeaftHistoryWindow(store, validationResponse);
    expect(store.handleYeaftHistoryWindow(validationResponse, validationConversationId)).toBe(true);
    await expect(clicked).resolves.toBe(true);
    expect(renderedReveal).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm42' }));
    expect(store._sent).toHaveLength(2);
    const focus = store.yeaftHistoryFocusWindowBySession[yeaftHistoryIdentityKey('agent-a', 'same')];
    expect(store.messagesMap['conv-a']
      .filter(row => row._historyWindowKey === focus.windowKey)
      .map(row => row.content)).toEqual(['old answer']);
    expect(focus).toMatchObject({ messageId: 'm42', conversationId: 'conv-a' });
  });

  it('merges an uncached search window into the ordered resident transcript without replacing its latest tail', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      seq: index + 50,
      type: index % 2 ? 'assistant' : 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
      isHistory: true,
    }));
    store.yeaftMessageWindowState = {
      [yeaftHistoryIdentityKey('agent-a', 'same')]: { visibleTurns: 5 },
    };

    const clicked = store.revealYeaftHistoryResult(indexedHistoryResult());
    const request = store._sent.at(-1);
    const response = indexedHistoryResponse(request, {
      messages: [
        { id: 'm41', seq: 41, role: 'user', content: 'old question', createdAt: 41 },
        { id: 'm42', seq: 42, role: 'assistant', content: 'old answer', createdAt: 42 },
      ],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(clicked).resolves.toBe(true);

    const visible = sliceScopedYeaftMessagesByRecentTurns(
      store.messagesMap['conv-a'],
      'same',
      store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')].visibleTurns,
    );
    expect(visible.map(row => row.id)).toEqual([
      'm41', 'm42',
      ...Array.from({ length: 12 }, (_, index) => `m${index + 50}`),
    ]);
    expect(visible.at(-1)?.id).toBe('m61');
    expect(store.yeaftHistoryFocusWindowBySession[yeaftHistoryIdentityKey('agent-a', 'same')]).toMatchObject({
      messageId: 'm42',
    });
    expect(store.showLatestYeaftMessageWindow('same', 'agent-a')).toBe(true);
    expect(sliceScopedYeaftMessagesByRecentTurns(
      store.messagesMap['conv-a'], 'same', Number.POSITIVE_INFINITY,
    ).at(-1)?.id).toBe('m61');
  });

  it('keeps an overlapping recent-tail result resident and visible after returning to Latest', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: index % 2 ? 'assistant' : 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));
    const originalIds = store.messagesMap['conv-a'].map(row => row.id);
    const result = indexedHistoryResult({
      entryId: 'entry-m55',
      entryStartSeq: 55,
      messageId: 'm55',
      seq: 55,
      sourceMessageIds: ['m55'],
    });

    const clicked = store.revealYeaftHistoryResult(result);
    const request = store._sent.at(-1);
    const response = indexedHistoryResponse(request, {
      messages: [{ id: 'm55', role: 'assistant', content: 'recent 5', createdAt: 55 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(clicked).resolves.toBe(true);
    expect(store.yeaftHistoryFocusWindowBySession[yeaftHistoryIdentityKey('agent-a', 'same')]).toBeUndefined();

    // MessageList still executes this action when Latest is clicked. There is no
    // detached focus to clear because the target retained recent membership.
    expect(store.showLatestYeaftMessageWindow('same', 'agent-a')).toBe(false);
    const resident = store.messagesMap['conv-a'];
    expect(resident.map(row => row.id)).toEqual(originalIds);
    expect(resident.find(row => row.id === 'm55')).not.toMatchObject({ _historyWindowDetached: true });
    expect(sliceScopedYeaftMessagesByRecentTurns(resident, 'same', 50).map(row => row.id)).toEqual(originalIds);
  });

  it('isolates overlapping history message IDs between Sessions sharing one conversation', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = [{
      id: 'm42',
      messageId: 'm42',
      type: 'assistant',
      content: 'session B row',
      sessionId: 'session-b',
      timestamp: 42,
    }];
    const result = indexedHistoryResult({
      entryId: 'entry-a-m42',
      entryStartSeq: 42,
      messageId: 'm42',
      seq: 42,
      sourceMessageIds: ['m42'],
    });

    const clicked = store.revealYeaftHistoryResult(result, {
      sessionId: 'same',
      agentId: 'agent-a',
    });
    const request = store._sent.at(-1);
    const response = indexedHistoryResponse(request, {
      sessionId: 'same',
      messages: [{ id: 'm42', role: 'assistant', content: 'session A row', createdAt: 42 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(clicked).resolves.toBe(true);

    expect(store.isYeaftMessageCached('same', 'm42')).toBe(true);
    expect(store.messagesMap['conv-a']).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: 'm42', sessionId: 'same', content: 'session A row' }),
      expect.objectContaining({ messageId: 'm42', sessionId: 'session-b', content: 'session B row' }),
    ]));
    expect(store.messagesMap['conv-a'].find(row => row.sessionId === 'session-b')).not.toMatchObject({
      _historyWindowDetached: true,
      historyEntryId: 'entry-a-m42',
    });
  });

  it('does not expand or render after the active Session changes while a window is pending', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));
    store.yeaftMessageWindowState = {
      [yeaftHistoryIdentityKey('agent-a', 'same')]: { visibleTurns: 5 },
      [yeaftHistoryIdentityKey('agent-a', 'other')]: { visibleTurns: 5 },
    };
    const renderedReveal = vi.fn();

    const clicked = revealOutlineResult({
      result: indexedHistoryResult(),
      revealWindow: candidate => store.revealYeaftHistoryResult(candidate),
      nextTick: vi.fn().mockResolvedValue(undefined),
      revealMessage: renderedReveal,
      isMobile: false,
    });
    const request = store._sent.at(-1);
    store.yeaftActiveSessionFilter = 'other';
    store.yeaftSessionAgentById.other = 'agent-a';

    const response = indexedHistoryResponse(request, {
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);

    await expect(clicked).resolves.toBe(false);
    expect(store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')].visibleTurns).toBe(5);
    expect(store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'other')].visibleTurns).toBe(5);
    expect(renderedReveal).not.toHaveBeenCalled();
  });

  it('does not expand or render after the same Session migrates conversation while a window is pending', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));
    store.messagesMap['conv-b'] = [];
    store.yeaftMessageWindowState = { [yeaftHistoryIdentityKey('agent-a', 'same')]: { visibleTurns: 5 } };
    const renderedReveal = vi.fn();

    const clicked = revealOutlineResult({
      result: indexedHistoryResult(),
      revealWindow: candidate => store.revealYeaftHistoryResult(candidate),
      nextTick: vi.fn().mockResolvedValue(undefined),
      revealMessage: renderedReveal,
      isMobile: false,
    });
    const request = store._sent.at(-1);
    store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-b' };
    store.yeaftConversationId = 'conv-b';

    const response = indexedHistoryResponse(request, {
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    });
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(conversationId).toBe('conv-b');
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);

    await expect(clicked).resolves.toBe(false);
    expect(store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')].visibleTurns).toBe(5);
    expect(renderedReveal).not.toHaveBeenCalled();
  });







  it('reveals a tool-only response through its persisted anchor', () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = [{
      id: 'm42:tool:read',
      messageId: 'm42:tool:read',
      persistedMessageId: 'm42',
      type: 'tool-use',
      toolName: 'FileRead',
      toolInput: { file_path: 'README.md' },
      sessionId: 'same',
      turnId: 'response-tool-only',
    }];

    expect(store.revealYeaftMessage('same', 'm42')).toBe(true);

    store.executionStatusMap = {};
    store.conversations = [];
    store.processingConversations = { 'conv-a': true };
    store._currentYeaftSessionId = 'same';
    store._currentYeaftTurnId = 'turn-tool';
    store._currentYeaftVpId = 'maker';
    store.messagesMap['conv-a'] = [{
      id: 'progress-before-tool',
      type: 'assistant',
      content: 'Inspecting files',
      sessionId: 'same',
      turnId: 'turn-tool',
      speakerVpId: 'maker',
      isStreaming: true,
      status: 'pending',
    }];

    handleAssistantOutputFrame(store, 'conv-a', {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'FileRead', input: { file_path: 'README.md' } }],
      },
    });

    expect(store.messagesMap['conv-a'][0]).toMatchObject({
      isStreaming: false,
      status: 'pending',
      turnId: 'turn-tool',
    });
    expect(store.messagesMap['conv-a'][0]).not.toHaveProperty('turnEndAt');
    expect(store.messagesMap['conv-a'][1]).toMatchObject({
      type: 'tool-use',
      toolName: 'FileRead',
      turnId: 'turn-tool',
    });
  });

  it('force-refreshes a loaded visible outline when a completed response has no durable anchor yet', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.messagesMap['conv-a'] = [{
      id: 'local-answer', messageId: 'local-answer', type: 'assistant', content: 'finished answer',
      sessionId: 'same', turnId: 'response-local', speakerVpId: 'maker', isStreaming: true, status: 'pending',
    }];
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };
    store._currentYeaftSessionId = 'same';
    store._currentYeaftTurnId = 'response-local';
    store._currentYeaftVpId = 'maker';
    store.processingConversations = { 'conv-a': true };
    store.activeVpTurns = {};
    store.executionStatusMap = {};
    store.conversations = [];
    store.vpStatuses = {};
    store._turnCompletedConvs = new Set();

    handleAssistantOutputFrame(store, 'conv-a', { type: 'result', result_text: '' }, 'agent-a');

    expect(store._sent).toHaveLength(1);
    expect(store._sent[0]).toMatchObject({
      type: 'yeaft_load_history_outline', agentId: 'agent-a', sessionId: 'same',
      perfTraceId: expect.stringMatching(/^pt_/),
    });
    expect(store._sent[0]).not.toHaveProperty('includeTotal');
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({ loaded: false, loading: true });
  });







  it('keeps pending refresh state isolated by agent and Session identity', () => {
    const store = primeStore();
    const keyA = yeaftHistoryIdentityKey('agent-a', 'same');
    const keyB = yeaftHistoryIdentityKey('agent-b', 'other');
    store.agents.push({ id: 'agent-b', version: '1.0.201', capabilities: ['session_history_outline'] });
    store.yeaftSessionAgentById.other = 'agent-b';
    store.yeaftHistoryOutlineBySession[keyA] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: true,
      requestId: 'request-a', requestAppend: true, refreshPending: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };
    store.yeaftHistoryOutlineBySession[keyB] = {
      agentId: 'agent-b', sessionId: 'other', loaded: true, loading: true,
      requestId: 'request-b', requestAppend: true, refreshPending: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };

    expect(store.invalidateYeaftHistoryOutline('same', 'agent-a')).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[keyA].refreshPending).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[keyB].refreshPending).toBe(false);

    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-b', sessionId: 'other', requestId: 'request-b', results: [],
      hasMore: false, nextBeforeSeq: null,
    })).toBe(true);
    expect(store._sent).toHaveLength(0);

    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a', sessionId: 'same', requestId: 'request-a', results: [],
      hasMore: false, nextBeforeSeq: null,
    })).toBe(true);
    expect(store._sent).toHaveLength(1);
    expect(store._sent[0]).toMatchObject({ agentId: 'agent-a', sessionId: 'same' });
  });



  it('keeps the promoted recent page bounded and exposes the displaced older cursor', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: Array.from({ length: 50 }, (_, index) => ({
        messageId: `m${index + 1}`, seq: index + 1, role: 'user', snippet: `row ${index + 1}`,
      })),
      hasMore: false, nextBeforeSeq: null, totalCount: 50, error: null,
    };

    expect(store.promoteYeaftHistoryOutlineRow({
      id: 'm51', messageId: 'm51', type: 'assistant', content: 'new response',
      sessionId: 'same', turnId: 'response-51', speakerVpId: 'maker',
    }, 'agent-a')).toBe(true);

    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      hasMore: true, nextBeforeSeq: 2, totalCount: 51,
    });
    expect(store.yeaftHistoryOutlineBySession[key].results).toHaveLength(50);
    expect(store.yeaftHistoryOutlineBySession[key].results[0].messageId).toBe('m2');
    expect(store.yeaftHistoryOutlineBySession[key].results.at(-1).messageId).toBe('m51');
  });



  it('merges one in-flight response and advances another client to a retried Action generation', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = [
      { id: 'live-a', messageId: 'live-a', type: 'assistant', content: 'working ', sessionId: 'same', turnId: 'response-live', speakerVpId: 'maker', isStreaming: true },
      { id: 'live-b', messageId: 'live-b', type: 'assistant', content: 'done', sessionId: 'same', turnId: 'response-live', speakerVpId: 'maker', isStreaming: true },
    ];
    store.yeaftHistoryOutlineBySession[yeaftHistoryIdentityKey('agent-a', 'same')] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };

    const state = store.getYeaftHistoryOutlineState();
    expect(state.results).toHaveLength(1);
    expect(state.results[0]).toMatchObject({ role: 'assistant', turnId: 'response-live' });
    expect(state.totalCount).toBe(1);

    store.workCenterAgentId = 'agent-action-conversation';
    store.workCenterItemsByAgent['agent-action-conversation'] = [{ id: 'wi-action' }];
    store.workCenterDetailByAgent['agent-action-conversation'] = {
      id: 'wi-action', revision: 4, status: 'waiting',
      actions: [{ id: 'action-conversation', generation: 2, status: 'waiting' }],
    };
    const listWorkItems = vi.spyOn(store, 'listWorkItems').mockResolvedValue([]);
    const continuedDetail = {
      id: 'wi-action', revision: 4, status: 'ready',
      actions: [{ id: 'action-conversation', generation: 3, status: 'ready' }],
    };
    store.workCenterRequest = vi.fn().mockResolvedValue(continuedDetail);
    const actionConversation = await store.sendWorkItemActionInput(
      'wi-action', 'Explain the blocker, then continue.', 'action-conversation', 4, 2,
      [], 'agent-action-conversation',
    );
    expect(store.workCenterRequest).toHaveBeenCalledWith('action_input', {
      id: 'wi-action', text: 'Explain the blocker, then continue.',
      actionId: 'action-conversation', revision: 4, generation: 2, attachments: [],
    }, 'agent-action-conversation');
    expect(listWorkItems).toHaveBeenCalledWith('agent-action-conversation', {});
    expect(actionConversation).toEqual(continuedDetail);
    listWorkItems.mockRestore();

    const sameTime = 100;
    const mergedActionMessages = mergeActionMessages(
      [{ id: 'event:10', role: 'user', text: 'legacy ten', createdAt: sameTime, updatedAt: 1 }],
      [
        { id: 'event:2', role: 'user', text: 'page two', createdAt: sameTime },
        { id: 'event:10', role: 'user', text: 'fresh ten', createdAt: sameTime, updatedAt: 2 },
      ],
      [
        { id: 'run:z', role: 'assistant', text: 'inline z', createdAt: sameTime, generation: 2, attempt: 2 },
        { id: 'event:9', role: 'user', text: 'inline nine', createdAt: sameTime },
      ],
      { id: 'run:a', role: 'assistant', text: 'live a', createdAt: sameTime, generation: 2, attempt: 3 },
    );
    expect(mergedActionMessages.map(message => message.id)).toEqual([
      'event:2', 'event:9', 'event:10', 'run:z', 'run:a',
    ]);
    expect(mergedActionMessages.find(message => message.id === 'event:10')?.text).toBe('fresh ten');

    const retryDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-generation-retry-'));
    let retryNow = 10;
    const retryStore = new WorkItemStore(join(retryDir, 'work-center.db'), { now: () => retryNow });
    const retryController = new WorkflowController(retryStore);
    const retryService = new WorkCenterService({
      yeaftDir: retryDir,
      store: retryStore,
      controller: retryController,
      runner: null,
      ownerBootId: 'generation-retry',
      settingsReader: () => ({}),
    });
    let retryDetail;
    let retriedDetail;
    let failedEvent;
    let eventSummary;
    let canonicalActiveItem;
    let failedAction;
    try {
      const retryItem = retryController.create({
        id: 'wi-1',
        title: 'Advance a retried graph Action generation',
        goal: 'Use generation before attempt when ordering Action progress',
        acceptanceCriteria: [],
        workflowTemplate: 'ai-planned',
        workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
        workDir: '/tmp',
        start: true,
      });
      const triageClaim = retryStore.claimReadyAction('generation-retry', 5_000);
      retryNow = 15;
      retryController.submit(
        triageClaim.run.id,
        'generation-retry',
        triageClaim.run.leaseEpoch,
        {
          outcome: 'completed',
          response: 'Graph created',
          summary: 'Triage complete',
          evidence: ['triage-evidence'],
          acceptanceChecks: [],
          plan: {
            workItemType: 'generation-retry',
            actions: [
              {
                id: 'action-1',
                type: 'research',
                objective: 'Inspect the generation-first progress fence',
                approach: 'Verify the projected retry identity before changing Web state',
                expectedOutcome: 'The retried Action identity is proven from canonical data',
                dependsOnActionIds: [],
                workspaceMode: 'read',
              },
              {
                id: 'deliver-fence',
                type: 'deliver',
                objective: 'Deliver the generation-first progress fence',
                approach: 'Apply the verified identity ordering to the browser projection',
                expectedOutcome: 'The browser advances to the retried Action generation',
                dependsOnActionIds: ['action-1'],
                workspaceMode: 'shared',
              },
            ],
          },
        },
      );
      const retryClaim = retryStore.claimReadyAction('generation-retry', 5_000);
      retryNow = 20;
      retryDetail = retryController.submit(
        retryClaim.run.id,
        'generation-retry',
        retryClaim.run.leaseEpoch,
        {
          outcome: 'failed',
          response: 'Old failure response',
          summary: 'Old failure summary',
          evidence: [],
          error: 'Old failure',
        },
      );
      failedAction = retryDetail.actions.find(action => action.id === retryClaim.action.id);
      expect(failedAction).toMatchObject({ generation: 1, attempt: 1, status: 'failed' });
      failedEvent = projectWorkCenterEvent({
        type: 'run.finished',
        actionId: failedAction.id,
        runId: retryClaim.run.id,
        workItem: retryDetail,
      });
      const retried = retryController.retry(retryItem.id, {
        expected: {
          actionId: failedAction.id,
          generation: failedAction.generation,
          revision: retryDetail.revision,
          statuses: ['failed'],
        },
      });
      eventSummary = projectWorkCenterEvent({
        type: 'action.retried',
        workItem: retried,
      }).workItem;
      expect(eventSummary.actionStats.find(action => action.id === failedAction.id)).toMatchObject({
        generation: 2, attempt: 0, status: 'ready', progressRevision: 0,
      });
      canonicalActiveItem = (await retryService.handle('list', { lane: 'active', limit: 100 }))
        .items.find(item => item.id === retryItem.id);
      expect(canonicalActiveItem).toMatchObject({ boardLane: 'active' });
      expect(failedEvent.workItem).toMatchObject({
        boardLane: 'needs_attention',
        updatedAt: canonicalActiveItem.updatedAt,
      });
      retryDetail = retryService.projectBrowserDetail(retryDetail);
      retriedDetail = retryService.projectBrowserDetail(retried);
    } finally {
      retryStore.close();
      rmSync(retryDir, { recursive: true, force: true });
    }

    const activeFilters = {
      lane: 'active', keyword: '', vpId: '', workItemType: '',
      createdFrom: null, createdTo: null, updatedFrom: null, updatedTo: null, limit: 100,
    };
    const activeQueryKey = JSON.stringify(activeFilters);
    for (const agentId of ['agent-lane-event', 'agent-lane-refresh', 'agent-lane-more']) {
      store._workCenterListFiltersByAgent[agentId] = activeFilters;
      store._workCenterListQueryByAgent[agentId] = activeQueryKey;
      store._workCenterListGenerationByAgent[agentId] = 1;
      store.workCenterItemsByAgent[agentId] = [canonicalActiveItem];
    }
    store.applyWorkCenterEvent('agent-lane-event', failedEvent);
    expect(store.workCenterItemsByAgent['agent-lane-event']).toEqual([canonicalActiveItem]);
    expect(store._workCenterListEventsByAgent['agent-lane-event'][canonicalActiveItem.id].summary)
      .toEqual(canonicalActiveItem);
    const attentionAgent = 'agent-lane-tombstone';
    const attentionFilters = { ...activeFilters, lane: 'needs_attention' };
    store._workCenterListFiltersByAgent[attentionAgent] = attentionFilters;
    store._workCenterListQueryByAgent[attentionAgent] = JSON.stringify(attentionFilters);
    store._workCenterListGenerationByAgent[attentionAgent] = 1;
    store.workCenterItemsByAgent[attentionAgent] = [failedEvent.workItem];
    store.applyWorkCenterEvent(attentionAgent, { type: 'action.retried', workItem: eventSummary });
    expect(store.workCenterItemsByAgent[attentionAgent]).toEqual([]);
    store.applyWorkCenterEvent(attentionAgent, failedEvent);
    expect(store.workCenterItemsByAgent[attentionAgent]).toEqual([]);
    expect(store._workCenterListEventsByAgent[attentionAgent][canonicalActiveItem.id].summary)
      .toEqual(eventSummary);

    const laneRequests = [];
    store.workCenterRequest = vi.fn((operation, payload, agentId) => new Promise(resolve => {
      laneRequests.push({ operation, payload, agentId, resolve });
    }));
    store.workCenterAgentId = 'agent-lane-refresh';
    const laneRefresh = store.listWorkItems('agent-lane-refresh', activeFilters);
    store.applyWorkCenterEvent('agent-lane-refresh', failedEvent);
    laneRequests.find(request => request.agentId === 'agent-lane-refresh').resolve({
      items: [canonicalActiveItem], nextCursor: null,
    });
    await laneRefresh;
    expect(store.workCenterItemsByAgent['agent-lane-refresh']).toEqual([canonicalActiveItem]);

    store.workCenterAgentId = 'agent-lane-more';
    store.workCenterListPageByAgent['agent-lane-more'] = {
      nextCursor: 'next-page', queryKey: activeQueryKey,
    };
    const laneMore = store.loadMoreWorkItems('agent-lane-more');
    store.applyWorkCenterEvent('agent-lane-more', failedEvent);
    laneRequests.find(request => request.agentId === 'agent-lane-more').resolve({
      items: [], nextCursor: null,
    });
    await laneMore;
    expect(store.workCenterItemsByAgent['agent-lane-more']).toEqual([canonicalActiveItem]);

    store.workCenterAgentId = 'agent-a';
    store.workCenterItemsByAgent = { ...store.workCenterItemsByAgent, 'agent-a': [] };
    store.workCenterDetailByAgent = { 'agent-a': retryDetail };
    store.workCenterActionMessages = {
      [`agent-a:wi-1:${failedAction.id}:1`]: {
        generation: 1, messages: [{ id: 'old-cache', text: 'Old failure' }], nextCursor: null, total: 1,
      },
    };
    const pendingRequests = [];
    store.workCenterRequest = vi.fn((operation, payload, agentId) => new Promise(resolve => {
      const entry = {
        operation,
        payload,
        agentId,
        resolved: false,
        resolve(value) {
          entry.resolved = true;
          resolve(value);
        },
      };
      pendingRequests.push(entry);
    }));

    expect(workItemDetailRefreshIdentity(retryDetail, eventSummary)).toEqual({
      actionId: failedAction.id,
      generation: 2,
      attempt: 0,
    });
    expect(mergeWorkItemSummary(retryDetail, eventSummary).actions
      .find(action => action.id === failedAction.id)).toMatchObject({
      generation: 2, attempt: 0, status: 'ready', progressRevision: 0,
    });
    store.applyWorkCenterEvent('agent-a', { type: 'action.retried', workItem: eventSummary });

    const advanced = store.workCenterDetailByAgent['agent-a'].actions
      .find(action => action.id === failedAction.id);
    expect(advanced).toMatchObject({ id: failedAction.id, generation: 2, attempt: 0, status: 'ready' });
    expect(advanced).not.toHaveProperty('messages');
    expect(advanced).not.toHaveProperty('thread');
    expect(advanced).not.toHaveProperty('liveMessage');
    expect(advanced.response).toBe('');
    const oldKey = workCenterActionMessageKey('agent-a', 'wi-1', failedAction.id, 1);
    const retryKey = workCenterActionMessageKey(
      'agent-a', 'wi-1', failedAction.id, advanced.generation,
    );
    expect(retryKey).toBe(`agent-a:wi-1:${failedAction.id}:2`);
    expect(store.workCenterActionMessages[oldKey].messages)
      .toEqual([expect.objectContaining({ id: 'old-cache' })]);
    expect(store.workCenterActionMessages[retryKey]).toBeUndefined();
    expect(store._workCenterActionMessageGenerationByKey[retryKey]).toBe(1);
    expect(store._workCenterDetailEventRefreshByAgent['agent-a']).toMatchObject({
      key: `wi-1:${failedAction.id}:2:0`,
    });

    const staleMessagePage = store.loadWorkItemActionMessages(
      'wi-1', failedAction.id, advanced.generation, null, 'agent-a',
    );
    pendingRequests.find(request => request.operation === 'get_action_messages').resolve({
      actionId: failedAction.id, generation: 1,
      messages: [{ id: 'late-old', text: 'Late old failure' }], nextCursor: null, total: 1,
    });
    await staleMessagePage;
    expect(store.workCenterActionMessages[retryKey]).toBeUndefined();

    const oldRequestScope = workCenterActionRequestScopeKey(
      'agent-a', 'wi-1', failedAction.id, 1,
    );
    const retryRequestScope = workCenterActionRequestScopeKey(
      'agent-a', 'wi-1', failedAction.id, advanced.generation,
    );
    store.workCenterActionRequests = {
      [oldRequestScope]: [{ id: 'request-old-generation', runId: 'run-old', generation: 1 }],
    };
    const inFlightOldGenerationList = store.loadWorkItemActionRequests(
      'wi-1', failedAction.id, 1, 'agent-a',
    );
    const staleRequestList = store.loadWorkItemActionRequests(
      'wi-1', failedAction.id, advanced.generation, 'agent-a',
    );
    const freshRequestList = store.loadWorkItemActionRequests(
      'wi-1', failedAction.id, advanced.generation, 'agent-a',
    );
    const oldGenerationRequest = pendingRequests.find(request => (
      request.operation === 'get_action_requests' && request.payload.generation === 1
    ));
    const requestLists = pendingRequests.filter(request => (
      request.operation === 'get_action_requests' && request.payload.generation === 2
    ));
    expect(requestLists.map(request => request.payload.generation)).toEqual([2, 2]);
    requestLists[1].resolve({
      actionId: failedAction.id,
      generation: 2,
      requests: [{ id: 'request-current', runId: 'run-current', generation: 2, attempt: 2 }],
    });
    await freshRequestList;
    requestLists[0].resolve({
      actionId: failedAction.id,
      generation: 2,
      requests: [{ id: 'request-late', runId: 'run-late', generation: 2, attempt: 1 }],
    });
    await staleRequestList;
    oldGenerationRequest.resolve({
      actionId: failedAction.id,
      generation: 1,
      requests: [{ id: 'request-old-late', runId: 'run-old-late', generation: 1 }],
    });
    await inFlightOldGenerationList;
    expect(store.workCenterActionRequests[oldRequestScope]).toEqual([
      expect.objectContaining({ id: 'request-old-late' }),
    ]);
    expect(store.workCenterActionRequests[retryRequestScope]).toEqual([
      expect.objectContaining({ id: 'request-current', attempt: 2 }),
    ]);

    const staleRequestDetail = store.loadWorkItemActionRequest(
      'wi-1', failedAction.id, advanced.generation, 'run-current', 'request-current', 'agent-a',
    );
    const freshRequestDetail = store.loadWorkItemActionRequest(
      'wi-1', failedAction.id, advanced.generation, 'run-current', 'request-current', 'agent-a',
    );
    const requestDetails = pendingRequests.filter(request => request.operation === 'get_action_request');
    expect(requestDetails.map(request => request.payload.generation)).toEqual([2, 2]);
    requestDetails[1].resolve({ generation: 2, request: { id: 'request-current', marker: 'fresh' } });
    await freshRequestDetail;
    requestDetails[0].resolve({ generation: 2, request: { id: 'request-current', marker: 'late' } });
    await staleRequestDetail;
    expect(store.workCenterActionRequestDetails[`${retryRequestScope}:run-current:request-current`])
      .toMatchObject({ marker: 'fresh' });

    pendingRequests.find(request => request.operation === 'get').resolve(retriedDetail);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.workCenterDetailByAgent['agent-a'].actions
      .find(action => action.id === failedAction.id)).toMatchObject({
      id: failedAction.id,
      generation: 2,
      status: 'ready',
      messages: [expect.objectContaining({
        generation: 1,
        attempt: 1,
        status: 'failed',
        text: 'Old failure response',
      })],
    });

    const acceptedRetry = store.workCenterDetailByAgent['agent-a'];
    const acceptedRetryAction = acceptedRetry.actions.find(action => action.id === failedAction.id);
    const requestCountAfterRetry = pendingRequests.length;
    store.applyWorkCenterEvent('agent-a', {
      type: 'action.retried',
      workItem: {
        ...eventSummary,
        actionStats: eventSummary.actionStats.map(action => (
          action.id === failedAction.id
            ? { ...action, generation: 1, attempt: 99, progressRevision: 99, status: 'failed' }
            : action
        )),
      },
    });
    expect(store.workCenterDetailByAgent['agent-a'].actions
      .find(action => action.id === failedAction.id)).toEqual(acceptedRetryAction);
    expect(pendingRequests).toHaveLength(requestCountAfterRetry);
    expect(store.workCenterDetailByAgent['agent-a']).toMatchObject({
      status: acceptedRetry.status,
      currentActionId: acceptedRetry.currentActionId,
    });
    store.applyWorkCenterEvent('agent-a', {
      type: 'run.progress',
      workItem: {
        ...eventSummary,
        actionStats: eventSummary.actionStats.map(action => (
          action.id === failedAction.id
            ? { ...action, attempt: 1, progressRevision: 10, status: 'running' }
            : action
        )),
      },
    });
    const sameGenerationNewAttempt = store.workCenterDetailByAgent['agent-a'].actions
      .find(action => action.id === failedAction.id);
    const requestCountAfterNewAttempt = pendingRequests.length;
    expect(sameGenerationNewAttempt).toMatchObject({
      generation: 2, attempt: 1, progressRevision: 10, status: 'running',
    });
    store.applyWorkCenterEvent('agent-a', {
      type: 'run.progress',
      workItem: {
        ...eventSummary,
        actionStats: eventSummary.actionStats.map(action => (
          action.id === failedAction.id
            ? { ...action, attempt: 0, progressRevision: 999, status: 'failed' }
            : action
        )),
      },
    });
    expect(store.workCenterDetailByAgent['agent-a'].actions
      .find(action => action.id === failedAction.id)).toEqual(sameGenerationNewAttempt);
    expect(pendingRequests).toHaveLength(requestCountAfterNewAttempt);

    const currentKey = workCenterActionMessageKey('agent-a', 'wi-1', 'action-1', 2);
    store.workCenterDetailByAgent = {
      ...store.workCenterDetailByAgent,
      'agent-a': {
        id: 'wi-1', revision: 6, coordinatorRevision: 0, updatedAt: 30,
        status: 'running', currentActionId: 'action-1',
        actions: [{
          id: 'action-1', generation: 2, status: 'running', progressRevision: 4,
          messages: [{ id: 'event:input', role: 'user', status: 'sent', text: 'input' }],
          liveMessage: {
            id: 'run:terminal', runId: 'terminal', role: 'assistant', status: 'running',
            text: 'partial response', generation: 2, attempt: 1, createdAt: 40,
          },
        }],
      },
    };
    store.workCenterActionMessages[currentKey] = {
      generation: 2,
      messages: [{ id: 'event:cached', role: 'user', text: 'cached input', createdAt: 10 }],
      nextCursor: '1',
      total: 2,
    };
    let resolveStalePage;
    const stalePage = store.loadWorkItemActionMessages(
      'wi-1', 'action-1', 2, '1', 'agent-a',
    );
    const stalePageRequest = pendingRequests.find(request => (
      request.operation === 'get_action_messages' && !request.resolved
    ));
    resolveStalePage = stalePageRequest.resolve;
    const terminalSummary = {
      id: 'wi-1', revision: 7, coordinatorRevision: 0, updatedAt: 40,
      status: 'done', currentActionId: null, currentAction: null,
      actionStats: [{
        id: 'action-1', generation: 2, status: 'completed', progressRevision: 5,
        response: 'FINAL REPLY',
        liveMessage: {
          id: 'run:terminal', runId: 'terminal', role: 'assistant', status: 'completed',
          text: 'FINAL REPLY', generation: 2, attempt: 1, createdAt: 50, updatedAt: 50,
        },
      }],
    };
    expect(workItemDetailRefreshIdentity(
      store.workCenterDetailByAgent['agent-a'], terminalSummary,
    )).toEqual({ actionId: 'action-1', generation: 2 });
    store.applyWorkCenterEvent('agent-a', { type: 'run.finished', workItem: terminalSummary });
    expect(store.workCenterActionMessages[currentKey]).toBeUndefined();
    expect(store._workCenterActionMessageGenerationByKey[currentKey]).toBe(1);
    expect(store._workCenterDetailEventRefreshByAgent['agent-a']).toMatchObject({
      key: 'wi-1:action-1:2',
    });
    expect(store.workCenterDetailByAgent['agent-a'].actions[0].liveMessage).toMatchObject({
      status: 'completed', text: 'FINAL REPLY',
    });
    expect(pendingRequests.filter(request => (
      request !== stalePageRequest
        && ['get', 'get_action_messages'].includes(request.operation)
        && !request.resolved
    )).map(request => request.operation).sort()).toEqual(['get', 'get_action_messages']);

    const terminalRefresh = pendingRequests.find(request => request.operation === 'get' && !request.resolved);
    const terminalMessages = pendingRequests.find(request => (
      request.operation === 'get_action_messages' && !request.resolved && request !== stalePageRequest
    ));
    terminalRefresh.resolve({
      ...terminalSummary,
      actions: [{
        id: 'action-1', generation: 2, status: 'completed', progressRevision: 5,
        messages: [{
          id: 'run:terminal', runId: 'terminal', role: 'assistant', status: 'completed',
          text: 'FINAL REPLY', generation: 2, attempt: 1, createdAt: 50,
        }],
      }],
    });
    terminalMessages.resolve({
      actionId: 'action-1', generation: 2,
      messages: [{
        id: 'run:terminal', runId: 'terminal', role: 'assistant', status: 'completed',
        text: 'FINAL REPLY', generation: 2, attempt: 1, createdAt: 50,
      }],
      nextCursor: null,
      total: 2,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.workCenterDetailByAgent['agent-a']).toMatchObject({
      status: 'done', currentActionId: null,
      actions: [expect.objectContaining({
        id: 'action-1', status: 'completed', messages: [expect.objectContaining({ text: 'FINAL REPLY' })],
      })],
    });
    expect(store.workCenterActionMessages[currentKey]).toMatchObject({
      nextCursor: null,
      messages: [expect.objectContaining({ text: 'FINAL REPLY' })],
    });
    resolveStalePage({
      actionId: 'action-1', generation: 2,
      messages: [{ id: 'event:stale', role: 'user', text: 'stale older input' }],
      nextCursor: null,
      total: 2,
    });
    await stalePage;
    expect(JSON.stringify(store.workCenterActionMessages[currentKey])).not.toContain('stale older input');

    const overlapDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-overlap-event-'));
    let overlapNow = 2_000;
    const overlapStore = new WorkItemStore(join(overlapDir, 'work-center.db'), { now: () => overlapNow });
    const overlapController = new WorkflowController(overlapStore);
    const overlapService = new WorkCenterService({
      yeaftDir: overlapDir,
      store: overlapStore,
      controller: overlapController,
      runner: null,
      ownerBootId: 'overlap-event',
      settingsReader: () => ({}),
    });
    const originalOverlapRequest = store.workCenterRequest;
    try {
      const overlapItem = overlapController.create({
        id: 'overlap-event',
        title: 'Keep overlapping terminal refreshes ordered',
        goal: 'Show the newest attempt without accepting stale refreshes',
        acceptanceCriteria: [],
        workflowTemplate: 'software-change',
        workDir: '/tmp',
        start: true,
      });
      const firstClaim = overlapStore.claimReadyAction('overlap-event', 5_000);
      expect(firstClaim.action.type).toBe('triage');
      overlapNow += 10;
      const firstRunning = overlapStore.updateRunProgress(
        firstClaim.run.id,
        'overlap-event',
        firstClaim.run.leaseEpoch,
        { response: 'ATTEMPT ONE PARTIAL', loopCount: 1 },
      );
      const overlapAgent = 'agent-overlap';
      store.workCenterDetailByAgent[overlapAgent] = overlapService.projectBrowserDetail(firstRunning);
      store.workCenterItemsByAgent[overlapAgent] = [];
      store.workCenterAgentId = overlapAgent;
      const overlapKey = workCenterActionMessageKey(
        overlapAgent,
        overlapItem.id,
        firstClaim.action.id,
        firstClaim.action.generation,
      );
      store.workCenterActionMessages[overlapKey] = {
        generation: firstClaim.action.generation,
        messages: [{ id: 'run:partial-one', role: 'assistant', text: 'ATTEMPT ONE PARTIAL' }],
        nextCursor: '1',
        total: 1,
      };

      overlapNow += 10;
      const firstTerminal = overlapController.submit(
        firstClaim.run.id,
        'overlap-event',
        firstClaim.run.leaseEpoch,
        {
          outcome: 'retryable',
          response: 'ATTEMPT ONE TERMINAL',
          summary: 'attempt one will retry',
          evidence: [],
          error: 'retry attempt one',
        },
      );
      const overlapRequests = [];
      store.workCenterRequest = vi.fn((operation, payload) => {
        const value = operation === 'get'
          ? overlapService.projectBrowserDetail(overlapStore.getWorkItemDetail(payload.id))
          : operation === 'get_action_messages'
            ? projectActionMessagePage(
                overlapStore.getAction(payload.actionId),
                overlapStore.getWorkItemDetail(payload.id).runs,
                overlapStore.listActionEvents(payload.actionId),
                payload,
              )
            : null;
        if (!value) throw new Error(`Unexpected overlap event operation: ${operation}`);
        let resolveRequest;
        let rejectRequest;
        const request = new Promise((resolve, reject) => {
          resolveRequest = resolve;
          rejectRequest = reject;
        });
        overlapRequests.push({
          operation,
          payload,
          getValue: () => operation === 'get'
            ? overlapService.projectBrowserDetail(overlapStore.getWorkItemDetail(payload.id))
            : projectActionMessagePage(
                overlapStore.getAction(payload.actionId),
                overlapStore.getWorkItemDetail(payload.id).runs,
                overlapStore.listActionEvents(payload.actionId),
                payload,
              ),
          value,
          resolve: resolveRequest,
          reject: rejectRequest,
        });
        return request;
      });

      const firstTerminalRefresh = store.refreshWorkItemDetailAfterActionChange;
      let firstTerminalRefreshPromise = null;
      store.refreshWorkItemDetailAfterActionChange = function (...args) {
        firstTerminalRefreshPromise = firstTerminalRefresh.apply(this, args);
        return firstTerminalRefreshPromise;
      };
      const firstTerminalEvent = projectWorkCenterEvent({
        type: 'run.finished',
        actionId: firstClaim.action.id,
        runId: firstClaim.run.id,
        workItem: firstTerminal,
      });
      store.applyWorkCenterEvent(overlapAgent, firstTerminalEvent);
      store.refreshWorkItemDetailAfterActionChange = firstTerminalRefresh;
      expect(store._workCenterActionMessageGenerationByKey[overlapKey]).toBe(1);
      const firstRefreshGeneration = store._workCenterDetailEventRefreshByAgent[overlapAgent]?.generation;
      expect(firstRefreshGeneration).toBeGreaterThan(0);
      expect(overlapRequests.map(request => request.operation).sort())
        .toEqual(['get', 'get_action_messages']);
      const staleOverlapPage = store.loadWorkItemActionMessages(
        overlapItem.id,
        firstClaim.action.id,
        firstClaim.action.generation,
        '1',
        overlapAgent,
      ).catch(() => null);

      const secondClaim = overlapStore.claimReadyAction('overlap-event', 5_000);
      expect(secondClaim.action.id).toBe(firstClaim.action.id);
      expect(secondClaim.run.actionAttempt).toBe(2);
      store.applyWorkCenterEvent(overlapAgent, projectWorkCenterEvent({
        type: 'run.started',
        actionId: secondClaim.action.id,
        runId: secondClaim.run.id,
        workItem: overlapStore.getWorkItemDetail(overlapItem.id),
      }));
      const secondRunning = overlapStore.updateRunProgress(
        secondClaim.run.id,
        'overlap-event',
        secondClaim.run.leaseEpoch,
        { response: 'ATTEMPT TWO PARTIAL', loopCount: 1 },
      );
      store.applyWorkCenterEvent(overlapAgent, projectWorkCenterEvent({
        type: 'run.progress',
        actionId: secondClaim.action.id,
        runId: secondClaim.run.id,
        workItem: secondRunning,
      }));
      expect(store.workCenterDetailByAgent[overlapAgent].actions
        .find(action => action.id === firstClaim.action.id)?.liveMessage).toMatchObject({
        attempt: 2,
        status: 'running',
        text: 'ATTEMPT TWO PARTIAL',
      });
      const canonicalRunningListItem = (await overlapService.handle('list', { limit: 100 }))
        .items.find(item => item.id === overlapItem.id);
      expect(canonicalRunningListItem.actionStats
        .find(action => action.id === firstClaim.action.id)).toMatchObject({
        generation: firstClaim.action.generation,
        attempt: 2,
        progressRevision: 5,
        status: 'running',
      });
      expect(applyWorkItemSummary([canonicalRunningListItem], firstTerminalEvent.workItem)[0])
        .toEqual(canonicalRunningListItem);
      store.workCenterItemsByAgent[overlapAgent] = [canonicalRunningListItem];
      const detailBeforeLateAttempt = store.workCenterDetailByAgent[overlapAgent];
      const requestCountBeforeLateAttempt = overlapRequests.length;
      store.applyWorkCenterEvent(overlapAgent, firstTerminalEvent);
      expect(store.workCenterItemsByAgent[overlapAgent][0]).toEqual(canonicalRunningListItem);
      expect(store.workCenterDetailByAgent[overlapAgent]).toEqual(detailBeforeLateAttempt);
      expect(overlapRequests).toHaveLength(requestCountBeforeLateAttempt);

      overlapNow += 10;
      const secondTerminal = overlapController.submit(
        secondClaim.run.id,
        'overlap-event',
        secondClaim.run.leaseEpoch,
        {
          outcome: 'completed',
          response: 'ATTEMPT TWO FINAL',
          summary: 'attempt two completed',
          evidence: ['attempt-two-evidence'],
          acceptanceChecks: [],
        },
      );
      const secondTerminalEvent = projectWorkCenterEvent({
        type: 'run.finished',
        actionId: secondClaim.action.id,
        runId: secondClaim.run.id,
        workItem: secondTerminal,
      });
      expect(secondTerminalEvent).toMatchObject({
        actionId: secondClaim.action.id,
        runId: secondClaim.run.id,
      });
      const secondTerminalRefresh = store.refreshWorkItemDetailAfterActionChange;
      let secondTerminalRefreshPromise = null;
      store.refreshWorkItemDetailAfterActionChange = function (...args) {
        secondTerminalRefreshPromise = secondTerminalRefresh.apply(this, args);
        return secondTerminalRefreshPromise;
      };
      store.applyWorkCenterEvent(overlapAgent, secondTerminalEvent);
      store.refreshWorkItemDetailAfterActionChange = secondTerminalRefresh;

      const immediateOverlapAction = store.workCenterDetailByAgent[overlapAgent].actions
        .find(action => action.id === firstClaim.action.id);
      expect(immediateOverlapAction.liveMessage).toMatchObject({
        attempt: 2,
        status: 'completed',
        text: 'ATTEMPT TWO FINAL',
      });
      expect(store._workCenterActionMessageGenerationByKey[overlapKey]).toBe(2);
      expect(store._workCenterDetailEventRefreshByAgent[overlapAgent]).toMatchObject({
        key: `${overlapItem.id}:${firstClaim.action.id}:${firstClaim.action.generation}:2`,
        generation: firstRefreshGeneration + 1,
      });
      const overlapMessageRequests = overlapRequests
        .filter(request => request.operation === 'get_action_messages');
      const overlapDetailRequests = overlapRequests.filter(request => request.operation === 'get');
      expect(overlapMessageRequests).toHaveLength(3);
      expect(overlapDetailRequests).toHaveLength(2);

      overlapMessageRequests.at(-1).resolve(overlapMessageRequests.at(-1).getValue());
      overlapDetailRequests.at(-1).resolve(overlapDetailRequests.at(-1).getValue());
      await secondTerminalRefreshPromise;
      await vi.waitFor(() => {
        expect(store.workCenterActionMessages[overlapKey]?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ text: 'ATTEMPT ONE TERMINAL' }),
          expect.objectContaining({ text: 'ATTEMPT TWO FINAL' }),
        ]));
      });

      const canonicalOverlapMessages = store.workCenterActionMessages[overlapKey]?.messages || [];
      expect(canonicalOverlapMessages.map(message => message.text)).toEqual([
        'ATTEMPT ONE TERMINAL',
        'ATTEMPT TWO FINAL',
      ]);
      expect(JSON.stringify(canonicalOverlapMessages)).not.toContain('ATTEMPT TWO PARTIAL');
      expect(store.workCenterDetailByAgent[overlapAgent].currentActionId)
        .toBe(secondTerminal.currentActionId);

      overlapDetailRequests[0].resolve(overlapDetailRequests[0].value);
      overlapMessageRequests[0].resolve(overlapMessageRequests[0].value);
      overlapMessageRequests[1].reject(new Error('late attempt one message failure'));
      await firstTerminalRefreshPromise;
      await staleOverlapPage;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const settledOverlapMessages = store.workCenterActionMessages[overlapKey]?.messages || [];
      expect(settledOverlapMessages.map(message => message.text)).toEqual([
        'ATTEMPT ONE TERMINAL',
        'ATTEMPT TWO FINAL',
      ]);
      expect(store.workCenterActionMessagesError[overlapKey]).toBeNull();
      expect(store.workCenterActionMessagesLoading[overlapKey]).toBe(false);
      expect(store.workCenterDetailByAgent[overlapAgent]).toMatchObject({
        status: secondTerminal.status,
        currentActionId: secondTerminal.currentActionId,
        actions: expect.arrayContaining([
          expect.objectContaining({ id: firstClaim.action.id, status: 'completed' }),
        ]),
      });
    } finally {
      store.workCenterRequest = originalOverlapRequest;
      overlapStore.close();
      rmSync(overlapDir, { recursive: true, force: true });
    }

    const finalDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-final-event-'));
    let finalNow = 1_000;
    const finalStore = new WorkItemStore(join(finalDir, 'work-center.db'), { now: () => finalNow });
    const finalController = new WorkflowController(finalStore);
    const finalService = new WorkCenterService({
      yeaftDir: finalDir,
      store: finalStore,
      controller: finalController,
      runner: null,
      ownerBootId: 'final-event',
      settingsReader: () => ({}),
    });
    try {
      const finalItem = finalController.create({
        id: 'final-event',
        title: 'Deliver the final reply',
        goal: 'Keep the terminal Action conversation complete',
        acceptanceCriteria: [],
        workflowTemplate: 'software-change',
        workDir: '/tmp',
        start: true,
      });
      let finalClaim = null;
      for (const type of ['triage', 'implement', 'review']) {
        const claim = finalStore.claimReadyAction('final-event', 5_000);
        expect(claim.action.type).toBe(type);
        finalNow += 10;
        finalController.submit(claim.run.id, 'final-event', claim.run.leaseEpoch, {
          outcome: 'completed',
          response: `${type} reply`,
          summary: `${type} complete`,
          evidence: [`${type}-evidence`],
          acceptanceChecks: [],
          ...(type === 'review' ? { reviewDecision: 'approved' } : {}),
        });
        finalNow += 10;
      }
      finalClaim = finalStore.claimReadyAction('final-event', 5_000);
      expect(finalClaim.action.type).toBe('deliver');
      const runningDetail = finalStore.updateRunProgress(
        finalClaim.run.id,
        'final-event',
        finalClaim.run.leaseEpoch,
        { response: 'PARTIAL DELIVERY', loopCount: 1 },
      );
      const runningBrowserDetail = finalService.projectBrowserDetail(runningDetail);
      const finalAgent = 'agent-final';
      store.workCenterDetailByAgent[finalAgent] = runningBrowserDetail;
      store.workCenterItemsByAgent[finalAgent] = [];
      store.workCenterAgentId = finalAgent;
      const runningAction = runningBrowserDetail.actions.find(action => action.id === finalClaim.action.id);
      const finalKey = workCenterActionMessageKey(
        finalAgent,
        finalItem.id,
        finalClaim.action.id,
        finalClaim.action.generation,
      );
      store.workCenterActionMessages[finalKey] = {
        generation: finalClaim.action.generation,
        messages: [],
        nextCursor: '1',
        total: 1,
      };
      expect(runningAction.liveMessage).toMatchObject({
        status: 'running', text: 'PARTIAL DELIVERY',
      });
      finalNow += 10;
      const finishedDetail = finalController.submit(
        finalClaim.run.id,
        'final-event',
        finalClaim.run.leaseEpoch,
        {
          outcome: 'completed',
          response: 'FINAL DELIVERY REPLY',
          summary: 'deliver complete',
          evidence: ['deliver-evidence'],
          acceptanceChecks: [],
        },
      );
      const finishedEvent = projectWorkCenterEvent({
        type: 'run.finished',
        actionId: finalClaim.action.id,
        runId: finalClaim.run.id,
        workItem: finishedDetail,
      });
      expect(finishedEvent.workItem).toMatchObject({
        status: 'done', currentActionId: null,
        actionStats: [
          expect.any(Object), expect.any(Object), expect.any(Object),
          expect.objectContaining({
            id: finalClaim.action.id,
            generation: finalClaim.action.generation,
            status: 'completed',
            liveMessage: expect.objectContaining({
              status: 'completed', text: 'FINAL DELIVERY REPLY',
            }),
          }),
        ],
      });
      const finalRequests = [];
      const originalWorkCenterRequest = store.workCenterRequest;
      store.workCenterRequest = vi.fn((operation, payload) => {
        finalRequests.push({ operation, payload });
        if (operation === 'get') {
          return Promise.resolve(finalService.projectBrowserDetail(finalStore.getWorkItemDetail(finalItem.id)));
        }
        if (operation === 'get_action_messages') {
          const action = finalStore.getAction(payload.actionId);
          return Promise.resolve(projectActionMessagePage(
            action,
            finalStore.getWorkItemDetail(finalItem.id).runs,
            finalStore.listActionEvents(payload.actionId),
            payload,
          ));
        }
        throw new Error(`Unexpected final event operation: ${operation}`);
      });
      store.applyWorkCenterEvent(finalAgent, finishedEvent);
      const immediateAction = store.workCenterDetailByAgent[finalAgent].actions
        .find(action => action.id === finalClaim.action.id);
      expect(immediateAction.liveMessage).toMatchObject({
        status: 'completed', text: 'FINAL DELIVERY REPLY',
      });
      expect(immediateAction.liveMessage.text).not.toBe('PARTIAL DELIVERY');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const settledDetail = store.workCenterDetailByAgent[finalAgent];
      const settledAction = settledDetail.actions.find(action => action.id === finalClaim.action.id);
      expect(settledDetail).toMatchObject({ status: 'done', currentActionId: null });
      expect(settledAction.messages.filter(message => message.text === 'FINAL DELIVERY REPLY')).toHaveLength(1);
      expect(JSON.stringify(settledAction.messages)).not.toContain('PARTIAL DELIVERY');
      expect(store.workCenterActionMessages[finalKey]).toMatchObject({
        nextCursor: null,
        messages: [expect.objectContaining({ text: 'FINAL DELIVERY REPLY' })],
      });
      expect(finalRequests.map(request => request.operation).sort()).toEqual([
        'get', 'get_action_messages',
      ]);
      store.workCenterRequest = originalWorkCenterRequest;
    } finally {
      finalStore.close();
      rmSync(finalDir, { recursive: true, force: true });
    }

    const nextActionSummary = {
      ...terminalSummary,
      revision: 8,
      updatedAt: 55,
      status: 'ready',
      currentActionId: 'action-2',
      currentAction: { id: 'action-2', generation: 1, status: 'ready' },
      actionStats: [
        terminalSummary.actionStats[0],
        { id: 'action-2', generation: 1, status: 'ready', progressRevision: 1 },
      ],
    };
    const nextActionCurrent = {
      ...store.workCenterDetailByAgent['agent-a'],
      revision: 7,
      updatedAt: 50,
      status: 'running',
      currentActionId: 'action-1',
      actions: [
        ...store.workCenterDetailByAgent['agent-a'].actions,
        { id: 'action-2', generation: 1, status: 'ready', progressRevision: 1 },
      ],
    };
    expect(workItemDetailRefreshIdentity(nextActionCurrent, nextActionSummary))
      .toEqual({ actionId: 'action-1', generation: 2 });

    const coordinatorSummary = {
      ...eventSummary,
      revision: 8,
      planRevision: 0,
      ledgerRevision: 0,
      updatedAt: 60,
      coordinatorRevision: 3,
      currentActionId: null,
      currentAction: null,
      actionStats: [],
    };
    store.applyWorkCenterEvent('agent-a', {
      type: 'coordinator.turn_completed', workItem: coordinatorSummary,
    });
    expect(store._workCenterDetailEventRefreshByAgent['agent-a']).toMatchObject({
      key: 'wi-1:coordinator:3',
    });
    const coordinatorRefresh = pendingRequests.find(request => request.operation === 'get' && !request.resolved);
    coordinatorRefresh.resolve({
      ...coordinatorSummary,
      messages: [{ id: 'turn-1', role: 'assistant', status: 'completed', text: 'Plan updated' }],
      actions: [],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.workCenterDetailByAgent['agent-a']).toMatchObject({
      coordinatorRevision: 3,
      messages: [expect.objectContaining({ text: 'Plan updated' })],
    });
    const messageAttachments = [{ fileId: 'file-1', name: 'screen.png', mimeType: 'image/png', size: 120 }];
    const sent = store.sendWorkItemMessage('wi-1', 'Change the target', 8, messageAttachments, 'agent-a');
    const coordinatorRequest = pendingRequests.find(request => request.operation === 'work_item_message');
    expect(store.workCenterRequest).toHaveBeenLastCalledWith('work_item_message', {
      id: 'wi-1', text: 'Change the target', revision: 8,
      planRevision: 0, ledgerRevision: 0, coordinatorRevision: 3,
      attachments: messageAttachments,
    }, 'agent-a');
    coordinatorRequest.resolve({ accepted: true, turnId: 'turn-2' });
    await expect(sent).resolves.toEqual({ accepted: true, turnId: 'turn-2' });
  });
});
