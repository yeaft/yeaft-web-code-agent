// @vitest-environment happy-dom
/**
 * task-338-F3 follow-up (N1) — GroupEditModal behaviour tests.
 *
 * Verifies the modal replacement for window.prompt() / window.confirm():
 *   - rename mode renders a text input prefilled with group.name
 *   - archive mode renders a confirm button (no text input)
 *   - submit emits 'confirm' with the correct payload shape
 *   - cancel / overlay-click / × / Esc all emit 'close'
 *   - no-op rename (empty or same-as-current) disables submit
 *   - once-submit guard prevents double-emission
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import GroupEditModal from '../../web/components/GroupEditModal.js';

const global = {
  mocks: {
    $t: (key, params) => {
      if (params && params.name) return `${key}(${params.name})`;
      return key;
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('GroupEditModal — rename mode', () => {
  const baseProps = { mode: 'rename', group: { id: 'grp_default', name: 'Default' } };

  it('renders title + input prefilled with current name', () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    expect(wrapper.find('.group-edit-title').text()).toBe('unify.group.editModal.renameTitle');
    const input = wrapper.find('input.group-edit-input');
    expect(input.exists()).toBe(true);
    expect(input.element.value).toBe('Default');
  });

  it('submit emits confirm with { mode, groupId, name } trimmed', async () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    const input = wrapper.find('input.group-edit-input');
    await input.setValue('  Renamed  ');
    await wrapper.find('form.group-edit-body').trigger('submit.prevent');
    const events = wrapper.emitted('confirm');
    expect(events).toBeTruthy();
    expect(events[0][0]).toEqual({ mode: 'rename', groupId: 'grp_default', name: 'Renamed' });
  });

  it('empty name disables submit + does not emit on submit attempt', async () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    await wrapper.find('input.group-edit-input').setValue('');
    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.attributes('disabled')).toBeDefined();
    await wrapper.find('form.group-edit-body').trigger('submit.prevent');
    expect(wrapper.emitted('confirm')).toBeFalsy();
  });

  it('no-op rename (same as current) disables submit', async () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    // Default value already equals current name.
    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.attributes('disabled')).toBeDefined();
  });

  it('once-submit guard: second submit is a no-op', async () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    await wrapper.find('input.group-edit-input').setValue('New');
    await wrapper.find('form.group-edit-body').trigger('submit.prevent');
    await wrapper.find('form.group-edit-body').trigger('submit.prevent');
    expect(wrapper.emitted('confirm')).toHaveLength(1);
  });
});

describe('GroupEditModal — archive mode', () => {
  const archiveProps = { mode: 'archive', group: { id: 'grp_default', name: 'Default' } };

  it('renders archive title + no text input', () => {
    const wrapper = mount(GroupEditModal, { global, props: archiveProps, attachTo: document.body });
    expect(wrapper.find('.group-edit-title').text()).toBe('unify.group.editModal.archiveTitle');
    expect(wrapper.find('input.group-edit-input').exists()).toBe(false);
  });

  it('submit button is always enabled in archive mode', () => {
    const wrapper = mount(GroupEditModal, { global, props: archiveProps, attachTo: document.body });
    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.attributes('disabled')).toBeUndefined();
    expect(submitBtn.classes()).toContain('is-danger');
  });

  it('submit emits confirm with { mode: "archive", groupId } (no name)', async () => {
    const wrapper = mount(GroupEditModal, { global, props: archiveProps, attachTo: document.body });
    await wrapper.find('form.group-edit-body').trigger('submit.prevent');
    const events = wrapper.emitted('confirm');
    expect(events).toBeTruthy();
    expect(events[0][0]).toEqual({ mode: 'archive', groupId: 'grp_default' });
    expect(events[0][0]).not.toHaveProperty('name');
  });
});

describe('GroupEditModal — close paths', () => {
  const baseProps = { mode: 'rename', group: { id: 'grp_default', name: 'Default' } };

  it('cancel button emits close', async () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    const btns = wrapper.findAll('button.group-edit-btn');
    const cancel = btns.find(b => !b.classes().includes('is-primary'));
    await cancel.trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('× close button emits close', async () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    await wrapper.find('.group-edit-close').trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('overlay click (outside modal) emits close', async () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    const overlay = wrapper.find('.group-edit-overlay');
    // .self modifier — dispatch click whose target is the overlay itself.
    await overlay.trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('Escape emits close', async () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('after submit, close is not emitted again (submitted guard)', async () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps, attachTo: document.body });
    await wrapper.find('input.group-edit-input').setValue('X');
    await wrapper.find('form.group-edit-body').trigger('submit.prevent');
    // After submit, requestClose is a no-op — overlay click, cancel, ×, Esc all ignored.
    await wrapper.find('.group-edit-close').trigger('click');
    expect(wrapper.emitted('close')).toBeFalsy();
  });
});

describe('GroupEditModal — a11y', () => {
  const baseProps = { mode: 'rename', group: { id: 'grp_default', name: 'Default' } };

  it('overlay has role=dialog + aria-modal=true', () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps });
    const overlay = wrapper.find('.group-edit-overlay');
    expect(overlay.attributes('role')).toBe('dialog');
    expect(overlay.attributes('aria-modal')).toBe('true');
    expect(overlay.attributes('aria-label')).toBeTruthy();
  });

  it('close button has aria-label', () => {
    const wrapper = mount(GroupEditModal, { global, props: baseProps });
    const close = wrapper.find('.group-edit-close');
    expect(close.attributes('aria-label')).toBeTruthy();
  });
});
