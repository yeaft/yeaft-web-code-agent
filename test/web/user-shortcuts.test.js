// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';

const globals = vi.hoisted(() => ({ auth: null }));
vi.mock('../../web/stores/auth.js', () => ({ useAuthStore: () => globals.auth }));
vi.mock('../../web/components/SessionCreateModal.js', () => ({ default: {
  props: ['initialAgentId'], emits: ['close', 'created'], template: '<div role="dialog">{{ initialAgentId }}</div>',
} }));
import {
  createUserShortcutsState, defaultUserShortcuts, matchShortcut, normalizeShortcut,
  shortcutFromEvent, useUserShortcuts, validateShortcut,
} from '../../web/utils/user-shortcuts.js';
import { handleGlobalShortcut, isGlobalShortcutAvailable, isGlobalShortcutFocusBlocked } from '../../web/utils/global-shortcuts.js';
import UserShortcutsSettings from '../../web/components/UserShortcutsSettings.js';
import UserShortcutsRuntime from '../../web/components/UserShortcutsRuntime.js';
import { en, zhCN } from '../../web/i18n/user-shortcuts.js';

const key = (binding, extra = {}) => {
  const parts = binding.split('+');
  const letter = parts.at(-1);
  const event = new KeyboardEvent('keydown', {
    key: letter.toLowerCase(), code: /^[0-9]$/.test(letter) ? `Digit${letter}` : `Key${letter}`,
    ctrlKey: parts.includes('Ctrl'), metaKey: parts.includes('Meta'), altKey: parts.includes('Alt'),
    shiftKey: parts.includes('Shift'), bubbles: true, cancelable: true, ...extra,
  });
  // happy-dom aliases AltGraph to Alt; real Alt+Shift events do not set AltGraph.
  const getModifierState = event.getModifierState.bind(event);
  event.getModifierState = modifier => modifier === 'AltGraph' ? false : getModifierState(modifier);
  return event;
};
const translate = (name, args = {}) => (en[name] || name).replace(/\{(\w+)\}/g, (_, k) => args[k] || '');
let states = [];
let wrappers = [];
let store;
beforeEach(() => {
  vi.stubGlobal('Vue', Vue);
  localStorage.clear();
  globals.auth = Vue.reactive({ isAuthenticated: true, userId: 'owner-a', role: 'pro' });
  store = Vue.reactive({
    currentView: 'yeaft', connectionState: 'connected', authenticated: true,
    currentAgent: 'agent-a', currentAgentInfo: { id: 'agent-a' },
    agents: [{ id: 'agent-a', online: true, capabilities: ['terminal', 'file_editor', 'workbench_session_routes'] }],
    activeSessionRoute: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'session-a' },
    workbenchRouteProtocolSupported: true, hasCapability: () => true,
  });
  vi.stubGlobal('Pinia', { useAuthStore: () => globals.auth, useChatStore: () => store });
});
afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount());
  states.forEach(state => state.dispose());
  wrappers = []; states = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
const create = options => {
  const state = createUserShortcutsState(globals.auth, options);
  states.push(state);
  return state;
};
const shared = () => {
  const state = useUserShortcuts();
  if (!states.includes(state)) states.push(state);
  return state;
};
const render = component => {
  const wrapper = mount(component, { attachTo: document.body, global: { mocks: { $t: translate } } });
  wrappers.push(wrapper);
  return wrapper;
};

describe('owner-scoped user shortcuts', () => {
  it('defaults to hidden and unbound; shares one reactive state for the current auth store', () => {
    expect(shared()).toBe(useUserShortcuts());
    expect(shared().preferences.value).toEqual(defaultUserShortcuts());
    expect(Object.values(shared().preferences.value.bindings)).toEqual(Array(9).fill(''));
  });
  it('isolates owners synchronously, clears logout state, and restores only the returning owner', () => {
    const state = create();
    expect(state.save({ showQuickSends: true, bindings: { terminal: 'Ctrl+Shift+Y' } })).toEqual({ ok: true });
    globals.auth.userId = 'owner-b';
    expect(state.preferences.value).toEqual(defaultUserShortcuts());
    state.save({ bindings: { files: 'Alt+Shift+O' } });
    globals.auth.isAuthenticated = false;
    expect(state.preferences.value).toEqual(defaultUserShortcuts());
    expect(state.save({ showQuickSends: true })).toMatchObject({ ok: false, error: 'unauthenticated' });
    globals.auth.userId = 'owner-a';
    globals.auth.isAuthenticated = true;
    expect(state.preferences.value.showQuickSends).toBe(true);
    expect(state.preferences.value.bindings).toMatchObject({ terminal: 'Ctrl+Shift+Y', files: '' });
    expect(localStorage.length).toBe(2);
  });
  it('validates saves, resets everything, and reports unavailable browser storage without changing state', () => {
    const state = create();
    state.save({ bindings: { terminal: 'Ctrl+Shift+Y' } });
    expect(state.save({ bindings: { files: 'ctrl+shift+y' } })).toMatchObject({ ok: false, error: 'conflict' });
    expect(state.reset()).toEqual({ ok: true });
    expect(state.preferences.value).toEqual(defaultUserShortcuts());
    const failing = create({ storage: () => { throw new Error('denied'); } });
    expect(failing.save({ showQuickSends: true })).toEqual({ ok: false, error: 'storage' });
    expect(failing.preferences.value.showQuickSends).toBe(false);
  });
  it('sanitizes corrupted stored data and drops reserved/duplicate bindings', () => {
    localStorage.setItem('yeaft:user-shortcuts:v1:owner-a', JSON.stringify({ bindings: {
      terminal: 'Ctrl+T', files: 'Ctrl+Shift+O', git: 'ctrl+shift+o', quickSend1: 'Alt+Shift+1',
    } }));
    expect(create().preferences.value.bindings).toMatchObject({ terminal: '', files: 'Ctrl+Shift+O', git: '', quickSend1: 'Alt+Shift+1' });
  });
});

