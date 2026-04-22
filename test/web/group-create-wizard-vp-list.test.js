// @vitest-environment happy-dom
/**
 * task-339-F2 — GroupCreateWizard defensive empty-VP render (mount-based).
 *
 * Verifies the wizard distinguishes:
 *   - "snapshot has not arrived" (emptyLibrary=false, lastSnapshotAt=0) → "Loading VPs…"
 *   - "snapshot arrived and is genuinely empty" (emptyLibrary=true)      → "No VPs available…"
 *   - "snapshot has VPs"                                                  → roster list renders
 *
 * Per PM ruling: do NOT touch vp-bridge source in this PR; any real
 * race/replay bug on the agent side is a separate follow-up ticket.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import GroupCreateWizard from '../../web/components/GroupCreateWizard.js';

function makeVpStore({ vpList = [], emptyLibrary = false, lastSnapshotAt = 0 } = {}) {
  return {
    vpList,
    vpOrder: vpList.map(v => v.vpId),
    emptyLibrary,
    lastSnapshotAt,
    vpLabel: (id) => id,
    vpColor: () => '#5B8DEF',
    vpInitial: (id) => (id ? id[0].toUpperCase() : '?'),
  };
}

function installPinia(vpStore) {
  window.Pinia = {
    useVpStore: () => vpStore,
    useChatStore: () => ({ groupCrudRequest: async () => ({ ok: true }) }),
    useGroupsStore: () => ({ groupList: [], activeGroupId: null, setActive: () => {} }),
  };
}

const global_ = {
  mocks: {
    $t: (key, params) => {
      if (params && typeof params.count === 'number') return `${params.count}`;
      return key;
    },
  },
};

describe('GroupCreateWizard — task-339-F2 defensive empty-VP render', () => {
  beforeEach(() => {
    installPinia(makeVpStore());
  });

  it('shows "Loading VPs…" when vpList is empty and no snapshot arrived', () => {
    installPinia(makeVpStore({ vpList: [], emptyLibrary: false, lastSnapshotAt: 0 }));
    const wrapper = mount(GroupCreateWizard, { global: global_ });
    const loading = wrapper.find('.group-wizard-empty-loading');
    expect(loading.exists()).toBe(true);
    expect(loading.text()).toBe('unify.group.wizard.rosterLoading');
    // Must NOT render the "genuinely empty" message here.
    expect(wrapper.html()).not.toContain('unify.group.wizard.rosterEmpty');
  });

  it('shows "No VPs available…" when emptyLibrary=true (snapshot received but empty)', () => {
    installPinia(makeVpStore({ vpList: [], emptyLibrary: true, lastSnapshotAt: Date.now() }));
    const wrapper = mount(GroupCreateWizard, { global: global_ });
    const empty = wrapper.findAll('.group-wizard-empty').filter(w => !w.classes('group-wizard-empty-loading'));
    expect(empty.length).toBeGreaterThan(0);
    expect(empty[0].text()).toBe('unify.group.wizard.rosterEmpty');
    expect(wrapper.find('.group-wizard-empty-loading').exists()).toBe(false);
  });

  it('renders roster list when vpList has entries', () => {
    installPinia(
      makeVpStore({
        vpList: [
          { vpId: 'alice', displayName: 'Alice' },
          { vpId: 'bob', displayName: 'Bob' },
        ],
        lastSnapshotAt: Date.now(),
      }),
    );
    const wrapper = mount(GroupCreateWizard, { global: global_ });
    const items = wrapper.findAll('.group-wizard-roster-item');
    expect(items.length).toBe(2);
    expect(wrapper.find('.group-wizard-empty-loading').exists()).toBe(false);
  });

  it('treats lastSnapshotAt>0 + vpList=0 as genuine empty (safeguard branch)', () => {
    installPinia(makeVpStore({ vpList: [], emptyLibrary: false, lastSnapshotAt: Date.now() }));
    const wrapper = mount(GroupCreateWizard, { global: global_ });
    expect(wrapper.find('.group-wizard-empty-loading').exists()).toBe(false);
    // Falls through to the rosterEmpty branch via the vpLibraryEmpty computed.
    expect(wrapper.html()).toContain('unify.group.wizard.rosterEmpty');
  });
});
