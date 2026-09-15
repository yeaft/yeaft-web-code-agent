// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { expect, it, vi } from 'vitest';
import ResourceControl from '../../web/components/WorkCenterResourceControl.js';
import en from '../../web/i18n/en.js';

it('does not treat a refresh spanning reconnect as confirmation of current resources', async () => {
  let resolve;
  const item = { id: 'item', revision: 1, status: 'needs_attention', executionControl: {
    revision: 2, limits: { maxRequests: 200, maxTokens: 2000000 }, usage: {}, stopReason: { code: 'work_item_requests_exhausted' },
  } };
  const store = reactive({ connectionState: 'connected', agents: [{ id: 'agent', online: true }],
    getWorkItem: vi.fn(() => new Promise(done => { resolve = done; })) });
  const previous = globalThis.Pinia;
  globalThis.Pinia = { useChatStore: () => store };
  const wrapper = mount(ResourceControl, { props: { item, agentId: 'agent' }, global: { mocks: { $t: key => en[key] || key } } });
  try {
    const refresh = wrapper.vm.refreshLatest();
    store.connectionState = 'disconnected';
    await flushPromises();
    store.connectionState = 'connected';
    await flushPromises();
    resolve(item);
    await refresh;
    expect(wrapper.vm.refreshRequired).toBe(true);
    expect(wrapper.vm.canManage).toBe(false);
    expect(wrapper.vm.notice).toBe('');
    store.getWorkItem.mockResolvedValue(item);
    await wrapper.vm.refreshLatest();
    expect(wrapper.vm.refreshRequired).toBe(false);
    expect(wrapper.vm.canManage).toBe(true);
  } finally { wrapper.unmount(); globalThis.Pinia = previous; }
});
