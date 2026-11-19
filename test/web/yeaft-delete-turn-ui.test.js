// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';

vi.stubGlobal('Vue', Vue);
vi.stubGlobal('Pinia', { defineStore: () => () => ({}) });
const { default: YeaftPage } = await import('../../web/components/YeaftPage.js');
const { default: UserTurnBlock } = await import('../../web/components/UserTurnBlock.js');
const { useDialogState, resolveDialog } = await import('../../web/utils/dialog.js');
const translate = key => en[key] || key;
let wrapper;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

it('renders an accessible, localized and gated action on native user bubbles', async () => {
  Pinia.useChatStore = () => ({});
  const target = { agentId: 'a', sessionId: 's', messageId: 'm0002' };
  wrapper = mount(UserTurnBlock, {
    props: { message: { id: 'm0002', type: 'user', content: 'hello' } },
    global: { provide: { t: translate }, config: { globalProperties: { $t: translate } } },
  });
  expect(wrapper.find('.message-delete-turn').exists()).toBe(false);
  await wrapper.setProps({ deleteTurnAction: { target, reason: 'running' } });
  const button = wrapper.get('.message-delete-turn');
  expect(button.attributes('aria-label')).toBe('Delete turn');
  expect(button.attributes('aria-disabled')).toBe('true');
  await button.trigger('click');
  expect(wrapper.emitted('delete-turn')).toBeUndefined();
  await wrapper.setProps({ deleteTurnAction: { target, reason: 'unsupported' } });
  expect(button.attributes('title')).toBe('Turn deletion requires an updated Server and Agent, and must be enabled for this data directory.');
  expect(button.attributes('aria-disabled')).toBe('true');
  await button.trigger('click');
  expect(wrapper.emitted('delete-turn')).toBeUndefined();
  expect(zh['yeaft.deleteTurn.unsupported']).toBe('请更新 Agent 和 Server，并为此数据目录启用轮次删除。');
  await wrapper.setProps({ deleteTurnAction: { target } });
  await button.trigger('click');
  expect(wrapper.emitted('delete-turn')).toEqual([[target]]);
  for (const key of Object.keys(en).filter(key => key.startsWith('yeaft.deleteTurn.'))) expect(zh[key]).toBeTruthy();
});

it('confirms the whole turn, ignores a confirmation after navigation, and localizes failures', async () => {
  const target = { agentId: 'a', sessionId: 's', messageId: 'm0002' };
  const store = Vue.reactive({ currentView: 'yeaft', currentAgent: 'a', yeaftActiveSessionFilter: 's',
    yeaftTurnDeleteUnavailable: () => null, deleteYeaftSessionTurn: vi.fn().mockResolvedValue({ ok: false, errorCode: 'turn_not_found' }) });
  Pinia.useChatStore = () => store;
  Pinia.useAuthStore = Pinia.useVpStore = () => ({});
  wrapper = mount({ ...YeaftPage, template: '<button @click="deleteTurn(payload)">test</button>', data: () => ({ payload: target }) },
    { global: { config: { globalProperties: { $t: translate } } } });
  const button = wrapper.get('button');
  await button.trigger('click');
  expect(useDialogState()).toMatchObject({ type: 'confirm', destructive: true, confirmLabel: 'Delete turn' });
  expect(useDialogState().message).toContain('including this message, any appended messages');
  resolveDialog(false);
  await flushPromises();
  expect(store.deleteYeaftSessionTurn).not.toHaveBeenCalled();
  await button.trigger('click');
  store.yeaftActiveSessionFilter = 'other';
  store.yeaftActiveSessionFilter = 's';
  resolveDialog(true);
  await flushPromises();
  expect(store.deleteYeaftSessionTurn).not.toHaveBeenCalled();
  await button.trigger('click');
  resolveDialog(true);
  await flushPromises();
  expect(store.deleteYeaftSessionTurn).toHaveBeenCalledExactlyOnceWith(target);
  expect(useDialogState()).toMatchObject({ type: 'alert', message: 'This turn is no longer available.' });
  resolveDialog(true);
});
