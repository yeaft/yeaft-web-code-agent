// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import Drawer from '../../web/components/YeaftToolStatsDrawer.js';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';

let wrapper;
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.unstubAllGlobals(); });
function render(snapshot, messages = en, registered = []) {
  const store = Vue.reactive({ yeaftToolStats: { snapshot, registered }, fetchYeaftToolStats: vi.fn() });
  vi.stubGlobal('Pinia', { useChatStore: () => store });
  wrapper = mount(Drawer, {
    props: { modelValue: true },
    global: { mocks: { $t: key => messages[key] || key } },
  });
  return store;
}
const legacy = { callCount: 1000, errorCount: 392, errorRate: 0.392, avgMs: 4, p50Ms: 3, p95Ms: 9, lastCalledAt: null, lastError: '/private/token' };

describe('Tool statistics drawer', () => {
  it('contrasts lifetime with sampled errors and exposes concise safe reason details in English', async () => {
    const store = render({ GitRead: { ...legacy, recent: { windowSize: 100, callCount: 10, errorCount: 2, errorRate: 0.2, errorReasons: { git_timeout: 1, invalid_arguments: 1 } } } });
    const row = wrapper.get('details');
    expect(row.get('.tool-stats-lifetime').text()).toBe('Lifetime39.2%392 / 1000 errors / calls');
    expect(row.get('.tool-stats-recent').text()).toBe('Recent20.0%2 / 10 errors / calls');
    expect(wrapper.text()).toContain(en['yeaft.toolStats.windowNote']);
    expect(row.attributes('open')).toBeUndefined();
    row.element.open = true;
    await row.trigger('toggle');
    expect(row.element.open).toBe(true);
    expect(row.get('.tool-stats-latency').text()).toContain('p95 9ms');
    expect(row.findAll('.tool-stats-reasons li').map(item => item.text())).toEqual([
      `${en['yeaft.toolStats.reason.git_timeout']}1`, `${en['yeaft.toolStats.reason.invalid_arguments']}1`,
    ]);
    expect(wrapper.text()).not.toContain('/private/token');
    expect(wrapper.find('table').exists()).toBe(false);
    await wrapper.get('.tool-stats-drawer-actions button').trigger('click');
    expect(store.fetchYeaftToolStats).toHaveBeenCalledOnce();
    await wrapper.get('.tool-stats-drawer-actions button:last-child').trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]]);
  });

  it('shows unknown recent data for legacy/registered rows and zero only for measured success in Chinese', async () => {
    const store = render({ GitRead: legacy }, zh, ['GitRead', 'Unused']);
    const rows = wrapper.findAll('details');
    expect(rows.map(row => row.get('.tool-stats-name').text())).toEqual(['GitRead', 'Unused']);
    expect(rows[0].get('.tool-stats-lifetime').text()).toContain('历史累计39.2%392 / 1000 错误 / 调用');
    for (const row of rows) {
      expect(row.get('.tool-stats-recent').text()).toBe('近期样本暂无近期样本');
      expect(row.get('.tool-stats-reasons-empty').text()).toBe('暂无近期样本');
    }
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe(zh['yeaft.toolStats.title']);
    expect(wrapper.text()).toContain(zh['yeaft.toolStats.windowNote']);
    store.yeaftToolStats.snapshot.GitRead.recent = { callCount: 1, errorCount: 0, errorRate: 0, errorReasons: {} };
    await Vue.nextTick();
    expect(wrapper.get('.tool-stats-recent').text()).toBe('近期样本0%0 / 1 错误 / 调用');
    expect(wrapper.get('.tool-stats-reasons-empty').text()).toBe('近期样本无错误');
    store.yeaftToolStats.snapshot.GitRead.recent = { callCount: 1, errorCount: 1, errorRate: 1, errorReasons: { network: 1 } };
    await Vue.nextTick();
    expect(wrapper.get('.tool-stats-reasons').text()).toBe('网络1');
  });
});
