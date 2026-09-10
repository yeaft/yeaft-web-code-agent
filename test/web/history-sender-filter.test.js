// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

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

  it('shows an unknown count and emits retry when the outline fails', async () => {
    const wrapper = mount(YeaftConversationOutline, {
      props: {
        outlineState: {
          results: [], loading: false, hasMore: false, totalCount: 0,
          error: 'index_unavailable',
        },
        searchState: {
          query: '', senderKey: '', results: [], loading: false, hasMore: false, error: null,
        },
      },
      global: { mocks: { $t: key => key } },
    });

    expect(wrapper.get('.yeaft-conversation-outline-count').text()).toBe('—');
    expect(wrapper.get('[role="alert"]').text()).toContain('yeaft.outline.indexUnavailable');
    await wrapper.get('[role="alert"] button').trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
    wrapper.unmount();
  });

  it('distinguishes a timeout and does not offer retry for unsupported Agents', () => {
    const timeoutWrapper = mount(YeaftConversationOutline, {
      props: {
        outlineState: { results: [], loading: false, hasMore: false, totalCount: 0, error: 'timeout' },
        searchState: { query: '', senderKey: '', results: [], loading: false, hasMore: false, error: null },
      },
      global: { mocks: { $t: key => key } },
    });
    expect(timeoutWrapper.get('[role="alert"]').text()).toContain('yeaft.outline.timeout');
    timeoutWrapper.unmount();

    const unsupportedWrapper = mount(YeaftConversationOutline, {
      props: {
        outlineState: { results: [], loading: false, hasMore: false, totalCount: 0, error: 'unsupported' },
        searchState: { query: '', senderKey: '', results: [], loading: false, hasMore: false, error: null },
      },
      global: { mocks: { $t: key => key } },
    });
    expect(unsupportedWrapper.get('[role="alert"]').text()).toContain('yeaft.outline.unsupported');
    expect(unsupportedWrapper.find('[role="alert"] button').exists()).toBe(false);
    unsupportedWrapper.unmount();
  });
});
