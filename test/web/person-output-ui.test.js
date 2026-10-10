// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import DigitalPersonPage from '../../web/components/DigitalPersonPage.js';
import PersonOutputs from '../../web/components/PersonOutputs.js';
import { acceptPersonResponse } from '../../web/stores/helpers/digital-person.js';
import { outputState } from '../../web/stores/helpers/person-outputs.js';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';
const { authStore } = vi.hoisted(() => ({ authStore: { value: null } }));
vi.mock('../../web/stores/auth.js', () => ({ useAuthStore: () => authStore.value }));
const file = { id: 'report', title: 'Report.md', kind: 'file', episodeId: 'episode', mimeType: 'text/markdown', size: 5 };
let wrapper, chat, requests, iframeLoadingDisabled;
const t = key => en[key] || key;
beforeEach(() => {
  iframeLoadingDisabled = window.happyDOM.settings.disableIframePageLoading;
  window.happyDOM.settings.disableIframePageLoading = true;
  vi.stubGlobal('Vue', Vue);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.innerWidth = 1200;
  localStorage.removeItem('person-output-panel-width');
  authStore.value = Vue.reactive({ userId: 'owner', authGeneration: 1, isAuthenticated: true });
  requests = [];
  chat = Vue.reactive({ digitalPersonUiEnabledByAgent: { a: true, b: true }, currentAgent: 'a', connectionState: 'connected', authenticated: true,
    agents: ['a', 'b'].map(id => ({ id, online: true, capabilities: ['digital_person'] })),
    sendWsMessage(request) {
      requests.push(request);
      const data = {
        status: { configured: true, outputsSupported: true }, open: {},
        snapshot: { person: { id: 'p-' + request.agentId, name: 'Ada' }, messages: [{ id: 'reply', role: 'assistant', episodeId: 'episode', text: 'Done', createdAt: 1 }], outputs: { items: [file], nextCursor: 'older' }, busy: false },
        messages: { items: [{ id: 'reply', role: 'assistant', episodeId: 'episode', text: 'Done', createdAt: 1 }], nextCursor: null }, traces: { items: [], nextCursor: null },
        outputs: { items: [{ ...file, id: 'older-report' }], nextCursor: null },
        output_read: { outputId: request.payload.outputId, data: btoa(request.payload.outputId === 'second' ? 'notes' : 'hello'), offset: 0, nextOffset: 5, eof: true, totalBytes: 5 },
      };
      queueMicrotask(() => acceptPersonResponse(chat, { ...request, ok: true, data: data[request.op] }));
      return true;
    },
  });
  vi.stubGlobal('Pinia', { useChatStore: () => chat });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = null;
  window.happyDOM.settings.disableIframePageLoading = iframeLoadingDisabled;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function page() {
  wrapper = mount(DigitalPersonPage, { attachTo: document.body, global: { provide: { t }, config: { globalProperties: { $t: t } } } });
  await flushPromises();
}
function preview(kind, mimeType, title = 'Report') {
  const state = Vue.reactive(outputState());
  state.selected = { ...file, kind: kind === 'link' ? 'link' : 'file', mimeType, title, url: 'https://example.com/report' };
  state.tabs.push({ item: state.selected, scrollTop: 0, scrollLeft: 0 });
  Object.assign(state.preview, { kind, status: 'ready', text: '<script>alert(1)</script><h1>Hello</h1>', url: 'blob:opaque' });
  wrapper = mount(PersonOutputs, { props: { state, supported: true }, global: { mocks: { $t: t } } });
  return state;
}
describe('Digital Person output surface', () => {
  it('does not auto-open or read; opens episode delivery and retains selection and scroll across tabs', async () => {
    await page();
    expect(wrapper.find('#person-side-panel').exists()).toBe(false);
    expect(requests.some(row => row.op === 'output_read')).toBe(false);
    await wrapper.get('.person-delivered-output').trigger('click'); await flushPromises();
    expect(wrapper.vm.panel).toBe('outputs');
    expect(wrapper.find('.person-output-preview .markdown-body').text()).toBe('hello');
    const scroll = wrapper.get('.person-output-preview').element;
    scroll.scrollTop = 120;
    await wrapper.vm.openPanel('thoughts'); await wrapper.vm.openPanel('outputs');
    expect(wrapper.get('.person-output-preview').element).toBe(scroll);
    expect(scroll.scrollTop).toBe(120);
    expect(requests.filter(row => row.op === 'output_read')).toHaveLength(1);
    expect(wrapper.find('.person-output-library').exists()).toBe(false);
    await wrapper.get('.person-output-library-button').trigger('click');
    await wrapper.get('.person-output-more').trigger('click'); await flushPromises();
    expect(wrapper.vm.state.outputs.items.map(row => row.id)).toEqual(['report', 'older-report']);
    expect(wrapper.vm.state.outputs.selected.id).toBe('report');
  });
  it('keeps the reader separate from the eye inspector and search, with a single requested library', async () => {
    await page();
    await wrapper.get('.person-outputs-button').trigger('click'); await flushPromises();
    expect(wrapper.find('.person-panel-header').exists()).toBe(false);
    expect(wrapper.find('.person-inspector-nav').exists()).toBe(false);
    expect(wrapper.findAll('.person-output-library')).toHaveLength(1);
    expect(wrapper.find('.person-output-preview').exists()).toBe(false);
    expect(wrapper.find('[role="tab"]').exists()).toBe(false);
    await wrapper.get('.person-output-item').trigger('click'); await flushPromises();
    expect(wrapper.find('.person-output-library').exists()).toBe(false);
    expect(wrapper.find('.person-output-title').exists()).toBe(false);
    expect(wrapper.find('.person-output-history').exists()).toBe(false);
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(1);
    await wrapper.get('.person-output-library-button').trigger('click');
    expect(wrapper.findAll('.person-output-library')).toHaveLength(1);
    expect(wrapper.find('.person-output-preview').exists()).toBe(false);
    await wrapper.get('.person-output-library-button').trigger('click');
    expect(wrapper.find('.person-output-preview').exists()).toBe(true);
    await wrapper.get('.person-thoughts-button').trigger('click'); await flushPromises();
    expect(wrapper.vm.panel).toBe('thoughts');
    const nav = wrapper.get('.person-inspector-nav');
    expect(nav.text()).not.toContain(t('person.outputs'));
    expect(nav.findAll('button').map(button => button.text())).toEqual(['overview', 'thoughts', 'turns', 'tasks', 'memory', 'skills'].map(section => t('person.' + section)));
    expect(wrapper.get('.person-outputs').isVisible()).toBe(false);
    await wrapper.get('.person-search-button').trigger('click');
    expect(wrapper.find('.person-inspector-nav').exists()).toBe(false);
    expect(wrapper.find('.person-search-form').exists()).toBe(true);
    await wrapper.get('.person-outputs-button').trigger('click'); await flushPromises();
    expect(wrapper.find('.person-search-form').exists()).toBe(false);
    expect(wrapper.get('.person-output-tab-select').text()).toBe('Report.md');
  });
  it('opens file and browser tabs only, switches content, and closes to an adjacent tab without resurrection', async () => {
    await page();
    const second = { ...file, id: 'second', title: 'Notes.md' };
    const link = { id: 'site', kind: 'link', title: 'Reference', url: 'https://example.com/reference' };
    wrapper.vm.state.outputs.items.push(second, link); await Vue.nextTick();
    for (const title of ['Report.md', 'Notes.md', 'Reference']) {
      if (title === 'Reference') {
        await wrapper.get('.person-output-library-button').trigger('click');
        await wrapper.findAll('.person-output-item').find(button => button.text().startsWith(title)).trigger('click');
      } else await wrapper.findAll('.person-delivered-output').find(button => button.text().startsWith(title)).trigger('click');
      await flushPromises();
    }
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['Report.md', 'Notes.md', 'Reference']);
    expect(wrapper.get('iframe').attributes('src')).toBe(link.url);
    expect(wrapper.find('[download]').exists()).toBe(false);
    await wrapper.vm.controller.refresh(); await flushPromises();
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['Report.md', 'Notes.md', 'Reference']);
    expect(wrapper.vm.state.outputs.selected.id).toBe('site');
    const reads = requests.filter(row => row.op === 'output_read').length;
    await wrapper.findAll('[role="tab"]')[1].trigger('click'); await flushPromises();
    expect(wrapper.get('.person-output-preview .markdown-body').text()).toBe('notes');
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.get('[download]').attributes('download')).toBe('Notes.md');
    await wrapper.get('[role="tab"][aria-selected="true"]').trigger('click'); await flushPromises();
    expect(requests.filter(row => row.op === 'output_read')).toHaveLength(reads + 1);
    await wrapper.findAll('.person-output-tab-close')[0].trigger('click'); await flushPromises();
    expect(wrapper.vm.state.outputs.selected.id).toBe('second');
    expect(requests.filter(row => row.op === 'output_read')).toHaveLength(reads + 1);
    await wrapper.findAll('.person-output-tab-close')[0].trigger('click'); await flushPromises();
    expect(wrapper.vm.state.outputs.selected.id).toBe('site');
    expect(document.activeElement).toBe(wrapper.get('[role="tab"]').element);
    await wrapper.get('.person-output-reader-close').trigger('click'); await flushPromises();
    expect(wrapper.vm.state.outputs.tabs.map(tab => tab.item.id)).toEqual(['site']);
    await wrapper.get('.person-outputs-button').trigger('click'); await flushPromises();
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['Reference']);
    await wrapper.get('.person-output-tab-close').trigger('click'); await flushPromises();
    expect(wrapper.vm.state.outputs.selected).toBeNull();
    expect(wrapper.vm.state.outputs.tabs).toEqual([]);
    expect(wrapper.find('.person-output-library').exists()).toBe(true);
    await wrapper.vm.controller.refresh(); await flushPromises();
    expect(wrapper.vm.state.outputs.selected).toBeNull();
    expect(wrapper.find('[role="tab"]').exists()).toBe(false);
  });
  it('restores each document scroll after switch, library reveal and closing/reopening the reader', async () => {
    await page(); await wrapper.get('.person-delivered-output').trigger('click'); await flushPromises();
    const scroll = wrapper.get('.person-output-preview');
    scroll.element.scrollTop = 120; scroll.element.scrollLeft = 35;
    await scroll.trigger('scroll');
    await wrapper.vm.selectOutput({ id: 'link:scroll', kind: 'link', title: 'Website', url: 'https://example.com' }); await flushPromises();
    expect(wrapper.get('.person-output-preview').element.scrollTop).toBe(0);
    expect(wrapper.get('.person-output-preview').element.scrollLeft).toBe(0);
    wrapper.get('.person-output-preview').element.scrollTop = 240;
    await wrapper.get('.person-output-preview').trigger('scroll');
    await wrapper.findAll('[role="tab"]')[0].trigger('click'); await flushPromises();
    expect(wrapper.get('.person-output-preview').element.scrollTop).toBe(120);
    expect(wrapper.get('.person-output-preview').element.scrollLeft).toBe(35);
    await wrapper.get('.person-output-library-button').trigger('click');
    await wrapper.get('.person-output-library-button').trigger('click'); await flushPromises();
    expect(wrapper.get('.person-output-preview').element.scrollTop).toBe(120);
    await wrapper.get('[role="tab"][aria-selected="true"]').trigger('keydown', { key: 'ArrowRight' }); await flushPromises();
    expect(wrapper.vm.state.outputs.selected.title).toBe('Website');
    expect(wrapper.get('.person-output-preview').element.scrollTop).toBe(240);
    await wrapper.get('.person-output-reader-close').trigger('click'); await flushPromises();
    await wrapper.get('.person-outputs-button').trigger('click'); await flushPromises();
    expect(wrapper.get('.person-output-preview').element.scrollTop).toBe(240);
    await wrapper.get('[role="tab"][aria-selected="true"]').trigger('keydown', { key: 'Delete' }); await flushPromises();
    expect(wrapper.vm.state.outputs.selected.id).toBe('report');
    expect(wrapper.get('.person-output-preview').element.scrollTop).toBe(120);
  });
  it.each(['owner', 'auth generation', 'signed out'])('clears open file/link tabs on %s change', async boundary => {
    await page(); await wrapper.get('.person-delivered-output').trigger('click'); await flushPromises();
    await wrapper.vm.selectOutput({ id: 'link:private', kind: 'link', title: 'Private', url: 'https://example.com/private' }); await flushPromises();
    expect(wrapper.vm.state.outputs.tabs).toHaveLength(2);
    if (boundary === 'owner') authStore.value.userId = 'new-owner';
    else if (boundary === 'auth generation') authStore.value.authGeneration++;
    else authStore.value.isAuthenticated = false;
    await flushPromises();
    expect(wrapper.vm.panel).toBeNull();
    expect(wrapper.vm.state.outputs.tabs).toEqual([]);
    expect(wrapper.vm.state.outputs.selected).toBeNull();
    expect(wrapper.vm.state.outputs.preview.url).toBe('');
    expect(wrapper.find('.person-outputs').exists()).toBe(false);
  });
  it('close only releases preview; identity switch clears selection without stopping work', async () => {
    await page(); await wrapper.get('.person-delivered-output').trigger('click'); await flushPromises();
    wrapper.vm.closePanel(); await Vue.nextTick();
    expect(wrapper.vm.state.outputs.selected.id).toBe('report');
    expect(wrapper.vm.state.outputs.tabs.map(tab => tab.item.id)).toEqual(['report']);
    expect(wrapper.vm.state.outputs.preview.url).toBe('');
    wrapper.vm.agentId = 'b'; await flushPromises();
    expect(wrapper.vm.state.outputs.selected).toBeNull();
    expect(wrapper.vm.state.outputs.tabs).toEqual([]);
    expect(requests.some(row => ['cancel', 'task_cancel', 'agent_close'].includes(row.op))).toBe(false);
  });
  it('offers keyboard resize and modal full-app expansion, restoring focus on close', async () => {
    await page(); await wrapper.get('.person-outputs-button').trigger('click');
    const divider = wrapper.get('[role="separator"]');
    Object.defineProperty(divider.element.parentElement, 'clientWidth', { value: 1200 });
    wrapper.findComponent({ name: 'PaneResizeHandle' }).vm.measure();
    await divider.trigger('keydown', { key: 'ArrowLeft' });
    expect(wrapper.vm.panelWidth).toBe(436);
    await wrapper.get('.person-output-expand').trigger('click');
    expect(wrapper.get('#person-side-panel').attributes('aria-modal')).toBe('true');
    expect(wrapper.get('#person-conversation').attributes('inert')).toBeDefined();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await Vue.nextTick();
    expect(wrapper.vm.panel).toBeNull();
    expect(document.activeElement).toBe(wrapper.get('.person-outputs-button').element);
  });
  it('uses a fullscreen dialog at 320px with focus trap and Escape', async () => {
    window.innerWidth = 320; await page();
    const opener = wrapper.get('.person-outputs-button'); opener.element.focus(); await opener.trigger('click'); await flushPromises();
    expect(wrapper.get('#person-side-panel').attributes('role')).toBe('dialog');
    expect(wrapper.find('[role="separator"]').exists()).toBe(false);
    const controls = [...wrapper.get('#person-side-panel').element.querySelectorAll('button:not(:disabled), [tabindex="0"]')].filter(el => !el.closest('[style*="display: none"]'));
    controls.at(-1).focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(controls[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await Vue.nextTick();
    expect(document.activeElement).toBe(opener.element);
  });
  it('traps only tabbable reader controls with multiple documents, not inactive tab buttons', async () => {
    window.innerWidth = 320; await page();
    await wrapper.get('.person-delivered-output').trigger('click'); await flushPromises();
    await wrapper.vm.selectOutput({ id: 'link:focus', title: 'Website', kind: 'link', url: 'https://example.com/focus' }); await flushPromises();
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs[0].attributes('tabindex')).toBe('-1');
    expect(tabs[1].attributes('tabindex')).toBe('0');
    wrapper.get('.person-output-preview').element.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(wrapper.findAll('.person-output-tab-close')[0].element);
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(wrapper.get('.person-output-preview').element);
    await wrapper.get('.person-output-tab-close').trigger('click'); await flushPromises();
    expect(wrapper.vm.state.outputs.selected.id).toBe('link:focus');
    expect(document.activeElement).toBe(wrapper.get('[role="tab"]').element);
  });
  it('intercepts normal safe reply links but preserves modifier/new-tab intent', async () => {
    await page();
    const node = wrapper.get('.person-message-text').element;
    node.innerHTML = '<a href="https://example.com/report" target="_blank" rel="noopener noreferrer">Report</a>';
    const anchor = node.firstElementChild;
    wrapper.vm.previewReplyLink({ target: anchor, button: 0, ctrlKey: true, defaultPrevented: false }); await Vue.nextTick();
    expect(wrapper.vm.panel).toBeNull();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true }); anchor.dispatchEvent(click); await flushPromises();
    expect(click.defaultPrevented).toBe(true);
    expect(wrapper.vm.state.outputs.selected.url).toBe('https://example.com/report');
    expect(requests.some(row => row.op === 'output_read')).toBe(false);
    expect(wrapper.get('.person-output-external').attributes('rel')).toBe('noopener noreferrer');
  });
  it('uses empty sandbox with static srcdoc and opaque HTML download URL', () => {
    preview('html', 'text/html');
    const frame = wrapper.get('iframe');
    expect(frame.attributes('sandbox')).toBe('');
    expect(frame.attributes('srcdoc')).toContain("default-src 'none'");
    expect(frame.attributes('srcdoc')).not.toContain('<script>');
    expect(wrapper.get('[download]').attributes('href')).toBe('blob:opaque');
  });
  it('embeds links with no script/same-origin privileges, and retains dedicated external open', () => {
    preview('link', 'text/html');
    expect(wrapper.get('iframe').attributes('sandbox')).toBe('');
    expect(wrapper.get('iframe').attributes('referrerpolicy')).toBe('no-referrer');
    expect(wrapper.get('.person-output-external').attributes('target')).toBe('_blank');
    expect(wrapper.text()).toContain(en['person.outputsFrameNotice']);
  });
  it('supports raster fit/zoom and PDF/binary fallbacks without execution controls', async () => {
    preview('image', 'image/png');
    expect(wrapper.get('img').classes()).toContain('is-fit');
    await wrapper.get('button[aria-label="Zoom in"]').trigger('click');
    expect(wrapper.get('img').element.style.width).toBe('125%');
    expect(wrapper.get('img').classes()).not.toContain('is-fit');
    wrapper.unmount();
    preview('pdf', 'application/pdf');
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.text()).toContain(en['person.outputsPdfDownload']);
    expect(wrapper.get('[download]').attributes('href')).toBe('blob:opaque');
    wrapper.unmount();
    preview('binary', 'application/octet-stream');
    expect(wrapper.text()).toContain(en['person.outputsBinary']);
    expect(wrapper.find('[download]').exists()).toBe(true);
  });
  it('renders read-only text and bilingual capability/empty/loading/error states', async () => {
    const state = preview('text', 'application/json');
    expect(wrapper.get('pre').text()).toContain('<script>');
    expect(wrapper.find('[contenteditable], textarea').exists()).toBe(false);
    await wrapper.setProps({ supported: false });
    expect(wrapper.text()).toContain(en['person.outputsUnsupported']);
    for (const key of Object.keys(en).filter(key => key.startsWith('person.outputs'))) expect(zh[key]).toBeTruthy();
    state.preview.status = 'loading'; await wrapper.setProps({ supported: true, fileSupported: false });
    expect(wrapper.text()).toContain(en['person.outputsFileUnsupported']);
    expect(wrapper.find('progress').exists()).toBe(true);
    await wrapper.setProps({ fileSupported: true });
    expect(wrapper.text()).not.toContain(en['person.outputsFileUnsupported']);
    state.preview.status = 'error'; state.preview.error = { code: 'invalidChunk' }; await Vue.nextTick();
    expect(wrapper.get('[role="alert"]').text()).toContain(en['person.outputsErrorInvalidChunk']);
    expect(wrapper.find('button').exists()).toBe(true);
    await wrapper.setProps({ gate: 'offline', disabled: true });
    expect(wrapper.text()).toContain(en['person.offline']);
    expect(wrapper.get('.person-output-tab-select').attributes('disabled')).toBeDefined();
    state.selected = null; await Vue.nextTick();
    expect(wrapper.text()).toContain(en['person.outputsEmpty']);
    expect(wrapper.find('.person-output-preview').exists()).toBe(false);
  });
});
