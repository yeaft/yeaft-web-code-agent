// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let YeaftConversationOutline;

beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ default: YeaftConversationOutline } = await import('../../web/components/YeaftConversationOutline.js'));
});

describe('Yeaft user-message history search', () => {
  it('renders only the user-message locator without a sender selector', async () => {
    const wrapper = mount(YeaftConversationOutline, {
      props: {
        outlineState: { results: [], loading: false, hasMore: false, totalCount: null },
        searchState: {
          query: '', senderKey: 'user',
          results: [{ messageId: 'm1', role: 'user', snippet: 'find this prompt' }],
          loading: false, hasMore: false, error: null,
        },
        activeMessageId: 'm1',
      },
      global: { mocks: { $t: key => key } },
      attachTo: document.body,
    });

    expect(wrapper.find('.yeaft-conversation-outline-search').exists()).toBe(true);
    expect(wrapper.find('.yeaft-conversation-outline-sender').exists()).toBe(false);
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.get('[role="option"]').text()).toContain('find this prompt');

    await wrapper.get('input[type="search"]').setValue('next prompt');
    expect(wrapper.emitted('query')?.at(-1)).toEqual(['next prompt']);
    wrapper.unmount();
  });

  it('keeps a load-more click inside the outline when the button disappears synchronously', async () => {
    const documentClick = vi.fn();
    document.addEventListener('click', documentClick);
    const wrapper = mount(YeaftConversationOutline, {
      props: {
        outlineState: { results: [], loading: false, hasMore: false, totalCount: null },
        searchState: {
          query: '', senderKey: 'user',
          results: Array.from({ length: 20 }, (_, index) => ({
            messageId: `m${20 - index}`,
            role: 'user',
            snippet: `prompt ${20 - index}`,
          })),
          loading: false, hasMore: true, error: null,
        },
        activeMessageId: 'm20',
        onLoadMoreSearch: () => wrapper.setProps({
          searchState: {
            ...wrapper.props('searchState'),
            loading: true,
            hasMore: false,
          },
        }),
      },
      global: { mocks: { $t: key => key } },
      attachTo: document.body,
    });

    await wrapper.get('.yeaft-conversation-outline-more').trigger('click');
    await Vue.nextTick();

    expect(wrapper.emitted('load-more-search')).toHaveLength(1);
    expect(wrapper.find('.yeaft-conversation-outline-more').exists()).toBe(false);
    expect(documentClick).not.toHaveBeenCalled();
    document.removeEventListener('click', documentClick);
    wrapper.unmount();
  });
});
