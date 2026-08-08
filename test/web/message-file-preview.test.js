// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isWorkbenchMessageForRoute,
  workbenchWorkspaceGeneration,
} from '../../web/utils/workbench-route.js';
import * as Vue from 'vue';
import { decorateMessageFileReferences, resolveMessageFileReference } from '../../web/utils/message-file-reference.js';

const readWeb = path => readFileSync(resolve(process.cwd(), 'web', path), 'utf8');

const capabilityMounts = [];

function capabilityStub(name, className) {
  return {
    props: {
      routeKey: { type: String, default: '' },
      runtimeProvider: { type: String, default: '' },
      agentId: { type: String, default: '' },
      sessionId: { type: String, default: '' },
      conversationId: { type: String, default: '' },
      workDir: { type: String, default: '' },
      workspaceGeneration: { type: String, default: '' },
    },
    setup(props) {
      Vue.onMounted(() => capabilityMounts.push({ name, ...props }));
      return { props };
    },
    template: `<div :class="'${className}'" :data-route-key="props.routeKey" :data-session-id="props.sessionId" :data-work-dir="props.workDir" :data-workspace-generation="props.workspaceGeneration">${name}</div>`,
  };
}

const workbenchStore = Vue.reactive({
  workbenchExpanded: true,
  workbenchMaximized: false,
  currentAgent: 'agent-1',
  currentConversation: 'yeaft-agent-1',
  activeSessionRoute: {
    runtimeProvider: 'yeaft',
    agentId: 'agent-1',
    sessionId: 'session-a',
  },
  effectiveWorkDir: '/workspace/a',
  capabilities: ['terminal', 'file_editor', 'workbench_session_routes'],
  workbenchRouteProtocolSupported: true,
  hasCapability(capability) {
    return this.capabilities.includes(capability);
  },
  toggleWorkbench: vi.fn(),
  toggleWorkbenchMaximized: vi.fn(),
});

globalThis.Vue = Vue;
globalThis.Pinia = {
  ...(globalThis.Pinia || {}),
  defineStore: globalThis.Pinia?.defineStore || (() => () => ({})),
  useChatStore: () => workbenchStore,
};
window.Pinia = globalThis.Pinia;

const { default: WorkbenchPanel } = await import('../../web/components/WorkbenchPanel.js');
const { default: ChatHeader } = await import('../../web/components/ChatHeader.js');

function mountWorkbench() {
  return mount(WorkbenchPanel, {
    attachTo: document.body,
    global: {
      mocks: { $t: key => key },
      stubs: {
        TerminalTab: capabilityStub('terminal', 'terminal-tab-stub'),
        GitStatusTab: capabilityStub('git', 'git-tab-stub'),
        FilesTab: capabilityStub('files', 'files-tab-stub'),
      },
    },
  });
}

