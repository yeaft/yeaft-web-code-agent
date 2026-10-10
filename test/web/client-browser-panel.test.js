// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import BrowserPanel, { normalizeBrowserAddress } from '../../web/components/BrowserPanel.js';
import { handleWorkbenchBrowserLink, openWorkbenchBrowser } from '../../web/utils/workbench-browser.js';
import { workbenchWorkspaceGeneration } from '../../web/utils/workbench-route.js';
import en from '../../web/i18n/en.js';
import zhCN from '../../web/i18n/zh-CN.js';

const { useBrowserStore } = vi.hoisted(() => ({ useBrowserStore: vi.fn() }));
vi.mock('../../web/stores/browser.js', () => ({ useBrowserStore }));

let wrappers;
let routeSequence = 0;
let fetchSpy;
let peerSpy;
let sendSpy;
let storageSpy;

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
  storageSpy = vi.spyOn(Storage.prototype, 'setItem');
  useBrowserStore.mockClear();
});

afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('client-only Workbench BrowserPanel', () => {
  it('starts empty without persistent guidance and navigates from the address form', async () => {
    const wrapper = mountPanel();
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.get('[type="submit"]').element.disabled).toBe(true);
    expect(wrapper.get('.browser-actions button').element.disabled).toBe(true);
    expect(wrapper.find('.browser-hint').exists()).toBe(false);
    expect(wrapper.get('input').attributes('aria-label')).toBe(en['workbench.browserAddressLabel']);
    document.body.appendChild(wrapper.element);
    wrapper.get('input').element.focus();
    expect(document.activeElement).toBe(wrapper.get('input').element);
    wrapper.element.remove();

    await enterAddress(wrapper, ' example.com/docs ');
    expect(wrapper.get('iframe').attributes('src')).toBe('https://example.com/docs');
    expect(wrapper.get('input').element.value).toBe('https://example.com/docs');
    expect(wrapper.get('.browser-actions button').element.disabled).toBe(false);
    expect(wrapper.emitted('navigate')).toEqual([[{
      routeKey: wrapper.props('routeKey'), url: 'https://example.com/docs',
    }]]);
    expect(wrapper.get('[role="status"]').text()).toBe(en['workbench.browserFrameLoading']);
    await wrapper.get('iframe').trigger('load');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.find('.browser-hint').exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(/successfully|connected|WebRTC/);
    expect(wrapper.find('video').exists()).toBe(false);
    expect(wrapper.find('textarea').exists()).toBe(false);
  });

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
    const firstFrame = wrapper.get('iframe').element;
    await wrapper.get('.browser-actions button').trigger('click');
    expect(wrapper.get('iframe').element).not.toBe(firstFrame);
    expect(wrapper.get('iframe').attributes('src')).toBe('https://example.com/');
  });

  it('reopens the same URL on navigation revision changes, but not for an unchanged intent', async () => {
    const wrapper = mountPanel({ navigation: { url: 'https://example.com/', revision: 1 } });
    const firstFrame = wrapper.get('iframe').element;
    await wrapper.setProps({ navigation: { url: 'https://example.com/', revision: 1 } });
    expect(wrapper.get('iframe').element).toBe(firstFrame);
    await wrapper.setProps({ navigation: { url: 'https://example.com/', revision: 2 } });
    expect(wrapper.get('iframe').element).not.toBe(firstFrame);
    expect(wrapper.emitted('navigate')).toBeUndefined();
    const secondFrame = wrapper.get('iframe').element;
    await wrapper.get('form').trigger('submit');
    expect(wrapper.get('iframe').element).not.toBe(secondFrame);
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

  it('starts a fresh component from parent-owned navigation with no cross-instance cache', async () => {
    const navigation = { url: 'https://example.com/initial', revision: 1 };
    const wrapper = mountPanel({ navigation });
    const routeKey = wrapper.props('routeKey');
    await enterAddress(wrapper, 'https://example.com/manually-opened');
    const remembered = wrapper.emitted('navigate').at(-1)[0];
    const oldFrame = wrapper.get('iframe').element;
    const staleLoad = wrapper.vm.onFrameLoad;
    wrapper.unmount();
    wrappers = wrappers.filter(item => item !== wrapper);
    const reopened = mountPanel({ routeKey, navigation: { url: remembered.url, revision: 1 } });
    expect(reopened.get('iframe').attributes('src')).toBe('https://example.com/manually-opened');
    expect(reopened.emitted('navigate')).toBeUndefined();
    staleLoad({ currentTarget: oldFrame });
    await Vue.nextTick();
    expect(reopened.get('[role="status"]').exists()).toBe(true);
    const unrelated = mountPanel({ routeKey });
    expect(unrelated.find('iframe').exists()).toBe(false);
  });

  it('ignores old load events during refresh and never invokes runtime, signaling or persistence APIs', async () => {
    const wrapper = mountPanel({ initialUrl: 'https://example.com/' });
    const oldFrame = wrapper.get('iframe').element;
    await wrapper.get('iframe').trigger('load');
    await wrapper.get('.browser-actions button').trigger('click');
    wrapper.vm.onFrameLoad({ currentTarget: oldFrame });
    await Vue.nextTick();
    expect(wrapper.get('[role="status"]').exists()).toBe(true);
    await enterAddress(wrapper, 'https://example.org/');
    await wrapper.setProps({ navigation: { url: 'https://example.net/', revision: 1 } });
    expect(useBrowserStore).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(peerSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(storageSpy).not.toHaveBeenCalled();
  });

  it('renders Chinese browser actions without a persistent limitations hint', () => {
    const wrapper = mountPanel({ initialUrl: 'https://example.com/' }, zhCN);
    expect(wrapper.find('.browser-hint').exists()).toBe(false);
    expect(wrapper.get('.browser-actions button').text()).toBe('刷新');
    expect(wrapper.get('.browser-external').text()).toBe('新标签页打开');
    for (const key of BrowserPanel.template.matchAll(/\$t\('([^']+)'\)/g)) {
      expect(en[key[1]]).toBeTruthy();
      expect(zhCN[key[1]]).toBeTruthy();
    }
  });
});

describe('Workbench external link routing', () => {
  it('dispatches only safe scoped intents and requires a host acknowledgement', () => {
    const route = { runtimeProvider: 'yeaft', agentId: 'a', sessionId: 's' };
    const listener = vi.fn(event => { event.detail.accepted = true; });
    window.addEventListener('workbench-open-browser', listener);
    try {
      expect(openWorkbenchBrowser('https://example.com/page.html', route, '/workspace')).toBe(true);
      expect(listener.mock.calls[0][0].detail).toMatchObject({
        routeKey: 'yeaft:a:s', url: 'https://example.com/page.html',
        workspaceGeneration: workbenchWorkspaceGeneration('yeaft:a:s', '/workspace'),
      });
      expect(openWorkbenchBrowser('javascript:alert(1)', route)).toBe(false);
      expect(openWorkbenchBrowser('https://example.com/', null)).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('workbench-open-browser', listener); }
    expect(openWorkbenchBrowser('https://example.com/', route)).toBe(false);
  });

  it('intercepts only ordinary accepted web links, preserves native fallback and non-web references', () => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="https://example.com/page.html"><span>page</span></a>';
    const anchor = root.querySelector('a');
    const open = vi.fn(() => true);
    const event = overrides => ({ target: anchor.firstChild, currentTarget: root, button: 0,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides });
    for (const override of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true },
      { button: 1 }, { defaultPrevented: true }, { currentTarget: document.createElement('div') }]) {
      expect(handleWorkbenchBrowserLink(event(override), open)).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
    anchor.setAttribute('download', '');
    expect(handleWorkbenchBrowserLink(event(), open)).toBe(false);
    anchor.removeAttribute('download');
    for (const href of ['README.md', '#section', 'mailto:user@example.com', 'javascript:1']) {
      anchor.setAttribute('href', href);
      expect(handleWorkbenchBrowserLink(event(), open)).toBe(false);
    }
    anchor.setAttribute('href', 'https://example.com/page.html');
    const rejected = event();
    expect(handleWorkbenchBrowserLink(rejected, () => false)).toBe(false);
    expect(rejected.preventDefault).not.toHaveBeenCalled();
    const accepted = event();
    expect(handleWorkbenchBrowserLink(accepted, open)).toBe(true);
    expect(accepted.preventDefault).toHaveBeenCalledTimes(1);
    expect(accepted.stopPropagation).toHaveBeenCalledTimes(1);
  });
});
