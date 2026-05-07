/**
 * vp-turn-detail-drawer.test.js — Task 5 of the VP quick-card plan.
 *
 * @vitest-environment happy-dom
 *
 * Pins the VpTurnDetailDrawer's contract:
 *   - hidden when store.unifyOpenVpTurnDetail === null
 *   - shows VP name + close + info buttons in the header when open
 *   - close button clears the descriptor on the store
 *   - info button toggles a popover overlay
 *   - switching to a different (vpId, turnId) updates the header and
 *     collapses any open info popover
 *
 * Setup deviation from the plan: pinia is NOT installed as an npm dep
 * (the runtime uses the CDN IIFE). We follow the project's standard
 * Pinia.defineStore shim pattern (see chat-input-dispatch.test.js,
 * vp-turn-detail-store.test.js) but hand-build a Vue.reactive() store
 * around the captured options so the component's `useChatStore()` call
 * yields a real, reactive object.
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';

// chat.js does `const { defineStore } = Pinia;` against globalThis.Pinia.
// We capture its options object once, then on each test build a fresh
// reactive store using that schema. `useChatStore` is the same factory
// the component imports — it must always return the SAME instance per
// test, so we hold the active store in a closure-scoped slot.
let capturedOptions = null;
let activeStore = null;

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  // The chat store is the only one with openVpTurnDetail in its actions
  // map — capture it. Other (smaller) stores get a no-op stub.
  if (options && options.actions && options.actions.openVpTurnDetail) {
    capturedOptions = options;
    return () => activeStore;
  }
  return () => ({});
};

/** Build a fresh reactive chat store from the captured options. */
function buildStore() {
  const state = Vue.reactive(capturedOptions.state());
  const wrapped = state;
  // Bind actions so `this` inside an action mutates `wrapped`.
  for (const [name, fn] of Object.entries(capturedOptions.actions || {})) {
    wrapped[name] = fn.bind(wrapped);
  }
  // Materialise getters as computed properties on the same object.
  // Pinia getters receive (state) and may use `this` for cross-getter
  // composition. Wire `this` to `wrapped` so both styles work.
  for (const [name, getter] of Object.entries(capturedOptions.getters || {})) {
    Object.defineProperty(wrapped, name, {
      get() { return getter.call(wrapped, wrapped); },
      enumerable: true,
      configurable: true,
    });
  }
  return wrapped;
}

let useChatStore;
let VpTurnDetailDrawer;
beforeAll(async () => {
  // Importing chat.js triggers the defineStore shim above.
  await import('../../web/stores/chat.js');
  if (!capturedOptions) {
    throw new Error('chat.js defineStore was not captured — Pinia shim mis-wired');
  }
  ({ useChatStore } = await import('../../web/stores/chat.js'));
  VpTurnDetailDrawer = (await import('../../web/components/VpTurnDetailDrawer.js')).default;
});

const stubT = (k) => k;
const mountOpts = {
  global: {
    mocks: { $t: stubT },
    stubs: { VpAvatar: true, AssistantTurn: true, transition: false },
  },
};

function setupStore({ openTarget, messages }) {
  activeStore = buildStore();
  // Seed a Unify conversation so the `messages` getter routes through
  // unifyConversationId. We deliberately do NOT set currentView='unify'
  // — that would activate the group-filter path; this way the raw
  // messagesMap entry passes through unfiltered.
  activeStore.unifyConversationId = 'unify-test';
  if (messages) activeStore.messagesMap['unify-test'] = messages;
  if (openTarget) activeStore.openVpTurnDetail(openTarget);
  return activeStore;
}

