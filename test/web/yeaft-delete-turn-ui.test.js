// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import en from '../../web/i18n/en.js';

vi.stubGlobal('Vue', Vue);
vi.stubGlobal('Pinia', { defineStore: () => () => ({}) });
const { default: YeaftPage } = await import('../../web/components/YeaftPage.js');
const { useDialogState, resolveDialog } = await import('../../web/utils/dialog.js');
const translate = key => en[key] || key;
let wrapper;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

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
