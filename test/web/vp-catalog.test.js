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
const { default: VpCrudPanel } = await import('../../web/components/VpCrudPanel.js');
const { default: SessionCreateModal } = await import('../../web/components/SessionCreateModal.js');
const { default: SessionSettingsModal } = await import('../../web/components/SessionSettingsModal.js');

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
  chat = Vue.reactive({ currentAgent: 'a', agents: [{ id: 'a', online: true }, { id: 'b', online: true }],
    sendWsMessage: vi.fn(() => true), sessionCrudRequest: vi.fn(async () => ({ ok: true })),
    createYeaftSession: vi.fn(async () => ({ ok: true, session: { id: 'created' } })), setActiveSessionFilter: vi.fn(),
  });
  window.Pinia = { useChatStore: () => chat, useVpStore, useSessionsStore };
});
afterEach(() => {
  wrapper?.unmount(); wrapper = null;
  document.body.innerHTML = '';
  delete window.Pinia;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
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

  it('loads the target Agent library, rejects stale snapshots and scopes all member mutations', async () => {
    sessions.applySnapshot([{ id: 'legacy', name: 'B team', roster: ['grace'], defaultVpId: 'grace' }], 'b');
    render(SessionSettingsModal, { groupId: 'legacy', agentId: 'b', initialSection: 'members' });
    expect(chat.sendWsMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'yeaft_vp_subscribe', agentId: 'b', requestId: expect.any(String) }));
    expect(member('linus')).toBeUndefined();
    const requestId = vp.snapshotRequestId;
    expect(vp.applySnapshot({ vps: library() }, 'a', 'initial')).toBe(false);
    expect(vp.applySnapshot({ vps: [{ vpId: 'grace', displayName: 'B Grace' }, { vpId: 'omni' }] }, 'b', requestId)).toBe(true);
    await Vue.nextTick();
    expect(member('grace').textContent).toContain('B Grace');
    expect(member('linus')).toBeUndefined();
    await wrapper.vm.toggleMember('omni', true);
    expect(chat.sessionCrudRequest).toHaveBeenLastCalledWith('add_member', { sessionId: 'legacy', vpId: 'omni' }, { agentId: 'b' });
    await wrapper.setProps({ agentId: 'a' });
    expect(vp.snapshotAgentId).toBe('a');
    expect(vp.applySnapshot({ vps: [{ vpId: 'grace', displayName: 'Stale B' }] }, 'b', requestId)).toBe(false);
    vp.applySnapshot({ vps: library() }, 'a', vp.snapshotRequestId);
    await Vue.nextTick();
    expect(member('linus').querySelector('input').checked).toBe(true);
    expect(sessions.sessionById('legacy', 'b').roster).toEqual(['grace']);
  });

  it('surfaces retryable library errors without replacing a saved roster', async () => {
    vi.useFakeTimers();
    vp.beginSnapshot('b', 'pending');
    render(SessionSettingsModal, { groupId: 'legacy', agentId: 'a', initialSection: 'members' });
    const requestId = vp.snapshotRequestId;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vp.snapshotStatus).toBe('error');
    expect(document.querySelector('[role="alert"]').textContent).toContain(en['yeaft.session.create.rosterError']);
    document.querySelector('[role="alert"] button').click(); await Vue.nextTick();
    expect(vp.snapshotRequestId).not.toBe(requestId);
    expect(vp.snapshotStatus).toBe('loading');
    expect(sessions.sessionById('legacy', 'a').roster).toEqual(['linus', 'martin']);
    expect(chat.sessionCrudRequest).not.toHaveBeenCalled();
    wrapper.unmount(); wrapper = null; vi.useRealTimers();
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