describe('VpTurnDetailDrawer', () => {
  beforeEach(() => { activeStore = null; });

  it('renders nothing when unifyOpenVpTurnDetail is null', () => {
    setupStore({});
    const wrapper = mount(VpTurnDetailDrawer, mountOpts);
    expect(wrapper.find('.vp-turn-detail-drawer').exists()).toBe(false);
  });

  it('renders drawer with header when target set', () => {
    setupStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [{ type: 'assistant', content: 'hi', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' }],
    });
    const wrapper = mount(VpTurnDetailDrawer, mountOpts);
    expect(wrapper.find('.vp-turn-detail-drawer').exists()).toBe(true);
    expect(wrapper.find('.drawer-header').text()).toContain('jobs');
  });

  it('close button calls closeVpTurnDetail', async () => {
    const store = setupStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [{ type: 'assistant', content: 'hi', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' }],
    });
    const wrapper = mount(VpTurnDetailDrawer, mountOpts);
    await wrapper.find('.drawer-close').trigger('click');
    expect(store.unifyOpenVpTurnDetail).toBeNull();
  });

  it('info button toggles a popover overlay', async () => {
    setupStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [{ type: 'assistant', content: 'hi', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' }],
    });
    const wrapper = mount(VpTurnDetailDrawer, mountOpts);
    expect(wrapper.find('.drawer-info-popover').exists()).toBe(false);
    await wrapper.find('.drawer-info-btn').trigger('click');
    expect(wrapper.find('.drawer-info-popover').exists()).toBe(true);
    await wrapper.find('.drawer-info-btn').trigger('click');
    expect(wrapper.find('.drawer-info-popover').exists()).toBe(false);
  });

  it('switching open target updates the header', async () => {
    const store = setupStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [
        { type: 'assistant', content: 'a', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' },
        { type: 'user', content: 'next' },
        { type: 'assistant', content: 'b', vpId: 'wozniak', turnId: 't2', speakerVpId: 'wozniak' },
      ],
    });
    const wrapper = mount(VpTurnDetailDrawer, mountOpts);
    expect(wrapper.find('.drawer-header').text()).toContain('jobs');
    store.openVpTurnDetail({ vpId: 'wozniak', turnId: 't2' });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.drawer-header').text()).toContain('wozniak');
  });

  it('reconstruction routes tool-use, todo, ask, and image messages correctly', () => {
    const bashMsg = { type: 'tool-use', toolName: 'bash', vpId: 'jobs', turnId: 't1' };
    const todoMsg = { type: 'tool-use', toolName: 'TodoWrite', vpId: 'jobs', turnId: 't1' };
    const askMsg = { type: 'tool-use', toolName: 'AskUserQuestion', vpId: 'jobs', turnId: 't1' };
    const imgMsg = { type: 'chat-image', url: 'x.png', vpId: 'jobs', turnId: 't1' };
    const asstMsg = { type: 'assistant', content: 'hello', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' };
    const store = setupStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [asstMsg, bashMsg, todoMsg, askMsg, imgMsg],
    });
    // The `messages` getter routes through activeConversationId, which
    // only resolves to `unifyConversationId` when currentView==='unify'.
    // The group-filter inside that getter is gated on
    // `unifyActiveGroupFilter` (default null), so flipping the view is
    // safe — the raw messagesMap entry passes through unfiltered.
    store.currentView = 'unify';
    const wrapper = mount(VpTurnDetailDrawer, mountOpts);
    const turn = wrapper.vm.targetTurn;
    expect(turn).toBeTruthy();
    expect(turn.textContent).toBe('hello');
    // Pinia store wraps objects in reactive proxies, so identity checks
    // (toBe) fail against the raw vars — compare by routing property.
    expect(turn.toolMsgs).toHaveLength(1);
    expect(turn.toolMsgs[0].toolName).toBe('bash');
    expect(turn.todoMsg?.toolName).toBe('TodoWrite');
    expect(turn.askMsg?.toolName).toBe('AskUserQuestion');
    expect(turn.imageMsgs).toHaveLength(1);
    expect(turn.imageMsgs[0].type).toBe('chat-image');
  });

  it('info popover closes when target switches', async () => {
    const store = setupStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [
        { type: 'assistant', content: 'a', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' },
        { type: 'assistant', content: 'b', vpId: 'wozniak', turnId: 't2', speakerVpId: 'wozniak' },
      ],
    });
    const wrapper = mount(VpTurnDetailDrawer, mountOpts);
    await wrapper.find('.drawer-info-btn').trigger('click');
    expect(wrapper.find('.drawer-info-popover').exists()).toBe(true);
    store.openVpTurnDetail({ vpId: 'wozniak', turnId: 't2' });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.drawer-info-popover').exists()).toBe(false);
  });

  it('renders drawer-empty when target set but no matching messages', () => {
    setupStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [],
    });
    const wrapper = mount(VpTurnDetailDrawer, mountOpts);
    expect(wrapper.find('.vp-turn-detail-drawer').exists()).toBe(true);
    expect(wrapper.find('.drawer-empty').exists()).toBe(true);
    expect(wrapper.find('assistant-turn-stub').exists()).toBe(false);
  });
});
