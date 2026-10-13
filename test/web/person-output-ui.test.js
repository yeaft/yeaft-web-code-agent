// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';

import PersonOutputs from '../../web/components/PersonOutputs.js';
import { outputState } from '../../web/stores/helpers/person-outputs.js';
import en from '../../web/i18n/en.js';

const file = { id: 'report', title: 'Report.md', kind: 'file', episodeId: 'episode', mimeType: 'text/markdown', size: 5 };
let wrapper, iframeLoadingDisabled;
const t = key => en[key] || key;
beforeEach(() => {
  iframeLoadingDisabled = window.happyDOM.settings.disableIframePageLoading;
  window.happyDOM.settings.disableIframePageLoading = true;
  vi.stubGlobal('Vue', Vue);
});
afterEach(() => {
  wrapper?.unmount(); wrapper = null;
  window.happyDOM.settings.disableIframePageLoading = iframeLoadingDisabled;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function preview(kind, mimeType, title = 'Report') {
  const state = Vue.reactive(outputState());
  state.selected = { ...file, kind: kind === 'link' ? 'link' : 'file', mimeType, title, url: 'https://example.com/report' };
  state.tabs.push({ item: state.selected, scrollTop: 0, scrollLeft: 0 });
  Object.assign(state.preview, { kind, status: 'ready', text: '<script>alert(1)</script><h1>Hello</h1>', url: 'blob:opaque' });
  wrapper = mount(PersonOutputs, { props: { state, supported: true }, global: { mocks: { $t: t } } });
  return state;
}
describe('Digital Person output surface', () => {
  it('uses empty sandbox with static srcdoc and opaque HTML download URL', () => {
    preview('html', 'text/html');
    const frame = wrapper.get('iframe');
    expect(frame.attributes('sandbox')).toBe('');
    expect(frame.attributes('srcdoc')).toContain("default-src 'none'");
    expect(frame.attributes('srcdoc')).not.toContain('<script>');
    expect(wrapper.get('[download]').attributes('href')).toBe('blob:opaque');
  });
  it('reuses the Workbench browser with opaque origin, no popups/top navigation, and retains dedicated external open', () => {
    preview('link', 'text/html');
    expect(wrapper.get('iframe').attributes('sandbox')).toBe('allow-scripts allow-forms');
    expect(wrapper.find('.browser-panel').exists()).toBe(true);
    expect(wrapper.get('iframe').attributes('referrerpolicy')).toBe('no-referrer');
    expect(wrapper.get('.person-output-external').attributes('target')).toBe('_blank');
    expect(wrapper.text()).toContain(en['person.outputsFrameNotice']);
  });
});
