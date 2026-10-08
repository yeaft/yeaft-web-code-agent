// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import VirtualTranscript from '../../web/components/VirtualTranscript.js';

function turns(count, prefix = 'turn') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    type: 'assistant-turn',
    text: `assistant response ${index}`,
    toolMsgs: [],
  }));
}

function createScroller({ viewportHeight = 300, scrollHeight = 100000 } = {}) {
  const el = document.createElement('div');
  el.className = 'chat-container';
  let scrollTop = 0;
  Object.defineProperties(el, {
    clientHeight: { configurable: true, get: () => viewportHeight },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = Math.min(Math.max(0, scrollHeight - viewportHeight), Math.max(0, Number(value) || 0)); },
    },
  });
  document.body.appendChild(el);
  return el;
}

function renderedIds(wrapper) {
  return wrapper.findAll('[data-turn-id]').map(node => node.attributes('data-turn-id'));
}

async function flushAnimationFrame(rounds = 1) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    await Vue.nextTick();
  }
}

function stubVirtualRowHeight(height) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  let measurementCalls = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
    if (this.classList?.contains('virtual-transcript-item')) {
      measurementCalls += 1;
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 100,
        bottom: height,
        left: 0,
        width: 100,
        height,
        toJSON: () => ({}),
      };
    }
    return original.call(this);
  });
  return () => measurementCalls;
}

