// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { createUserPreferencesState, useUserPreferences } from '../../web/utils/user-preferences.js';
import SidebarSectionResizeHandle from '../../web/components/SidebarSectionResizeHandle.js';
import UnifiedSessionList from '../../web/components/UnifiedSessionList.js';

const defaults = { sidebarCollapsedProjects: {}, sidebarCollapsedSections: {} };
const ok = (ratio, compact = false, extra = {}) => ({ ok: true, json: async () => ({ ...defaults, sidebarProjectsRatio: ratio, sidebarActionsCompact: compact, ...extra }) });
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

  it('loads compact mode, sends field-only patches and keeps later optimistic changes across queued responses', async () => {
    const write = deferred();
    const request = vi.fn().mockResolvedValueOnce(ok(0.65, true)).mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce(ok(0.7, false)).mockResolvedValueOnce(ok(0.4, true));
    const { state } = stateFor(request);
    await tick();
    expect(state.preferences.value).toEqual({ ...defaults, sidebarProjectsRatio: 0.65, sidebarActionsCompact: true });
    const ratio = state.saveSidebarProjectsRatio(0.7);
    const compact = state.saveSidebarActionsCompact(false);
    await tick();
    expect(state.preferences.value).toEqual({ ...defaults, sidebarProjectsRatio: 0.7, sidebarActionsCompact: false });
    write.resolve(ok(0.7, true));
    expect(await ratio).toBe(true);
    expect(state.preferences.value.sidebarActionsCompact).toBe(false);
    expect(await compact).toBe(true);
    expect(request.mock.calls[2][1].body).toBe('{"sidebarActionsCompact":false}');
    await state.refresh();
    expect(state.preferences.value).toEqual({ ...defaults, sidebarProjectsRatio: 0.4, sidebarActionsCompact: true });
    expect(await state.saveSidebarActionsCompact('true')).toBe(false);
  });

  it('rolls back only failed compact changes without erasing a queued ratio save and fences both on account switch', async () => {
    const failed = deferred();
    const oldWrite = deferred();
    const request = vi.fn().mockResolvedValueOnce(ok(0.5, true)).mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce(ok(0.6, true)).mockReturnValueOnce(oldWrite.promise).mockResolvedValueOnce(ok(0.3));
    const { state, auth } = stateFor(request);
    await tick();
    const compact = state.saveSidebarActionsCompact(false);
    const ratio = state.saveSidebarProjectsRatio(0.6);
    await tick();
    failed.resolve({ ok: false });
    expect(await compact).toBe(false);
    expect(state.preferences.value.sidebarActionsCompact).toBe(true);
    expect(state.preferences.value.sidebarProjectsRatio).toBe(0.6);
    expect(await ratio).toBe(true);
    // Saving a different field cannot silently dismiss the failed layout save.
    expect(state.error.value).toBe('save');
    const old = state.saveSidebarActionsCompact(false);
    const queued = state.saveSidebarActionsCompact(true);
    await tick();
    auth.userId = 'owner-b'; auth.token = 'token-b';
    await tick();
    oldWrite.resolve(ok(0.6, false));
    expect(await old).toBe(false);
    expect(await queued).toBe(false);
    expect(state.preferences.value).toEqual({ ...defaults, sidebarProjectsRatio: 0.3, sidebarActionsCompact: false });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('exposes the latest cross-device value when a drag is cancelled after a pending refresh', async () => {
    vi.stubGlobal('Vue', Vue);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const pending = deferred();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok(0.5)).mockReturnValueOnce(pending.promise).mockResolvedValue(ok(0.68)));
    const auth = Vue.reactive({ isAuthenticated: true, userId: 'integrated-owner', authGeneration: 1 });
    vi.stubGlobal('Pinia', { useAuthStore: () => auth });
    const state = useUserPreferences();
    states.push(state);
    localStorage.removeItem('yeaft-sidebar-section-collapse');
    const wrapper = mount(UnifiedSessionList, { global: { mocks: { $t: key => key } } });
    try {
      await tick();
      const handle = wrapper.findComponent(SidebarSectionResizeHandle);
      window.dispatchEvent(new Event('focus'));
      handle.vm.$emit('update:modelValue', 0.6);
      await tick();
      pending.resolve(ok(0.68));
      await tick();
      // Do not jump the handle out from under an active drag.
      expect(handle.props('modelValue')).toBe(0.6);
      handle.vm.$emit('cancel');
      await tick();
      expect(handle.props('modelValue')).toBe(0.68);
      window.dispatchEvent(new Event('focus'));
      await tick();
      expect(handle.props('modelValue')).toBe(0.68);
    } finally { wrapper.unmount(); }
  });

  it('merges queued folder/section choices per key, rolls back failures and fences old-account writes', async () => {
    const write = deferred();
    const old = deferred();
    const request = vi.fn().mockResolvedValueOnce(ok(0.5, false, {
      sidebarCollapsedProjects: { a: true, offline: true }, sidebarCollapsedSections: { recents: true },
    })).mockReturnValueOnce(write.promise).mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(ok(0.5, false, {
        sidebarCollapsedProjects: { a: false, offline: true, remote: true },
        sidebarCollapsedSections: { recents: false },
      })).mockResolvedValueOnce(ok(0.5, false, {
        sidebarCollapsedProjects: { a: false, offline: false, remote: true },
        sidebarCollapsedSections: { recents: false },
      })).mockReturnValueOnce(old.promise).mockResolvedValueOnce(ok(0.6, false, {
        sidebarCollapsedProjects: { b: true },
      }));
    const { state, auth } = stateFor(request);
    await tick();
    const first = state.saveSidebarProjectCollapsed('a', false);
    const failed = state.saveSidebarProjectCollapsed('b', true);
    const section = state.saveSidebarSectionCollapsed('recents', false);
    expect(state.preferences.value.sidebarCollapsedProjects).toEqual({ a: false, b: true, offline: true });
    expect(state.preferences.value.sidebarCollapsedSections).toEqual({ recents: false });
    await tick();
    write.resolve(ok(0.5, false, {
      sidebarCollapsedProjects: { a: false, offline: true, remote: true }, sidebarCollapsedSections: { recents: true },
    }));
    expect(await first).toBe(true);
    expect(await failed).toBe(false);
    expect(await section).toBe(true);
    expect(state.preferences.value.sidebarCollapsedProjects).toEqual({ a: false, offline: true, remote: true });
    expect(state.error.value).toBe('save');
    expect(request.mock.calls.slice(1, 4).map(([, options]) => JSON.parse(options.body))).toEqual([
      { sidebarCollapsedProjects: { a: false } }, { sidebarCollapsedProjects: { b: true } },
      { sidebarCollapsedSections: { recents: false } },
    ]);
    // Success for another folder must not hide a failed folder save.
    expect(await state.saveSidebarProjectCollapsed('offline', false)).toBe(true);
    expect(state.error.value).toBe('save');
    const inFlight = state.saveSidebarProjectCollapsed('a', true);
    const queued = state.saveSidebarSectionCollapsed('projects', true);
    await tick();
    auth.userId = 'owner-b'; auth.token = 'token-b';
    await tick();
    old.resolve(ok(0.5, false, { sidebarCollapsedProjects: { a: true } }));
    expect(await inFlight).toBe(false);
    expect(await queued).toBe(false);
    expect(state.preferences.value.sidebarCollapsedProjects).toEqual({ b: true });
    expect(state.preferences.value.sidebarCollapsedSections).toEqual({});
    expect(await state.saveSidebarProjectCollapsed('__proto__', true)).toBe(false);
    expect(await state.saveSidebarProjectCollapsed('', true)).toBe(false);
    expect(await state.saveSidebarProjectCollapsed('b', 'false')).toBe(false);
    expect(await state.saveSidebarSectionCollapsed('tasks', true)).toBe(false);
    expect(request).toHaveBeenCalledTimes(7);
    auth.isAuthenticated = false;
    expect(state.preferences.value.sidebarCollapsedProjects).toEqual({});
  });

  it('restores folders and sections on mount and focus without device-local state or pruning unseen projects', async () => {
    vi.stubGlobal('Vue', Vue);
    const auth = Vue.reactive({ isAuthenticated: true, userId: 'folders-owner', authGeneration: 1 });
    vi.stubGlobal('Pinia', { useAuthStore: () => auth });
    let saved = { ...defaults, sidebarProjectsRatio: 0.5, sidebarActionsCompact: false,
      sidebarCollapsedProjects: { p: true, offline: true }, sidebarCollapsedSections: { recents: true } };
    const request = vi.fn(async (_url, options) => {
      if (options?.method === 'PATCH') {
        const patch = JSON.parse(options.body);
        saved = { ...saved,
          sidebarCollapsedProjects: { ...saved.sidebarCollapsedProjects, ...patch.sidebarCollapsedProjects },
          sidebarCollapsedSections: { ...saved.sidebarCollapsedSections, ...patch.sidebarCollapsedSections } };
      }
      return { ok: true, json: async () => saved };
    });
    vi.stubGlobal('fetch', request);
    states.push(useUserPreferences());
    // Legacy storage is not user-scoped and must never override server state.
    localStorage.setItem('yeaft-sidebar-section-collapse', JSON.stringify({ projects: true }));
    const props = { projects: [{ id: 'p', name: 'Project' }] };
    const render = () => mount(UnifiedSessionList, { props, global: { mocks: { $t: key => key } } });
    let wrapper = render();
    try {
      expect(wrapper.get('.sidebar-project-toggle').attributes('disabled')).toBeDefined();
      await tick();
      expect(wrapper.get('.sidebar-project-toggle').attributes('aria-expanded')).toBe('false');
      expect(wrapper.get('.projects-section').classes()).not.toContain('is-collapsed');
      expect(wrapper.get('.recents-section').classes()).toContain('is-collapsed');
      await wrapper.get('.sidebar-project-toggle').trigger('click');
      await tick();
      expect(saved.sidebarCollapsedProjects).toEqual({ p: false, offline: true });
      wrapper.unmount(); wrapper = render();
      await tick();
      expect(wrapper.get('.sidebar-project-toggle').attributes('aria-expanded')).toBe('true');
      saved = { ...saved, sidebarCollapsedProjects: { p: true, offline: true }, sidebarCollapsedSections: { projects: true } };
      window.dispatchEvent(new Event('focus'));
      await tick();
      expect(wrapper.get('.projects-section').classes()).toContain('is-collapsed');
      expect(wrapper.get('.recents-section').classes()).not.toContain('is-collapsed');
      await wrapper.get('.sidebar-project-add-button').trigger('click');
      await tick();
      expect(saved.sidebarCollapsedSections).toEqual({ projects: false });
      expect(wrapper.find('.sidebar-project-create').exists()).toBe(true);
      expect(wrapper.get('.sidebar-project-toggle').attributes('aria-expanded')).toBe('false');
      auth.isAuthenticated = false;
      await tick();
      expect(wrapper.find('.sidebar-project-toggle').attributes('disabled')).toBeDefined();
      expect(wrapper.find('.sidebar-project-toggle').attributes('aria-expanded')).toBe('true');
    } finally { wrapper.unmount(); localStorage.removeItem('yeaft-sidebar-section-collapse'); }
  });

  it('supports keyboard limits/reset and pointer preview, commit, cancel and cleanup', async () => {
    vi.stubGlobal('Vue', Vue);
    let resizeCallback;
    vi.stubGlobal('ResizeObserver', class { constructor(cb) { resizeCallback = cb; } observe() {} disconnect() {} });
    const wrapper = mount(SidebarSectionResizeHandle, {
      props: { label: 'Resize', modelValue: 0.5, 'onUpdate:modelValue': ratio => wrapper.setProps({ modelValue: ratio }), onCancel: () => wrapper.setProps({ modelValue: 0.7 }) },
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
      expect(wrapper.emitted('cancel')).toHaveLength(1);
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
