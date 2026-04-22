// @vitest-environment happy-dom
/**
 * task-339-F1 — UnifySidebarV2 Groups section (mount-based).
 */

import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import UnifySidebarV2 from '../../web/components/UnifySidebarV2.js';

function makeGroupsStore(groupList = []) {
  return {
    groupList,
    activeGroupId: groupList[0]?.id || null,
    setActive: vi.fn(),
  };
}

function makeChatStore() {
  return {
    groupCrudRequest: vi.fn().mockResolvedValue({ ok: true }),
    unifyThreads: [],
    unifyTasks: [],
    unifyActiveThreadId: null,
    unifyActiveTaskId: null,
    unifyConversationId: null,
    messagesMap: {},
  };
}

function setupPinia(groupsStore, chatStore) {
  const pinia = {
    useGroupsStore: () => groupsStore,
    useChatStore: () => chatStore,
  };
  window.Pinia = pinia;
  globalThis.Pinia = pinia;
}

const stubs = {
  GroupCreateWizard: {
    name: 'GroupCreateWizard',
    emits: ['close', 'created'],
    template: '<div class="mock-wizard">wizard</div>',
  },
};

const global_ = {
  mocks: {
    $t: (key, params) => {
      if (params && typeof params.count === 'number') return `${params.count} members`;
      return key;
    },
  },
  stubs,
};

describe('UnifySidebarV2 — task-339-F1 Groups section', () => {
  it('hides the Groups section entirely when groupList is empty', () => {
    setupPinia(makeGroupsStore([]), makeChatStore());
    const wrapper = mount(UnifySidebarV2, { global: global_ });
    expect(wrapper.find('.usv2-group-groups').exists()).toBe(false);
  });

  it('renders a fallback "+ new group" CTA button when groupList is empty', async () => {
    setupPinia(makeGroupsStore([]), makeChatStore());
    const wrapper = mount(UnifySidebarV2, { global: global_ });
    const btn = wrapper.find('.usv2-new-group-btn');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    expect(wrapper.vm.groupWizardOpen).toBe(true);
    expect(wrapper.find('.mock-wizard').exists()).toBe(true);
  });

  it('renders Groups section ABOVE the Active Threads section when groups exist', () => {
    setupPinia(
      makeGroupsStore([{ id: 'g1', name: 'Team A', roster: ['a', 'b'], defaultVpId: 'a' }]),
      makeChatStore(),
    );
    const wrapper = mount(UnifySidebarV2, { global: global_ });
    const html = wrapper.html();
    const idxGroups = html.indexOf('usv2-group-groups');
    const idxActiveThreads = html.indexOf('unify.sidebar.activeThreads');
    expect(idxGroups).toBeGreaterThan(-1);
    expect(idxActiveThreads).toBeGreaterThan(-1);
    expect(idxGroups).toBeLessThan(idxActiveThreads);
  });

  it('clicking a group row emits select-group and calls groupsStore.setActive', async () => {
    const groups = makeGroupsStore([
      { id: 'g1', name: 'Alpha', roster: ['a'], defaultVpId: 'a' },
      { id: 'g2', name: 'Beta', roster: [], defaultVpId: null },
    ]);
    setupPinia(groups, makeChatStore());
    const wrapper = mount(UnifySidebarV2, { global: global_ });
    const rows = wrapper.findAll('.usv2-group-row');
    expect(rows.length).toBe(2);
    await rows[1].trigger('click');
    expect(groups.setActive).toHaveBeenCalledWith('g2');
    const emitted = wrapper.emitted('select-group');
    expect(emitted).toBeTruthy();
    expect(emitted[0][0].id).toBe('g2');
  });

  it('inline + button in the Groups header opens the wizard', async () => {
    setupPinia(
      makeGroupsStore([{ id: 'g1', name: 'X', roster: ['a'], defaultVpId: 'a' }]),
      makeChatStore(),
    );
    const wrapper = mount(UnifySidebarV2, { global: global_ });
    const btn = wrapper.find('.usv2-group-new-btn');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    expect(wrapper.vm.groupWizardOpen).toBe(true);
    expect(wrapper.find('.mock-wizard').exists()).toBe(true);
  });
});
