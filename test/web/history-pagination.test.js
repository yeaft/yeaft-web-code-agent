// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { createHistoryPageBudget, isHistoryScrollInput } from '../../web/utils/history-pagination.js';

globalThis.Pinia = { defineStore: () => () => ({}) };
const { default: MessageList } = await import('../../web/components/MessageList.js');
let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mountHistory(view = 'chat') {
  vi.useFakeTimers();
  vi.stubGlobal('Vue', Vue);
  vi.stubGlobal('requestAnimationFrame', callback => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const store = Vue.reactive({ currentView: view, currentConversation: 'conv', activeConversationId: 'conv',
    currentAgent: 'a', yeaftActiveSessionFilter: 's', agents: [], messages: [{ id: 'm100', type: 'user', content: 'latest' }],
    hasMoreMessages: true, loadingMoreMessages: false, yeaftHasMoreHistory: true,
    yeaftLoadingMoreHistory: false, yeaftOldestLoadedSeq: 100, isProcessing: false });
  let seq = 100;
  const load = vi.fn(() => {
    store.loadingMoreMessages = true;
    store.yeaftLoadingMoreHistory = true;
    setTimeout(() => {
      seq -= 1;
      store.messages.unshift({ id: `m${seq}`, type: 'user', content: `older ${seq}` });
      store.loadingMoreMessages = false;
      store.yeaftLoadingMoreHistory = false;
    }, 10);
  });
  store.loadMoreMessages = load;
  store.loadMoreYeaftHistory = load;
  globalThis.Pinia.useChatStore = () => store;
  wrapper = mount({ ...MessageList,
    template: '<main ref="containerRef"><button @click="onClickLoadMore">older</button><VirtualTranscript ref="virtualTranscriptRef" @scroll-state="onVirtualTranscriptScrollState" /></main>',
  }, { attachTo: document.body, global: { stubs: { VirtualTranscript: {
    template: '<div />', methods: { scrollToBottom() {}, setBottomFollowEnabled() {}, cancelPendingBottomFollow() {}, clearTargetAnchor() {} },
  } } } });
  const el = wrapper.element;
  Object.defineProperties(el, { clientHeight: { value: 800, configurable: true }, scrollHeight: { value: 10000, configurable: true } });
  el.scrollTop = 0;
  return { store, load, el };
}
async function settle() { await vi.advanceTimersByTimeAsync(200); await Vue.nextTick(); }
function wheel(el, deltaY = -100) { el.dispatchEvent(new WheelEvent('wheel', { deltaY })); }

describe('user-owned history pagination', () => {
  it('caps a wheel burst at three pages; idle/new gestures, explicit clicks and cancellation own the budget', () => {
    const budget = createHistoryPageBudget();
    expect(budget.consume()).toBe(false);
    budget.recordInput({ direction: -1, now: 0 });
    for (let i = 0; i < 10; i += 1) {
      budget.recordInput({ direction: -1, now: i * 10 });
      expect(budget.consume()).toBe(i < 3);
    }
    budget.recordInput({ direction: -1, now: 400 });
    expect(budget.consume()).toBe(true);
    budget.recordInput({ direction: 1, now: 410 });
    expect(budget.consume()).toBe(false);
    // Key repeats/touchmove never replenish even after long input gaps.
    budget.recordInput({ direction: -1, newGesture: false, now: 900 });
    expect(budget.consume()).toBe(false);
    budget.recordInput({ direction: -1, newGesture: true, now: 901 });
    expect(budget.consume()).toBe(true);
    budget.stop();
    expect(budget.consume()).toBe(false);
    budget.start();
    expect([budget.consume(), budget.consume(), budget.consume(), budget.consume()]).toEqual([true, true, true, false]);
    budget.reset();
    expect(budget.consume()).toBe(false);
  });

  it('bounds async CLI/Yeaft loads and never rearms from virtual layout or programmatic scrolling', async () => {
    for (const view of ['chat', 'yeaft']) {
      const { load, el } = mountHistory(view);
      wrapper.vm.onVirtualTranscriptScrollState({ scrollTop: 0, scrollHeight: 10000, clientHeight: 800 });
      el.dispatchEvent(new Event('scroll'));
      await settle();
      expect(load).not.toHaveBeenCalled();
      const nested = document.createElement('div');
      nested.style.overflowY = 'auto';
      el.appendChild(nested);
      Object.defineProperties(nested, { clientHeight: { value: 100 }, scrollHeight: { value: 400 } });
      nested.scrollTop = 100;
      expect(isHistoryScrollInput(nested, el, -1)).toBe(false);
      nested.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      await settle();
      expect(load).not.toHaveBeenCalled();
      nested.scrollTop = 0;
      expect(isHistoryScrollInput(nested, el, -1)).toBe(true);
      nested.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      await settle();
      expect(load).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 5; i += 1) {
        el.scrollTop = i % 2 ? 3000 : 0;
        el.dispatchEvent(new Event('scroll'));
        wrapper.vm.onVirtualTranscriptScrollState({ scrollTop: el.scrollTop, scrollHeight: 10000, clientHeight: 800 });
      }
      await settle();
      expect(load).toHaveBeenCalledTimes(3);
      el.scrollTop = 0;
      wheel(el);
      await settle();
      expect(load).toHaveBeenCalledTimes(6);
      wheel(el, 100);
      await wrapper.get('button').trigger('click');
      await settle();
      expect(load).toHaveBeenCalledTimes(9);
      wrapper.unmount();
      wrapper = null;
      vi.useRealTimers();
    }
  });

  it('handles repeated keys/touch gestures, resident pages and session switches without leaking continuation', async () => {
    const { store, load, el } = mountHistory('yeaft');
    const key = repeat => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', repeat, bubbles: true }));
    key(false);
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
    key(true);
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
    const touch = (type, y) => {
      const event = new Event(type);
      Object.defineProperty(event, 'touches', { value: y == null ? [] : [{ clientY: y }] });
      el.dispatchEvent(event);
    };
    touch('touchstart', 100);
    touch('touchmove', 150);
    await settle();
    expect(load).toHaveBeenCalledTimes(6);
    touch('touchmove', 200);
    await settle();
    expect(load).toHaveBeenCalledTimes(6);
    touch('touchend');
    store.hasHiddenYeaftMessages = true;
    store.expandYeaftMessageWindow = vi.fn(() => store.messages.unshift({ id: `resident-${store.messages.length}`, type: 'user', content: 'cached' }));
    touch('touchstart', 100);
    touch('touchmove', 150);
    await settle();
    expect(store.expandYeaftMessageWindow).toHaveBeenCalledTimes(3);
    store.hasHiddenYeaftMessages = false;
    await wrapper.get('button').trigger('click');
    expect(load).toHaveBeenCalledTimes(7);
    store.yeaftActiveSessionFilter = 'other';
    await settle();
    expect(load).toHaveBeenCalledTimes(7);
    expect(wrapper.vm.isAtBottom).toBe(true);
  });
});
