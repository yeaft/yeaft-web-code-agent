// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = Vue.ref({ bindings: { quickSend1: 'Ctrl+E', quickSend5: 'Ctrl+J' } });
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
  preferences.value = { bindings: { quickSend1: 'Ctrl+E', quickSend5: 'Ctrl+J' } };
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
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Agent quick-send Composer', () => {
  it('disables input and sending while an external operation owns the composer', async () => {
    const sendFn = vi.fn();
    await create({ sendFn, disabled: true, disabledPlaceholderKey: 'yeaft.session.copying' });
    const input = wrapper.get('textarea');
    expect(input.attributes('disabled')).toBeDefined();
    expect(input.attributes('placeholder')).toBe('yeaft.session.copying');
    expect(wrapper.get('.chat-composer').classes()).toContain('is-disabled');
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
    await input.setValue('blocked');
    await input.trigger('keydown', { key: 'Enter' });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('loads configured presets automatically and projects their names into the mobile toolbar', async () => {
    await create();
    expect(store.sendWsMessage).toHaveBeenCalledWith({ type: 'get_llm_config', agentId: 'a1' });
    expect(wrapper.find('.mobile-quick-send-bar').exists()).toBe(false);
    await wrapper.get('textarea').trigger('focus');
    const bar = wrapper.get('.mobile-quick-send-bar');
    expect(bar.attributes('role')).toBe('toolbar');
    expect(bar.get('.mobile-quick-send-button').text()).toBe('Fast');
    await wrapper.get('textarea').trigger('blur');
    expect(wrapper.find('.mobile-quick-send-bar').exists()).toBe(false);
    expect(wrapper.find('.composer-send-mode-trigger').exists()).toBe(false);
    expect(wrapper.find('.composer-send-mode-menu').exists()).toBe(false);
  });

  it('exits the mobile input state after the preset send is accepted', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const sendFn = vi.fn();
    await create({ sendFn });
    const input = wrapper.get('textarea');
    const blur = vi.spyOn(input.element, 'blur');
    await input.trigger('focus');
    await input.setValue('touch send');
    await wrapper.get('.mobile-quick-send-button').trigger('pointerdown');
    await wrapper.get('.mobile-quick-send-button').trigger('click');
    expect(sendFn).toHaveBeenCalledWith('touch send', undefined, null,
      { model: 'p/fast', effort: 'low', maxOutputTokens: 2048 });
    expect(input.element.value).toBe('');
    expect(blur).toHaveBeenCalledOnce();
    expect(wrapper.find('.mobile-quick-send-bar').exists()).toBe(false);
  });

  it('keeps the mobile input state when a send is rejected', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const sendFn = vi.fn(() => false);
    await create({ sendFn });
    const input = wrapper.get('textarea');
    const blur = vi.spyOn(input.element, 'blur');
    await input.trigger('focus');
    await input.setValue('keep editing');
    await wrapper.get('.mobile-quick-send-button').trigger('click');
    expect(input.element.value).toBe('keep editing');
    expect(blur).not.toHaveBeenCalled();
    expect(wrapper.find('.mobile-quick-send-bar').exists()).toBe(true);
  });

  it('sends one-shot settings by shortcut with quote, then ordinary Enter has no override', async () => {
    const sendFn = vi.fn();
    const quote = { author: 'User', content: 'earlier' };
    await create({ sendFn, quote });
    await wrapper.get('textarea').setValue('hello');
    await wrapper.get('textarea').trigger('keydown', { key: 'e', ctrlKey: true });
    expect(sendFn).toHaveBeenLastCalledWith('hello', undefined, quote,
      { model: 'p/fast', effort: 'low', maxOutputTokens: 2048 });
    expect(wrapper.get('textarea').element.value).toBe('');
    await wrapper.get('textarea').setValue('normal');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    expect(sendFn).toHaveBeenLastCalledWith('normal', undefined, quote);
  });

  it('only consumes an available current-Agent slot and preserves draft on rejection/offline', async () => {
    const sendFn = vi.fn(() => false);
    await create({ sendFn });
    const input = wrapper.get('textarea');
    await input.setValue('keep');
    const accepted = new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true, cancelable: true });
    input.element.dispatchEvent(accepted);
    expect(accepted.defaultPrevented).toBe(true);
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(input.element.value).toBe('keep');

    store.connectionState = 'reconnecting';
    await Vue.nextTick();
    const offline = new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true, cancelable: true });
    input.element.dispatchEvent(offline);
    expect(offline.defaultPrevented).toBe(false);
    expect(sendFn).toHaveBeenCalledTimes(1);

    store.currentAgent = 'a2';
    store.connectionState = 'connected';
    await Vue.nextTick();
    expect(wrapper.find('.composer-send-modes').exists()).toBe(false);
    expect(wrapper.find('.composer-send-mode-trigger').exists()).toBe(false);
    const unconfigured = new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true, cancelable: true });
    input.element.dispatchEvent(unconfigured);
    expect(unconfigured.defaultPrevented).toBe(false);
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('does not consume IME, repeat, empty-input, or unconfigured-slot shortcuts', async () => {
    const sendFn = vi.fn();
    await create({ sendFn });
    const input = wrapper.get('textarea');
    const dispatch = extra => {
      const event = new KeyboardEvent('keydown', {
        key: extra.key, ctrlKey: extra.ctrlKey, repeat: extra.repeat,
        bubbles: true, cancelable: true,
      });
      if (extra.isComposing) Object.defineProperty(event, 'isComposing', { value: true });
      input.element.dispatchEvent(event);
      return event;
    };

    expect(dispatch({ key: 'e', ctrlKey: true }).defaultPrevented).toBe(false);
    await input.setValue('safe');
    expect(dispatch({ key: 'e', ctrlKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(dispatch({ key: 'e', ctrlKey: true, repeat: true }).defaultPrevented).toBe(false);
    expect(dispatch({ key: 'j', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(sendFn).not.toHaveBeenCalled();
    expect(input.element.value).toBe('safe');
  });
});
