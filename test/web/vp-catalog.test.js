// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { buildVpDomainSections, isLegacyVp, RECOMMENDED_VP_IDS, selectVpCatalog } from '../../web/utils/vp-domains.js';
import { buildVpMentionSections, filterVpMentions, selectMentionCandidates } from '../../web/components/VpMentionAutocomplete.js';
import { STOCK_VP_IDS } from '../../agent/yeaft/vp/stock-ids.js';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';

// Exercise the real stores' getters/actions without the browser-only Pinia loader.
const stores = new Map();
globalThis.Pinia = { defineStore: (id, options) => () => {
  if (stores.has(id)) return stores.get(id);
  const store = Vue.reactive(options.state());
  for (const [key, getter] of Object.entries(options.getters || {})) {
    Object.defineProperty(store, key, { get: () => getter.call(store, store) });
  }
  for (const [key, action] of Object.entries(options.actions || {})) store[key] = action.bind(store);
  stores.set(id, store);
  return store;
} };
const { useVpStore } = await import('../../web/stores/vp.js');
const { useSessionsStore } = await import('../../web/stores/sessions.js');
const { useChatStore } = await import('../../web/stores/chat.js');
const { useAuthStore } = await import('../../web/stores/auth.js');
const { default: VpCrudPanel } = await import('../../web/components/VpCrudPanel.js');
const { default: SessionCreateModal } = await import('../../web/components/SessionCreateModal.js');
const { default: SessionSettingsModal } = await import('../../web/components/SessionSettingsModal.js');
const { default: ChatInput } = await import('../../web/components/ChatInput.js');

