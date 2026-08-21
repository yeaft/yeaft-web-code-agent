// @vitest-environment happy-dom
/**
 * turn-debug-eyes.test.js — turn-level debug entry.
 *
 * Covers:
 *   1. VpTurnBlock puts a debug-specific action first in the existing
 *      hover footer on finished AI turns and emits `open-debug`; streaming
 *      turns have no debug action.
 *   2. `handleMessage` `yeaft_debug_history` detail responses flip the
 *      turn-level debug panel to ready/error and stale requestIds cannot
 *      overwrite a newer panel selection.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mount } from '@vue/test-utils';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import * as Vue from 'vue';

const vpStore = Vue.reactive({
  vpList: [],
  vpLabel: (vpId) => vpId,
  vpTextColor: () => '',
});
const chatStore = Vue.reactive({
  currentAgent: 'agent-1',
  cancelVpTurn: vi.fn(),
  isVpTypingInCurrentConv: () => false,
  activeVpTurns: {},
});

globalThis.Vue = Vue;
globalThis.Pinia = {
  defineStore: (id) => {
    if (id === 'vp') return () => vpStore;
    if (id === 'chat') return () => chatStore;
    return () => ({});
  },
  useChatStore: () => chatStore,
  useVpStore: () => vpStore,
};
window.Pinia = globalThis.Pinia;

const { default: VpTurnBlock } = await import('../../web/components/VpTurnBlock.js');
const { default: YeaftDebugPanel } = await import('../../web/components/YeaftDebugPanel.js');
const { handleMessage } = await import('../../web/stores/helpers/messageHandler.js');

function makeTurn(overrides = {}) {
  return {
    type: 'assistant-turn',
    speakerVpId: 'omni',
    turnId: 'turn-abc',
    textContent: 'hello',
    isStreaming: false,
    ...overrides,
  };
}

beforeEach(() => {
  chatStore.currentAgent = 'agent-1';
  chatStore.activeVpTurns = {};
  chatStore.cancelVpTurn.mockClear();
  window.Pinia.useChatStore = () => chatStore;
});

describe('VpTurnBlock debug action', () => {
  it('renders the debug-specific action first in the existing hover footer', () => {
    const wrapper = mount(VpTurnBlock, {
      props: { turn: makeTurn() },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    const assistantTurn = wrapper.find('.assistant-turn');
    const footer = wrapper.find('.turn-footer');
    const actions = footer.findAll('button');
    const btn = footer.find('.debug-turn-action-btn');

    expect(assistantTurn.classes()).toContain('has-turn-debug-action');
    expect(footer.exists()).toBe(true);
    expect(btn.exists()).toBe(true);
    expect(actions[0].classes()).toContain('debug-turn-action-btn');
    expect(btn.attributes('aria-label')).toContain('debug trace');
    const icon = btn.get('.debug-turn-action-icon');
    expect(icon.exists()).toBe(true);
    expect(icon.find('path').attributes('d')).toContain('M20 8h-2.81');
    expect(icon.findAll('path')).toHaveLength(1);
    expect(wrapper.find('.vp-turn-debug-btn').exists()).toBe(false);
    expect(wrapper.find('.vp-turn-block-actions').exists()).toBe(false);
  });

  it('does not render the debug action while the turn is streaming', () => {
    const wrapper = mount(VpTurnBlock, {
      props: { turn: makeTurn({ isStreaming: true }) },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    expect(wrapper.find('.assistant-turn').classes()).not.toContain('has-turn-debug-action');
    expect(wrapper.find('.debug-turn-action-btn').exists()).toBe(false);
  });

  it('does not opt a legacy AssistantTurn into the debug action', async () => {
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: { turn: makeTurn({ speakerVpId: null }) },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { VpSpeakerHeader: true },
      },
    });
    expect(wrapper.classes()).not.toContain('has-turn-debug-action');
    expect(wrapper.find('.debug-turn-action-btn').exists()).toBe(false);
  });

  it('limits coarse-pointer visibility to the debug action class', async () => {
    const css = await readFile(resolve(process.cwd(), 'web/styles/chat-messages.css'), 'utf8');
    expect(css).toContain('@media (pointer: coarse)');
    expect(css).toContain('.assistant-turn.has-turn-debug-action .turn-footer');
    expect(css).not.toContain('@media (pointer: coarse) {\n  .assistant-turn .turn-footer');
  });

  it('emits open-debug with the turn identity on click', async () => {
    const wrapper = mount(VpTurnBlock, {
      props: { turn: makeTurn() },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    await wrapper.find('.debug-turn-action-btn').trigger('click');
    expect(wrapper.emitted('open-debug')).toHaveLength(1);
  });
});

describe('handleMessage turn-level panel status', () => {
  function makeStore(overrides = {}) {
    return Vue.reactive({
      _yeaftDebugHistoryLatestDetailRequestId: null,
      _yeaftDebugHistoryLatestListRequestId: null,
      _fetchYeaftDebugHistoryTimer: null,
      _yeaftDebugHistoryInFlightKey: null,
      yeaftDebugHistoryLoading: false,
      yeaftDebugHistoryError: null,
      yeaftDebugHistoryFetchedAt: 0,
      yeaftDebugHistoryProjection: null,
      yeaftDebugHistoryHasMore: false,
      yeaftDebugHistoryLimit: 1,
      yeaftDebugTurnsById: {},
      yeaftDebugLoops: [],
      yeaftDebugTurnOrder: [],
      yeaftDebugPanel: {
        open: true,
        status: 'loading',
        requestId: 'dbgpanel_req_1',
        agentId: 'agent-1',
        sessionId: 'session-1',
        turnId: 'turn-abc',
        error: null,
      },
      _appendDreamEvent: () => {},
      handleYeaftOutput: () => {},
      ...overrides,
    });
  }

  it('renders the fetched system prompt and loop detail after expanding the turn', async () => {
    const store = makeStore();
    store._yeaftDebugHistoryLatestDetailRequestId = 'dbgpanel_req_1';
    const loadYeaftDebugHistory = vi.fn();
    store.loadYeaftDebugHistory = loadYeaftDebugHistory;
    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'dbgpanel_req_1',
      detailTurnId: 'turn-abc',
      turns: [{
        turnId: 'turn-abc',
        sessionId: 'session-1',
        userPrompt: 'Inspect the trace',
        detailsLoaded: true,
        loopCount: 2,
        memoryLoaded: [{
          id: 'resident:sessions/session-1',
          layer: 'resident',
          scope: 'sessions/session-1',
          body: 'Persisted memory from the exact request.',
        }],
        memoryLoadedMeta: { recallLimit: 8, recallCandidates: 1 },
      }],
      loops: [{
        turnId: 'turn-abc',
        loopNumber: 1,
        model: 'provider/model-a',
        systemPrompt: 'You are the traced system prompt.',
        messages: [{ role: 'user', content: 'Inspect the trace' }],
        response: 'The loop detail is present.',
        toolCalls: [],
        usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
        latencyMs: 42,
      }, {
        turnId: 'turn-abc',
        loopNumber: 2,
        model: 'provider/model-a',
        systemPrompt: 'You are the changed system prompt for loop two.',
        messages: [
          { role: 'user', content: 'Inspect the trace' },
          { role: 'assistant', content: 'The loop detail is present.' },
          { role: 'user', content: 'Continue after the tool.' },
        ],
        response: 'The second loop detail is present.',
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
        latencyMs: 50,
      }],
      dreamEvents: [],
      projection: {
        truncated: true,
        reason: 'debug_detail_wire_budget',
        projectedBytes: 1024,
      },
    });

    window.Pinia.useChatStore = () => store;
    const wrapper = mount(YeaftDebugPanel, {
      global: { mocks: { $t: key => key } },
    });
    await Vue.nextTick();

    expect(store.yeaftDebugPanel.status).toBe('ready');
    expect(store.yeaftDebugHistoryProjection).toMatchObject({ truncated: true });
    expect(store.yeaftDebugTurnsById['turn-abc'].loops).toBeUndefined();
    expect(store.yeaftDebugTurnsById['turn-abc'].memoryLoaded).toEqual([
      expect.objectContaining({ body: 'Persisted memory from the exact request.' }),
    ]);
    expect(store.yeaftDebugLoops).toHaveLength(2);
    await wrapper.get('.yeaft-debug-turn-header').trigger('click');
    expect(wrapper.get('.yeaft-debug-turn-body').isVisible()).toBe(true);
    expect(wrapper.get('.yeaft-debug-notice').text()).toBe('yeaft.debugHistoryTruncated');
    expect(wrapper.findAll('.yeaft-debug-loop-num').map(node => node.text())).toEqual(['Loop 1', 'Loop 2']);
    expect(wrapper.findAll('.yeaft-debug-loop-model').map(node => node.text())).toEqual(['provider/model-a', 'provider/model-a']);

    const loopHeaders = wrapper.findAll('.yeaft-debug-loop-header');
    await loopHeaders[0].trigger('click');
    let loopBodies = wrapper.findAll('.yeaft-debug-loop-body');
    expect(loopBodies[0].text()).toContain('yeaft.systemPrompt');
    await loopBodies[0].find('.yeaft-debug-show-btn').trigger('click');
    expect(loopBodies[0].find('.yeaft-debug-pre').text()).toBe('You are the traced system prompt.');
    expect(loopBodies[0].text()).toContain('yeaft.debugAssistantResponse');

    await loopHeaders[1].trigger('click');
    loopBodies = wrapper.findAll('.yeaft-debug-loop-body');
    await loopBodies[1].find('.yeaft-debug-show-btn').trigger('click');
    expect(loopBodies[1].find('.yeaft-debug-pre').text()).toBe('You are the changed system prompt for loop two.');
    expect(loadYeaftDebugHistory).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('localizes the retryable timeout diagnostic instead of blaming reconnect alone', async () => {
    const store = makeStore({
      yeaftDebugHistoryError: 'debug_history_timeout',
      yeaftDebugPanel: {
        open: true,
        status: 'error',
        requestId: 'dbgpanel_req_1',
        agentId: 'agent-1',
        sessionId: 'session-1',
        turnId: 'turn-abc',
        error: 'debug_history_timeout',
      },
    });
    window.Pinia.useChatStore = () => store;
    const wrapper = mount(YeaftDebugPanel, {
      global: { mocks: { $t: key => key } },
    });
    await Vue.nextTick();

    expect(wrapper.get('.yeaft-debug-error').text()).toBe('yeaft.debugHistoryUnavailable');
    wrapper.unmount();
  });

  it('flips the panel to error when the agent returns an error', () => {
    const store = makeStore();
    store._yeaftDebugHistoryLatestDetailRequestId = 'dbgpanel_req_1';
    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'dbgpanel_req_1',
      detailTurnId: 'turn-abc',
      turns: [],
      loops: [],
      dreamEvents: [],
      error: 'trace disabled',
    });
    expect(store.yeaftDebugPanel.status).toBe('error');
    expect(store.yeaftDebugPanel.error).toBe('trace disabled');
  });

  it('ignores a stale detail response for an older panel request', () => {
    const store = makeStore();
    store._yeaftDebugHistoryLatestDetailRequestId = 'dbgpanel_req_NEW';
    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'dbgpanel_req_OLD',
      detailTurnId: 'turn-abc',
      turns: [],
      loops: [],
      dreamEvents: [],
    });
    // Guard drops the stale response before any state mutation.
    expect(store.yeaftDebugPanel.status).toBe('loading');
    expect(store.yeaftDebugHistoryFetchedAt).toBe(0);
  });
});
