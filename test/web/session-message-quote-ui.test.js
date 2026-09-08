// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import {
  appendTurnResponseSegment,
  finalizeTurnResponseSegments,
  markTurnResponseKinds,
} from '../../web/utils/turn-response.js';
import {
  messageVpOwner,
  orderYeaftVpTurnMessagesByExecution,
  shouldCloseYeaftVpTurn,
} from '../../web/stores/helpers/yeaft-turn-boundary.js';

function groupYeaftHistoryRows(messages) {
  const turns = [];
  let currentTurn = null;
  for (const msg of orderYeaftVpTurnMessagesByExecution(messages)) {
    if (currentTurn && shouldCloseYeaftVpTurn(currentTurn, msg)) {
      turns.push(currentTurn);
      currentTurn = null;
    }
    if (!currentTurn) {
      currentTurn = {
        speakerVpId: messageVpOwner(msg),
        turnId: msg.turnId,
        isHistory: msg.isHistory === true,
        messages: [],
      };
    }
    currentTurn.messages.push(msg);
  }
  if (currentTurn) turns.push(currentTurn);
  return turns;
}

describe('Session message quote UI wiring', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete globalThis.marked;
    delete globalThis.hljs;
    vi.unstubAllGlobals();
  });

  it('keeps user attachments inside the bubble and separates turn progress from the final Markdown result', async () => {
    const user = readFileSync(resolve(process.cwd(), 'web/components/MessageItem.js'), 'utf8');
    const bubbleStart = user.indexOf('class="message-user-block"');
    const attachmentsEnd = user.indexOf('<!-- Expanded attachments preview -->');
    const bubbleBeforeAttachments = user.slice(bubbleStart, attachmentsEnd);

    expect(bubbleBeforeAttachments).toContain('class="attachments-badge"');
    expect(bubbleBeforeAttachments).not.toContain('class="message-action-btn"');
    expect(user.indexOf('class="message-user-actions"')).toBeGreaterThan(user.indexOf('class="user-attachments"'));
    expect(user).not.toContain('class="user-attachments-indicator"');

    globalThis.Vue = Vue;
    globalThis.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({ answerUserQuestion: vi.fn(), cancelVpTurn: vi.fn() }),
    };
    globalThis.marked = {
      setOptions: vi.fn(),
      parse: vi.fn(text => text.startsWith('## ')
        ? `<h2>${text.slice(3)}</h2>`
        : `<p>${text}</p>`),
    };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');

    const rows = [
      { id: 'a1', type: 'assistant', content: 'Inspecting files.', sessionId: 's1', speakerVpId: 'linus', turnId: 't1' },
      { id: 'a2', type: 'assistant', content: 'Sibling reply.', sessionId: 's1', speakerVpId: 'martin', turnId: 't2' },
      { id: 'a3', type: 'assistant', content: '## 改动', sessionId: 's1', speakerVpId: 'linus', turnId: 't1' },
    ];
    markTurnResponseKinds(rows, { sessionId: 's1', vpId: 'linus', turnId: 't1', reason: 'end_turn' });
    expect(rows.map(row => row.responseKind)).toEqual(['progress', undefined, 'result']);

    const aborted = [{ type: 'assistant', content: 'Partial', sessionId: 's1', speakerVpId: 'linus', turnId: 't3' }];
    markTurnResponseKinds(aborted, { sessionId: 's1', vpId: 'linus', turnId: 't3', reason: 'aborted' });
    expect(aborted[0].responseKind).toBe('progress');

    const errored = [{ type: 'assistant', content: 'Partial before error', sessionId: 's1', speakerVpId: 'linus', turnId: 't4' }];
    markTurnResponseKinds(errored, { sessionId: 's1', vpId: 'linus', turnId: 't4', reason: 'errored' });
    expect(errored[0].responseKind).toBe('progress');

    const legacyHistoryTurns = groupYeaftHistoryRows([
      { id: 'partial-a', type: 'assistant', speakerVpId: 'linus', turnId: 'runtime-a', isHistory: true },
      { id: 'partial-b', type: 'assistant', speakerVpId: 'linus', turnId: 'runtime-b', isHistory: true },
      { id: 'result-c', type: 'assistant', speakerVpId: 'linus', turnId: 'runtime-c', isHistory: true },
    ]);
    expect(legacyHistoryTurns).toHaveLength(1);
    expect(legacyHistoryTurns[0].messages.map(message => message.id))
      .toEqual(['partial-a', 'partial-b', 'result-c']);

    const routeForwardTurns = groupYeaftHistoryRows([
      ...legacyHistoryTurns[0].messages,
      {
        id: 'handoff-d',
        type: 'assistant',
        speakerVpId: 'linus',
        turnId: 'runtime-d',
        executionOrigin: 'route_forward',
        isHistory: true,
      },
      {
        id: 'handoff-tool',
        type: 'tool-use',
        toolName: 'FileRead',
        toolInput: { file_path: 'README.md' },
        speakerVpId: 'linus',
        turnId: 'runtime-d',
        executionOrigin: 'route_forward',
        isHistory: true,
      },
    ]);
    expect(routeForwardTurns).toHaveLength(2);
    expect(routeForwardTurns[1].messages.map(message => message.id))
      .toEqual(['handoff-d', 'handoff-tool']);

    const turn = {
      id: 'turn-row', turnId: 't1', textContent: '', textSegments: [], toolMsgs: [],
      imageMsgs: [], todoMsg: null, askMsg: null, isStreaming: false, messages: [rows[0], rows[2]],
    };
    appendTurnResponseSegment(turn, rows[0]);
    appendTurnResponseSegment(turn, rows[2]);
    finalizeTurnResponseSegments(turn);
    const wrapper = mount(AssistantTurn, {
      props: { turn },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });
    await Vue.nextTick();
    expect(globalThis.marked.parse).toHaveBeenNthCalledWith(1, 'Inspecting files.');
    expect(globalThis.marked.parse).toHaveBeenNthCalledWith(2, '## 改动');
    expect(wrapper.get('.turn-progress-group').isVisible()).toBe(true);
    expect(wrapper.get('.turn-response-progress').text()).toBe('Inspecting files.');
    expect(wrapper.find('.turn-progress-toggle').exists()).toBe(false);
    expect(wrapper.find('.turn-progress-count').exists()).toBe(false);
    expect(wrapper.find('.turn-response-label').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('过程');
    expect(wrapper.text()).not.toContain('结果');
    expect(wrapper.get('.turn-response-result h2').text()).toBe('改动');
    wrapper.unmount();

    const toolTurn = {
      ...turn,
      textContent: '',
      textSegments: [],
      messages: [],
      toolMsgs: [{
        id: 'history-read',
        toolName: 'FileRead',
        toolInput: { file_path: 'README.md' },
        hasResult: true,
        isHistory: true,
      }],
    };
    const toolWrapper = mount(AssistantTurn, {
      props: { turn: toolTurn },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { ToolLine: { props: ['toolName', 'toolInput'], template: '<div class="tool-line-stub">{{ toolName }} {{ toolInput.file_path }}</div>' }, AskCard: true, VpSpeakerHeader: true },
      },
    });
    await Vue.nextTick();
    expect(toolWrapper.get('.tool-line-stub').text()).toBe('FileRead README.md');
    expect(toolWrapper.text()).not.toContain('omitted');
    expect(toolWrapper.text()).not.toContain('省略');
    toolWrapper.unmount();

    const streamingTurn = { ...turn, textContent: '', textSegments: [], messages: [], isStreaming: false, isActive: true };
    appendTurnResponseSegment(streamingTurn, {
      id: 'live', type: 'assistant', content: 'Still working', responseKind: 'progress', isStreaming: true,
    });
    const streamingWrapper = mount(AssistantTurn, {
      props: { turn: streamingTurn },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });
    await Vue.nextTick();
    expect(streamingWrapper.get('.turn-progress-group').isVisible()).toBe(true);
    expect(streamingWrapper.find('.turn-progress-toggle').exists()).toBe(false);
    streamingWrapper.unmount();

    const legacy = { ...turn, textContent: '', textSegments: [], messages: [] };
    appendTurnResponseSegment(legacy, { id: 'legacy', type: 'assistant', content: 'Legacy answer', isStreaming: false });
    finalizeTurnResponseSegments(legacy);
    expect(legacy.textSegments[0].kind).toBe('result');

    const abortedHistory = { ...turn, textContent: '', textSegments: [], messages: [], isHistory: true };
    appendTurnResponseSegment(abortedHistory, {
      id: 'aborted', type: 'assistant', content: 'Partial output', responseKind: 'progress', isStreaming: false,
    });
    finalizeTurnResponseSegments(abortedHistory);
    expect(abortedHistory.textSegments[0].kind).toBe('progress');

    const pendingHistoryMessage = {
      id: 'pending-history', type: 'assistant', content: 'Still waiting for reviewers',
      responseKind: 'result', status: 'pending', isStreaming: false,
    };
    const pendingHistory = {
      ...turn,
      textContent: '',
      textSegments: [],
      messages: [pendingHistoryMessage],
      isHistory: true,
      isActive: false,
    };
    appendTurnResponseSegment(pendingHistory, pendingHistoryMessage);
    finalizeTurnResponseSegments(pendingHistory);
    expect(pendingHistory.textSegments[0].kind).toBe('progress');

    pendingHistoryMessage.status = 'completed';
    pendingHistoryMessage.turnEndReason = 'end_turn';
    pendingHistory.textSegments = [];
    appendTurnResponseSegment(pendingHistory, pendingHistoryMessage);
    finalizeTurnResponseSegments(pendingHistory);
    expect(pendingHistory.textSegments[0].kind).toBe('result');

    for (const failure of [
      { turnEndReason: 'cancelled' },
      { turnEndReason: 'error' },
      { incomplete: true, stopReason: 'error' },
    ]) {
      const contradictoryMessage = {
        id: `failed-${failure.turnEndReason || failure.stopReason}`,
        type: 'assistant', content: 'Partial failure', responseKind: 'result', isStreaming: false,
        ...failure,
      };
      const contradictoryTurn = {
        ...turn, textContent: '', textSegments: [], messages: [contradictoryMessage], isHistory: true,
      };
      appendTurnResponseSegment(contradictoryTurn, contradictoryMessage);
      finalizeTurnResponseSegments(contradictoryTurn);
      expect(contradictoryTurn.textSegments[0].kind).toBe('progress');
    }

    const splitStore = {
      activePanelId: 'pane-1',
      panels: [{ id: 'pane-1', conversationId: 'conversation-1' }],
      messagesMap: {
        'conversation-1': [
          { id: 'legacy-progress', type: 'assistant', content: 'Legacy progress', isHistory: true },
          { id: 'legacy-result', type: 'assistant', content: '## Legacy result', isHistory: true },
        ],
      },
      processingConversations: {},
      connectionState: 'connected',
      compactStatus: null,
      sessionHealth: {},
      getPaneRightPanel: () => null,
      setActivePanel: vi.fn(),
      removePanel: vi.fn(),
      sendMessageToConversation: vi.fn(),
      cancelExecutionForConversation: vi.fn(),
      setPaneRightPanel: vi.fn(),
      sendWsMessage: vi.fn(),
    };
    globalThis.Pinia.useChatStore = () => splitStore;
    const { default: SplitPane } = await import('../../web/components/SplitPane.js');
    const splitWrapper = mount(SplitPane, {
      props: { paneId: 'pane-1' },
      global: {
        mocks: { $t: key => key },
        stubs: {
          ChatHeader: true,
          MessageItem: true,
          ChatInput: true,
          ExpertPanel: true,
          SubAgentPanel: true,
          AssistantTurn: {
            props: ['turn'],
            template: `<div class="split-assistant-turn">
              <span v-for="segment in turn.textSegments" :class="'split-segment-' + segment.kind">{{ segment.content }}</span>
            </div>`,
          },
        },
      },
    });
    await Vue.nextTick();
    expect(splitWrapper.get('.split-segment-progress').text()).toBe('Legacy progress');
    expect(splitWrapper.get('.split-segment-result').text()).toBe('## Legacy result');
    splitWrapper.unmount();

  });

  it('keeps the user message and multiline composer layouts coherent', async () => {
    const user = readFileSync(resolve(process.cwd(), 'web/components/MessageItem.js'), 'utf8');
    const sidebarCss = readFileSync(resolve(process.cwd(), 'web/styles/sidebar.css'), 'utf8');
    const messagesCss = readFileSync(resolve(process.cwd(), 'web/styles/chat-messages.css'), 'utf8');
    const blockStart = user.indexOf('class="message-user-block"');
    const blockEnd = user.indexOf('<!-- System message -->');
    const userBlock = user.slice(blockStart, blockEnd);

    expect(readFileSync(resolve(process.cwd(), 'web/i18n/en.js'), 'utf8')).toContain("'message.editAsNew': 'Edit'");
    expect(readFileSync(resolve(process.cwd(), 'web/i18n/zh-CN.js'), 'utf8')).toContain("'message.editAsNew': '编辑'");
    expect(user).toContain("<span class=\"message-user-author\">{{ $t('message.you') }}</span>");
    expect(user).toContain('class="message-user-meta-separator"');
    expect(user.indexOf('class="message-user-meta"')).toBeLessThan(blockStart);
    expect(userBlock).toContain('class="message-content"');
    expect(userBlock).toContain('class="message-user-attachments"');
    expect(userBlock).toContain('class="user-attachments"');
    expect(sidebarCss).toMatch(/\.message-user-block\s*\{[\s\S]*?background: var\(--bg-user-msg-subtle\);/);
    expect(sidebarCss).toMatch(/\.message-user-meta\s*\{[\s\S]*?justify-content: flex-end;/);
    expect(sidebarCss).toMatch(/\.message-user-actions\s*\{[^}]*opacity:\s*0;/);
    expect(sidebarCss).toMatch(/\.message\.user:hover \.message-user-actions,[\s\S]*?\.message\.user:focus-within \.message-user-actions\s*\{[^}]*opacity:\s*1;/);
    expect(messagesCss).toMatch(/\.turn-footer\s*\{[^}]*opacity:\s*0;/);
    expect(messagesCss).toMatch(/\.assistant-turn:hover \.turn-footer,[\s\S]*?\.assistant-turn:focus-within \.turn-footer[\s\S]*?opacity:\s*1;/);
    expect(readFileSync(resolve(process.cwd(), 'web/styles/yeaft.css'), 'utf8'))
      .not.toMatch(/\.yeaft-page \.turn-footer\s*\{[^}]*opacity:\s*1;/);
    expect(messagesCss).toMatch(/\.message\.user\s*\{[\s\S]*?align-items: stretch;/);

    globalThis.Vue = Vue;
    globalThis.Pinia.useChatStore = () => ({ customExpertRoles: [] });
    const { default: MessageItem } = await import('../../web/components/MessageItem.js');
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          type: 'user',
          content: 'Check this again',
          timestamp: Date.UTC(2026, 6, 28, 8, 15),
          attachments: [{ name: 'layout.png', mimeType: 'image/png', isImage: true, preview: 'data:image/png;base64,AA==' }],
        },
        sessionActions: true,
      },
      global: {
        mocks: {
          $t: key => ({
            'message.you': 'You',
            'message.quote': 'Quote',
            'message.editAsNew': 'Edit',
          }[key] || key),
        },
        provide: { t: key => key },
      },
    });

    expect(wrapper.get('.message-user-author').text()).toBe('You');
    expect(wrapper.get('.message-user-meta-separator').text()).toBe('·');
    expect(wrapper.get('.message-user-meta .message-time').text()).not.toBe('');
    expect(wrapper.get('.message-user-block .message-content').text()).toBe('Check this again');
    expect(wrapper.findAll('.message-user-block .message-action-btn')).toHaveLength(0);
    const userActions = wrapper.findAll('.message-user-actions .message-action-btn');
    expect(userActions).toHaveLength(2);
    expect(userActions.map(action => action.text())).toEqual(['', '']);
    expect(userActions.map(action => action.attributes('title'))).toEqual(['Quote', 'Edit']);
    expect(userActions.map(action => action.attributes('aria-label'))).toEqual(['Quote', 'Edit']);
    expect(wrapper.get('.message-user-block .attachments-badge').text()).toContain('message.imageCount');
    expect(wrapper.find('.message-user-actions .attachments-badge').exists()).toBe(false);
    expect(wrapper.get('.message-user-meta').element.compareDocumentPosition(
      wrapper.get('.message-user-block').element,
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wrapper.get('.message-user-block').element.compareDocumentPosition(
      wrapper.get('.message-user-actions').element,
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    wrapper.unmount();

    globalThis.Pinia.useChatStore = () => ({ answerUserQuestion: vi.fn(), cancelVpTurn: vi.fn() });
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const assistant = mount(AssistantTurn, {
      props: {
        turn: {
          id: 'assistant-actions',
          textContent: 'Done',
          textSegments: [{ key: 'result', content: 'Done', kind: 'result', isStreaming: false }],
          toolMsgs: [],
          imageMsgs: [],
          todoMsg: null,
          askMsg: null,
          isStreaming: false,
        },
        sessionActions: true,
        responseCollapsible: true,
        responseToggleLabel: 'Collapse response',
      },
      global: {
        mocks: {
          $t: key => ({
            'message.quote': 'Quote',
            'message.screenshot': 'Screenshot',
            'message.screenshotting': 'Taking screenshot...',
            'message.exportMd': 'Export MD',
            'message.copyAll': 'Copy all',
            'message.copied': 'Copied',
            'message.assistant': 'Assistant',
          }[key] || key),
        },
        provide: { t: key => key === 'message.assistant' ? 'Assistant' : key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });
    const assistantActions = assistant.findAll('.turn-footer button');
    expect(assistantActions).toHaveLength(5);
    expect(assistantActions.map(action => action.text())).toEqual(['', '', '', '', '']);
    expect(assistantActions.map(action => action.attributes('title'))).toEqual([
      'Quote', 'Screenshot', 'Export MD', 'Copy all', 'Collapse response',
    ]);
    expect(assistantActions.map(action => action.attributes('aria-label'))).toEqual([
      'Quote', 'Screenshot', 'Export MD', 'Copy all', 'Collapse response',
    ]);
    assistant.unmount();

    const chatStore = Vue.reactive({
      activeConversationId: 'conversation-1',
      btwMode: false,
      compactStatus: null,
      currentAgent: 'agent-1',
      currentConversation: 'conversation-1',
      currentView: 'chat',
      customExpertRoles: [],
      expertSelections: [],
      inputDrafts: {},
      isProcessing: false,
      slashCommandDescriptions: {},
      yeaftActiveSessionFilter: null,
    });
    globalThis.Pinia = {
      ...(globalThis.Pinia || {}),
      useAuthStore: () => ({}),
      useChatStore: () => chatStore,
      useSessionsStore: () => ({ activeSessionId: null, sessions: {} }),
      useVpStore: () => ({ vpList: [] }),
    };
    window.Pinia = globalThis.Pinia;

    let composerResizeCallback = null;
    let pendingResizeFrame = null;
    let nextResizeFrameId = 0;
    const observeComposer = vi.fn();
    const disconnectComposer = vi.fn();
    const cancelResizeFrame = vi.fn();
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      constructor(callback) { composerResizeCallback = callback; }
      observe(element) { observeComposer(element); }
      disconnect() { disconnectComposer(); }
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      const id = ++nextResizeFrameId;
      pendingResizeFrame = { id, callback };
      return id;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancelResizeFrame);

    const { default: ChatInput } = await import('../../web/components/ChatInput.js');
    const inputWrapper = mount(ChatInput, {
      props: { showStop: true },
      slots: {
        'actions-start': '<button class="composer-start-slot" type="button">Start</button>',
        'actions-end-before': '<button class="composer-model-slot" type="button">Model</button>',
      },
      global: {
        mocks: { $t: key => key },
        stubs: { VpMentionAutocomplete: true },
      },
    });

    const composer = inputWrapper.get('.chat-composer');
    const textarea = composer.get('textarea');
    const actionRow = composer.get('.chat-composer-actions');

    expect(composer.attributes('data-message-composer')).toBe('');
    const startActions = actionRow.get('.chat-composer-actions-start');
    const endActions = actionRow.get('.chat-composer-actions-end');

    expect(textarea.attributes('rows')).toBe('2');
    expect(actionRow.element.parentElement).toBe(composer.element);
    expect(textarea.element.compareDocumentPosition(actionRow.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(startActions.findAll('.attach-btn')).toHaveLength(1);
    expect(startActions.findAll('.work-item-draft-btn')).toHaveLength(0);
    expect(startActions.findAll('.composer-start-slot')).toHaveLength(1);
    expect(startActions.findAll('.composer-model-slot')).toHaveLength(0);
    expect(startActions.get('.attach-btn').element.compareDocumentPosition(
      startActions.get('.composer-start-slot').element,
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(endActions.findAll('.composer-model-slot')).toHaveLength(1);
    expect(endActions.get('.composer-model-slot').element.compareDocumentPosition(endActions.get('.stop-btn').element)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(endActions.findAll('.send-btn')).toHaveLength(2);
    expect(endActions.get('.stop-btn').element.compareDocumentPosition(endActions.findAll('.send-btn')[1].element)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...composer.element.children].filter(child => child.matches('.attach-btn, .send-btn'))).toHaveLength(0);
    expect(observeComposer).toHaveBeenCalledWith(composer.get('.textarea-wrapper').element);

    let composerScrollHeight = 96;
    Object.defineProperty(textarea.element, 'scrollHeight', {
      configurable: true,
      get: () => composerScrollHeight,
    });
    requestAnimationFrame.mockClear();
    pendingResizeFrame = null;
    composerResizeCallback([{ contentRect: { width: 480 } }]);
    composerResizeCallback([{ contentRect: { width: 480 } }]);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    let resizeFrame = pendingResizeFrame;
    pendingResizeFrame = null;
    resizeFrame.callback(performance.now());
    await Vue.nextTick();
    expect(textarea.element.style.height).toBe('96px');
    expect(textarea.classes()).not.toContain('is-scrollable');

    composerScrollHeight = 160;
    composerResizeCallback([{ contentRect: { width: 320 } }]);
    resizeFrame = pendingResizeFrame;
    pendingResizeFrame = null;
    resizeFrame.callback(performance.now());
    await Vue.nextTick();
    expect(textarea.element.style.height).toBe('120px');
    expect(textarea.classes()).toContain('is-scrollable');
    requestAnimationFrame.mockClear();
    composerResizeCallback([{ contentRect: { width: 320 } }]);
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    chatStore.btwMode = true;
    await Vue.nextTick();
    expect(inputWrapper.get('.chat-composer-actions-start .btw-input-tag').text()).toBe('BTW');
    expect(inputWrapper.find('.chat-composer-actions-start .attach-btn').exists()).toBe(false);
    expect(inputWrapper.find('.chat-composer-actions-start .work-item-draft-btn').exists()).toBe(false);
    expect(inputWrapper.find('.chat-composer-actions-start .composer-start-slot').exists()).toBe(true);
    expect(inputWrapper.find('.chat-composer-actions-end .composer-model-slot').exists()).toBe(true);
    expect(inputWrapper.findAll('.chat-composer-actions-end .send-btn')).toHaveLength(2);

    const inputCss = readFileSync(resolve(process.cwd(), 'web/styles/chat-input.css'), 'utf8');
    const chatInputSource = readFileSync(resolve(process.cwd(), 'web/components/ChatInput.js'), 'utf8');
    const messageComposerSource = readFileSync(resolve(process.cwd(), 'web/components/MessageComposer.js'), 'utf8');
    const variablesCss = readFileSync(resolve(process.cwd(), 'web/styles/variables.css'), 'utf8');
    const yeaftCss = readFileSync(resolve(process.cwd(), 'web/styles/yeaft.css'), 'utf8');
    const workCenterCss = readFileSync(resolve(process.cwd(), 'web/styles/work-center.css'), 'utf8');
    const workCenterSource = readFileSync(resolve(process.cwd(), 'web/components/WorkCenterPage.js'), 'utf8');
    const darkThemeStart = variablesCss.indexOf('[data-theme="dark"]');
    const lightThemeTokens = variablesCss.slice(variablesCss.indexOf(':root {'), darkThemeStart);
    const darkThemeTokens = variablesCss.slice(darkThemeStart);
    const composerTokens = [
      '--chat-composer-gap: 8px;',
      '--chat-composer-control-gap: 8px;',
      '--chat-composer-padding: 12px;',
      '--chat-composer-radius: 18px;',
      '--chat-composer-focus-ring-width: 2px;',
      '--chat-composer-textarea-min-height: 4.5em;',
      '--chat-composer-textarea-mobile-height: 3em;',
      '--chat-composer-control-size: 32px;',
      '--yeaft-composer-model-max-width: 260px;',
      '--yeaft-composer-model-mobile-max-width: 46vw;',
      '--yeaft-composer-model-font-size: 12px;',
      '--yeaft-composer-model-border-width: 1px;',
      '--yeaft-model-menu-width: 280px;',
      '--yeaft-effort-menu-width: 180px;',
      '--yeaft-model-menu-max-height: 72dvh;',
      '--yeaft-model-menu-layer: 1300;',
      '--yeaft-header-folder-max-width: 280px;',
      '--yeaft-header-folder-font-size: 12px;',
    ];

    const layoutRoot = document.createElement('div');
    layoutRoot.className = 'yeaft-page';
    layoutRoot.innerHTML = `
      <footer class="input-area yeaft-session-input">
        <div class="input-wrapper chat-composer" data-message-composer></div>
      </footer>
      <div class="input-wrapper chat-composer work-center-item-message-input" data-message-composer></div>
    `;
    const sessionComposer = layoutRoot.querySelector('.yeaft-session-input .chat-composer');
    const workCenterComposer = layoutRoot.querySelector('.work-center-item-message-input');
    const sessionComposerSelector = '.yeaft-session-input > .input-wrapper.chat-composer';
    expect(sessionComposer.matches(sessionComposerSelector)).toBe(true);
    expect(workCenterComposer.matches(sessionComposerSelector)).toBe(false);
    expect(workCenterSource).toContain('class="work-center-item-message-input"');
    expect(workCenterSource).not.toContain(':rows="3"');
    expect(workCenterCss).toMatch(/\.work-center-item-message-input\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/);
    expect(workCenterCss).toMatch(/\.work-center-conversation-column,[\s\S]*?\.work-center-composer-column\s*\{[^}]*max-width:\s*var\(--work-center-conversation-column-width\);/);
    expect(workCenterCss).toMatch(/\.work-center-conversation-composer\s*\{[^}]*env\(safe-area-inset-bottom, 0px\)/);

    expect(inputCss).toMatch(/\.input-wrapper\.chat-composer\s*\{[^}]*flex-direction:\s*column/);
    expect(inputCss).toMatch(/\.input-wrapper\.chat-composer\s*\{[^}]*gap:\s*var\(--chat-composer-gap\)/);
    expect(inputCss).toMatch(/\.input-wrapper\.chat-composer\s*\{[^}]*padding:\s*var\(--chat-composer-padding\)/);
    expect(inputCss).toMatch(/\.input-wrapper\.chat-composer\s*\{[^}]*border-radius:\s*var\(--chat-composer-radius\)/);
    expect(inputCss).toMatch(/\.input-wrapper\.chat-composer:focus-within\s*\{[^}]*var\(--chat-composer-focus-ring-width\)/);
    expect(inputCss).toMatch(/\.chat-composer textarea\s*\{[^}]*min-height:\s*var\(--chat-composer-textarea-min-height\)/);
    expect(inputCss).toMatch(/\.input-wrapper\.chat-composer textarea\.is-scrollable\s*\{[^}]*overflow-y:\s*auto;/);
    expect(inputCss).toMatch(/\.input-wrapper textarea,[\s\S]*?\.textarea-wrapper textarea\s*\{[^}]*max-height:\s*120px;[^}]*overflow-y:\s*hidden;/);
    expect(inputCss).toMatch(/@media \(max-width:\s*768px\)[\s\S]*?\.input-wrapper\.chat-composer textarea\s*\{[^}]*min-height:\s*var\(--chat-composer-textarea-mobile-height\);[^}]*max-height:\s*var\(--chat-composer-textarea-mobile-height\);[^}]*overflow-y:\s*auto;/);
    expect(chatInputSource).not.toContain(':rows="3"');
    expect(messageComposerSource).toContain('rows: { type: Number, default: 2 }');
    expect(messageComposerSource).toContain("'is-scrollable': textareaScrollable");
    expect(messageComposerSource).not.toContain('textarea.style.overflowY');
    expect(inputCss).toMatch(/\.chat-composer-actions\s*\{[^}]*justify-content:\s*space-between/);
    expect(inputCss).toMatch(/\.chat-composer-actions\s*\{[^}]*gap:\s*var\(--chat-composer-gap\)/);
    expect(inputCss).toMatch(/\.chat-composer-actions-start,[\s\S]*?gap:\s*var\(--chat-composer-control-gap\)/);
    expect(inputCss).toMatch(/\.chat-composer \.(?:attach-btn|send-btn),[\s\S]*?\.chat-composer \.send-btn\s*\{[^}]*width:\s*var\(--chat-composer-control-size\)/);
    expect(inputCss).toMatch(/\.chat-composer \.(?:attach-btn|send-btn),[\s\S]*?\.chat-composer \.send-btn\s*\{[^}]*height:\s*var\(--chat-composer-control-size\)/);
    expect(inputCss).toMatch(/\.send-btn\s*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*var\(--accent-fg\)/);
    expect(inputCss).toMatch(/\.send-btn\.stop-btn\s*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*var\(--accent-fg\)/);
    expect(messageComposerSource).toContain('d="m7 12 5-5 5 5M12 7v10"');
    expect(messageComposerSource).toContain('<rect x="7" y="7" width="10" height="10" rx="1.5"/>');
    expect(yeaftCss).toMatch(/\.yeaft-session-input > \.input-wrapper\.chat-composer,[\s\S]*?\.yeaft-page \.expert-chips-bar\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*var\(--session-content-width\)/);
    expect(yeaftCss).not.toContain('--yeaft-composer-max-width');
    expect(yeaftCss).not.toMatch(/\.yeaft-page \.input-wrapper(?:\.chat-composer)?\s*\{/);
    expect(yeaftCss).toMatch(/\.yeaft-topbar-folder-path\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*direction:\s*rtl;/);
    expect(yeaftCss).toMatch(/\.yeaft-composer-model-controls\s*\{[^}]*display:\s*flex;[^}]*gap:\s*var\(--sidebar-section-toggle-gap\)/);
    expect(yeaftCss).toMatch(/\.yeaft-composer-choice\s*\{[^}]*position:\s*relative/);
    expect(yeaftCss).toMatch(/\.yeaft-composer-model,[\s\S]*?\.yeaft-composer-effort\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/);
    expect(yeaftCss).toMatch(/\.yeaft-composer-model-dropdown,[\s\S]*?\.yeaft-composer-effort-dropdown\s*\{[^}]*right:\s*0;[^}]*bottom:\s*calc\(100% \+ var\(--chat-composer-gap\)\)[^}]*max-height:\s*var\(--yeaft-model-menu-max-height\)/);
    expect(yeaftCss).toMatch(/@media \(max-width:\s*768px\)[\s\S]*?\.yeaft-topbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto;/);
    expect(yeaftCss).toMatch(/\.yeaft-topbar-context\s*\{[^}]*grid-column:\s*2;[^}]*display:\s*grid;/);
    expect(yeaftCss).toMatch(/\.yeaft-topbar-folder\s*\{[^}]*grid-row:\s*2;[^}]*width:\s*100%;[^}]*max-width:\s*100%;/);
    expect(yeaftCss).toMatch(/@media \(max-width:\s*768px\)[\s\S]*?\.yeaft-session-input > \.input-wrapper\.chat-composer,[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;/);
    for (const token of composerTokens) {
      expect(lightThemeTokens).toContain(token);
      expect(darkThemeTokens).toContain(token);
    }
    composerResizeCallback([{ contentRect: { width: 640 } }]);
    const pendingFrameId = pendingResizeFrame.id;
    inputWrapper.unmount();
    expect(disconnectComposer).toHaveBeenCalledTimes(1);
    expect(cancelResizeFrame).toHaveBeenCalledWith(pendingFrameId);
  });

});
