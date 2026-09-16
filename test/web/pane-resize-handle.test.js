// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import PaneResizeHandle from '../../web/components/PaneResizeHandle.js';

let wrapper;
let observer;
function mountHandle() {
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect = vi.fn();
  });
  wrapper = mount(PaneResizeHandle, {
    props: { modelValue: 400, label: 'Resize Actions', controls: 'actions' },
    attachTo: document.body,
  });
  Object.defineProperty(wrapper.element.parentElement, 'clientWidth', { configurable: true, value: 1200 });
  wrapper.element.getClientRects = () => [{ width: 8 }];
  wrapper.element.setPointerCapture = vi.fn();
  wrapper.element.hasPointerCapture = vi.fn(() => true);
  wrapper.element.releasePointerCapture = vi.fn();
  wrapper.vm.measure();
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

describe('PaneResizeHandle', () => {
  it('supports keyboard resizing, limits and reset without changing other layout state', async () => {
    const handle = mountHandle();
    await handle.trigger('keydown', { key: 'ArrowLeft' });
    await handle.trigger('keydown', { key: 'ArrowRight', shiftKey: true });
    await handle.trigger('keydown', { key: 'Home' });
    await handle.trigger('keydown', { key: 'End' });
    expect(handle.emitted('update:modelValue')).toEqual([[416], [336], [400], [840]]);
    await handle.setProps({ modelValue: 10000 });
    expect(handle.attributes('aria-valuenow')).toBe('840');
    await handle.setProps({ modelValue: 280 });
    await handle.trigger('keydown', { key: 'ArrowRight' });
    expect(handle.emitted('update:modelValue').at(-1)).toEqual([280]);
  });

  it('handles only the active pointer and restores body styles on cancel and unmount', async () => {
    const handle = mountHandle();
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'text';
    const pointer = { isPrimary: true, button: 0, pointerId: 7, clientX: 800, preventDefault: vi.fn() };
    handle.vm.startDrag({ ...pointer, button: 2 });
    expect(handle.element.setPointerCapture).not.toHaveBeenCalled();
    handle.vm.startDrag(pointer);
    handle.vm.moveDrag({ pointerId: 8, clientX: 600 });
    expect(handle.emitted('update:modelValue')).toBeUndefined();
    handle.vm.moveDrag({ pointerId: 7, clientX: 600 });
    expect(handle.emitted('update:modelValue')).toEqual([[600]]);
    await handle.trigger('pointercancel');
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
    expect(handle.element.releasePointerCapture).toHaveBeenCalledWith(7);
    handle.vm.startDrag(pointer);
    handle.unmount();
    wrapper = null;
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it('ends dragging when the container changes to single-pane mode or the window loses focus', () => {
    const handle = mountHandle();
    const pointer = { isPrimary: true, button: 0, pointerId: 1, clientX: 800, preventDefault: vi.fn() };
    handle.vm.startDrag(pointer);
    window.dispatchEvent(new Event('blur'));
    expect(handle.vm.dragging).toBe(false);
    handle.vm.startDrag(pointer);
    handle.element.getClientRects = () => [];
    observer.callback();
    expect(handle.vm.dragging).toBe(false);
    expect(document.body.style.userSelect).toBe('');
  });
});
