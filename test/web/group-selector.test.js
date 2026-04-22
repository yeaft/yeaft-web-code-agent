// @vitest-environment happy-dom
/**
 * task-338-F3 — GroupSelector behaviour tests (mount-based).
 *
 * Real mount via @vue/test-utils — drives the dropdown, asserts on rendered
 * DOM + events, not source strings. Outside-click and Escape are synthesised
 * on the real happy-dom document. Pinia is shimmed on `window.Pinia` so the
 * component's lazy `useGroupsStore` / `useChatStore` lookups return our stubs.
 *
 * F3 follow-up (N1-N5) adds:
 *   N1 — rename/archive open GroupEditModal (no window.prompt/confirm)
 *   N2+N5 — ↑/↓ keyboard + aria-activedescendant + Enter to select
 *   N3 — busy-state: aria-busy + spinner while WS round-trip is in flight
 *   N4 — CSS `.is-danger` hover uses token, not rgba hardcode
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
  const req = vi.fn().mockResolvedValue({ ok: true });
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
  GroupCreateWizard: {
    name: 'GroupCreateWizard',
    emits: ['close', 'created'],
    template: '<div class="mock-wizard">wizard</div>',
  },
  // NOTE: we intentionally do NOT stub GroupEditModal — we want to verify
  // it mounts correctly and interact with its confirm/cancel controls.
};

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
    const rows = wrapper.findAll('.unify-topbar-group-option');
    expect(rows).toHaveLength(3);
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
    await rows[1].trigger('click');
    expect(groups.setActive).toHaveBeenCalledTimes(1);
    expect(groups.setActive).toHaveBeenCalledWith('grp_team');
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(false);
  });

  it('active row shows checkmark', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const activeRow = wrapper.findAll('.unify-topbar-group-option').find(w => w.classes().includes('active'));
    expect(activeRow).toBeTruthy();
    const check = activeRow.find('.unify-model-check').text();
    expect(check.length).toBeGreaterThan(0);
  });
});

// ─── N1 — rename/archive via GroupEditModal (no prompt/confirm) ────

describe('GroupSelector — N1: rename via modal (not window.prompt)', () => {
  it('rename menu item opens GroupEditModal in rename mode (no prompt)', async () => {
    const promptSpy = vi.fn();
    window.prompt = promptSpy;
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    // First menu item is rename.
    await wrapper.find('.unify-topbar-group-menu .unify-topbar-group-menu-item').trigger('click');
    // Modal mounted.
    const modal = wrapper.findComponent({ name: 'GroupEditModal' });
    expect(modal.exists()).toBe(true);
    expect(modal.props('mode')).toBe('rename');
    expect(modal.props('group').id).toBe('grp_default');
    // window.prompt was NOT called.
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('modal confirm event routes through groupCrudRequest("rename", ...)', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    await wrapper.find('.unify-topbar-group-menu .unify-topbar-group-menu-item').trigger('click');
    const modal = wrapper.findComponent({ name: 'GroupEditModal' });
    await modal.vm.$emit('confirm', {
      mode: 'rename',
      groupId: 'grp_default',
      name: 'Renamed Group',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(chat.groupCrudRequest).toHaveBeenCalledWith('rename', {
      groupId: 'grp_default',
      name: 'Renamed Group',
    });
  });

  it('modal close without confirm is a no-op', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    await wrapper.find('.unify-topbar-group-menu .unify-topbar-group-menu-item').trigger('click');
    const modal = wrapper.findComponent({ name: 'GroupEditModal' });
    await modal.vm.$emit('close');
    await Promise.resolve();
    expect(chat.groupCrudRequest).not.toHaveBeenCalled();
    // Modal unmounted.
    expect(wrapper.findComponent({ name: 'GroupEditModal' }).exists()).toBe(false);
  });

  it('archive menu item opens GroupEditModal in archive mode (no confirm)', async () => {
    const confirmSpy = vi.fn();
    window.confirm = confirmSpy;
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    const items = wrapper.findAll('.unify-topbar-group-menu .unify-topbar-group-menu-item');
    await items[1].trigger('click');
    const modal = wrapper.findComponent({ name: 'GroupEditModal' });
    expect(modal.exists()).toBe(true);
    expect(modal.props('mode')).toBe('archive');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('archive confirm routes through groupCrudRequest("archive", ...)', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    const items = wrapper.findAll('.unify-topbar-group-menu .unify-topbar-group-menu-item');
    await items[1].trigger('click');
    const modal = wrapper.findComponent({ name: 'GroupEditModal' });
    await modal.vm.$emit('confirm', { mode: 'archive', groupId: 'grp_default' });
    await Promise.resolve();
    await Promise.resolve();
    expect(chat.groupCrudRequest).toHaveBeenCalledWith('archive', { groupId: 'grp_default' });
  });
});

// ─── N2+N5 — keyboard navigation + aria-activedescendant ────

describe('GroupSelector — N2+N5: keyboard nav + aria-activedescendant', () => {
  it('trigger has combobox/listbox a11y attributes', () => {
    const wrapper = mount(GroupSelector, { global });
    const trigger = wrapper.find('.unify-topbar-group-trigger');
    expect(trigger.attributes('role')).toBe('combobox');
    expect(trigger.attributes('aria-haspopup')).toBe('listbox');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(trigger.attributes('tabindex')).toBe('0');
  });

  it('opening dropdown flips aria-expanded to true', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const trigger = wrapper.find('.unify-topbar-group-trigger');
    expect(trigger.attributes('aria-expanded')).toBe('true');
  });

  it('row ids are stable group-option-${g.id} (not index)', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const rows = wrapper.findAll('.unify-topbar-group-option');
    expect(rows[0].attributes('id')).toBe('group-option-grp_default');
    expect(rows[1].attributes('id')).toBe('group-option-grp_team');
    expect(rows[2].attributes('id')).toBe('group-option-grp_empty');
  });

  it('on open, aria-activedescendant seeds to active row id', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const trigger = wrapper.find('.unify-topbar-group-trigger');
    expect(trigger.attributes('aria-activedescendant')).toBe('group-option-grp_default');
  });

  it('ArrowDown rotates highlight and updates aria-activedescendant', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const trigger = wrapper.find('.unify-topbar-group-trigger');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    // Seeded at idx=0 (grp_default), Down → idx=1 (grp_team).
    expect(trigger.attributes('aria-activedescendant')).toBe('group-option-grp_team');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(trigger.attributes('aria-activedescendant')).toBe('group-option-grp_empty');
    // Wraps around.
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(trigger.attributes('aria-activedescendant')).toBe('group-option-grp_default');
  });

  it('ArrowUp rotates highlight backwards and wraps', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const trigger = wrapper.find('.unify-topbar-group-trigger');
    // Seeded at idx=0, Up → wraps to last (grp_empty).
    await trigger.trigger('keydown', { key: 'ArrowUp' });
    expect(trigger.attributes('aria-activedescendant')).toBe('group-option-grp_empty');
    await trigger.trigger('keydown', { key: 'ArrowUp' });
    expect(trigger.attributes('aria-activedescendant')).toBe('group-option-grp_team');
  });

  it('Enter on highlighted row triggers setActive + closes dropdown', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const trigger = wrapper.find('.unify-topbar-group-trigger');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    // Now highlighted = grp_team.
    await trigger.trigger('keydown', { key: 'Enter' });
    expect(groups.setActive).toHaveBeenCalledWith('grp_team');
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(false);
  });

  it('ArrowDown on closed dropdown opens it (does not select)', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    const trigger = wrapper.find('.unify-topbar-group-trigger');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.find('.unify-topbar-group-dropdown').exists()).toBe(true);
    expect(groups.setActive).not.toHaveBeenCalled();
  });

  it('highlighted row gets .is-highlighted class', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const trigger = wrapper.find('.unify-topbar-group-trigger');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    const rows = wrapper.findAll('.unify-topbar-group-option');
    // Seeded at 0 → ArrowDown → 1 is highlighted.
    expect(rows[1].classes()).toContain('is-highlighted');
    expect(rows[0].classes()).not.toContain('is-highlighted');
  });
});

// ─── N3 — busy state: aria-busy + spinner during WS round-trip ────

describe('GroupSelector — N3: busy state during WS CRUD', () => {
  it('row gets aria-busy="true" + spinner while request is in flight', async () => {
    // Hang the request so we can observe the busy state.
    let resolveReq;
    chat.groupCrudRequest = vi.fn().mockImplementation(
      () => new Promise((res) => { resolveReq = res; }),
    );
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    await wrapper.find('.unify-topbar-group-menu .unify-topbar-group-menu-item').trigger('click');
    const modal = wrapper.findComponent({ name: 'GroupEditModal' });
    modal.vm.$emit('confirm', { mode: 'rename', groupId: 'grp_default', name: 'New' });
    await wrapper.vm.$nextTick();

    // Busy state visible.
    const busyRow = wrapper.findAll('.unify-topbar-group-option').find(r => r.attributes('id') === 'group-option-grp_default');
    expect(busyRow.attributes('aria-busy')).toBe('true');
    expect(busyRow.classes()).toContain('is-busy');
    expect(busyRow.find('.unify-topbar-group-spinner').exists()).toBe(true);
    // Kebab hidden during busy.
    expect(busyRow.find('.unify-topbar-group-kebab').exists()).toBe(false);

    // Release.
    resolveReq({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    await wrapper.vm.$nextTick();
    const clearedRow = wrapper.findAll('.unify-topbar-group-option').find(r => r.attributes('id') === 'group-option-grp_default');
    expect(clearedRow.attributes('aria-busy')).toBe('false');
    expect(clearedRow.classes()).not.toContain('is-busy');
  });

  it('spinner renders renamingEllipsis label when op=rename', async () => {
    chat.groupCrudRequest = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    await wrapper.find('.unify-topbar-group-menu .unify-topbar-group-menu-item').trigger('click');
    const modal = wrapper.findComponent({ name: 'GroupEditModal' });
    modal.vm.$emit('confirm', { mode: 'rename', groupId: 'grp_default', name: 'X' });
    await wrapper.vm.$nextTick();
    const spinnerText = wrapper.find('.unify-topbar-group-spinner-text').text();
    expect(spinnerText).toBe('unify.group.renamingEllipsis');
  });

  it('spinner renders archivingEllipsis label when op=archive', async () => {
    chat.groupCrudRequest = vi.fn().mockImplementation(() => new Promise(() => {}));
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    const items = wrapper.findAll('.unify-topbar-group-menu .unify-topbar-group-menu-item');
    await items[1].trigger('click');
    const modal = wrapper.findComponent({ name: 'GroupEditModal' });
    modal.vm.$emit('confirm', { mode: 'archive', groupId: 'grp_default' });
    await wrapper.vm.$nextTick();
    const spinnerText = wrapper.find('.unify-topbar-group-spinner-text').text();
    expect(spinnerText).toBe('unify.group.archivingEllipsis');
  });

  it('busy row ignores click (does not call setActive)', async () => {
    chat.groupCrudRequest = vi.fn().mockImplementation(() => new Promise(() => {}));
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const row = wrapper.findAll('.unify-topbar-group-option')[0];
    await row.find('.unify-topbar-group-kebab').trigger('click');
    await wrapper.find('.unify-topbar-group-menu .unify-topbar-group-menu-item').trigger('click');
    const modal = wrapper.findComponent({ name: 'GroupEditModal' });
    modal.vm.$emit('confirm', { mode: 'rename', groupId: 'grp_default', name: 'X' });
    await wrapper.vm.$nextTick();
    // Re-open dropdown + click the now-busy row.
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const busyRow = wrapper.findAll('.unify-topbar-group-option').find(r => r.attributes('id') === 'group-option-grp_default');
    await busyRow.trigger('click');
    expect(groups.setActive).not.toHaveBeenCalled();
  });
});

// ─── N4 — CSS token on .is-danger (no rgba hardcode) ────

describe('GroupSelector — N4: .is-danger uses CSS token', () => {
  const root = join(import.meta.dirname, '../..');
  const cssSrc = readFileSync(join(root, 'web/styles/unify.css'), 'utf8');

  // Extract the .unify-topbar-group-menu-item.is-danger rule block.
  function extractBlock(src, selector) {
    const idx = src.indexOf(selector);
    if (idx < 0) return '';
    const start = src.indexOf('{', idx);
    const end = src.indexOf('}', start);
    return src.slice(start, end + 1);
  }

  it('negative: .is-danger:hover does NOT hardcode rgba(220,38,38,...)', () => {
    const block = extractBlock(cssSrc, '.unify-topbar-group-menu-item.is-danger:hover');
    expect(block).not.toMatch(/rgba\(\s*220\s*,\s*38\s*,\s*38/);
  });

  it('positive: .is-danger uses var(--error) / var(--error-bg) tokens', () => {
    const baseBlock = extractBlock(cssSrc, '.unify-topbar-group-menu-item.is-danger');
    const hoverBlock = extractBlock(cssSrc, '.unify-topbar-group-menu-item.is-danger:hover');
    expect(baseBlock).toMatch(/var\(--error\)/);
    expect(hoverBlock).toMatch(/var\(--error-bg/);
  });
});

// ─── "+ New group" + outside-click/Esc + a11y (from F3 baseline) ────

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

  it('rows have role="option" + aria-selected', async () => {
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    const rows = wrapper.findAll('.unify-topbar-group-option');
    expect(rows[0].attributes('role')).toBe('option');
    expect(rows[0].attributes('aria-selected')).toBe('true'); // active
    expect(rows[1].attributes('aria-selected')).toBe('false');
  });
});

describe('GroupSelector — empty state + fallbacks', () => {
  it('shows empty-state copy when groupList is empty', async () => {
    delete window.Pinia;
    const emptyGroups = { groupList: [], activeGroupId: null, activeGroup: null, setActive: vi.fn() };
    window.Pinia = {
      useGroupsStore: () => emptyGroups,
      useChatStore: () => makeChatStore(),
    };
    const wrapper = mount(GroupSelector, { global, attachTo: document.body });
    await wrapper.find('.unify-topbar-group-trigger').trigger('click');
    expect(wrapper.find('.unify-topbar-group-empty').exists()).toBe(true);
    expect(wrapper.findAll('.unify-topbar-group-option')).toHaveLength(0);
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

// ─── i18n parity (en vs zh-CN) — includes new editModal keys ─────

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
    'unify.group.archivingEllipsis',
    'unify.group.renamingEllipsis',
    // N1 new keys
    'unify.group.editModal.renameTitle',
    'unify.group.editModal.renameBody',
    'unify.group.editModal.renameSubmit',
    'unify.group.editModal.archiveTitle',
    'unify.group.editModal.archiveBody',
    'unify.group.editModal.archiveSubmit',
    'unify.group.editModal.newNameLabel',
    'unify.group.editModal.cancel',
    'unify.group.editModal.close',
  ];
  for (const k of keys) {
    it(`both locales define "${k}"`, () => {
      expect(enSrc).toContain(`'${k}'`);
      expect(zhSrc).toContain(`'${k}'`);
    });
  }
});
