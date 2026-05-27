// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';

globalThis.Vue = Vue;

import MessageItem from '../../web/components/MessageItem.js';

function mountMessage(message) {
  globalThis.Pinia = globalThis.Pinia || {};
  globalThis.Pinia.useChatStore = () => ({ customExpertRoles: [] });
  return mount(MessageItem, {
    props: { message },
    global: {
      provide: {
        t: (key, params) => {
          if (key === 'message.imageCount') return `${params.count} image`;
          if (key === 'message.fileCount') return `${params.count} file`;
          if (key === 'common.comma') return ', ';
          return key;
        },
      },
      stubs: {},
    },
  });
}

describe('MessageItem attachment rendering', () => {
  it('renders replayed image attachments with a persisted preview URL', async () => {
    const wrapper = mountMessage({
      type: 'user',
      content: 'see image',
      attachments: [{
        name: 'pic.png',
        mimeType: 'image/png',
        isImage: true,
        preview: '/api/preview/file-id?token=tok',
      }],
    });

    await wrapper.find('.attachments-badge').trigger('click');

    const img = wrapper.find('img.user-attachment-image');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('/api/preview/file-id?token=tok');
    expect(wrapper.find('.user-attachment-file').exists()).toBe(false);
  });

  it('keeps old no-preview image attachments as file cards', async () => {
    const wrapper = mountMessage({
      type: 'user',
      content: 'old image',
      attachments: [{ name: 'old.png', mimeType: 'image/png', isImage: true }],
    });

    await wrapper.find('.attachments-badge').trigger('click');

    expect(wrapper.find('img.user-attachment-image').exists()).toBe(false);
    expect(wrapper.find('.user-attachment-file').exists()).toBe(true);
  });
});
