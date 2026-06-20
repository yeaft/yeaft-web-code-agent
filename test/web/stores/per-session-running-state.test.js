import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStorageData = new Map();

globalThis.localStorage = {
  getItem: vi.fn((key) => localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: vi.fn((key, value) => { localStorageData.set(key, String(value)); }),
  removeItem: vi.fn((key) => { localStorageData.delete(key); }),
};

function createStoreFactory(_id, options) {
  let instance = null;
  return () => {
    if (instance) return instance;
    instance = {
      ...(typeof options.state === 'function' ? options.state() : {}),
    };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, {
        enumerable: true,
        get() { return getter(instance); },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    return instance;
  };
}

globalThis.Pinia = { defineStore: createStoreFactory };
globalThis.Vue = globalThis.Vue || {};
globalThis.window = globalThis.window || { addEventListener: vi.fn(), removeEventListener: vi.fn() };
globalThis.document = globalThis.document || { addEventListener: vi.fn(), removeEventListener: vi.fn() };

const { useChatStore } = await import('../../../web/stores/chat.js');
const { visibleSessionStatusTasks } = await import('../../../web/components/YeaftPage.js');

function freshStore() {
  const store = useChatStore();
  store.currentView = 'chat';
  store.activeConversations = [];
  store.yeaftActiveSessionFilter = null;
  store.yeaftConversationId = null;
  store.processingConversations = {};
  store.compactStatus = null;
  store.yeaftProcessingSessions = {};
  store.activeVpTurns = {};
  store.stoppingVpTurnIds = {};
  store.messagesMap = {};
  store.yeaftActiveTasksBySession = {};
  store.sendWsMessage = vi.fn(() => true);
  return store;
}

describe('per-session running state', () => {
  beforeEach(() => {
    localStorageData.clear();
  });

  it('keeps Chat running state scoped to the active conversation', () => {
    const store = freshStore();
    store.activeConversations = ['chat-a'];
    store.processingConversations = { 'chat-a': true };

    expect(store.isProcessing).toBe(true);
    expect(store.isConversationProcessing('chat-a')).toBe(true);
    expect(store.isConversationProcessing('chat-b')).toBe(false);

    store.activeConversations = ['chat-b'];

    expect(store.isProcessing).toBe(false);
    expect(store.isConversationProcessing('chat-a')).toBe(true);
    expect(store.isConversationProcessing('chat-b')).toBe(false);
  });

  it('keeps Yeaft running state scoped to the selected session', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftProcessingSessions = { 'session-a': true };
    store.yeaftActiveSessionFilter = 'session-a';

    expect(store.isProcessing).toBe(true);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isYeaftSessionProcessing('session-b')).toBe(false);

    store.yeaftActiveSessionFilter = 'session-b';

    expect(store.isProcessing).toBe(false);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isYeaftSessionProcessing('session-b')).toBe(false);
  });

  it('keeps Yeaft active while any VP turn in that session is unfinished', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftActiveSessionFilter = 'session-a';

    store.handleYeaftOutput({ event: { type: 'vp_turn_start', sessionId: 'session-a', vpId: 'vp-a', turnId: 'turn-a', ts: 1 } });
    store.handleYeaftOutput({ event: { type: 'vp_turn_start', sessionId: 'session-a', vpId: 'vp-b', turnId: 'turn-b', ts: 2 } });

    expect(store.isProcessing).toBe(true);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);

    store.handleYeaftOutput({ event: { type: 'vp_turn_end', sessionId: 'session-a', vpId: 'vp-a', turnId: 'turn-a', reason: 'end_turn' } });

    expect(store.isProcessing).toBe(true);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);

    store.handleYeaftOutput({ event: { type: 'vp_turn_end', sessionId: 'session-a', vpId: 'vp-b', turnId: 'turn-b', reason: 'end_turn' } });

    expect(store.isProcessing).toBe(false);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(false);
  });

  it('keeps recently completed task snapshots visible to the Session status pane', () => {
    const store = freshStore();
    store.yeaftActiveSessionFilter = 'session-a';

    store.handleYeaftOutput({ event: { type: 'yeaft_task_event', task: {
      id: 'task-1',
      sessionId: 'session-a',
      kind: 'sub_agent',
      status: 'running',
      createdAt: '2026-06-19T10:00:00.000Z',
      updatedAt: '2026-06-19T10:00:00.000Z',
    } } });
    store.handleYeaftOutput({ event: { type: 'yeaft_task_event', task: {
      id: 'task-1',
      sessionId: 'session-a',
      kind: 'sub_agent',
      status: 'succeeded',
      createdAt: '2026-06-19T10:00:00.000Z',
      updatedAt: '2026-06-19T10:00:02.000Z',
      endedAt: '2026-06-19T10:00:02.000Z',
      result: { summary: 'final answer from task snapshot' },
    } } });

    const paneTasks = visibleSessionStatusTasks(store.yeaftActiveTasksBySession['session-a']);

    expect(paneTasks).toHaveLength(1);
    expect(paneTasks[0]).toMatchObject({
      id: 'task-1',
      status: 'succeeded',
      result: { summary: 'final answer from task snapshot' },
    });
  });

  it('appends async task completion updates to the originating tool result', () => {
    const store = freshStore();
    store.yeaftConversationId = 'yeaft-conv';
    store.currentView = 'yeaft';

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      data: {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'spawn-1', name: 'SpawnAgent', input: { name: 'worker' } }] },
      },
    });
    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      data: {
        type: 'user',
        tool_use_result: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: 'Started background task task-1.' }],
      },
    });
    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      data: {
        type: 'user',
        tool_use_result: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: '<task-result id="task-1">done</task-result>', is_update: true }],
      },
    });

    const tools = store.messagesMap['yeaft-conv'].filter(msg => msg.type === 'tool-use');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolId: 'spawn-1', toolName: 'SpawnAgent', hasResult: true });
    expect(tools[0].toolResult).toContain('Started background task task-1.');
    expect(tools[0].toolResult).toContain('<task-result id="task-1">done</task-result>');
  });

  it('sorts running tasks before recent terminal task snapshots', () => {
    const tasks = visibleSessionStatusTasks({
      done: { id: 'done', status: 'succeeded', updatedAt: '2026-06-19T10:00:03.000Z' },
      running: { id: 'running', status: 'running', updatedAt: '2026-06-19T10:00:01.000Z' },
    });

    expect(tasks.map(task => task.id)).toEqual(['running', 'done']);
  });

  it('sends scoped sub-agent prompts through a narrow Yeaft wire message', () => {
    const store = freshStore();
    store.yeaftAgentId = 'agent-1';

    const sent = store.sendYeaftSubAgentPrompt({
      sessionId: 'session-a',
      taskId: 'task-1',
      subAgentId: 'sub-1',
      message: ' new user idea ',
      clientPromptId: 'prompt-1',
    });

    expect(sent).toBe('prompt-1');
    expect(store.yeaftSubAgentPromptResults['prompt-1']).toMatchObject({
      status: 'pending',
      message: 'new user idea',
    });
    expect(store.sendWsMessage).toHaveBeenCalledWith({
      type: 'yeaft_sub_agent_prompt',
      agentId: 'agent-1',
      sessionId: 'session-a',
      taskId: 'task-1',
      subAgentId: 'sub-1',
      message: 'new user idea',
      clientPromptId: 'prompt-1',
    });
  });

  it('stores sub-agent prompt result events for UI ack and error feedback', () => {
    const store = freshStore();
    store.yeaftSubAgentPromptResults = {
      'prompt-1': { clientPromptId: 'prompt-1', status: 'pending', message: 'keep me' },
    };

    store.handleYeaftOutput({ sessionId: 'session-a', event: {
      type: 'yeaft_sub_agent_prompt_result',
      clientPromptId: 'prompt-1',
      success: false,
      taskId: 'task-1',
      subAgentId: 'sub-1',
      error: 'sub-agent task not found',
    } });

    expect(store.yeaftSubAgentPromptResults['prompt-1']).toMatchObject({
      status: 'failed',
      message: 'keep me',
      error: 'sub-agent task not found',
      sessionId: 'session-a',
      taskId: 'task-1',
      subAgentId: 'sub-1',
    });
  });

  it('rejects incomplete scoped sub-agent prompts before the wire', () => {
    const store = freshStore();
    store.yeaftAgentId = 'agent-1';

    expect(store.sendYeaftSubAgentPrompt({ sessionId: 'session-a', taskId: 'task-1', subAgentId: '', message: 'x', clientPromptId: 'bad-prompt' })).toBe(false);
    expect(store.yeaftSubAgentPromptResults['bad-prompt']).toMatchObject({ status: 'failed' });
    expect(store.sendWsMessage).not.toHaveBeenCalled();
  });

  it('keeps Chat compacting state scoped to the active conversation', () => {
    const store = freshStore();
    store.currentView = 'chat';
    store.activeConversations = ['chat-a'];
    store.compactStatus = { conversationId: 'chat-a', status: 'compacting', message: 'Compacting...' };

    expect(store.isConversationCompacting('chat-a')).toBe(true);
    expect(store.isConversationCompacting('chat-b')).toBe(false);

    store.activeConversations = ['chat-b'];

    expect(store.isConversationCompacting(store.activeConversationId)).toBe(false);
  });

  it('does not let Chat compacting state leak into Yeaft input state', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-b';
    store.compactStatus = { conversationId: 'chat-a', status: 'compacting', message: 'Compacting...' };
    store.processingConversations = { 'chat-a': true };

    expect(store.isConversationCompacting('chat-a')).toBe(true);
    expect(store.isConversationCompacting(store.yeaftConversationId)).toBe(false);
    expect(store.isProcessing).toBe(false);

    store.yeaftProcessingSessions = { 'session-b': true };

    expect(store.isProcessing).toBe(true);
  });
});
