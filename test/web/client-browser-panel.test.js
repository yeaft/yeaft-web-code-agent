// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import BrowserPanel, { normalizeBrowserAddress } from '../../web/components/BrowserPanel.js';

import en from '../../web/i18n/en.js';

const { useBrowserStore } = vi.hoisted(() => ({ useBrowserStore: vi.fn() }));
vi.mock('../../web/stores/browser.js', () => ({ useBrowserStore }));

let wrappers;
let routeSequence = 0;
let fetchSpy;
let peerSpy;
let sendSpy;

function mountPanel(props = {}, locale = en) {
  const wrapper = mount(BrowserPanel, {
    props: { routeKey: `client-browser-test-${++routeSequence}`, ...props },
    global: { mocks: { $t: key => locale[key] || key } },
  });
  wrappers.push(wrapper);
  return wrapper;
}

async function enterAddress(wrapper, value) {
  await wrapper.get('input').setValue(value);
  await wrapper.get('form').trigger('submit');
}

beforeEach(() => {
  wrappers = [];
  // This suite tests actual Vue/DOM interactions without loading remote pages.
  window.happyDOM.settings.disableIframePageLoading = true;
  vi.stubGlobal('Vue', Vue);
  fetchSpy = vi.fn();
  peerSpy = vi.fn();
  sendSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('RTCPeerConnection', peerSpy);
  vi.stubGlobal('Pinia', { useChatStore: () => ({ sendWsMessage: sendSpy }) });
  useBrowserStore.mockClear();
});

afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('client-only Workbench BrowserPanel', () => {
  it('rejects unsafe protocols, embedded credentials and the control plane without changing the frame/link', async () => {
    const wrapper = mountPanel({ initialUrl: 'https://example.com/safe' });
    const originalFrame = wrapper.get('iframe').element;
    const origin = window.location.origin;
    for (const value of [
      'javascript:alert(1)', 'javascript:123', 'data:text/html,<script>1</script>',
      'file:///etc/passwd', 'ftp://example.com', 'blob:https://example.com/id',
      'https://user:pass@example.com', 'https://user@example.com',
      `${origin}/api/auth`, `${origin}/`, '/api/auth', 'https://exa mple.com',
    ]) {
      await enterAddress(wrapper, value);
      expect(wrapper.get('[role="alert"]').text()).toBe(en['workbench.browserAddressInvalid']);
      expect(wrapper.get('iframe').element).toBe(originalFrame);
      expect(wrapper.get('iframe').attributes('src')).toBe('https://example.com/safe');
      expect(wrapper.get('.browser-external').attributes('href')).toBe('https://example.com/safe');
    }
    await enterAddress(wrapper, 'http://localhost:5173/app');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('iframe').attributes('src')).toBe('http://localhost:5173/app');
    expect(normalizeBrowserAddress('localhost:5173/app')).toBe('https://localhost:5173/app');
    expect(normalizeBrowserAddress('example.com:8080/docs')).toBe('https://example.com:8080/docs');
    expect(normalizeBrowserAddress('//example.com/docs')).toBe('https://example.com/docs');
  });

  it('uses a safe external anchor and an opaque-origin sandbox without popup/top-navigation permissions', async () => {
    const wrapper = mountPanel({ initialUrl: 'https://example.com/' });
    const link = wrapper.get('.browser-external');
    expect(link.element.tagName).toBe('A');
    expect(link.attributes()).toMatchObject({
      href: 'https://example.com/', target: '_blank', rel: 'noopener noreferrer',
      referrerpolicy: 'no-referrer',
    });
    expect(wrapper.get('iframe').attributes()).toMatchObject({
      sandbox: 'allow-scripts allow-forms', referrerpolicy: 'no-referrer',
      title: en['workbench.browserFrameLabel'],
    });
    expect(wrapper.get('.browser-embed-notice').text()).toBe(en['workbench.browserEmbedNotice']);
    vi.useFakeTimers();
    const firstFrame = wrapper.get('iframe').element;
    await wrapper.get('.browser-actions button').trigger('click');
    expect(wrapper.get('iframe').element).not.toBe(firstFrame);
    expect(wrapper.get('iframe').attributes('src')).toBe('https://example.com/');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('.browser-embed-notice').text()).toBe(en['workbench.browserFrameWaiting']);
    expect(wrapper.get('.browser-external').attributes('href')).toBe('https://example.com/');
    await wrapper.get('iframe').trigger('load');
    expect(wrapper.get('.browser-embed-notice').text()).toBe(en['workbench.browserEmbedNotice']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(peerSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('isolates route URLs, drafts and errors, ignores stale iframe loads and restores route state', async () => {
    const wrapper = mountPanel({ initialUrl: 'https://example.com/route-a' });
    const routeA = wrapper.props('routeKey');
    const routeB = `client-browser-test-${++routeSequence}`;
    const oldFrame = wrapper.get('iframe').element;
    await wrapper.get('input').setValue('unfinished-a.example');
    await wrapper.setProps({ routeKey: routeB, initialUrl: '', navigation: null });
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.get('input').element.value).toBe('');
    await enterAddress(wrapper, 'javascript:alert(1)');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    await enterAddress(wrapper, 'https://example.org/route-b');
    oldFrame.dispatchEvent(new Event('load'));
    // Direct invocation also covers delivery after Vue detached the old handler.
    wrapper.vm.onFrameLoad({ currentTarget: oldFrame });
    await Vue.nextTick();
    expect(wrapper.get('[role="status"]').exists()).toBe(true);
    expect(wrapper.get('iframe').attributes('src')).toBe('https://example.org/route-b');
    await wrapper.get('iframe').trigger('load');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);

    await wrapper.setProps({ routeKey: routeA, initialUrl: 'https://example.com/route-a' });
    expect(wrapper.get('iframe').attributes('src')).toBe('https://example.com/route-a');
    expect(wrapper.get('input').element.value).toBe('unfinished-a.example');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.setProps({ routeKey: routeB, initialUrl: '' });
    expect(wrapper.get('iframe').attributes('src')).toBe('https://example.org/route-b');
  });
});
