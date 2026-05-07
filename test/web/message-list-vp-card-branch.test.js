/**
 * message-list-vp-card-branch.test.js — Task 6 of the VP quick-card plan.
 *
 * @vitest-environment happy-dom
 *
 * Pins the MessageList template branching contract:
 *   - assistant-turn items with `intent === 'feature'` render VpQuickCard
 *   - assistant-turn items WITHOUT a feature preview render AssistantTurn
 *
 * Setup mirrors vp-turn-detail-drawer.test.js: pinia is NOT installed as
 * an npm dep (the runtime uses the CDN IIFE), so we use the project's
 * Pinia.defineStore shim. MessageList only consumes useChatStore, so we
 * follow the single-store capture pattern.
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';

let capturedOptions = null;
let activeStore = null;

// MessageList consumes the Vue global (Vue.ref, Vue.computed, ...). When
// the runtime serves the page it ships Vue as a CDN IIFE; in vitest we
// have it as a module import — bridge the two.
globalThis.Vue = globalThis.Vue || Vue;

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  if (options && options.actions && options.actions.openVpTurnDetail) {
    capturedOptions = options;
    return () => activeStore;
  }
  return () => ({});
};
// MessageList reads `Pinia.useChatStore()` from the global at runtime.
// Wire the captured factory once we know it.

function buildStore() {
  const state = Vue.reactive(capturedOptions.state());
  const wrapped = state;
  for (const [name, fn] of Object.entries(capturedOptions.actions || {})) {
    wrapped[name] = fn.bind(wrapped);
  }
  for (const [name, getter] of Object.entries(capturedOptions.getters || {})) {
    Object.defineProperty(wrapped, name, {
      get() { return getter.call(wrapped, wrapped); },
      enumerable: true,
      configurable: true,
    });
  }
  return wrapped;
}

let MessageList;
beforeAll(async () => {
  await import('../../web/stores/chat.js');
  if (!capturedOptions) {
    throw new Error('chat.js defineStore was not captured — Pinia shim mis-wired');
  }
  // MessageList calls Pinia.useChatStore() at setup() time.
  globalThis.Pinia.useChatStore = () => activeStore;
  MessageList = (await import('../../web/components/MessageList.js')).default;
});

const stubT = (k) => k;
const stubs = {
  VpQuickCard: { name: 'VpQuickCard', template: '<div class="vp-quick-card-stub"></div>', props: ['turn', 'preview'] },
  AssistantTurn: { name: 'AssistantTurn', template: '<div class="assistant-turn-stub"></div>', props: ['turn'] },
  MessageItem: true,
  FeaturePill: true,
  QuickPreview: true,
  VpSpeakerHeader: true,
  ReflectionCard: true,
  SubAgentCard: true,
  GroupAnnouncementBar: true,
  VpAvatar: true,
  ChatInput: true,
  transition: false,
  'transition-group': false,
};
const mountOpts = { global: { mocks: { $t: stubT }, stubs } };

function setupStore({ messages, previews }) {
  activeStore = buildStore();
  activeStore.unifyConversationId = 'unify-test';
  // The `messages` getter routes through activeConversationId, which only
  // resolves to unifyConversationId when currentView==='unify'.
  activeStore.currentView = 'unify';
  // MessageList gates its messages template on `store.currentConversation`,
  // which reads `activeConversations[0]`. Seed it so the welcome screen
  // doesn't swallow the message list.
  activeStore.activeConversations = ['unify-test'];
  if (messages) activeStore.messagesMap['unify-test'] = messages;
  if (previews) activeStore.unifyQuickPreviews = previews;
  return activeStore;
}

describe('MessageList — VpQuickCard vs AssistantTurn branch', () => {
  beforeEach(() => { activeStore = null; });

  it('renders VpQuickCard for a feature-intent turn', () => {
    setupStore({
      messages: [
        { type: 'assistant', content: 'partial...', vpId: 'jobs', turnId: 't1',
          speakerVpId: 'jobs', isStreaming: true },
      ],
      previews: {
        'jobs:t1': { vpId: 'jobs', turnId: 't1', intent: 'feature', preview: 'Refactoring auth' },
      },
    });
    const wrapper = mount(MessageList, mountOpts);
    expect(wrapper.find('.vp-quick-card-stub').exists()).toBe(true);
    expect(wrapper.find('.assistant-turn-stub').exists()).toBe(false);
  });

  it('renders AssistantTurn for a turn without a feature preview', () => {
    setupStore({
      messages: [
        { type: 'assistant', content: 'hello', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' },
      ],
      previews: {},
    });
    const wrapper = mount(MessageList, mountOpts);
    expect(wrapper.find('.vp-quick-card-stub').exists()).toBe(false);
    expect(wrapper.find('.assistant-turn-stub').exists()).toBe(true);
  });
});
