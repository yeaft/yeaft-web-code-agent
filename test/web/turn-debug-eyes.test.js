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

  it('shows the response model and effort before the provider-call count', () => {
    const translate = (key, vars) => {
      if (key === 'yeaft.message.llmCalls') return `${vars.count} LLM calls`;
      if (key === 'yeaft.modelMenu.effort.high') return 'High';
      return key;
    };
    const wrapper = mount(VpTurnBlock, {
      props: {
        turn: makeTurn({
          model: 'provider/model-v2',
          effort: 'high',
          llmCallCount: 3,
        }),
      },
      global: {
        mocks: { $t: translate },
        provide: { t: translate },
      },
    });

    const footerText = wrapper.find('.turn-footer').text();
    expect(footerText).toContain('provider/model-v2 · High');
    expect(footerText).toContain('3 LLM calls');
    expect(footerText.indexOf('provider/model-v2 · High')).toBeLessThan(
      footerText.indexOf('3 LLM calls')
    );
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

    const latestSystem = wrapper.get('.yeaft-debug-latest-system-prompt');
    await latestSystem.get('.yeaft-debug-show-btn').trigger('click');
    expect(latestSystem.get('pre').text()).toBe('You are the changed system prompt for loop two.');
    expect(wrapper.text()).not.toContain('You are the traced system prompt.');

    const loopHeaders = wrapper.findAll('.yeaft-debug-loop-header');
    await loopHeaders[0].trigger('click');
    await loopHeaders[1].trigger('click');
    const loopBodies = wrapper.findAll('.yeaft-debug-loop-body');
    for (const body of loopBodies) {
      expect(body.text()).not.toContain('yeaft.systemPrompt');
      expect(body.text()).not.toContain('copy req');
      expect(body.text()).toContain('yeaft.debugAssistantResponse');
    }
    await loopBodies[1].find('.yeaft-debug-show-btn').trigger('click');
    expect(loopBodies[1].find('.yeaft-debug-pre').text()).toBe('The second loop detail is present.');
    expect(loadYeaftDebugHistory).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('shows and copies only the latest request while preserving full per-loop tool details', async () => {
    const fullResult = 'full tool result\n'.repeat(2000) + 'RESULT_TAIL';
    const latestBody = { model: 'latest-model', input: [{ role: 'user', content: 'LATEST_BODY' }] };
    const loops = [1, 2].map(loopNumber => ({
      turnId: 'turn-abc', loopNumber, model: 'provider/model-a',
      systemPrompt: loopNumber === 2 ? 'LATEST_SYSTEM' : 'OLD_SYSTEM',
      rawRequest: { method: 'POST', url: '/responses', headers: { 'x-request-id': 'not-body' }, body: loopNumber === 2 ? latestBody : { input: 'OLD_BODY' } },
      toolCalls: [{ id: `call-${loopNumber}`, name: 'Read', input: { path: `/file-${loopNumber}` } }],
      rawResponse: { status: 200 },
    }));
    const turn = {
      turnId: 'turn-abc', detailsLoaded: true, loopCount: 2,
      tools: loops.map(loop => ({ loopNumber: loop.loopNumber, callId: `call-${loop.loopNumber}`, name: 'Read', toolOutput: fullResult })),
    };
    const store = makeStore({
      yeaftDebugPanel: { open: true, status: 'ready', turnId: 'turn-abc', sessionId: 'session-1' },
      yeaftDebugTurnsById: { 'turn-abc': turn }, yeaftDebugLoops: loops,
    });
    window.Pinia.useChatStore = () => store;
    const wrapper = mount(YeaftDebugPanel, { global: { mocks: { $t: key => key } } });
    const copy = vi.spyOn(wrapper.vm, 'copyText').mockImplementation(() => {});
    await wrapper.get('.yeaft-debug-turn-header').trigger('click');
    const request = wrapper.get('.yeaft-debug-latest-request');
    const system = wrapper.get('.yeaft-debug-latest-system-prompt');
    expect(wrapper.findAll('.yeaft-debug-latest-request')).toHaveLength(1);
    expect(request.element.parentElement.classList.contains('yeaft-debug-turn-body')).toBe(true);
    await request.get('.yeaft-debug-show-btn').trigger('click');
    expect(request.get('pre').text()).toBe(JSON.stringify(latestBody, null, 2));
    await request.get('.yeaft-debug-copy-btn').trigger('click');
    expect(copy).toHaveBeenLastCalledWith(JSON.stringify(latestBody, null, 2), 'yeaft.debugLatestRequestBody');
    await system.get('.yeaft-debug-show-btn').trigger('click');
    expect(system.get('pre').text()).toBe('LATEST_SYSTEM');
    await system.get('.yeaft-debug-copy-btn').trigger('click');
    expect(copy).toHaveBeenLastCalledWith('LATEST_SYSTEM', 'yeaft.debugLatestSystemPrompt');
    for (const header of wrapper.findAll('.yeaft-debug-loop-header')) await header.trigger('click');
    for (const [index, body] of wrapper.findAll('.yeaft-debug-loop-body').entries()) {
      expect(body.text()).not.toContain('copy req');
      const buttons = body.findAll('.yeaft-debug-tool-row button');
      await buttons[2].trigger('click');
      const detail = body.findAll('.yeaft-debug-tool-detail pre');
      expect(JSON.parse(detail[0].text())).toEqual({ path: `/file-${index + 1}` });
      expect(detail[1].text()).toBe(fullResult);
      await buttons[1].trigger('click');
      expect(copy).toHaveBeenLastCalledWith(fullResult, 'tool output');
    }
    await wrapper.get('.yeaft-debug-turn-copy').trigger('click');
    const markdown = copy.mock.lastCall[0];
    expect(markdown.match(/LATEST_BODY/g)).toHaveLength(1);
    expect(markdown.match(/LATEST_SYSTEM/g)).toHaveLength(1);
    expect(markdown).not.toContain('OLD_BODY');
    expect(markdown).not.toContain('OLD_SYSTEM');
    expect(markdown).not.toContain('x-request-id');

    // Progress metadata arriving after hydration must not hide loaded data.
    store.yeaftDebugLoops.push({ turnId: 'turn-abc', loopNumber: 3 });
    await Vue.nextTick();
    expect(request.get('pre').text()).toContain('LATEST_BODY');
    expect(request.get('.yeaft-debug-section-meta').text()).toBe('Loop 2');
    expect(system.get('pre').text()).toBe('LATEST_SYSTEM');

    // Each field falls back independently and keeps its own source Loop.
    store.yeaftDebugLoops[1].rawRequest = null;
    store.yeaftDebugLoops[1].rawRequestBase = { body: 'MUST_NOT_INHERIT' };
    await Vue.nextTick();
    expect(request.get('pre').text()).toContain('OLD_BODY');
    expect(request.get('.yeaft-debug-section-meta').text()).toBe('Loop 1');
    expect(system.get('.yeaft-debug-section-meta').text()).toBe('Loop 2');
    await wrapper.get('.yeaft-debug-turn-copy').trigger('click');
    expect(copy.mock.lastCall[0]).toContain('yeaft.debugLatestRequestBody (Loop 1)');
    expect(copy.mock.lastCall[0]).toContain('yeaft.debugLatestSystemPrompt (Loop 2)');
    expect(copy.mock.lastCall[0]).not.toContain('MUST_NOT_INHERIT');
    store.yeaftDebugLoops[1].systemPrompt = '';
    await Vue.nextTick();
    expect(system.get('pre').text()).toBe('OLD_SYSTEM');
    expect(system.get('.yeaft-debug-section-meta').text()).toBe('Loop 1');

    // Only genuinely empty turns show unavailable and disable the actions.
    store.yeaftDebugLoops[0].rawRequest = null;
    store.yeaftDebugLoops[0].systemPrompt = '';
    await Vue.nextTick();
    expect(request.find('.yeaft-debug-section-meta').exists()).toBe(false);
    expect(system.find('.yeaft-debug-section-meta').exists()).toBe(false);
    expect(request.find('pre').exists()).toBe(false);
    expect(request.get('.yeaft-debug-copy-btn').attributes('disabled')).toBeDefined();
    expect(request.get('.yeaft-debug-show-btn').attributes('disabled')).toBeDefined();
    expect(request.text()).toContain('yeaft.debugRequestBodyUnavailable');
    expect(system.get('.yeaft-debug-copy-btn').attributes('disabled')).toBeDefined();
    expect(system.text()).toContain('yeaft.debugSystemPromptUnavailable');
    await wrapper.get('.yeaft-debug-turn-copy').trigger('click');
    expect(copy.mock.lastCall[0]).not.toMatch(/OLD_BODY|LATEST_BODY|OLD_SYSTEM|LATEST_SYSTEM/);
    wrapper.unmount();
  });

  it('selects the latest legacy loop without mutating order and respects explicit null', () => {
    const vm = { ...YeaftDebugPanel.methods };
    const base = { body: { input: [{ role: 'user', content: 'base' }] } };
    const latest = {
      loopNumber: 3, systemPrompt: 'latest', requestBase: { rawRequest: base },
      requestDelta: { rawRequestDelta: { body: { messagesKey: 'input', messagesFrom: 1, messagesAppend: [{ role: 'user', content: 'append' }] } } },
    };
    const turn = { loops: [latest, { loopNumber: 1, rawRequest: { body: 'old' } }] };
    expect(JSON.parse(vm.latestRequestForTurn(turn).bodyText).input).toHaveLength(2);
    expect(turn.loops[0]).toBe(latest);
    latest.rawRequest = null;
    expect(vm.latestRequestForTurn(turn)).toMatchObject({ bodyLoopNumber: 1, bodyText: 'old', systemPromptLoopNumber: 3, systemPrompt: 'latest' });
    expect(vm.latestRequestForTurn({ loops: [] })).toBeNull();
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
