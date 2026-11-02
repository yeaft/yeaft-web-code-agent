// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import MessageComposer from '../../web/components/MessageComposer.js';

let wrapper;
let width;
let touchOnly;
beforeEach(() => {
  width = 1280;
  touchOnly = false;
  vi.stubGlobal('Vue', Vue);
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    matches: query === '(max-width: 768px)' ? width <= 768 : touchOnly,
  }));
});
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function render(props = {}, onKeydown) {
  wrapper = mount(MessageComposer, {
    props: { modelValue: 'draft', keyboardSend: true, canSend: true, ...props, onKeydown },
    global: { mocks: { $t: key => key } },
  });
}
function key(options = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
  wrapper.get('textarea').element.dispatchEvent(event);
  return event;
}

describe('Composer keyboard ownership', () => {
  it.each(['narrow', 'touch landscape'])('leaves mobile Enter to the textarea before parent handlers (%s)', async mode => {
    width = mode === 'narrow' ? 320 : 1024;
    touchOnly = mode !== 'narrow';
    const parent = vi.fn(event => { if (event.key === 'Enter') event.preventDefault(); });
    render({}, parent);
    for (const options of [{}, { shiftKey: true }, { ctrlKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(key(options).defaultPrevented).toBe(false);
    }
    expect(parent).not.toHaveBeenCalled();
    expect(wrapper.emitted('send')).toBeUndefined();
    expect(key({ key: 'ArrowDown' }).defaultPrevented).toBe(false);
    expect(parent).toHaveBeenCalledOnce();
    await wrapper.get('.send-btn').trigger('click');
    expect(wrapper.emitted('send')).toHaveLength(1);
    // Re-evaluate the device/layout at keydown time, not only on mount.
    width = 1280; touchOnly = false;
    await wrapper.setProps({ onKeydown: undefined });
    expect(key().defaultPrevented).toBe(true);
    expect(wrapper.emitted('send')).toHaveLength(2);
  });

  it('retains desktop Enter, Shift+Enter, IME, repeat and parent-autocomplete semantics', async () => {
    render();
    for (const options of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(key(options).defaultPrevented).toBe(false);
    }
    expect(wrapper.emitted('send')).toBeUndefined();
    expect(key().defaultPrevented).toBe(true);
    expect(wrapper.emitted('send')).toHaveLength(1);
    expect(key({ repeat: true }).defaultPrevented).toBe(true);
    expect(wrapper.emitted('send')).toHaveLength(1);
    await wrapper.setProps({ onKeydown: event => event.preventDefault() });
    expect(key().defaultPrevented).toBe(true);
    expect(wrapper.emitted('send')).toHaveLength(1);
    await wrapper.setProps({ keyboardSend: false, onKeydown: undefined });
    expect(key().defaultPrevented).toBe(false);
    expect(wrapper.emitted('send')).toHaveLength(1);
    // Older/test browsers without matchMedia still follow the mobile breakpoint.
    vi.spyOn(window, 'matchMedia').mockRestore();
    vi.stubGlobal('matchMedia', undefined);
    vi.stubGlobal('innerWidth', 320);
    await wrapper.setProps({ keyboardSend: true });
    expect(key().defaultPrevented).toBe(false);
    expect(wrapper.emitted('send')).toHaveLength(1);
    vi.stubGlobal('innerWidth', 1280);
    expect(key().defaultPrevented).toBe(true);
    expect(wrapper.emitted('send')).toHaveLength(2);
  });

  it('keeps explicit and keyboard sends fenced by availability and attachment readiness', async () => {
    render();
    for (const props of [
      { disabled: true }, { disabled: false, sending: true },
      { sending: false, canSend: false },
      { canSend: true, attachmentsEnabled: true, attachments: [{ uploading: true }] },
      { attachments: [{ uploadError: 'Failed' }] }, { attachments: [{}] },
    ]) {
      await wrapper.setProps(props);
      key();
      await wrapper.get('.send-btn').trigger('click');
      expect(wrapper.emitted('send')).toBeUndefined();
    }
    width = 320;
    await wrapper.setProps({ attachments: [{ fileId: 'ready' }] });
    expect(key().defaultPrevented).toBe(false);
    expect(wrapper.emitted('send')).toBeUndefined();
    await wrapper.get('.send-btn').trigger('click');
    expect(wrapper.emitted('send')).toHaveLength(1);
  });
});