const ids = list => list.map(vp => vp.vpId);
const library = () => [
  ...[...STOCK_VP_IDS].map(vpId => ({ vpId, displayName: vpId, role: 'Assistant', isStock: true })),
  { vpId: 'my-assistant', displayName: 'My assistant', role: 'Custom task' },
];
let wrapper, chat, vp, sessions;
const t = key => en[key] || key;
const globalOptions = { mocks: { $t: t }, stubs: { ModernSelect: true, FolderPickerDialog: true, VpAvatar: true } };
beforeEach(() => {
  vi.stubGlobal('Vue', Vue);
  localStorage.clear();
  stores.clear();
  vp = useVpStore();
  sessions = useSessionsStore();
  vp.beginSnapshot('a', 'initial');
  vp.applySnapshot({ vps: library() }, 'a', 'initial');
  sessions.applySnapshot([{ id: 'legacy', name: 'Old team', roster: ['linus', 'martin'], defaultVpId: 'linus', workDir: '/repo', announcement: 'Keep facts' }], 'a');
  chat = Vue.reactive({ currentView: 'yeaft', yeaftActiveSessionFilter: 'legacy', inputDrafts: {},
    currentAgent: 'a', agents: [{ id: 'a', online: true }, { id: 'b', online: true }],
    sendWsMessage: vi.fn(() => true), sessionCrudRequest: vi.fn(async () => ({ ok: true })),
    createYeaftSession: vi.fn(async () => ({ ok: true, session: { id: 'created' } })), setActiveSessionFilter: vi.fn(),
  });
  window.Pinia = { useChatStore: () => chat, useVpStore, useSessionsStore };
  vi.stubGlobal('Pinia', { ...globalThis.Pinia, ...window.Pinia, useAuthStore: () => ({}) });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = null;
  document.body.innerHTML = '';
  delete window.Pinia;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function render(component, props = {}) {
  wrapper = mount(component, { props, attachTo: document.body, global: globalOptions });
  return wrapper;
}
function member(id) {
  return [...document.querySelectorAll('.group-settings-roster-item')].find(row => row.querySelector('input').value === id);
}

describe('Scenario VP catalog compatibility', () => {
  it('recommends exactly five shipped identities and custom entries without deleting legacy records', () => {
    const full = library();
    const before = structuredClone(full);
    expect(ids(selectVpCatalog(full))).toEqual([...RECOMMENDED_VP_IDS, 'my-assistant']);
    // Older Agents lack isStock; every shipped historical identity is still classified.
    for (const vpId of STOCK_VP_IDS) expect(isLegacyVp({ vpId })).toBe(!RECOMMENDED_VP_IDS.includes(vpId));
    expect(ids(selectVpCatalog(full.map(({ isStock, ...vp }) => vp)))).toEqual([...RECOMMENDED_VP_IDS, 'my-assistant']);
    const withFuture = [...full, { vpId: 'future-stock', isStock: true }, { vpId: 'future-custom', isStock: false }];
    expect(ids(selectVpCatalog(withFuture))).toContain('future-custom');
    expect(ids(selectVpCatalog(withFuture))).not.toContain('future-stock');
    expect(ids(selectVpCatalog(full, { includeIds: ['linus', 'missing', 'user'] }))).toEqual([...RECOMMENDED_VP_IDS, 'linus', 'my-assistant', 'missing']);
    expect(selectVpCatalog(full, { showLegacy: true })).toHaveLength(full.length);
    expect(full).toEqual(before);
    expect(selectVpCatalog(null, { includeIds: null })).toEqual([]);
    for (const section of buildVpDomainSections(full)) {
      expect(en[section.labelKey]).toBeTruthy(); expect(zh[section.labelKey]).toBeTruthy();
    }
  });

  it('keeps old Session members mentionable while explicit library searches can find hidden VPs', () => {
    const full = library();
    expect(ids(selectMentionCandidates(full, null))).toEqual([...RECOMMENDED_VP_IDS, 'my-assistant']);
    expect(ids(filterVpMentions(selectMentionCandidates(full, null, 'lin'), 'lin'))).toEqual(['linus']);
    const old = selectMentionCandidates(full, { roster: ['linus', 'martin'] });
    expect(new Set(ids(filterVpMentions(old, '')))).toEqual(new Set(['linus', 'martin']));
    expect(selectMentionCandidates(full, { roster: [] })).toEqual([]);
    expect(filterVpMentions(old, 'software')).toEqual([]);
    const ordered = filterVpMentions(full, '');
    expect(buildVpMentionSections(ordered).flatMap(section => section.items.map(item => item.vp))).toEqual(ordered);
    expect(buildVpMentionSections(ordered).flatMap(section => section.items.map(item => item.flatIndex))).toEqual(ordered.map((_, index) => index));
  });

  it('shows the recommended creation picker but preserves an explicitly selected legacy VP when collapsed', async () => {
    render(SessionCreateModal, { initialAgentId: 'a' });
    await wrapper.setData({ vpRosterOpen: true });
    expect([...document.querySelectorAll('.yeaft-roster-row input')].map(input => input.value)).toEqual([...RECOMMENDED_VP_IDS, 'my-assistant']);
    expect(wrapper.vm.form.vpIds).toEqual(['omni']);
    const toggle = document.querySelector('.vp-catalog-legacy-toggle');
    toggle.click(); await Vue.nextTick();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const old = document.querySelector('input[value="linus"]');
    old.checked = true; old.dispatchEvent(new Event('change', { bubbles: true }));
    await Vue.nextTick();
    wrapper.vm.form.defaultVpId = 'linus';
    toggle.click(); await Vue.nextTick();
    expect(document.querySelector('input[value="linus"]').checked).toBe(true);
    expect(document.querySelector('input[value="martin"]')).toBeNull();
    await wrapper.vm.onSubmit();
    expect(chat.createYeaftSession).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: 'a', vpIds: ['omni', 'linus'], defaultVpId: 'linus' }));
  });

  it('retains existing legacy and missing members through unrelated settings and adding a scenario assistant', async () => {
    sessions.applyRosterChange({ sessionId: 'legacy', roster: ['linus', 'martin', 'missing'], defaultVpId: 'linus' }, 'a');
    render(SessionSettingsModal, { groupId: 'legacy', agentId: 'a', initialSection: 'members' });
    expect(member('linus').querySelector('input').checked).toBe(true);
    expect(member('martin').querySelector('input').checked).toBe(true);
    expect(member('missing').textContent).toContain('missing');
    expect(member('steve')).toBeUndefined();
    expect(member('linus').querySelector('[aria-pressed="true"]')).not.toBeNull();
    expect(document.body.textContent).toContain(en['yeaft.vp.catalog.legacyMembers']);
    await wrapper.setData({ renameDraft: 'Renamed', announcementDraft: 'New note', workDirDraft: '/other' });
    await wrapper.vm.saveRename(); await wrapper.vm.saveAnnouncement(); await wrapper.vm.saveWorkDir();
    expect(chat.sessionCrudRequest.mock.calls.map(call => call[0])).toEqual(['rename', 'update', 'update']);
    expect(sessions.sessionById('legacy', 'a').roster).toEqual(['linus', 'martin', 'missing']);
    expect(sessions.sessionById('legacy', 'a').defaultVpId).toBe('linus');
    await wrapper.vm.toggleMember('software-omni', true);
    expect(chat.sessionCrudRequest).toHaveBeenLastCalledWith('add_member', { sessionId: 'legacy', vpId: 'software-omni' }, { agentId: 'a' });
    sessions.applyRosterChange({ sessionId: 'legacy', roster: ['linus', 'martin', 'missing', 'software-omni'] }, 'a');
    await Vue.nextTick();
    expect(member('linus').querySelector('input').checked).toBe(true);
    expect(member('software-omni').querySelector('input').checked).toBe(true);
    expect(wrapper.vm.defaultVpId).toBe('linus');
    await wrapper.vm.toggleMember('linus', false);
    expect(chat.sessionCrudRequest).toHaveBeenLastCalledWith('remove_member', { sessionId: 'legacy', vpId: 'linus' }, { agentId: 'a' });
    sessions.applyRosterChange({ sessionId: 'legacy', roster: ['martin', 'missing', 'software-omni'], defaultVpId: 'martin' }, 'a');
    await Vue.nextTick();
    expect(member('linus')).toBeUndefined();
    document.querySelector('.vp-catalog-legacy-toggle').click(); await Vue.nextTick();
    expect(member('linus').querySelector('input').checked).toBe(false);
  });

  it('keeps the active Session identity and @ picker while settings loads another Agent and after closing', async () => {
    sessions.applySnapshot([{ id: 'legacy', name: 'B team', roster: ['grace'], defaultVpId: 'grace' }], 'b');
    const composer = mount(ChatInput, { global: { ...globalOptions, stubs: { ...globalOptions.stubs,
      MessageComposer: { template: '<div><slot name="overlays" /></div>' },
    } } });
    try {
      composer.vm.inputText = '@'; composer.vm.handleInput(); await Vue.nextTick();
      expect(ids(composer.vm.mentionVpCandidates)).toEqual(['linus', 'martin']);
      expect(composer.text()).toContain('linus');
      render(SessionSettingsModal, { groupId: 'legacy', agentId: 'b', initialSection: 'members' });
      expect(chat.sendWsMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'yeaft_vp_subscribe', agentId: 'b', requestId: expect.any(String) }));
      const requestId = vp.snapshotForAgent('b').snapshotRequestId;
      expect(vp.snapshotAgentId).toBe('a');
      expect(vp.applySnapshot({ vps: library() }, 'a', 'initial')).toBe(true);
      expect(vp.applySnapshot({ vps: [{ vpId: 'grace', displayName: 'B Grace', description: 'B role' }, { vpId: 'omni' }] }, 'b', requestId)).toBe(true);
      await Vue.nextTick();
      expect(member('grace').textContent).toContain('B Grace');
      expect(member('grace').textContent).toContain('B role');
      expect(member('linus')).toBeUndefined();
      expect(vp.vpLabel('linus')).toBe('linus');
      expect(vp.vps.grace.displayName).not.toBe('B Grace');
      expect(ids(composer.vm.mentionVpCandidates)).toEqual(['linus', 'martin']);
      expect(composer.text()).not.toContain('B Grace');
      await wrapper.vm.toggleMember('omni', true);
      expect(chat.sessionCrudRequest).toHaveBeenLastCalledWith('add_member', { sessionId: 'legacy', vpId: 'omni' }, { agentId: 'b' });
      wrapper.vm.requestClose();
      expect(wrapper.emitted('close')).toHaveLength(1);
      wrapper.unmount(); wrapper = null;
      expect(vp.applySnapshot({ vps: library().map(record => record.vpId === 'linus' ? { ...record, displayName: 'A Linus updated' } : record) }, 'a', 'initial')).toBe(true);
      await Vue.nextTick();
      expect(vp.vpLabel('linus')).toBe('A Linus updated');
      expect(composer.text()).toContain('A Linus updated');
      expect(ids(composer.vm.mentionVpCandidates)).toEqual(['linus', 'martin']);
    } finally { composer.unmount(); }
  });

  it('surfaces retryable target library timeouts and rejects stale/wrong-Agent errors without poisoning the active roster', async () => {
    vi.useFakeTimers();
    sessions.applySnapshot([{ id: 'legacy', roster: ['grace'], defaultVpId: 'grace' }], 'b');
    render(SessionSettingsModal, { groupId: 'legacy', agentId: 'b', initialSection: 'members' });
    const requestId = vp.snapshotForAgent('b').snapshotRequestId;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vp.snapshotForAgent('b').snapshotStatus).toBe('error');
    expect(vp.snapshotStatus).toBe('ready');
    expect(document.querySelector('[role="alert"]').textContent).toContain(en['yeaft.session.create.rosterError']);
    document.querySelector('[role="alert"] button').click(); await Vue.nextTick();
    const retryId = vp.snapshotForAgent('b').snapshotRequestId;
    expect(retryId).not.toBe(requestId);
    expect(vp.snapshotForAgent('b').snapshotStatus).toBe('loading');
    expect(vp.failSnapshot('b', requestId, 'late timeout')).toBe(false);
    expect(vp.failSnapshot('a', retryId, 'wrong Agent')).toBe(false);
    expect(vp.failSnapshot('b', null, 'uncorrelated')).toBe(false);
    expect(vp.applySnapshot({ vps: [{ vpId: 'stale' }] }, 'b', requestId)).toBe(false);
    expect(vp.applySnapshot({ vps: [{ vpId: 'grace', displayName: 'Legacy B Grace' }] }, 'b')).toBe(true);
    await Vue.nextTick();
    expect(member('grace').textContent).toContain('Legacy B Grace');
    expect(vp.snapshotStatus).toBe('ready');
    expect(vp.snapshotAgentId).toBe('a');
    expect(vp.vps.linus).toBeTruthy();
    expect(sessions.sessionById('legacy', 'a').roster).toEqual(['linus', 'martin']);
    expect(chat.sessionCrudRequest).not.toHaveBeenCalled();
  });

  it('routes live updates/removals to the target cache and keeps it available on settings retarget', async () => {
    sessions.applySnapshot([{ id: 'legacy', roster: ['grace'], defaultVpId: 'grace' }], 'b');
    render(SessionSettingsModal, { groupId: 'legacy', agentId: 'b', initialSection: 'members' });
    const requestId = vp.snapshotForAgent('b').snapshotRequestId;
    vp.applySnapshot({ vps: [{ vpId: 'grace', displayName: 'B Grace' }, { vpId: 'omni' }] }, 'b', requestId);
    vp.upsert({ vpId: 'grace', displayName: 'B Grace live' }, 'persona.edit', 'b');
    vp.remove('omni', 'file.removed', 'b');
    await Vue.nextTick();
    expect(member('grace').textContent).toContain('B Grace live');
    expect(member('omni')).toBeUndefined();
    expect(vp.vps.omni).toBeTruthy();
    expect(vp.lastChange).toBeNull();
    vp.upsert({ vpId: 'linus', displayName: 'A Linus live' }, 'persona.edit', 'a');
    await wrapper.setProps({ agentId: 'a' });
    expect(member('linus').textContent).toContain('A Linus live');
    expect(vp.snapshotAgentId).toBe('a');
    expect(vp.applySnapshot({ vps: [{ vpId: 'grace', displayName: 'Background B' }] }, 'b', requestId)).toBe(true);
    await Vue.nextTick();
    expect(member('grace')).toBeUndefined();
    expect(vp.vps.linus.displayName).toBe('A Linus live');
    await wrapper.setProps({ agentId: 'b' });
    expect(member('grace').textContent).toContain('Background B');
    expect(chat.sendWsMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps create-Agent requests local and scopes websocket failures and retries', async () => {
    render(SessionCreateModal, { initialAgentId: 'a' });
    await wrapper.setData({ form: { ...wrapper.vm.form, agentId: 'b' }, vpRosterOpen: true });
    const requestId = vp.snapshotForAgent('b').snapshotRequestId;
    expect(vp.snapshotAgentId).toBe('a');
    expect(vp.vps.linus).toBeTruthy();
    expect(vp.applySnapshot({ vps: [{ vpId: 'omni', displayName: 'B Omni' }] }, 'b', requestId)).toBe(true);
    await Vue.nextTick();
    expect(document.querySelector('.yeaft-roster-name').textContent).toBe('B Omni');
    expect(vp.vpLabel('omni')).toBe('omni');
    chat.sendWsMessage.mockReturnValueOnce(false);
    wrapper.vm.retryVpSnapshot(); await Vue.nextTick();
    expect(vp.snapshotForAgent('b').snapshotStatus).toBe('error');
    expect(document.querySelector('[role="alert"]').textContent).toContain(en['yeaft.session.create.rosterError']);
    expect(vp.snapshotStatus).toBe('ready');
    expect(vp.applySnapshot({ vps: [{ vpId: 'stale' }] }, 'b', requestId)).toBe(false);
    wrapper.vm.retryVpSnapshot();
    const retryId = vp.snapshotForAgent('b').snapshotRequestId;
    expect(vp.failSnapshot('b', requestId, 'late failure')).toBe(false);
    expect(vp.applySnapshot({ vps: [{ vpId: 'omni', displayName: 'B Omni refreshed' }] }, 'b', retryId)).toBe(true);
    await Vue.nextTick();
    expect(wrapper.vm.form.vpIds).toEqual(['omni']);
    await wrapper.setData({ form: { ...wrapper.vm.form, agentId: 'a' } });
    expect(wrapper.vm.vpLabelFor('omni')).toBe('omni');
    expect(vp.snapshotAgentId).toBe('a');
  });

  it('submits the entire pinned selection and default after partial hydration, validation failure and retry', async () => {
    render(SessionCreateModal, { initialAgentId: 'a' });
    await wrapper.setData({ vpRosterOpen: true });
    wrapper.vm.toggleVp('linus', true);
    wrapper.vm.form.defaultVpId = 'linus';
    vp.applySnapshot({ vps: [{ vpId: 'omni' }] }, 'a', 'initial');
    await Vue.nextTick();
    expect(document.querySelector('input[value="linus"]').checked).toBe(true);
    chat.createYeaftSession.mockResolvedValueOnce({ ok: false, error: { code: 'vp_not_found', message: 'linus is unavailable' } });
    await wrapper.vm.onSubmit();
    expect(chat.createYeaftSession).toHaveBeenLastCalledWith(expect.objectContaining({ vpIds: ['omni', 'linus'], defaultVpId: 'linus' }));
    expect(wrapper.vm.submitError).toBeTruthy();
    expect(wrapper.vm.form.vpIds).toEqual(['omni', 'linus']);
    expect(wrapper.vm.form.defaultVpId).toBe('linus');
    wrapper.vm.retryVpSnapshot();
    expect(wrapper.vm.canSubmit).toBe(false);
    expect(wrapper.vm.form.vpIds).toEqual(['omni', 'linus']);
    vp.applySnapshot({ vps: library() }, 'a', vp.snapshotForAgent('a').snapshotRequestId);
    await Vue.nextTick();
    expect(document.querySelector('input[value="linus"]').checked).toBe(true);
    expect(wrapper.vm.form.defaultVpId).toBe('linus');
    await wrapper.vm.onSubmit();
    expect(chat.createYeaftSession).toHaveBeenLastCalledWith(expect.objectContaining({ vpIds: ['omni', 'linus'], defaultVpId: 'linus' }));
  });

  it('never reseeds an existing create selection when live removal makes its metadata unavailable', async () => {
    render(SessionCreateModal, { initialAgentId: 'a' });
    await wrapper.setData({ vpRosterOpen: true, form: { ...wrapper.vm.form, vpIds: ['omni', 'linus'], defaultVpId: 'linus' } });
    // Even before a user toggle marks the picker touched, hydration cannot change
    // a selection already represented by checked rows.
    expect(wrapper.vm.vpPickerTouched).toBe(false);
    vp.remove('linus', 'file.removed', 'a');
    await Vue.nextTick();
    expect(document.querySelector('input[value="linus"]').checked).toBe(true);
    expect(wrapper.vm.form.vpIds).toEqual(['omni', 'linus']);
    expect(wrapper.vm.form.defaultVpId).toBe('linus');
    await wrapper.vm.onSubmit();
    expect(chat.createYeaftSession).toHaveBeenLastCalledWith(expect.objectContaining({ vpIds: ['omni', 'linus'], defaultVpId: 'linus' }));
    wrapper.vm.toggleVp('linus', false);
    expect(wrapper.vm.form.vpIds).toEqual(['omni']);
    expect(wrapper.vm.form.defaultVpId).toBe('omni');
  });

  it('never projects a modal snapshot into an uninitialized active view and isolates same-Agent correlated refreshes', () => {
    vp.beginSnapshot(null, null);
    vp.beginSnapshot('b', 'target-b', { target: true });
    expect(vp.applySnapshot({ vps: [{ vpId: 'omni', displayName: 'B Omni' }] }, 'b', 'target-b')).toBe(true);
    expect(vp.vpList).toEqual([]);
    expect(vp.snapshotAgentId).toBeNull();
    expect(vp.applySnapshot({ vps: library() }, 'a')).toBe(true);
    vp.beginSnapshot('a', 'refresh-a', { target: true });
    expect(vp.applySnapshot({ vps: [{ vpId: 'omni', displayName: 'A refreshed' }] }, 'a', 'refresh-a')).toBe(true);
    expect(vp.snapshotAgentId).toBe('a');
    expect(vp.vps.linus).toBeTruthy();
    expect(vp.vpLabel('omni', 'a')).toBe('A refreshed');
    vp.beginSnapshot('a', 'retry-a', { target: true });
    expect(vp.applySnapshot({ vps: [{ vpId: 'stale' }] }, 'a', 'refresh-a')).toBe(false);
    expect(vp.failSnapshot('a', 'refresh-a', 'late failure')).toBe(false);
    expect(vp.snapshotStatus).toBe('ready');
    expect(vp.vps.linus).toBeTruthy();
    vp.applySnapshot({ vps: [{ vpId: 'omni', displayName: 'A retried' }] }, 'a', 'retry-a');
    vp.upsert({ vpId: 'omni', displayName: 'A live' }, 'manual.reload', 'a');
    expect(vp.vpLabel('omni')).toBe('A live');
    expect(vp.vpLabel('omni', 'a')).toBe('A live');
  });

  it('promotes only an actually activated Agent library and continues receiving scoped wire updates', async () => {
    const realChat = useChatStore();
    realChat.currentAgent = 'a';
    render(SessionCreateModal, { initialAgentId: 'b' });
    const requestId = vp.snapshotForAgent('b').snapshotRequestId;
    realChat.handleYeaftOutput({ agentId: 'b', requestId,
      event: { type: 'vp_snapshot', vps: [{ vpId: 'omni', displayName: 'B Omni' }] } });
    expect(vp.snapshotAgentId).toBe('a');
    expect(vp.vps.linus).toBeTruthy();
    realChat.activateYeaftAgent('b');
    expect(vp.snapshotAgentId).toBe('b');
    expect(vp.vpLabel('omni')).toBe('B Omni');
    expect(vp.vps.linus).toBeUndefined();
    realChat.handleYeaftOutput({ agentId: 'b', event: { type: 'vp_updated', vp: { vpId: 'omni', displayName: 'B live' } } });
    expect(vp.vpLabel('omni')).toBe('B live');
    realChat.activateYeaftAgent('a');
    expect(vp.snapshotAgentId).toBe('a');
    expect(vp.vps.linus).toBeTruthy();
    realChat.handleYeaftOutput({ agentId: 'b', event: { type: 'vp_removed', vpId: 'omni' } });
    expect(vp.vps.omni).toBeTruthy();
    expect(vp.vpListForAgent('b')).toEqual([]);
    realChat.handleYeaftOutput({ agentId: 'a', event: { type: 'vp_snapshot', vps: library() } });
    expect(vp.snapshotAgentId).toBe('a');
    expect(vp.vps.linus).toBeTruthy();
  });

  it('keeps active and cached list ordering coherent across Agent switches, removals and new custom VPs', () => {
    vp.applySnapshot({ vps: [{ vpId: 'omni' }, { vpId: 'remove-me' }] }, 'a', 'initial');
    vp.beginSnapshot('b', 'b-list', { target: true });
    vp.applySnapshot({ vps: [{ vpId: 'omni', displayName: 'B Omni' }] }, 'b', 'b-list');
    vp.activateAgent('b'); vp.activateAgent('a');
    vp.remove('remove-me', 'file.removed', 'a');
    vp.upsert({ vpId: 'new-custom', displayName: 'New custom' }, 'file.added', 'a');
    expect(ids(vp.vpList)).toEqual(['omni', 'new-custom']);
    expect(ids(vp.vpListForAgent('a'))).toEqual(['omni', 'new-custom']);
    vp.activateAgent('b'); vp.activateAgent('a');
    expect(ids(vp.vpList)).toEqual(['omni', 'new-custom']);
    expect(vp.vpLabel('new-custom')).toBe('New custom');
  });

  it('fails closed for double-unstamped legacy frames with multiple Agent scopes but accepts a unique scope', () => {
    expect(vp.applySnapshot({ vps: [{ vpId: 'omni', displayName: 'Unique A' }] })).toBe(true);
    vp.beginSnapshot('b', 'pending-b', { target: true });
    expect(vp.applySnapshot({ vps: [{ vpId: 'omni', displayName: 'Ambiguous B' }] })).toBe(false);
    expect(vp.upsert({ vpId: 'omni', displayName: 'Ambiguous live' })).toBe(false);
    expect(vp.remove('omni')).toBe(false);
    expect(vp.vpLabel('omni')).toBe('Unique A');
    expect(vp.snapshotForAgent('b').snapshotStatus).toBe('loading');
    expect(vp.applySnapshot({ vps: [{ vpId: 'omni', displayName: 'Stamped B' }] }, 'b')).toBe(true);
    expect(vp.vpLabel('omni')).toBe('Unique A');
    expect(vp.vpLabel('omni', 'b')).toBe('Stamped B');
  });

  it('discards active and background private libraries on auth reset and rejects their late correlated replies', () => {
    const auth = useAuthStore();
    vp.beginSnapshot('b', 'private-b', { target: true });
    vp.applySnapshot({ vps: [{ vpId: 'private-b', displayName: 'Private B identity' }] }, 'b', 'private-b');
    chat._yeaftVpSubscribedAgentKey = 'a';
    expect(vp.vps.linus).toBeTruthy();
    expect(vp.vpListForAgent('b')).toHaveLength(1);
    auth.reset();
    expect(vp.vpList).toEqual([]);
    expect(vp.targetSnapshots).toEqual({});
    expect(vp.snapshotStatus).toBe('idle');
    expect(chat._yeaftVpSubscribedAgentKey).toBeNull();
    expect(vp.applySnapshot({ vps: [{ vpId: 'private-b' }] }, 'b', 'private-b')).toBe(false);
    expect(vp.applySnapshot({ vps: library() }, 'a', 'initial')).toBe(false);
    expect(vp.applySnapshot({ vps: [{ vpId: 'late-private' }] })).toBe(false);
    expect(vp.upsert({ vpId: 'late-private' }, null, 'a')).toBe(false);
    expect(vp.vpList).toEqual([]);
    auth.userId = 'owner-a'; auth.token = 'owner-token'; auth.isAuthenticated = true;
    vp.beginSnapshot('a', 'new-owner-library');
    vp.applySnapshot({ vps: library() }, 'a', 'new-owner-library');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200,
      headers: { get: () => null }, json: async () => ({ userId: 'owner-b', role: 'pro' }) })));
    return auth.refreshSession().then(ok => {
      expect(ok).toBe(true);
      expect(auth.userId).toBe('owner-b');
      expect(vp.vpList).toEqual([]);
      expect(vp.targetSnapshots).toEqual({});
    });
  });

  it('keeps prompt detail and legacy expansion available in the VP library', async () => {
    vp.request = vi.fn(async () => ({ ok: true, vp: { vpId: 'linus', isStock: true, persona: 'Original soul' } }));
    // The panel detail request goes through chat's existing VP CRUD API.
    chat.vpCrudRequest = vi.fn(async () => ({ ok: true, vp: { vpId: 'linus', isStock: true, persona: 'Original soul' } }));
    render(VpCrudPanel);
    expect(wrapper.findAll('.vp-crud-card')).toHaveLength(RECOMMENDED_VP_IDS.length + 1);
    await wrapper.get('.vp-catalog-legacy-toggle').trigger('click');
    expect(wrapper.findAll('.vp-crud-card')).toHaveLength(library().length);
    await wrapper.vm.startView(vp.vps.linus);
    await flushPromises();
    expect(wrapper.vm.view).toBe('detail');
    expect(wrapper.vm.detail?.vpId).toBe('linus');
    expect(vp.vps.linus).toBeTruthy();
  });

  it('clears only an explicitly null default after the last removal and preserves omitted fields and other Agents', () => {
    sessions.applySnapshot([{ id: 'legacy', roster: ['grace'], defaultVpId: 'grace' }], 'b');
    sessions.applyRosterChange({ sessionId: 'legacy', roster: ['martin'] }, 'a');
    expect(sessions.sessionById('legacy', 'a').defaultVpId).toBe('linus');
    sessions.applyRosterChange({ sessionId: 'legacy', roster: [], defaultVpId: null }, 'a');
    expect(sessions.sessionById('legacy', 'a')).toMatchObject({ roster: [], defaultVpId: null });
    expect(sessions.sessionById('legacy', 'b')).toMatchObject({ roster: ['grace'], defaultVpId: 'grace' });
  });
});
