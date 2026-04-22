// @vitest-environment happy-dom
/**
 * task-338-F3 — GroupSelector behaviour tests (mount-based).
 *
 * Real mount via @vue/test-utils — drives the dropdown, asserts on rendered
 * DOM + events, not source strings. Outside-click and Escape are synthesised
 * on the real happy-dom document. Pinia is shimmed on `window.Pinia` so the
 * component's lazy `useGroupsStore` / `useChatStore` lookups return our stubs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'fs';
import { join } from 'path';

import GroupSelector from '../../web/components/GroupSelector.js';

// ─── Shared mocks ────────────────────────────────────────────

function makeGroupsStore(overrides = {}) {
  return {
    groupList: [
      { id: 'grp_default', name: 'Default', roster: ['alice', 'bob', 'charlie'], defaultVpId: 'alice' },
      { id: 'grp_team', name: 'Team', roster: ['alice'], defaultVpId: 'alice' },
      { id: 'grp_empty', name: 'Empty', roster: [], defaultVpId: null },
    ],
    activeGroupId: 'grp_default',
    activeGroup: null,
    setActive: vi.fn(),
    ...overrides,
  };
}

function makeChatStore(overrides = {}) {
  const req = vi.fn().mockResolvedValue({ ok: true, op: 'rename' });
  return { groupCrudRequest: req, ...overrides };
}

function installPinia(groupsStore, chatStore) {
  groupsStore.activeGroup = groupsStore.groupList.find(g => g.id === groupsStore.activeGroupId) || null;
  window.Pinia = {
    useGroupsStore: () => groupsStore,
    useChatStore: () => chatStore,
  };
}

const stubs = {
  // Real GroupCreateWizard pulls in VP store etc. — not our concern.
  GroupCreateWizard: {
    name: 'GroupCreateWizard',
    emits: ['close', 'created'],
    template: '<div class="mock-wizard">wizard</div>',
  },
};

// Minimal $t mock so the template doesn't explode.
const global = {
  mocks: {
    $t: (key, params) => {
      if (params && typeof params.count === 'number') return `${params.count} members`;
      if (params && params.name) return `${key}(${params.name})`;
      return key;
    },
  },
  stubs,
};

let groups, chat;

beforeEach(() => {
  groups = makeGroupsStore();
  chat = makeChatStore();
  installPinia(groups, chat);
});

afterEach(() => {
  delete window.Pinia;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── Mount behaviour ─────────────────────────────────────────

describe('GroupSelector — render + dropdown toggle', () => {
  it('renders the active group name in the trigger', () => {
    const wrapper = mount(GroupSelector, { global });
    const name = wrapper.find('.unify-topbar-group-name');
    expect(name.text()).toBe('Default');
  });

  it('renders the active group member count', () => {
    const wrapper = mount(GroupSelector, { global });
    const count = wrapper.find('.unify-topbar-group-count').text();
    expect(count).toContain('3');
  });

  it('dropdown is closed by default and opens on trigger click', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(false);
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(true);
    // Every group is rendered.
    const rows = wrapper.findAll('.unify-topbar-group-option');
    expect(rows).toHaveLength(3);
    // Includes "+ New group" affordance.
    expect(wrapper.find('.unify-topbar-group-new').exists()).toBe(true);
  });

  it('chevron has `.open` class only when dropdown is open', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    expect(wrapper.find('.unify-model-chevron.open').exists()).toBe(false);
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    expect(wrapper.find('.unify-model-chevron.open').exists()).toBe(true);
  });
});

describe('GroupSelector — select / switch active group', () => {
  it('clicking a group row calls groupsStore.setActive and closes dropdown', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const rows = wrapper.findAll('.unify-topbar-group-option');
    // Click the 2nd group ("grp_team").
    await rows[1].trigger('click');
    expect(groups.setActive).toHaveBeenCalledTimes(1);
    expect(groups.setActive).toHaveBeenCalledWith('grp_team');
    // Dropdown closed after select.
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(false);
  });

  it('active row shows checkmark (not empty placeholder)', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const activeRow = wrapper.findAll('.unify-topbar-group-option').find(w => w.classes().includes('active'));
    expect(activeRow).toBeTruthy();
    // The checkmark entity (&#10003;) only renders inside the first span when active.
    const check = activeRow.find('.unify-model-check').text();
    expect(check.length).toBeGreaterThan(0);
  });
});

describe('GroupSelector — rename/archive kebab', () => {
  it('kebab click opens per-row menu with Rename + Archive', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const rows = wrapper.findAll('.unify-topbar-group-option');
    await rows[0].find('.unify-topbar-group-kebab').trigger('click');
    const menu = wrapper.find('.unify-topbar-group-menu');
    expect(menu.exists()).toBe(true);
    const items = menu.findAll('.unify-topbar-group-menu-item');
    expect(items).toHaveLength(2);
  });

  it('rename menu item prompts and fires groupCrudRequest("rename", ...)', async () => {
    window.prompt = vi.fn().mockReturnValue('Renamed Group');
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    await wrapper.find('.unify-topbar-group-menu .unify-topbar-group-menu-item').trigger('click');
    // Flush microtasks so the awaited promise settles.
    await Promise.resolve();
    expect(window.prompt).toHaveBeenCalled();
    expect(chat.groupCrudRequest).toHaveBeenCalledWith('rename', {
      groupId: 'grp_default',
      name: 'Renamed Group',
    });
  });

  it('rename menu item is a no-op when prompt is cancelled', async () => {
    window.prompt = vi.fn().mockReturnValue(null);
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    await wrapper.find('.unify-topbar-group-menu .unify-topbar-group-menu-item').trigger('click');
    await Promise.resolve();
    expect(chat.groupCrudRequest).not.toHaveBeenCalled();
  });

  it('archive menu item confirms and fires groupCrudRequest("archive", ...)', async () => {
    window.confirm = vi.fn().mockReturnValue(true);
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    const items = wrapper.findAll('.unify-topbar-group-menu .unify-topbar-group-menu-item');
    // Second item is archive (danger).
    await items[1].trigger('click');
    await Promise.resolve();
    expect(window.confirm).toHaveBeenCalled();
    expect(chat.groupCrudRequest).toHaveBeenCalledWith('archive', { groupId: 'grp_default' });
  });

  it('archive is a no-op when confirm is declined', async () => {
    window.confirm = vi.fn().mockReturnValue(false);
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    const items = wrapper.findAll('.unify-topbar-group-menu .unify-topbar-group-menu-item');
    await items[1].trigger('click');
    await Promise.resolve();
    expect(chat.groupCrudRequest).not.toHaveBeenCalled();
  });
});

describe('GroupSelector — "+ New group" wizard mount', () => {
  it('clicking "+ New group" mounts GroupCreateWizard and closes dropdown', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    await wrapper.find('.unify-topbar-group-new').trigger('click');
    expect(wrapper.findComponent({ name: 'GroupCreateWizard' }).exists()).toBe(true);
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(false);
  });

  it('wizard "created" emit makes the new group active and unmounts the wizard', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    await wrapper.find('.unify-topbar-group-new').trigger('click');
    const wizard = wrapper.findComponent({ name: 'GroupCreateWizard' });
    await wizard.vm.$emit('created', { id: 'grp_new', name: 'New', roster: [] });
    expect(groups.setActive).toHaveBeenCalledWith('grp_new');
    expect(wrapper.findComponent({ name: 'GroupCreateWizard' }).exists()).toBe(false);
  });
});

describe('GroupSelector — outside-click / Esc close', () => {
  it('pressing Escape closes the dropdown', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(true);
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(false);
  });

  it('outside-click closes the dropdown', async () => {
    const outside = document.createElement('div');
    outside.id = 'outside-node';
    document.body.appendChild(outside);
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(true);
    outside.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(false);
  });

  it('click inside dropdown does NOT close it', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const dropdown = wrapper.find('.unify-topbar-group-dropdown');
    dropdown.element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(true);
  });
});

describe('GroupSelector — a11y', () => {
  it('trigger element has title for screen readers', () => {
    const wrapper = mount(GroupSelector, { global });
    const trigger = wrapper.find('.unify-topbar-group-trigger');
    expect(trigger.attributes('title')).toBeTruthy();
  });

  it('kebab has aria-label', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const kebab = wrapper.find('.unify-topbar-group-kebab');
    expect(kebab.attributes('aria-label')).toBeTruthy();
  });

  it('"+ New group" button has aria-label', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const btn = wrapper.find('.unify-topbar-group-new');
    expect(btn.attributes('aria-label')).toBeTruthy();
  });
});

describe('GroupSelector — empty state + fallbacks', () => {
  it('shows empty-state copy when groupList is empty', async () => {
    delete window.Pinia;
    const emptyGroups = { groupList: [], activeGroupId: null, activeGroup: null, setActive: vi.fn() };
    const emptyChat = makeChatStore();
    window.Pinia = {
      useGroupsStore: () => emptyGroups,
      useChatStore: () => emptyChat,
    };
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    expect(wrapper.find('.unify-topbar-group-empty').exists()).toBe(true);
    expect(wrapper.findAll('.unify-topbar-group-option')).toHaveLength(0);
    // "+ New group" still available.
    expect(wrapper.find('.unify-topbar-group-new').exists()).toBe(true);
  });

  it('activeLabel falls back to "unify.group.defaultName" when no active group', () => {
    delete window.Pinia;
    const emptyGroups = { groupList: [], activeGroupId: null, activeGroup: null, setActive: vi.fn() };
    window.Pinia = {
      useGroupsStore: () => emptyGroups,
      useChatStore: () => makeChatStore(),
    };
    const wrapper = mount(GroupSelector, { global });
    expect(wrapper.find('.unify-topbar-group-name').text()).toBe('unify.group.defaultName');
  });
});

// ─── i18n parity (kept from source-scan layer — cheap + orthogonal) ─────

describe('GroupSelector — i18n parity (en vs zh-CN)', () => {
  const root = join(import.meta.dirname, '../..');
  const enSrc = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
  const zhSrc = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');
  const keys = [
    'unify.group.defaultName',
    'unify.group.empty',
    'unify.group.newButton',
    'unify.group.newButtonAria',
    'unify.group.sidebarTitle',
    'unify.group.moreActions',
    'unify.group.rename',
    'unify.group.renamePrompt',
    'unify.group.archive',
    'unify.group.archiveConfirm',
    'unify.group.membersCount',
    'unify.group.oneMember',
    'unify.group.noMembers',
  ];
  for (const k of keys) {
    it(`both locales define "${k}"`, () => {
      expect(enSrc).toContain(`'${k}'`);
      expect(zhSrc).toContain(`'${k}'`);
    });
  }
});
