// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import SubAgentPanel from '../../web/components/SubAgentPanel.js';
import {
  clearMarkdownCache,
  renderMarkdown,
  renderMermaidIn,
  resetMermaidForTests,
} from '../../web/utils/markdown.js';

describe('markdown Mermaid rendering', () => {
  afterEach(() => {
    delete globalThis.mermaid;
    delete globalThis.Vue;
    delete globalThis.Pinia;
    clearMarkdownCache();
    resetMermaidForTests();
  });

  it('keeps Mermaid fenced blocks as renderable code before client-side render', () => {
    const html = renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```');

    expect(html).toContain('code-block-wrapper');
    expect(html).toContain('language-mermaid');
    expect(html).toContain('graph TD');
  });

  it('replaces Mermaid code blocks with rendered SVG when Mermaid is available', async () => {
    globalThis.mermaid = {
      initialize: vi.fn(),
      render: vi.fn(async (id, code) => ({ svg: `<svg data-id="${id}"><text>${code}</text></svg>` })),
    };
    document.documentElement.removeAttribute('data-theme');
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```');

    await renderMermaidIn(container);

    expect(globalThis.mermaid.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'strict',
    });
    expect(globalThis.mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), expect.stringContaining('A-->B'));
    expect(container.querySelector('.mermaid-rendered svg')).not.toBeNull();
    expect(container.querySelector('pre code.language-mermaid')).toBeNull();
  });

  it('leaves the code block in place when Mermaid rendering fails', async () => {
    globalThis.mermaid = {
      initialize: vi.fn(),
      render: vi.fn(async () => { throw new Error('bad diagram'); }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('```mermaid\nbroken\n```');

    await renderMermaidIn(container);

    const code = container.querySelector('pre code.language-mermaid');
    expect(code).not.toBeNull();
    expect(code.dataset.mermaidError).toBe('true');
    expect(container.querySelector('.mermaid-rendered')).toBeNull();
    warn.mockRestore();
  });

  it('rerenders sub-agent Mermaid blocks when switching active agents with equal message counts', async () => {
    globalThis.Vue = Vue;
    const store = Vue.reactive({
      activeSubagentId: 'agent-a',
      currentSubagents: [
        {
          id: 'agent-a',
          slug: 'agent-a',
          type: 'explorer',
          status: 'completed',
          startTime: 2,
          messages: [{ type: 'text', content: 'plain text' }],
        },
        {
          id: 'agent-b',
          slug: 'agent-b',
          type: 'explorer',
          status: 'completed',
          startTime: 1,
          messages: [{ type: 'text', content: '```mermaid\ngraph TD\n  B-->C\n```' }],
        },
      ],
    });
    Object.defineProperty(store, 'activeSubagentMessages', {
      get() {
        const agent = store.currentSubagents.find((item) => item.id === store.activeSubagentId);
        return agent?.messages || [];
      },
    });
    globalThis.Pinia = { useChatStore: () => store };
    globalThis.mermaid = {
      initialize: vi.fn(),
      render: vi.fn(async (id, code) => ({ svg: `<svg data-id="${id}"><text>${code}</text></svg>` })),
    };

    const wrapper = mount(SubAgentPanel, {
      props: { visible: true },
      global: {
        mocks: {
          $t: (key, params) => params?.count != null ? `${key}:${params.count}` : key,
        },
      },
      attachTo: document.body,
    });
    await Vue.nextTick();
    await Vue.nextTick();
    expect(wrapper.find('pre code.language-mermaid').exists()).toBe(false);

    store.activeSubagentId = 'agent-b';
    await Vue.nextTick();
    await Vue.nextTick();
    await Promise.resolve();

    expect(globalThis.mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), expect.stringContaining('B-->C'));
    expect(wrapper.find('.mermaid-rendered svg').exists()).toBe(true);
    expect(wrapper.find('pre code.language-mermaid').exists()).toBe(false);
    wrapper.unmount();
  });
});
