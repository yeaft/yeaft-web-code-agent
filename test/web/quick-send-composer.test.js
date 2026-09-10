// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = Vue.ref({ showQuickSends: false, bindings: { quickSend1: 'Ctrl+E', quickSend5: 'Ctrl+J' } });
vi.mock('../../web/utils/user-shortcuts.js', () => ({
  useUserShortcuts: () => ({ preferences }),
  matchShortcut: (event, binding) => !!binding && event.ctrlKey && binding.toLowerCase() === `ctrl+${event.key.toLowerCase()}`,
}));
let store;
let wrapper;
const preset = { id: 'fast', name: 'Fast', model: 'p/fast', effort: 'low', maxOutputTokens: 2048 };
async function create(props = {}) {
  const { default: ChatInput } = await import('../../web/components/ChatInput.js');
  wrapper = mount(ChatInput, {
    props: { quickSendEnabled: true, sendFn: vi.fn(), ...props },
    slots: { 'actions-end-before': '<button class="model-slot">Model</button>' },
    global: { mocks: { $t: key => key }, stubs: { VpMentionAutocomplete: true } },
  });
  return wrapper;
}
beforeEach(() => {
  preferences.value = { showQuickSends: false, bindings: { quickSend1: 'Ctrl+E', quickSend5: 'Ctrl+J' } };
  store = Vue.reactive({
    activeConversationId: 'c1', currentConversation: 'c1', currentView: 'yeaft',
    currentAgent: 'a1', agents: [{ id: 'a1', online: true }, { id: 'a2', online: true }], connectionState: 'connected',
    btwMode: false, compactStatus: null, customExpertRoles: [], expertSelections: [], inputDrafts: {},
    isProcessing: false, slashCommandDescriptions: {}, yeaftActiveSessionFilter: 's1',
    llmConfig: { a1: { loaded: true, agentConfig: { quickSends: [preset] } }, a2: { loaded: true, agentConfig: { quickSends: [] } } },
    sendWsMessage: vi.fn(),
  });
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useChatStore: () => store, useSessionsStore: () => ({ activeSessionId: 's1', sessionById: () => null, sessions: {} }),
    useVpStore: () => ({ vpList: [] }), useAuthStore: () => ({}),
  };
  window.Pinia = globalThis.Pinia;
});
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); });

describe('Agent quick-send Composer', () => {
  it('defaults hidden; opt-in adds a send-mode menu beside the ordinary send button', async () => {
    await create();
    expect(wrapper.find('.composer-send-modes').exists()).toBe(false);
    expect(wrapper.find('.composer-send-mode-trigger').exists()).toBe(false);
    preferences.value.showQuickSends = true;
    await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledWith({ type: 'get_llm_config', agentId: 'a1' });
    const trigger = wrapper.get('.composer-send-mode-trigger');
    expect(trigger.attributes('disabled')).toBeDefined();
    expect(wrapper.get('.model-slot').element.compareDocumentPosition(trigger.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(trigger.element.compareDocumentPosition(wrapper.get('.send-btn:not(.composer-send-mode-trigger)').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sends one-shot settings with quote, then ordinary Enter has no override', async () => {
    preferences.value.showQuickSends = true;
    const sendFn = vi.fn();
    const quote = { author: 'User', content: 'earlier' };
    await create({ sendFn, quote });
    await wrapper.get('textarea').setValue('hello');
    await wrapper.get('.composer-send-mode-trigger').trigger('click');
    const option = wrapper.get('.composer-send-mode-option');
    expect(option.text()).toContain('Fast');
    expect(option.text()).toContain('Ctrl+E');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await Vue.nextTick();
    expect(wrapper.find('.composer-send-mode-menu').exists()).toBe(false);
    await wrapper.get('.composer-send-mode-trigger').trigger('click');
    await wrapper.get('.composer-send-mode-option').trigger('click');
    expect(sendFn).toHaveBeenLastCalledWith('hello', undefined, quote,
      { model: 'p/fast', effort: 'low', maxOutputTokens: 2048 });
    expect(wrapper.get('textarea').element.value).toBe('');
    await wrapper.get('textarea').setValue('normal');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    expect(sendFn).toHaveBeenLastCalledWith('normal', undefined, quote);
  });

  it('only sends the current Agent slot and preserves draft on rejection/offline', async () => {
    preferences.value.showQuickSends = true;
    const sendFn = vi.fn(() => false);
    await create({ sendFn });
    await wrapper.get('textarea').setValue('keep');
    await wrapper.get('textarea').trigger('keydown', { key: 'e', ctrlKey: true });
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(wrapper.get('textarea').element.value).toBe('keep');
    store.connectionState = 'reconnecting';
    await Vue.nextTick();
    await wrapper.get('textarea').trigger('keydown', { key: 'e', ctrlKey: true });
    expect(sendFn).toHaveBeenCalledTimes(1);
    store.currentAgent = 'a2';
    await Vue.nextTick();
    expect(wrapper.find('.composer-send-modes').exists()).toBe(false);
    expect(wrapper.find('.composer-send-mode-trigger').exists()).toBe(false);
    await wrapper.get('textarea').trigger('keydown', { key: 'e', ctrlKey: true });
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('does not send on IME, repeat, empty input, or an unconfigured slot', async () => {
    preferences.value.showQuickSends = true;
    const sendFn = vi.fn();
    await create({ sendFn });
    const input = wrapper.get('textarea');
    await input.trigger('keydown', { key: 'e', ctrlKey: true });
    await input.setValue('safe');
    await input.trigger('keydown', { key: 'e', ctrlKey: true, isComposing: true });
    await input.trigger('keydown', { key: 'e', ctrlKey: true, repeat: true });
    await input.trigger('keydown', { key: 'j', ctrlKey: true });
    expect(sendFn).not.toHaveBeenCalled();
    expect(input.element.value).toBe('safe');
  });
});