describe('VirtualTranscript DOM windowing', () => {
  let rafTimers;
  let rafSequence;

  beforeEach(() => {
    globalThis.Vue = Vue;
    rafTimers = new Map();
    rafSequence = 0;
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      const id = ++rafSequence;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        callback(performance.now());
      }, 0);
      rafTimers.set(id, timer);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id) => {
      const timer = rafTimers.get(id);
      if (timer) clearTimeout(timer);
      rafTimers.delete(id);
    });
  });

  afterEach(() => {
    for (const timer of rafTimers.values()) clearTimeout(timer);
    document.body.innerHTML = '';
    delete globalThis.Vue;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });



  it('keeps the initial Session tail pinned while first-time row measurements replace estimates', async () => {
    const scroller = document.createElement('div');
    scroller.className = 'chat-container';
    let scrollTop = 0;
    let scrollHeight = 10000;
    let heightGrowthObserved = false;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: value => { scrollTop = Math.min(scrollHeight - 300, Math.max(0, Number(value) || 0)); },
      },
    });
    document.body.appendChild(scroller);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
      if (this.classList?.contains('virtual-transcript-item')) {
        // Real layout changes scrollHeight before commitMeasurements asks whether
        // it is still near the tail. The old geometry-derived owner therefore
        // saw a 4000px gap and never corrected the initial Session position.
        heightGrowthObserved = true;
        scrollHeight = 14000;
        return {
          x: 0, y: 0, top: 0, right: 100, bottom: 140, left: 0,
          width: 100, height: 140, toJSON: () => ({}),
        };
      }
      return {
        x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0,
        width: 0, height: 0, toJSON: () => ({}),
      };
    });

    const wrapper = mount(VirtualTranscript, {
      props: {
        items: turns(100),
        estimateHeight: () => 100,
        initialAlign: 'end',
        itemGap: 0,
        overscan: 1,
      },
      slots: { default: ({ item }) => Vue.h('div', { 'data-turn-id': item.id }, item.id) },
      attachTo: scroller,
    });

    await flushAnimationFrame(4);

    expect(heightGrowthObserved).toBe(true);
    expect(scrollTop).toBe(13700);
    wrapper.unmount();
  });

  it('preserves the visible content anchor when background history prepends rows', async () => {
    const scroller = createScroller({ viewportHeight: 300, scrollHeight: 100000 });
    scroller.scrollTop = 2500;
    const wrapper = mount(VirtualTranscript, {
      props: {
        items: turns(100),
        estimateHeight: () => 100,
        itemGap: 0,
        overscan: 1,
      },
      slots: { default: ({ item }) => Vue.h('div', { 'data-turn-id': item.id }, item.id) },
      attachTo: scroller,
    });
    await flushAnimationFrame(3);
    wrapper.vm.setBottomFollowEnabled(false);

    await wrapper.setProps({ items: [...turns(20, 'older'), ...turns(100)] });
    await flushAnimationFrame(3);

    expect(scroller.scrollTop).toBe(4500);
    wrapper.unmount();
  });

  it('follows changing sibling/viewport geometry only while enabled and observes late siblings', async () => {
    const scroller = createScroller({ viewportHeight: 300, scrollHeight: 10000 });
    let scrollHeight = 10000;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    let scrollTop = 9700;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = Math.min(scrollHeight - scroller.clientHeight, Math.max(0, Number(value) || 0)); },
    });
    const observed = new Set();
    let resizeCallback;
    let mutationCallback;
    const disconnectResize = vi.fn();
    const disconnectMutation = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { resizeCallback = callback; }
      observe(target) { observed.add(target); }
      unobserve(target) { observed.delete(target); }
      disconnect() { disconnectResize(); }
    });
    vi.stubGlobal('MutationObserver', class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
      disconnect() { disconnectMutation(); }
    });
    const wrapper = mount(VirtualTranscript, {
      props: { items: turns(100), estimateHeight: () => 100, initialAlign: 'end', itemGap: 0 },
      slots: { default: ({ item }) => Vue.h('div', {}, item.id) },
      attachTo: scroller,
    });
    await flushAnimationFrame(4);
    expect(observed.has(scroller)).toBe(true);

    const nav = document.createElement('nav');
    scroller.appendChild(nav);
    scrollHeight += 40;
    mutationCallback();
    await flushAnimationFrame(3);
    expect(observed.has(nav)).toBe(true);
    expect(scrollTop).toBe(scrollHeight - 300);
    scrollHeight += 40;
    resizeCallback([{ target: nav }]);
    await flushAnimationFrame(3);
    expect(scrollTop).toBe(scrollHeight - 300);

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 250 });
    resizeCallback([{ target: scroller }]);
    await flushAnimationFrame(3);
    expect(scrollTop).toBe(scrollHeight - 250);
    wrapper.vm.setBottomFollowEnabled(false);
    scroller.scrollTop = 3000;
    scrollHeight += 80;
    resizeCallback([{ target: nav }]);
    await flushAnimationFrame(3);
    expect(scrollTop).toBe(3000);

    nav.remove();
    mutationCallback();
    expect(observed.has(nav)).toBe(false);
    wrapper.unmount();
    expect(disconnectResize).toHaveBeenCalledOnce();
    expect(disconnectMutation).toHaveBeenCalledOnce();
  });

  it('fences stale bottom work and keeps a targeted child row aligned after block resize', async () => {
    const scroller = createScroller({ viewportHeight: 300, scrollHeight: 10000 });
    scroller.scrollTop = 9700;
    const rowHeights = new Map();
    // Model actual DOM growth as rows resize, so anchor compensation cannot
    // pass merely by being clamped at an unchanged fake scrollHeight.
    let scrollHeight = 10000;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    let scrollTop = 9700;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = Math.min(scrollHeight - 300, Math.max(0, Number(value) || 0)); },
    });
    let rowHeight = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
      if (this.classList?.contains('virtual-transcript-item')) {
        const height = rowHeights.get(this.dataset.virtualId) || 100;
        return { x: 0, y: 0, top: 0, right: 100, bottom: height, left: 0, width: 100, height, toJSON: () => ({}) };
      }
      return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) };
    });

    const rafCallbacks = new Map();
    let nextRafId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      const id = ++nextRafId;
      rafCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', id => rafCallbacks.delete(id));
    let resizeCallback;
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      constructor(callback) { resizeCallback = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const flushRafs = async () => {
      const callbacks = Array.from(rafCallbacks.values());
      rafCallbacks.clear();
      callbacks.forEach(callback => callback(performance.now()));
      await Vue.nextTick();
    };

    const wrapper = mount(VirtualTranscript, {
      props: { items: turns(100), estimateHeight: () => 100, initialAlign: 'end', itemGap: 0, overscan: 1 },
      slots: { default: ({ item }) => Vue.h('div', { 'data-turn-id': item.id }, item.id) },
      attachTo: scroller,
    });
    await Vue.nextTick();
    await flushRafs();
    await flushRafs();

    const row = wrapper.get('.virtual-transcript-item').element;
    rowHeight = 120;
    scrollHeight += 20;
    rowHeights.set(row.dataset.virtualId, rowHeight);
    resizeCallback([{ target: row }]);
    const queuedMeasurement = Array.from(rafCallbacks.values()).at(-1);
    rafCallbacks.clear();
    queuedMeasurement(performance.now());
    wrapper.vm.cancelPendingBottomFollow();
    scroller.scrollTop = 3000;
    await Vue.nextTick();
    await flushRafs();
    expect(scroller.scrollTop).toBe(3000);

    wrapper.vm.setBottomFollowEnabled(false);
    scroller.scrollTop = 9700;
    scroller.dispatchEvent(new Event('scroll'));
    await flushRafs();
    await flushRafs();
    // Select a still-mounted overscan predecessor after pausing. The earlier
    // row belonged to the initial tail window and may now be unmounted.
    const predecessorRow = wrapper.get('.virtual-transcript-item').element;
    rowHeight = (rowHeights.get(predecessorRow.dataset.virtualId) || 100) + 30;
    scrollHeight += 30;
    rowHeights.set(predecessorRow.dataset.virtualId, rowHeight);
    resizeCallback([{ target: predecessorRow }]);
    await flushRafs();
    await Vue.nextTick();
    await flushRafs();
    // Growth above the viewport preserves the content anchor (+30), not the
    // tail: the original 20px bottom gap must survive the compensation.
    expect(scroller.scrollTop).toBe(9730);
    expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBe(20);

    wrapper.vm.setBottomFollowEnabled(true);
    rowHeight += 30;
    scrollHeight += 30;
    rowHeights.set(predecessorRow.dataset.virtualId, rowHeight);
    resizeCallback([{ target: predecessorRow }]);
    await flushRafs();
    await Vue.nextTick();
    await flushRafs();
    expect(scroller.scrollTop).toBe(9780);
    expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBe(0);

    wrapper.unmount();

    // Search anchors an actual persisted child row, not the aggregate virtual
    // block. A later outer-block measurement must keep that child at the
    // viewport start instead of falling back to the block's first line.
    const targetScroller = createScroller({ viewportHeight: 300, scrollHeight: 12000 });
    targetScroller.scrollTop = 5000;
    targetScroller.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 100, right: 800, bottom: 400, left: 0, width: 800, height: 300, toJSON: () => ({}),
    });
    const blockHeights = Array(12).fill(1000);
    const blockOffset = index => blockHeights.slice(0, index).reduce((sum, height) => sum + height, 0);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
      if (this.classList?.contains('virtual-transcript-item')) {
        const index = Number(this.dataset.virtualIndex || 0);
        const top = 100 + blockOffset(index) - targetScroller.scrollTop;
        const height = blockHeights[index];
        return { x: 0, y: top, top, right: 800, bottom: top + height, left: 0, width: 800, height, toJSON: () => ({}) };
      }
      if (this.classList?.contains('target-child')) {
        const top = 100 + blockOffset(5) + 600 - targetScroller.scrollTop;
        return { x: 0, y: top, top, right: 800, bottom: top + 40, left: 0, width: 800, height: 40, toJSON: () => ({}) };
      }
      return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) };
    });
    const targetWrapper = mount(VirtualTranscript, {
      props: { items: turns(12, 'block'), estimateHeight: () => 1000, itemGap: 0, overscan: 1 },
      slots: {
        default: ({ item }) => Vue.h('div', { 'data-turn-id': item.id }, [
          item.id,
          item.id === 'block-5' ? Vue.h('div', { class: 'target-child' }, 'persisted row') : null,
        ]),
      },
      attachTo: targetScroller,
    });
    await Vue.nextTick();
    await flushRafs();
    await flushRafs();
    const predecessorBlock = targetWrapper.get('[data-virtual-id="block-4"]').element;
    const targetBlock = targetWrapper.get('[data-virtual-id="block-5"]').element;
    const child = targetWrapper.get('.target-child').element;
    expect(targetWrapper.vm.anchorTarget('block-5', child, { align: 'start' })).toBe(true);
    expect(targetScroller.scrollTop).toBe(5600);

    // Target-only growth after the child does not move the persisted row.
    blockHeights[5] = 1100;
    resizeCallback([{ target: targetBlock }]);
    await flushRafs();
    await Vue.nextTick();
    await flushRafs();
    expect(targetScroller.scrollTop).toBe(5600);
    expect(child.getBoundingClientRect().top).toBe(targetScroller.getBoundingClientRect().top);

    // Predecessor-only growth still uses the generic content-anchor delta.
    blockHeights[4] = 1100;
    resizeCallback([{ target: predecessorBlock }]);
    await flushRafs();
    await Vue.nextTick();
    await flushRafs();
    expect(targetScroller.scrollTop).toBe(5700);
    expect(child.getBoundingClientRect().top).toBe(targetScroller.getBoundingClientRect().top);

    // If the predecessor and active target resize in one observer batch, target
    // realignment owns the final scroll. Adding anchorDelta again would yield
    // 5900 and push the persisted row 100px above the viewport.
    blockHeights[4] = 1200;
    blockHeights[5] = 1200;
    resizeCallback([{ target: predecessorBlock }, { target: targetBlock }]);
    await flushRafs();
    await Vue.nextTick();
    await flushRafs();
    expect(targetScroller.scrollTop).toBe(5800);
    expect(child.getBoundingClientRect().top).toBe(targetScroller.getBoundingClientRect().top);

    // scrollToKey explicitly transfers ownership back to the aggregate block.
    expect(await targetWrapper.vm.scrollToKey('block-5', { align: 'start' })).toBe(true);
    await Vue.nextTick();
    expect(targetScroller.scrollTop).toBe(5200);
    expect(targetBlock.getBoundingClientRect().top).toBe(targetScroller.getBoundingClientRect().top);

    blockHeights[4] = 1300;
    blockHeights[5] = 1300;
    resizeCallback([{ target: predecessorBlock }, { target: targetBlock }]);
    await flushRafs();
    await Vue.nextTick();
    await flushRafs();
    expect(targetScroller.scrollTop).toBe(5300);
    expect(targetBlock.getBoundingClientRect().top).toBe(targetScroller.getBoundingClientRect().top);
    targetWrapper.unmount();
    targetScroller.remove();
  });




});