describe('keyboard validation and matching', () => {
  it.each(['T', 'W', 'N', 'L', 'R', 'P', 'F', 'G', 'S', 'O'])('rejects Ctrl/Meta+%s browser/project collisions', letter => {
    for (const modifier of ['Ctrl', 'Meta']) expect(validateShortcut(`${modifier}+${letter}`)).toMatchObject({ valid: false, error: 'reserved' });
  });
  it('normalizes modifiers, accepts recommendations, and rejects bare/malformed keys and duplicates', () => {
    expect(normalizeShortcut('shift+ctrl+y')).toBe('Ctrl+Shift+Y');
    for (const mod of ['Ctrl', 'Meta']) for (const letter of ['Y', 'O', 'G', 'U']) {
      expect(validateShortcut(`${mod}+Shift+${letter}`).valid).toBe(true);
    }
    for (const binding of ['Y', 'Shift+Y', 'Ctrl+Ctrl+Y', 'Ctrl+Escape', 'wat']) expect(validateShortcut(binding).valid).toBe(false);
    expect(validateShortcut('Ctrl+Shift+F').valid).toBe(false);
    expect(validateShortcut('Ctrl+Shift+S').valid).toBe(false);
    expect(validateShortcut('Alt+Shift+1', { terminal: 'alt+shift+1' }, 'quickSend1')).toMatchObject({ valid: false, conflict: 'terminal' });
  });
  it('matches physical Shift+digits and macOS Option letters with exact modifiers', () => {
    const event = key('Alt+Shift+1', { key: '!' });
    expect(shortcutFromEvent(event)).toBe('Alt+Shift+1');
    expect(matchShortcut(event, 'Alt+Shift+1')).toBe(true);
    expect(matchShortcut(event, 'Alt+1')).toBe(false);
    expect(matchShortcut(key('Meta+Shift+Y', { key: 'Ÿ' }), 'Meta+Shift+Y')).toBe(true);
  });
  it.each([{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { key: 'Dead' }])('ignores repeat/IME events %j', extra => {
    expect(matchShortcut(key('Ctrl+Shift+Y', extra), 'Ctrl+Shift+Y')).toBe(false);
  });
  it('does not match previously handled events or empty bindings', () => {
    const event = key('Ctrl+Shift+Y'); event.preventDefault();
    expect(matchShortcut(event, 'Ctrl+Shift+Y')).toBe(false);
    expect(matchShortcut(key('Alt+Shift+1'), '')).toBe(false);
  });
});

describe('global action availability and focus ownership', () => {
  it('requires online exact route capabilities and the mounted view', () => {
    for (const action of ['terminal', 'files', 'git', 'newSession']) expect(isGlobalShortcutAvailable(action, store, globals.auth)).toBe(true);
    expect(isGlobalShortcutAvailable('quickSend1', store, globals.auth)).toBe(false);
    const variants = [
      { connectionState: 'reconnecting' }, { authenticated: false }, { currentView: 'settings' },
      { workCenterOpen: true }, { pluginCenterOpen: true }, { currentAgent: 'other' },
      { agents: [{ id: 'agent-a', online: false }] },
      { activeSessionRoute: { ...store.activeSessionRoute, agentId: 'other' } },
      { currentAgentInfo: { id: 'other' } }, { workbenchRouteProtocolSupported: false },
      { hasCapability: () => false }, { currentView: 'chat', isSplitMode: true },
      { agents: [{ id: 'agent-a', online: true, capabilities: ['terminal'] }] },
    ];
    for (const variant of variants) expect(isGlobalShortcutAvailable('terminal', { ...store, ...variant }, globals.auth)).toBe(false);
    expect(isGlobalShortcutAvailable('files', { ...store, currentView: 'chat' }, { ...globals.auth, role: 'user' })).toBe(false);
    expect(isGlobalShortcutAvailable('newSession', { ...store, activeSessionRoute: null }, globals.auth)).toBe(true);
  });
  it.each(['input', 'textarea', 'select', '[contenteditable]', '.monaco-editor', '.cm-editor', '.xterm'])('leaves %s focus alone', selector => {
    const element = document.createElement(selector.startsWith('.') || selector.startsWith('[') ? 'div' : selector);
    if (selector[0] === '.') element.className = selector.slice(1);
    if (selector[0] === '[') element.setAttribute('contenteditable', 'true');
    document.body.append(element);
    expect(isGlobalShortcutFocusBlocked({ target: element })).toBe(true);
  });
  it('blocks visible modals but not hidden settings, and never dispatches quick sends', () => {
    const modal = document.createElement('div'); modal.className = 'settings-overlay'; document.body.append(modal);
    expect(isGlobalShortcutFocusBlocked(key('Ctrl+Shift+Y'))).toBe(true);
    modal.style.display = 'none';
    expect(isGlobalShortcutFocusBlocked(key('Ctrl+Shift+Y'))).toBe(false);
    const execute = vi.fn(() => true);
    const context = { preferences: { bindings: { terminal: 'Ctrl+Shift+Y', quickSend1: 'Alt+Shift+1' } }, store, auth: globals.auth, execute };
    const event = key('Ctrl+Shift+Y');
    expect(handleGlobalShortcut(event, context)).toBe('terminal');
    expect(event.defaultPrevented).toBe(true);
    expect(handleGlobalShortcut(key('Alt+Shift+1'), context)).toBe(null);
    expect(execute).toHaveBeenCalledOnce();
    expect(handleGlobalShortcut(key('Ctrl+Shift+Y'), { ...context, execute: () => false })).toBe(null);
  });
});

describe('General settings and App runtime integration', () => {
  it('records, explains conflicts, clears and resets with accessible keyboard controls', async () => {
    shared();
    const wrapper = render(UserShortcutsSettings);
    await wrapper.find('input').setValue(true);
    expect(shared().preferences.value.showQuickSends).toBe(true);
    const record = wrapper.findAll('.user-shortcuts-record')[0];
    await record.trigger('click');
    record.element.dispatchEvent(key('Ctrl+T'));
    await Vue.nextTick();
    expect(wrapper.find('[role="alert"]').text()).toContain('conflicts');
    record.element.dispatchEvent(key('Ctrl+Shift+Y'));
    await Vue.nextTick();
    expect(shared().preferences.value.bindings.terminal).toBe('Ctrl+Shift+Y');
    expect(record.attributes('aria-pressed')).toBe('false');
    await wrapper.find('.user-shortcuts-controls .btn-ghost').trigger('click');
    expect(shared().preferences.value.bindings.terminal).toBe('');
    await wrapper.find('.user-shortcuts-settings > .btn-secondary').trigger('click');
    expect(shared().preferences.value).toEqual(defaultUserShortcuts());
  });
  it('mounts standard session creation and dispatches acknowledged route-scoped workbench activation', async () => {
    shared().save({ bindings: { terminal: 'Ctrl+Shift+Y', newSession: 'Ctrl+Shift+U' } });
    const wrapper = render(UserShortcutsRuntime);
    const accept = vi.fn(event => { event.detail.accepted = true; });
    window.addEventListener('workbench-open-capability', accept);
    try {
      const event = key('Ctrl+Shift+Y'); document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(accept.mock.calls[0][0].detail).toMatchObject({ capabilityId: 'terminal', routeKey: 'yeaft:agent-a:session-a' });
      document.dispatchEvent(key('Ctrl+Shift+U'));
      await Vue.nextTick();
      expect(wrapper.find('[role="dialog"]').text()).toBe('agent-a');
      globals.auth.userId = 'owner-b';
      await Vue.nextTick();
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    } finally { window.removeEventListener('workbench-open-capability', accept); }
  });
  it('keeps bilingual keys aligned and wires the workbench listener with cleanup', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    const panel = readFileSync('web/components/WorkbenchPanel.js', 'utf8');
    expect(panel).toContain("window.addEventListener('workbench-open-capability', handleOpenCapability)");
    expect(panel).toContain("window.removeEventListener('workbench-open-capability', handleOpenCapability)");
    expect(panel).toContain('detail.routeKey !== activeRouteKey.value');
    const settings = readFileSync('web/components/SettingsPanel.js', 'utf8');
    expect(settings).toContain('<UserShortcutsSettings />');
  });
});
