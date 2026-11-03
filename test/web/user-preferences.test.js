// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { createUserPreferencesState } from '../../web/utils/user-preferences.js';
import SidebarSectionResizeHandle from '../../web/components/SidebarSectionResizeHandle.js';

const ok = ratio => ({ ok: true, json: async () => ({ sidebarProjectsRatio: ratio }) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await Vue.nextTick(); };
const states = [];
afterEach(() => { states.splice(0).forEach(state => state.dispose()); vi.unstubAllGlobals(); });
function stateFor(request) {
  vi.stubGlobal('Vue', Vue);
  const auth = Vue.reactive({ isAuthenticated: true, userId: 'owner-a', authGeneration: 1, token: 'token-a' });
  const state = createUserPreferencesState(auth, { request });
  states.push(state);
  return { auth, state };
}

describe('server-owned sidebar user preferences', () => {
  it('loads the signed-in user and serializes repeated drags; refresh never writes a default', async () => {
    const firstWrite = deferred();
    const request = vi.fn().mockResolvedValueOnce(ok(0.65)).mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(ok(0.72)).mockResolvedValueOnce(ok(0.4));
    const { state } = stateFor(request);
    expect(state.ready.value).toBe(false);
    await tick();
    expect(state.preferences.value.sidebarProjectsRatio).toBe(0.65);
    const first = state.saveSidebarProjectsRatio(0.6);
    const second = state.saveSidebarProjectsRatio(0.72);
    await tick();
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.preferences.value.sidebarProjectsRatio).toBe(0.72);
    await state.refresh();
    expect(request).toHaveBeenCalledTimes(2);
    firstWrite.resolve(ok(0.6));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(request.mock.calls[2][1].body).toBe('{"sidebarProjectsRatio":0.72}');
    await state.refresh();
    expect(state.preferences.value.sidebarProjectsRatio).toBe(0.4);
    expect(request.mock.calls.filter(([, options]) => options.method === 'PATCH')).toHaveLength(2);
  });

  it('fences old reads and queued writes on user switch and same-user re-login', async () => {
    const oldRead = deferred();
    const oldWrite = deferred();
    const request = vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(ok(0.3))
      .mockReturnValueOnce(oldWrite.promise).mockResolvedValueOnce(ok(0.45));
    const { state, auth } = stateFor(request);
    auth.userId = 'owner-b'; auth.token = 'token-b';
    await tick();
    oldRead.resolve(ok(0.8));
    await tick();
    expect(state.preferences.value.sidebarProjectsRatio).toBe(0.3);
    const write = state.saveSidebarProjectsRatio(0.7);
    const queued = state.saveSidebarProjectsRatio(0.75);
    await tick();
    auth.authGeneration++;
    await tick();
    oldWrite.resolve(ok(0.7));
    expect(await write).toBe(false);
    expect(await queued).toBe(false);
    expect(state.preferences.value.sidebarProjectsRatio).toBe(0.45);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
    auth.isAuthenticated = false;
    expect(state.ready.value).toBe(false);
    expect(state.preferences.value.sidebarProjectsRatio).toBe(0.5);
    expect(await state.saveSidebarProjectsRatio(0.7)).toBe(false);
  });

  it('keeps failures visible, rolls back failed saves and permits read/save retry', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ok(0.6))
      .mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(ok(0.85));
    const { state } = stateFor(request);
    await tick();
    expect(state.error.value).toBe('load');
    expect(await state.saveSidebarProjectsRatio(0.7)).toBe(false);
    await state.refresh();
    expect(state.ready.value).toBe(true);
    expect(await state.saveSidebarProjectsRatio(0.7)).toBe(false);
    expect(state.preferences.value.sidebarProjectsRatio).toBe(0.6);
    expect(state.error.value).toBe('save');
    expect(await state.saveSidebarProjectsRatio(1)).toBe(true);
    expect(state.preferences.value.sidebarProjectsRatio).toBe(0.85);
    expect(state.error.value).toBeNull();
  });

  it('supports keyboard limits/reset and pointer preview, commit, cancel and cleanup', async () => {
    vi.stubGlobal('Vue', Vue);
    let resizeCallback;
    vi.stubGlobal('ResizeObserver', class { constructor(cb) { resizeCallback = cb; } observe() {} disconnect() {} });
    const wrapper = mount(SidebarSectionResizeHandle, {
      props: { label: 'Resize', modelValue: 0.5, 'onUpdate:modelValue': ratio => wrapper.setProps({ modelValue: ratio }) },
    });
    const el = wrapper.element;
    el.setPointerCapture = vi.fn(); el.hasPointerCapture = () => false;
    const host = document.createElement('div');
    const projects = document.createElement('section');
    host.append(projects, el);
    projects.getBoundingClientRect = () => ({ height: 245 });
    Object.defineProperty(host, 'clientHeight', { value: 500 });
    Object.defineProperty(el, 'offsetHeight', { value: 10 });
    el.getClientRects = () => [{}];
    try {
      await wrapper.trigger('keydown', { key: 'End' });
      expect(wrapper.emitted('change').at(-1)).toEqual([0.85]);
      await wrapper.trigger('keydown', { key: 'ArrowDown' });
      expect(wrapper.emitted('change').at(-1)).toEqual([0.85]);
      await wrapper.trigger('keydown', { key: 'Home' });
      expect(wrapper.emitted('change').at(-1)).toEqual([0.15]);
      await wrapper.trigger('dblclick');
      expect(wrapper.props('modelValue')).toBe(0.5);
      const beforeClick = wrapper.emitted('change').length;
      wrapper.vm.startDrag({ isPrimary: true, button: 0, pointerId: 0, clientY: 100, preventDefault() {} });
      wrapper.vm.finishDrag();
      expect(wrapper.emitted('change')).toHaveLength(beforeClick);
      wrapper.vm.startDrag({ isPrimary: true, button: 0, pointerId: 1, clientY: 100, preventDefault() {} });
      wrapper.vm.moveDrag({ pointerId: 1, clientY: 198 });
      // pointerup may arrive before Vue has delivered the new modelValue prop.
      wrapper.vm.finishDrag();
      expect(wrapper.emitted('change').at(-1)).toEqual([0.7]);
      await tick();
      expect(wrapper.props('modelValue')).toBe(0.7);
      wrapper.vm.startDrag({ isPrimary: true, button: 0, pointerId: 2, clientY: 100, preventDefault() {} });
      wrapper.vm.moveDrag({ pointerId: 2, clientY: 0 });
      await tick();
      el.getClientRects = () => [];
      resizeCallback();
      await tick();
      expect(wrapper.props('modelValue')).toBe(0.7);
      expect(document.body.style.cursor).toBe('');
      await wrapper.setProps({ disabled: true });
      const count = wrapper.emitted('change').length;
      await wrapper.trigger('keydown', { key: 'ArrowDown' });
      expect(wrapper.emitted('change')).toHaveLength(count);
      expect(wrapper.attributes('tabindex')).toBe('-1');
    } finally { wrapper.unmount(); }
  });
});