describe('Workbench capability launcher', () => {
  beforeEach(() => {
    workbenchStore.workbenchExpanded = true;
    workbenchStore.workbenchMaximized = false;
    workbenchStore.currentAgent = 'agent-1';
    workbenchStore.currentConversation = 'yeaft-agent-1';
    workbenchStore.activeSessionRoute = {
      runtimeProvider: 'yeaft',
      agentId: 'agent-1',
      sessionId: 'session-a',
    };
    workbenchStore.effectiveWorkDir = '/workspace/a';
    workbenchStore.capabilities = ['terminal', 'file_editor', 'workbench_session_routes'];
    workbenchStore.workbenchRouteProtocolSupported = true;
    capabilityMounts.length = 0;
    workbenchStore.toggleWorkbench.mockClear();
    workbenchStore.toggleWorkbenchMaximized.mockClear();
    globalThis.Pinia.useChatStore = () => workbenchStore;
    window.Pinia = globalThis.Pinia;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens on a four-capability launcher instead of persistent tabs', () => {
    const wrapper = mountWorkbench();

    const cards = wrapper.findAll('.workbench-capability-card');
    expect(cards.map(card => card.attributes('data-workbench-capability')))
      .toEqual(['terminal', 'git', 'files', 'browser']);
    expect(wrapper.find('.workbench-tabs').exists()).toBe(false);
    expect(wrapper.find('.wb-tab').exists()).toBe(false);
    expect(wrapper.get('.workbench-header-title').text()).toBe('workbench.title');
    expect(wrapper.get('[data-workbench-capability="terminal"] .workbench-capability-status').text()).toBe('workbench.available');
    expect(wrapper.get('[data-workbench-capability="browser"] .workbench-capability-status').text()).toBe('workbench.unavailable');
    expect(wrapper.get('[data-workbench-capability="browser"]').attributes('disabled')).toBeUndefined();
    expect(capabilityMounts).toEqual([]);
    wrapper.unmount();
  });

  it('lazily opens one route-scoped capability and restores keyboard focus on close', async () => {
    const wrapper = mountWorkbench();
    const terminalCard = wrapper.get('[data-workbench-capability="terminal"]');
    terminalCard.element.focus();

    await terminalCard.trigger('click');
    await Vue.nextTick();
    expect(wrapper.get('.terminal-tab-stub').isVisible()).toBe(true);
    expect(wrapper.get('.terminal-tab-stub').attributes()).toMatchObject({
      'data-route-key': 'yeaft:agent-1:session-a',
      'data-session-id': 'session-a',
      'data-work-dir': '/workspace/a',
      'data-workspace-generation': workbenchWorkspaceGeneration(
        'yeaft:agent-1:session-a',
        '/workspace/a',
      ),
    });
    expect(capabilityMounts.map(entry => entry.name)).toEqual(['terminal']);
    expect(wrapper.get('.workbench-header-title').text()).toBe('workbench.terminal');
    expect(wrapper.find('.workbench-launcher').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.workbench-view-close').element);

    await wrapper.get('.workbench-view-close').trigger('click');
    await Vue.nextTick();
    expect(wrapper.get('.workbench-launcher').isVisible()).toBe(true);
    expect(wrapper.get('.workbench-header-title').text()).toBe('workbench.title');
    expect(document.activeElement).toBe(wrapper.get('[data-workbench-capability="terminal"]').element);

    await wrapper.get('.workbench-panel-close').trigger('click');
    expect(workbenchStore.toggleWorkbench).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('resets and isolates activated capabilities across same-Agent Session routes', async () => {
    const wrapper = mountWorkbench();
    await wrapper.get('[data-workbench-capability="terminal"]').trigger('click');
    await Vue.nextTick();
    expect(wrapper.get('.terminal-tab-stub').attributes('data-route-key')).toBe('yeaft:agent-1:session-a');

    workbenchStore.activeSessionRoute = {
      runtimeProvider: 'yeaft',
      agentId: 'agent-1',
      sessionId: 'session-b',
    };
    workbenchStore.effectiveWorkDir = '/workspace/b';
    await Vue.nextTick();
    expect(wrapper.get('.workbench-launcher').isVisible()).toBe(true);
    expect(wrapper.find('.terminal-tab-stub').exists()).toBe(false);

    await wrapper.get('[data-workbench-capability="git"]').trigger('click');
    await Vue.nextTick();
    expect(wrapper.get('.git-tab-stub').attributes()).toMatchObject({
      'data-route-key': 'yeaft:agent-1:session-b',
      'data-session-id': 'session-b',
      'data-work-dir': '/workspace/b',
      'data-workspace-generation': workbenchWorkspaceGeneration(
        'yeaft:agent-1:session-b',
        '/workspace/b',
      ),
    });
    expect(capabilityMounts.map(entry => `${entry.name}:${entry.routeKey}`)).toEqual([
      'terminal:yeaft:agent-1:session-a',
      'git:yeaft:agent-1:session-b',
    ]);
    wrapper.unmount();
  });

  it('rejects delayed responses from an older workspace generation on the same route', () => {
    const routeKey = 'yeaft:agent-1:session-a';
    const oldGeneration = workbenchWorkspaceGeneration(routeKey, '/workspace/a');
    const currentGeneration = workbenchWorkspaceGeneration(routeKey, '/workspace/b');
    for (const type of [
      'git_status_result',
      'directory_listing',
      'file_search_result',
      'file_tabs_restored',
    ]) {
      expect(isWorkbenchMessageForRoute({
        type,
        workbenchRouteKey: routeKey,
        workbenchWorkspaceGeneration: oldGeneration,
      }, routeKey, currentGeneration)).toBe(false);
      expect(isWorkbenchMessageForRoute({
        type,
        workbenchRouteKey: routeKey,
        workbenchWorkspaceGeneration: currentGeneration,
      }, routeKey, currentGeneration)).toBe(true);
    }
  });

  it('keeps Browser discoverable without pretending Phase 0 has a viewer', async () => {
    const wrapper = mountWorkbench();

    await wrapper.get('[data-workbench-capability="browser"]').trigger('click');
    expect(wrapper.get('.workbench-browser-view').text()).toContain('workbench.browserUnavailable');
    expect(wrapper.find('video').exists()).toBe(false);
    expect(wrapper.find('iframe').exists()).toBe(false);
    wrapper.unmount();
  });

  it('routes a message file-open event directly to Files and resets on reopen', async () => {
    const wrapper = mountWorkbench();

    window.dispatchEvent(new CustomEvent('open-file-in-explorer', { detail: {
      filePath: 'README.md',
      workbenchRoute: workbenchStore.activeSessionRoute,
    } }));
    await Vue.nextTick();
    expect(wrapper.get('.files-tab-stub').isVisible()).toBe(true);
    expect(wrapper.get('.files-tab-stub').attributes('data-route-key')).toBe('yeaft:agent-1:session-a');
    expect(wrapper.get('.workbench-header-title').text()).toBe('workbench.files');

    workbenchStore.workbenchExpanded = false;
    await Vue.nextTick();
    workbenchStore.workbenchExpanded = true;
    await Vue.nextTick();
    expect(wrapper.get('.workbench-launcher').isVisible()).toBe(true);
    wrapper.unmount();
  });

  it('shows unavailable detail for unsupported legacy capabilities', async () => {
    workbenchStore.capabilities = ['terminal', 'file_editor'];
    workbenchStore.workbenchRouteProtocolSupported = false;
    const wrapper = mountWorkbench();

    await wrapper.get('[data-workbench-capability="git"]').trigger('click');
    expect(wrapper.get('.workbench-capability-empty').text()).toContain('workbench.capabilityUnavailable');
    expect(wrapper.find('.git-tab-stub').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('Workbench entry', () => {
  it('shows the Chat entry from the page gate instead of unrelated provider capabilities', () => {
    const toggleWorkbench = vi.fn();
    const headerStore = {
      currentConversation: 'conversation-1',
      conversations: [{
        id: 'conversation-1',
        provider: 'copilot',
        capabilities: { clear: true, mcp: true },
      }],
      agents: [],
      currentWorkDir: '/workspace',
      workbenchExpanded: false,
      compactStatus: null,
      clearStatus: null,
      contextUsage: null,
      currentMcpServers: [],
      mcpPanelOpen: false,
      runningSubagentCount: 0,
      expertSelections: [],
      getConversationTitle: () => 'Conversation',
      isRefreshingSession: () => false,
      getPaneRightPanel: () => null,
      toggleWorkbench,
    };
    globalThis.Pinia.useChatStore = () => headerStore;

    const visible = mount(ChatHeader, {
      props: { canUseWorkbench: true },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    expect(visible.find('[aria-label="chat.sidebar.workbench"]').exists()).toBe(true);
    visible.unmount();

    const hidden = mount(ChatHeader, {
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    expect(hidden.find('[aria-label="chat.sidebar.workbench"]').exists()).toBe(false);
    hidden.unmount();
  });
});

describe('message file preview', () => {
  it('accepts local code and document references while leaving web links alone', () => {
    expect(resolveMessageFileReference('docs/design-doc.md#L119')).toEqual({ path: 'docs/design-doc.md', line: 119 });
    expect(resolveMessageFileReference('./src/main.js:42')).toEqual({ path: './src/main.js', line: 42 });
    expect(resolveMessageFileReference('/workspace/readme.md')).toEqual({ path: '/workspace/readme.md', line: null });
    expect(resolveMessageFileReference('file:///workspace/spec.pdf')).toEqual({ path: '/workspace/spec.pdf', line: null });
    expect(resolveMessageFileReference('https://example.test/design-doc.md')).toBeNull();
    expect(resolveMessageFileReference('#section')).toBeNull();
    expect(resolveMessageFileReference('/api/files/readme.md')).toBeNull();
  });

  it('rejects Git refs and versions without blocking recognizable extensionless files', () => {
    expect(resolveMessageFileReference('origin/main')).toBeNull();
    expect(resolveMessageFileReference('feature/message-preview')).toBeNull();
    expect(resolveMessageFileReference('v1.0.403')).toBeNull();
    expect(resolveMessageFileReference('release/v1.0.403')).toBeNull();
    expect(resolveMessageFileReference('./v1.0.403')).toEqual({ path: './v1.0.403', line: null });
    expect(resolveMessageFileReference('/workspace/v1.0.403')).toEqual({ path: '/workspace/v1.0.403', line: null });
    expect(resolveMessageFileReference('file:///workspace/v1.0.403')).toEqual({ path: '/workspace/v1.0.403', line: null });
    expect(resolveMessageFileReference('artifact.7z')).toBeNull();
    expect(resolveMessageFileReference('./artifact.7z')).toBeNull();
    expect(resolveMessageFileReference('/workspace/archive.tar.gz')).toBeNull();
    expect(resolveMessageFileReference('README')).toEqual({ path: 'README', line: null });
    expect(resolveMessageFileReference('Dockerfile')).toEqual({ path: 'Dockerfile', line: null });
    expect(resolveMessageFileReference('docs/README')).toEqual({ path: 'docs/README', line: null });
    expect(resolveMessageFileReference('.gitignore')).toEqual({ path: '.gitignore', line: null });
  });

  it('decorates file links and standalone inline-code references without touching code blocks', () => {
    const html = decorateMessageFileReferences([
      '<a href="docs/design-doc.md#L119">design doc</a>',
      '<a class="existing" href="docs/notes.md">notes</a>',
      '<a href="https://example.test">web</a>',
      '<code>web/components/WorkbenchPanel.js:1</code>',
      '<code>origin/main</code>',
      '<code>v1.0.403</code>',
      '<code>artifact.7z</code>',
      '<pre><code>web/components/FilesTab.js:17</code></pre>',
    ].join(' '));

    expect(html).toContain('href="docs/design-doc.md#L119" class="message-file-reference"');
    expect(html).toContain('class="existing message-file-reference" href="docs/notes.md"');
    expect(html).not.toMatch(/<a[^>]*\bclass=[^>]*\bclass=/);
    expect(html).toContain('<a href="web/components/WorkbenchPanel.js:1" class="message-file-reference"');
    expect(html).toContain('<code>origin/main</code>');
    expect(html).toContain('<code>v1.0.403</code>');
    expect(html).not.toContain('href="origin/main"');
    expect(html).not.toContain('href="v1.0.403"');
    expect(html).toContain('<code>artifact.7z</code>');
    expect(html).not.toContain('href="artifact.7z"');
    expect(html).toContain('<a href="https://example.test">web</a>');
    expect(html).toContain('<pre><code>web/components/FilesTab.js:17</code></pre>');
  });

  it('opens a local Markdown link in the message file panel without intercepting external links', async () => {
    const openFileInExplorer = vi.fn();
    globalThis.Vue = Vue;
    globalThis.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({
        answerUserQuestion: vi.fn(),
        cancelVpTurn: vi.fn(),
        openFileInExplorer,
      }),
    };
    globalThis.marked = {
      setOptions: vi.fn(),
      parse: vi.fn(() => '<p><a href="docs/design-doc.md#L119">design doc</a> <a href="https://example.test">web</a></p>'),
    };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: {
        turn: {
          id: 'turn-file-preview',
          textContent: 'links',
          textSegments: [{ key: 'result', content: 'links', kind: 'result' }],
          toolMsgs: [], imageMsgs: [], todoMsg: null, askMsg: null, isStreaming: false,
        },
      },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });

    await wrapper.get('a[href="docs/design-doc.md#L119"]').trigger('click');
    expect(openFileInExplorer).toHaveBeenCalledWith('docs/design-doc.md', { hideTree: true, line: 119 });

    await wrapper.get('a[href="https://example.test"]').trigger('click');
    expect(openFileInExplorer).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('wires the right panel to the complete Files experience with a collapsed tree by default', () => {
    const filesTab = readWeb('components/FilesTab.js');
    const workbench = readWeb('components/WorkbenchPanel.js');
    const capabilityHost = readWeb('components/WorkbenchCapabilityHost.js');
    const chatPage = readWeb('components/ChatPage.js');
    const chatHeader = readWeb('components/ChatHeader.js');
    const yeaftPage = readWeb('components/YeaftPage.js');
    const yeaftActions = readWeb('components/YeaftSessionActions.js');
    const yeaftSidebar = readWeb('components/YeaftSidebar.js');

    expect(filesTab).toContain('treeInitiallyVisible');
    expect(filesTab).toContain("'tree-collapsed': !treeVisible");
    expect(filesTab.match(/class="vscode-action-btn file-tree-collapse-btn"/g)).toHaveLength(2);
    expect(filesTab.match(/d="M8\.59 16\.59 13\.17 12 8\.59 7\.41 10 6l6 6-6 6z"/g)).toHaveLength(2);
    expect(filesTab).not.toContain('d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"');
    expect(filesTab).toContain('class="file-tree-collapsed-rail"');
    expect(filesTab).not.toContain('class="file-tree-toggle"');
    const filesCss = readWeb('styles/files.css');
    const mobileCss = filesCss.slice(filesCss.indexOf('@media (max-width: 768px)'));
    expect(mobileCss).toMatch(/\.file-tree-collapsed-rail\s*\{[^}]*display:\s*none;/s);
    expect(mobileCss).toMatch(/\.file-two-col\.tree-collapsed \.file-col-tree\s*\{[^}]*display:\s*flex;/s);
    const wsHandler = readWeb('components/files/wsHandler.js');
    expect(wsHandler).toContain('pendingRevealLines.set(nPath, line)');
    expect(wsHandler).toContain('normalizePath(msg.requestedFilePath || msg.filePath)');
    expect(readWeb('../agent/workbench/file-ops.js')).toContain('requestedFilePath: filePath');
    expect(filesCss).toMatch(/\.file-tree-collapsed-rail\s*\{[^}]*order:\s*4;[^}]*border-left:/s);
    expect(filesCss).toMatch(/\.file-col-tree\s*\{[^}]*order:\s*3;/s);
    expect(filesCss).toMatch(/\.file-col-content\s*\{[^}]*order:\s*1;/s);
    expect(filesCss).toMatch(/\.file-tree-splitter\s*\{[^}]*order:\s*2;/s);
    expect(filesTab).toContain('startWidth - (clientX - startX)');
    expect(workbench).toContain('<WorkbenchCapabilityHost');
    expect(capabilityHost).toContain("files: 'FilesTab'");
    expect(capabilityHost).toContain(':tree-initially-visible="activeCapability === \'files\' ? false : undefined"');
    expect(workbench).toContain('class="workbench-header-action workbench-maximize-btn"');
    expect(workbench).toContain(':aria-label="store.workbenchMaximized ? $t(\'workbench.restore\') : $t(\'workbench.maximize\')"');
    expect(workbench).toContain('d="M7 14H5v5h5v-2H7v-3z');
    expect(workbench).toContain('d="M5 16h3v3h2v-5H5v2z');
    expect(readWeb('stores/chat.js')).toContain('else Vue.nextTick(dispatchOpen);');
    expect(chatPage.indexOf('<WorkbenchPanel')).toBeGreaterThan(chatPage.indexOf('<div class="chat-body"'));
    expect(chatHeader).toContain("$t('chat.sidebar.workbench')");
    expect(chatHeader).toContain('canUseWorkbench: { type: Boolean, default: false }');
    expect(chatHeader).not.toContain("capOn('file_editor')");
    expect(chatPage).toContain('<ChatHeader :can-use-workbench="canUseWorkbench"');
    expect(yeaftActions).toContain("@click=\"$emit('toggle-workbench')\"");
    expect(yeaftPage.indexOf('<WorkbenchPanel')).toBeGreaterThan(yeaftPage.indexOf('<div class="yeaft-main"'));
    const yeaftCss = readWeb('styles/yeaft.css');
    expect(yeaftCss).toMatch(/\.yeaft-main\.workbench-maximized\s*\{[^}]*display:\s*none;/s);
    expect(yeaftCss).not.toContain('.yeaft-main.workbench-maximized > .yeaft-main-center');
    expect(yeaftSidebar).not.toContain('@click="onToggleWorkbench"');
  });
});
