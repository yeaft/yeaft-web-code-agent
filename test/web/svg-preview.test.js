// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import SvgPreview from '../../web/components/files/SvgPreview.js';
import { getFileType, isPreviewableTextFile, isSvgFile } from '../../web/components/files/fileEditor.js';
import { createFilePreview } from '../../web/components/files/filePreview.js';
import { openImagePreview } from '../../web/utils/imagePreview.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle r="30"/></svg>';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('SVG preview', () => {
  it('keeps SVG editable as text and defaults to preview after switching files', async () => {
    vi.stubGlobal('Vue', Vue);
    expect(isSvgFile('scene.SVG')).toBe(true);
    expect(isSvgFile('scene.svg.js')).toBe(false);
    expect(isPreviewableTextFile('scene.SVG')).toBe(true);
    expect(getFileType('scene.SVG')).toBe('text');
    const activeFile = Vue.ref({ name: 'scene.svg', content: SVG });
    const destroyEditor = vi.fn();
    const saveCurrentUndoHistory = vi.fn();
    const preview = createFilePreview(activeFile, {
      editorContainer: Vue.ref(null), createEditor: vi.fn(), destroyEditor, saveCurrentUndoHistory,
    });
    expect(preview.isActiveSvg.value).toBe(true);
    expect(preview.isActiveTextPreview.value).toBe(true);
    expect(preview.textPreviewMode.value).toBe(true);
    preview.switchToTextEdit();
    expect(preview.textPreviewMode.value).toBe(false);
    preview.switchToTextPreview();
    expect(destroyEditor).toHaveBeenCalledOnce();
    expect(saveCurrentUndoHistory).toHaveBeenCalledOnce();
    preview.switchToTextEdit();
    activeFile.value = { name: 'other.svg', content: SVG };
    await Vue.nextTick();
    expect(preview.textPreviewMode.value).toBe(true);
  });

  it('uses opaque-origin image URLs, rejects stale decodes, and recovers after invalid source', async () => {
    vi.stubGlobal('Vue', Vue);
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'toWellFormed');
    Object.defineProperty(String.prototype, 'toWellFormed', { configurable: true, value: undefined });
    let wrapper;
    try {
      wrapper = mount(SvgPreview, {
        props: { content: SVG, name: 'scene.svg' },
        global: { provide: { t: key => key }, mocks: { $t: key => key } },
      });
      const firstUrl = wrapper.get('img').attributes('src');
      expect(firstUrl).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`);
      expect(new URL(firstUrl).origin).toBe('null');
      expect(wrapper.find('svg, iframe, object, embed').exists()).toBe(false);
      const firstImage = wrapper.get('img').element;
      firstImage.dispatchEvent(new Event('load'));
      await Vue.nextTick();
      expect(wrapper.find('[role="status"]').exists()).toBe(false);
      await wrapper.setProps({ content: '<svg>broken' });
      expect(wrapper.get('img').attributes('src')).not.toBe(firstUrl);
      wrapper.vm.onLoad({ target: firstImage });
      await Vue.nextTick();
      expect(wrapper.find('[role="status"]').exists()).toBe(true);
      await wrapper.get('img').trigger('error');
      expect(wrapper.get('[role="alert"]').text()).toBe('files.svgPreviewLoadFailed');
      await wrapper.setProps({ content: SVG });
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      await wrapper.get('img').trigger('load');
      expect(wrapper.find('[role="status"]').exists()).toBe(false);
      await wrapper.setProps({ content: SVG + '<!-- paired: 🏎️; lone: \ud800\ud800-\udfff -->' });
      const decoded = decodeURIComponent(wrapper.get('img').attributes('src').split(',')[1]);
      expect(decoded).toContain('paired: 🏎️; lone: \ufffd\ufffd-\ufffd');
    } finally {
      wrapper?.unmount();
      if (descriptor) Object.defineProperty(String.prototype, 'toWellFormed', descriptor);
      else delete String.prototype.toWellFormed;
    }
  });

  it('disposes zoom overlays and global listeners on source changes, deactivation and unmount', async () => {
    vi.stubGlobal('Vue', Vue);
    const active = Vue.ref(true);
    const content = Vue.ref(SVG);
    const wrapper = mount({
      setup: () => () => Vue.h(Vue.KeepAlive, null, {
        default: () => active.value ? Vue.h(SvgPreview, { content: content.value, name: 'scene.svg' }) : null,
      }),
    }, { attachTo: document.body, global: { provide: { t: key => key }, mocks: { $t: key => key } } });
    const open = async () => {
      await wrapper.get('img').trigger('load');
      await wrapper.get('.file-preview-image-button').trigger('click');
      expect(document.querySelectorAll('.image-preview-overlay')).toHaveLength(1);
    };
    const expectDisposed = () => {
      expect(document.querySelector('.image-preview-overlay')).toBeNull();
      const key = new KeyboardEvent('keydown', { key: '+', cancelable: true });
      document.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(false);
    };
    try {
      await open();
      content.value += '<!-- changed -->';
      await Vue.nextTick();
      expectDisposed();
      await open();
      active.value = false;
      await Vue.nextTick();
      expectDisposed();
      active.value = true;
      await Vue.nextTick();
      await open();
    } finally {
      wrapper.unmount();
    }
    expectDisposed();
    // Ordinary callers retain their DOM return value and animated close/focus.
    // An owner abort during that close must also cancel its pending removal timer.
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const overlay = openImagePreview(SVG, { trigger, signal: controller.signal });
      expect(overlay).toBe(document.querySelector('.image-preview-overlay'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      expect(document.activeElement).toBe(trigger);
      expect(overlay.classList.contains('visible')).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      expectDisposed();
      expect(vi.getTimerCount()).toBe(0);
      expect(openImagePreview(SVG, { signal: controller.signal })).toBeNull();
    } finally {
      trigger.remove();
      vi.useRealTimers();
    }
  });
});
