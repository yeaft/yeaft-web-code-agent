// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FolderPickerDialog from '../../web/components/FolderPickerDialog.js';
import SessionSettingsModal from '../../web/components/SessionSettingsModal.js';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';

const wrappers = [];
function mountDialog(overrides = {}, messages = en) {
  const state = { path: '/home/user/project', draft: '/home/user/project', entries: [{ name: 'child', type: 'directory' }], loading: false, error: '', canConfirm: true, ...overrides };
  const wrapper = mount(FolderPickerDialog, { attachTo: document.body, props: { state }, global: { mocks: { $t: key => messages[key] || key }, stubs: { Teleport: true } } });
  wrappers.push(wrapper);
  return wrapper;
}

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  document.body.innerHTML = '';
  delete window.Pinia;
  vi.useRealTimers();
});

describe('shared directory picker presentation', () => {
  it('offers root, ancestor, parent and single-click folder navigation without requiring double-click', async () => {
    const wrapper = mountDialog();
    expect(wrapper.find('.folder-picker-root').exists()).toBe(false);
    await wrapper.get('.folder-picker-navigation > button').trigger('click');
    const crumbs = wrapper.findAll('.folder-picker-breadcrumbs button');
    await crumbs[0].trigger('click');
    await crumbs[1].trigger('click');
    await wrapper.get('.folder-picker-item').trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([['/home/user'], ['/'], ['/home'], ['/home/user/project/child']]);
    expect(wrapper.get('.folder-picker-item').attributes('type')).toBe('button');
    expect(wrapper.find('[role="dialog"]').attributes('aria-modal')).toBe('true');
  });

  it('renders a continuous path with native separators, including roots, UNC and literal POSIX backslashes', async () => {
    const wrapper = mountDialog();
    for (const path of ['/', '/home/user/project', '/home/back\\slash/project', 'C:\\', 'C:\\Users\\Test User\\project', 'd:/projects/yeaft', '\\\\server\\share\\folder\\child']) {
      await wrapper.setProps({ state: { ...wrapper.props('state'), path } });
      const nav = wrapper.get('.folder-picker-breadcrumbs');
      expect([...nav.element.children].map(node => node.textContent).join('')).toBe(path);
      const current = nav.get('[aria-current="location"]');
      expect(current.attributes('title')).toBe(path);
    }
  });

  it('keeps the Windows drive chooser reachable through the drive breadcrumb and parent button', async () => {
    const wrapper = mountDialog({ path: 'C:\\Users\\project' });
    await wrapper.findAll('.folder-picker-breadcrumbs button')[0].trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([['C:\\']]);
    await wrapper.setProps({ state: { ...wrapper.props('state'), path: 'C:\\' } });
    await wrapper.get('.folder-picker-navigation > button').trigger('click');
    expect(wrapper.emitted('navigate').at(-1)).toEqual(['']);
    await wrapper.setProps({ state: { ...wrapper.props('state'), path: '', canConfirm: false } });
    expect(wrapper.get('.folder-picker-navigation > button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined();
  });

  it('uses editable input and Enter/Go without submitting the outer create form', async () => {
    const wrapper = mountDialog();
    const input = wrapper.get('input');
    expect(document.activeElement).toBe(input.element);
    await input.setValue('/absolute/path');
    expect(wrapper.emitted('edit-path')).toEqual([['/absolute/path']]);
    await wrapper.setProps({ state: { ...wrapper.props('state'), draft: '/absolute/path', canConfirm: false } });
    await input.trigger('keydown', { key: 'Enter' });
    await wrapper.get('.folder-picker-address button').trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([['/absolute/path'], ['/absolute/path']]);
    expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button').every(button => button.attributes('type') === 'button')).toBe(true);
  });

  it('keeps loading, error/retry and empty states distinct in both languages', async () => {
    for (const messages of [en, zh]) {
      const wrapper = mountDialog({ loading: true, canConfirm: false }, messages);
      expect(wrapper.get('[role="status"]').text()).toContain(messages['common.loading']);
      expect(wrapper.find('.folder-picker-item').exists()).toBe(false);
      await wrapper.setProps({ state: { ...wrapper.props('state'), loading: false, error: 'loadFailed', errorDetail: 'EACCES' } });
      expect(wrapper.get('[role="alert"]').text()).toContain(messages['modal.folderPicker.loadFailed']);
      expect(wrapper.get('[role="alert"]').text()).toContain('EACCES');
      await wrapper.get('[role="alert"] button').trigger('click');
      expect(wrapper.emitted('navigate')).toEqual([['/home/user/project']]);
      await wrapper.setProps({ state: { ...wrapper.props('state'), error: '', entries: [], canConfirm: true } });
      expect(wrapper.get('[role="status"]').text()).toBe(messages['common.noSubdirectories']);
      await wrapper.get('.btn-primary').trigger('click');
      expect(wrapper.emitted('confirm')).toHaveLength(1);
    }
  });

  it('supports arrow navigation, traps Tab, closes only the picker on Escape and restores focus', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const wrapper = mountDialog({ entries: [{ name: 'first' }, { name: 'last' }] });
    const list = wrapper.get('.folder-picker-list');
    list.element.focus();
    await list.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(wrapper.findAll('.folder-picker-item')[0].element);
    await list.trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(wrapper.findAll('.folder-picker-item')[1].element);
    await list.trigger('keydown', { key: 'ArrowLeft' });
    expect(wrapper.emitted('navigate')).toEqual([['/home/user']]);
    wrapper.get('.btn-primary').element.focus();
    await wrapper.get('.btn-primary').trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(wrapper.find('button').element);
    await wrapper.find('button').trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(wrapper.get('.btn-primary').element);
    const outerEsc = vi.fn();
    window.addEventListener('keydown', outerEsc);
    await wrapper.get('input').trigger('keydown', { key: 'Escape' });
    window.removeEventListener('keydown', outerEsc);
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(outerEsc).not.toHaveBeenCalled();
    wrapper.unmount();
    wrappers.pop();
    expect(document.activeElement).toBe(opener);
  });

  it('integrates Session settings as a local draft; browsing and confirming do not save Session data', async () => {
    vi.useFakeTimers();
    const chat = { currentAgent: 'agent-1', agents: [], sendWsMessage: vi.fn(() => true), sessionCrudRequest: vi.fn() };
    const group = { id: 'session-1', name: 'Session', workDir: '/project', roster: [], agentId: 'agent-1' };
    window.Pinia = { useChatStore: () => chat, useSessionsStore: () => ({ sessionById: () => group }) };
    const wrapper = mount(SessionSettingsModal, { attachTo: document.body, props: { groupId: 'session-1', agentId: 'agent-1' }, global: { mocks: { $t: key => en[key] || key }, stubs: { Teleport: true } } });
    wrappers.push(wrapper);
    await wrapper.findAll('button').find(button => button.text() === en['modal.newConv.browse']).trigger('click');
    const request = chat.sendWsMessage.mock.lastCall[0];
    expect(request).toMatchObject({ type: 'list_directory', agentId: 'agent-1', dirPath: '/project', directoryPickerScope: 'agent' });
    window.dispatchEvent(new CustomEvent('workbench-message', { detail: { type: 'directory_listing', conversationId: '_workdir_picker', requestId: request.requestId, agentId: 'agent-1', dirPath: '/resolved/project', entries: [] } }));
    await wrapper.vm.$nextTick();
    await wrapper.findComponent(FolderPickerDialog).get('.btn-primary').trigger('click');
    expect(wrapper.vm.workDirDraft).toBe('/resolved/project');
    expect(wrapper.vm.folderPickerOpen).toBe(false);
    expect(chat.sessionCrudRequest).not.toHaveBeenCalled();
  });
});
