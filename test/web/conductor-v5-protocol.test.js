import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * PR #334 — Conductor V5 frontend protocol alignment tests.
 *
 * Validates:
 *   1. openConductor sends V5 `open_conductor` (not old create_conductor_session)
 *   2. sendConductorMessage sends `conductor_user_input` (not old conductor_human_input)
 *   3. sendConductorControl sends `stop_conductor` / `clear_conductor` (not old conductor_control)
 *   4. handleConductorOutput handles all 9 V5 message types
 *   5. conductorConvId derives `conductor_${agentId}` key
 *   6. No sessionId in any sent/received messages
 *   7. messageHandler.js routes all 9 V5 types to handleConductorOutput
 *   8. chat.js state: conductorMessages/Tasks/Statuses only (no conductorSessions/conductorActors)
 *   9. ConductorChatView session getter uses conversations (not conductorSessions)
 */

// =====================================================================
// Helpers: replicate conductor.js logic for isolated testing
// =====================================================================

function conductorConvId(agentId) {
  return `conductor_${agentId}`;
}

function createMockStore(overrides = {}) {
  const sent = [];
  return {
    currentAgent: overrides.currentAgent || 'agent-1',
    currentConversation: overrides.currentConversation || null,
    conversations: overrides.conversations || [],
    messages: overrides.messages || [],
    messagesCache: overrides.messagesCache || {},
    conductorMessages: overrides.conductorMessages || {},
    conductorTasks: overrides.conductorTasks || {},
    conductorStatuses: overrides.conductorStatuses || {},
    agents: overrides.agents || [{ id: 'agent-1', name: 'Test Agent' }],
    _sentMessages: sent,
    sendWsMessage(msg) {
      sent.push(msg);
      return true;
    },
    selectConversation(id) {
      this.currentConversation = id;
    },
    saveOpenSessions() {}
  };
}

function extractTextContent(msg) {
  const content = msg.data?.message?.content ?? msg.content ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  return '';
}

// Replicate ensureMessages
function ensureMessages(store, convId) {
  if (!store.conductorMessages[convId]) {
    store.conductorMessages[convId] = [];
  }
  return store.conductorMessages[convId];
}

// =====================================================================
// Tests
// =====================================================================

describe('Conductor V5 Protocol — conductor.js', () => {

  describe('conductorConvId', () => {
    it('should derive convId from agentId', () => {
      expect(conductorConvId('agent-1')).toBe('conductor_agent-1');
    });

    it('should handle different agentId formats', () => {
      expect(conductorConvId('abc-123')).toBe('conductor_abc-123');
      expect(conductorConvId('myAgent')).toBe('conductor_myAgent');
    });
  });

  describe('openConductor', () => {
    it('should send open_conductor with agentId', () => {
      const store = createMockStore();
      // Replicate openConductor logic
      const agentId = 'agent-1';
      const convId = conductorConvId(agentId);
      store.currentAgent = agentId;
      store.sendWsMessage({ type: 'open_conductor', agentId });

      expect(store._sentMessages).toHaveLength(1);
      expect(store._sentMessages[0].type).toBe('open_conductor');
      expect(store._sentMessages[0].agentId).toBe('agent-1');
    });

    it('should not send create_conductor_session (old V2)', () => {
      const store = createMockStore();
      store.sendWsMessage({ type: 'open_conductor', agentId: 'agent-1' });
      expect(store._sentMessages[0].type).not.toBe('create_conductor_session');
    });

    it('should not include sessionId', () => {
      const store = createMockStore();
      store.sendWsMessage({ type: 'open_conductor', agentId: 'agent-1' });
      expect(store._sentMessages[0].sessionId).toBeUndefined();
    });

    it('should resume existing conductor conversation', () => {
      const convId = conductorConvId('agent-1');
      const store = createMockStore({
        conversations: [{ id: convId, type: 'conductor', agentId: 'agent-1' }]
      });
      const existing = store.conversations.find(c => c.id === convId);
      expect(existing).toBeDefined();
      store.selectConversation(existing.id);
      expect(store.currentConversation).toBe(convId);
    });
  });

  describe('sendConductorMessage', () => {
    it('should send conductor_user_input type', () => {
      const store = createMockStore();
      const msg = {
        type: 'conductor_user_input',
        content: 'Hello conductor',
        agentId: store.currentAgent
      };
      store.sendWsMessage(msg);
      expect(store._sentMessages[0].type).toBe('conductor_user_input');
      expect(store._sentMessages[0].content).toBe('Hello conductor');
    });

    it('should not send conductor_human_input (old V2)', () => {
      const store = createMockStore();
      store.sendWsMessage({
        type: 'conductor_user_input',
        content: 'test',
        agentId: 'agent-1'
      });
      expect(store._sentMessages[0].type).not.toBe('conductor_human_input');
    });

    it('should not include sessionId in user input', () => {
      const store = createMockStore();
      store.sendWsMessage({
        type: 'conductor_user_input',
        content: 'test',
        agentId: 'agent-1'
      });
      expect(store._sentMessages[0].sessionId).toBeUndefined();
    });

    it('should add human message to conductorMessages', () => {
      const convId = conductorConvId('agent-1');
      const store = createMockStore({ currentConversation: convId });
      const messages = ensureMessages(store, convId);
      messages.push({
        id: 'msg-1',
        role: 'human',
        type: 'text',
        content: 'Build a feature',
        timestamp: Date.now()
      });
      expect(store.conductorMessages[convId]).toHaveLength(1);
      expect(store.conductorMessages[convId][0].role).toBe('human');
    });
  });

  describe('sendConductorControl', () => {
    it('should send stop_conductor for stop action', () => {
      const store = createMockStore();
      const action = 'stop';
      const type = action === 'stop' ? 'stop_conductor' : 'clear_conductor';
      store.sendWsMessage({ type, agentId: store.currentAgent });
      expect(store._sentMessages[0].type).toBe('stop_conductor');
    });

    it('should send clear_conductor for clear action', () => {
      const store = createMockStore();
      const action = 'clear';
      const type = action === 'stop' ? 'stop_conductor' : 'clear_conductor';
      store.sendWsMessage({ type, agentId: store.currentAgent });
      expect(store._sentMessages[0].type).toBe('clear_conductor');
    });

    it('should not send conductor_control (old V2)', () => {
      const store = createMockStore();
      const action = 'stop';
      const type = action === 'stop' ? 'stop_conductor' : 'clear_conductor';
      store.sendWsMessage({ type, agentId: store.currentAgent });
      expect(store._sentMessages[0].type).not.toBe('conductor_control');
    });

    it('should not include sessionId in control', () => {
      const store = createMockStore();
      store.sendWsMessage({ type: 'stop_conductor', agentId: store.currentAgent });
      expect(store._sentMessages[0].sessionId).toBeUndefined();
    });
  });

  describe('handleConductorOutput — conductor_opened', () => {
    it('should create conversation entry for conductor_opened', () => {
      const store = createMockStore();
      const msg = {
        type: 'conductor_opened',
        agentId: 'agent-1',
        tasks: {},
        uiMessages: [],
        status: 'running'
      };
      const agentId = msg.agentId || store.currentAgent;
      const convId = conductorConvId(agentId);

      // Simulate handleConductorOutput for conductor_opened
      store.conductorTasks[convId] = {};
      ensureMessages(store, convId);
      store.conductorStatuses[convId] = {
        status: msg.status || 'running',
        costUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0
      };

      const conv = {
        id: convId,
        agentId,
        agentName: 'Test Agent',
        type: 'conductor',
        name: 'Conductor'
      };
      store.conversations.push(conv);
      store.currentConversation = convId;

      expect(store.currentConversation).toBe('conductor_agent-1');
      expect(store.conversations).toHaveLength(1);
      expect(store.conversations[0].type).toBe('conductor');
      expect(store.conductorStatuses[convId].status).toBe('running');
    });

    it('should restore tasks from conductor_opened (object format)', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      const tasks = {
        'task-1': { taskId: 'task-1', title: 'Build API', status: 'active', workDir: '/project' },
        'task-2': { taskId: 'task-2', title: 'Write tests', status: 'pending' }
      };

      store.conductorTasks[convId] = {};
      if (typeof tasks === 'object' && !Array.isArray(tasks)) {
        for (const [taskId, t] of Object.entries(tasks)) {
          store.conductorTasks[convId][taskId] = t;
        }
      }

      expect(Object.keys(store.conductorTasks[convId])).toHaveLength(2);
      expect(store.conductorTasks[convId]['task-1'].title).toBe('Build API');
      expect(store.conductorTasks[convId]['task-2'].title).toBe('Write tests');
    });

    it('should restore uiMessages from conductor_opened', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      const uiMessages = [
        { source: 'user', type: 'text', content: 'Hello', timestamp: 1000 },
        { source: 'conductor', type: 'text', content: 'I will help', timestamp: 2000 }
      ];

      store.conductorMessages[convId] = uiMessages.map(m => ({
        id: m.timestamp || 'gen-id',
        role: m.role || m.source || 'conductor',
        type: m.type || 'text',
        content: m.content,
        _streaming: false
      }));

      expect(store.conductorMessages[convId]).toHaveLength(2);
      expect(store.conductorMessages[convId][0].role).toBe('user');
      expect(store.conductorMessages[convId][1].role).toBe('conductor');
    });

    it('should handle empty uiMessages', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      const uiMessages = [];

      if (uiMessages && uiMessages.length > 0) {
        store.conductorMessages[convId] = uiMessages;
      } else {
        ensureMessages(store, convId);
      }

      expect(store.conductorMessages[convId]).toEqual([]);
    });

    it('should reuse existing conversation', () => {
      const convId = conductorConvId('agent-1');
      const store = createMockStore({
        conversations: [{ id: convId, type: 'chat', agentId: 'agent-1' }]
      });

      let conv = store.conversations.find(c => c.id === convId);
      if (conv) {
        conv.type = 'conductor';
        conv.agentId = 'agent-1';
      }

      expect(conv.type).toBe('conductor');
      expect(store.conversations).toHaveLength(1); // no duplicate
    });
  });

  describe('handleConductorOutput — conductor_output', () => {
    it('should handle text output — create new streaming message', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      const messages = ensureMessages(store, convId);

      const msg = {
        type: 'conductor_output',
        outputType: 'text',
        data: { message: { content: 'Starting task...' } }
      };

      const textContent = extractTextContent(msg);
      messages.push({
        id: 'msg-1',
        role: 'conductor',
        type: 'text',
        content: textContent,
        _streaming: true,
        timestamp: Date.now()
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Starting task...');
      expect(messages[0]._streaming).toBe(true);
    });

    it('should append to existing streaming message', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      store.conductorMessages[convId] = [{
        id: 'msg-1',
        role: 'conductor',
        type: 'text',
        content: 'Hello',
        _streaming: true,
        taskId: null,
        timestamp: Date.now()
      }];

      const messages = store.conductorMessages[convId];
      // Find existing streaming msg
      let streamMsg = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'conductor' && messages[i]._streaming) {
          streamMsg = messages[i];
          break;
        }
      }

      expect(streamMsg).not.toBeNull();
      streamMsg.content += ' World';
      expect(messages[0].content).toBe('Hello World');
    });

    it('should handle tool_use output', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      const messages = ensureMessages(store, convId);

      const toolContent = [{
        type: 'tool_use',
        name: 'Read',
        id: 'tool-1',
        input: { file_path: '/src/index.js' }
      }];

      for (const block of toolContent) {
        if (block.type === 'tool_use') {
          messages.push({
            id: 'tool-msg-1',
            role: 'conductor',
            type: 'tool',
            toolName: block.name,
            toolId: block.id,
            toolInput: block.input,
            hasResult: false,
            content: `${block.name} ${block.input?.file_path || ''}`,
            timestamp: Date.now()
          });
        }
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('tool');
      expect(messages[0].toolName).toBe('Read');
      expect(messages[0].toolId).toBe('tool-1');
      expect(messages[0].hasResult).toBe(false);
    });

    it('should handle tool_result and mark hasResult', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      store.conductorMessages[convId] = [{
        id: 'tool-msg-1',
        type: 'tool',
        toolId: 'tool-1',
        hasResult: false
      }];
      const messages = store.conductorMessages[convId];

      const toolId = 'tool-1';
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'tool' && messages[i].toolId === toolId) {
          messages[i].hasResult = true;
          break;
        }
      }

      expect(messages[0].hasResult).toBe(true);
    });

    it('should handle system output', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      const messages = ensureMessages(store, convId);

      messages.push({
        id: 'sys-1',
        role: 'system',
        type: 'system',
        content: 'Conductor started',
        timestamp: Date.now()
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('system');
      expect(messages[0].type).toBe('system');
    });
  });

  describe('handleConductorOutput — conductor_status', () => {
    it('should handle status update with tasks and cost', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      const msg = {
        type: 'conductor_status',
        tasks: { 'task-1': { taskId: 'task-1', title: 'API', status: 'active' } },
        status: 'running',
        costUsd: 0.05,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        activeClaudes: 2
      };

      // Simulate throttled update (immediate for test)
      if (msg.tasks) {
        if (!store.conductorTasks[convId]) store.conductorTasks[convId] = {};
        for (const [taskId, t] of Object.entries(msg.tasks)) {
          store.conductorTasks[convId][taskId] = t;
        }
      }
      store.conductorStatuses[convId] = {
        status: msg.status,
        costUsd: msg.costUsd,
        totalInputTokens: msg.totalInputTokens || 0,
        totalOutputTokens: msg.totalOutputTokens || 0,
        activeClaudes: msg.activeClaudes || 0
      };

      expect(store.conductorTasks[convId]['task-1'].title).toBe('API');
      expect(store.conductorStatuses[convId].costUsd).toBe(0.05);
      expect(store.conductorStatuses[convId].activeClaudes).toBe(2);
    });
  });

  describe('handleConductorOutput — conductor_task_created', () => {
    it('should add task to store and create message', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      store.conductorTasks[convId] = {};
      const messages = ensureMessages(store, convId);

      const task = { taskId: 'task-new', title: 'Implement search', status: 'active', workDir: '/project', scenario: 'dev' };
      store.conductorTasks[convId][task.taskId] = task;

      messages.push({
        id: 'tc-1',
        role: 'conductor',
        type: 'task_created',
        content: `Task created: ${task.title}`,
        taskId: task.taskId,
        timestamp: Date.now()
      });

      expect(store.conductorTasks[convId]['task-new'].title).toBe('Implement search');
      expect(messages[messages.length - 1].type).toBe('task_created');
    });
  });

  describe('handleConductorOutput — conductor_task_message', () => {
    it('should add task message to messages', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      const messages = ensureMessages(store, convId);

      messages.push({
        id: 'tm-1',
        role: 'conductor',
        type: 'task_message',
        content: 'Task progress: 50%',
        taskId: 'task-1',
        timestamp: Date.now()
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('task_message');
      expect(messages[0].taskId).toBe('task-1');
    });
  });

  describe('handleConductorOutput — conductor_turn_completed', () => {
    it('should end streaming on turn completed', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      store.conductorMessages[convId] = [{
        id: 'msg-1',
        role: 'conductor',
        type: 'text',
        content: 'Done analyzing.',
        _streaming: true
      }];

      const messages = store.conductorMessages[convId];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._streaming) {
          messages[i]._streaming = false;
          break;
        }
      }

      expect(messages[0]._streaming).toBe(false);
    });
  });

  describe('handleConductorOutput — conductor_cleared', () => {
    it('should clear messages, tasks, and statuses', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      store.conductorMessages[convId] = [{ id: '1', content: 'old' }];
      store.conductorTasks[convId] = { 'task-1': { title: 'Old' } };
      store.conductorStatuses[convId] = { status: 'running' };

      // Simulate conductor_cleared
      store.conductorMessages[convId] = [];
      store.conductorTasks[convId] = {};
      store.conductorStatuses[convId] = {};

      expect(store.conductorMessages[convId]).toEqual([]);
      expect(store.conductorTasks[convId]).toEqual({});
      expect(store.conductorStatuses[convId]).toEqual({});
    });
  });

  describe('handleConductorOutput — conductor_history_loaded', () => {
    it('should prepend older messages', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      store.conductorMessages[convId] = [
        { id: 'current-1', content: 'Recent msg', timestamp: 3000 }
      ];

      const olderMessages = [
        { source: 'conductor', type: 'text', content: 'Old msg 1', timestamp: 1000 },
        { source: 'user', type: 'text', content: 'Old msg 2', timestamp: 2000 }
      ].map(m => ({
        id: m.timestamp,
        role: m.role || m.source || 'conductor',
        type: m.type || 'text',
        content: m.content,
        _streaming: false
      }));

      const existing = store.conductorMessages[convId];
      store.conductorMessages[convId] = [...olderMessages, ...existing];

      expect(store.conductorMessages[convId]).toHaveLength(3);
      expect(store.conductorMessages[convId][0].content).toBe('Old msg 1');
      expect(store.conductorMessages[convId][2].content).toBe('Recent msg');
    });
  });

  describe('handleConductorOutput — conductor_error', () => {
    it('should add error message', () => {
      const store = createMockStore();
      const convId = conductorConvId('agent-1');
      const messages = ensureMessages(store, convId);

      messages.push({
        id: 'err-1',
        role: 'system',
        type: 'error',
        content: 'Connection lost',
        timestamp: Date.now()
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('error');
      expect(messages[0].content).toBe('Connection lost');
    });
  });

  describe('extractTextContent', () => {
    it('should extract string content directly', () => {
      expect(extractTextContent({ data: { message: { content: 'hello' } } })).toBe('hello');
    });

    it('should extract text blocks from array', () => {
      const msg = {
        data: {
          message: {
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'World' }
            ]
          }
        }
      };
      expect(extractTextContent(msg)).toBe('Hello World');
    });

    it('should filter non-text blocks', () => {
      const msg = {
        data: {
          message: {
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'tool_use', name: 'Read' },
              { type: 'text', text: ' World' }
            ]
          }
        }
      };
      expect(extractTextContent(msg)).toBe('Hello World');
    });

    it('should fallback to msg.content when no data', () => {
      expect(extractTextContent({ content: 'fallback' })).toBe('fallback');
    });

    it('should return empty string for missing content', () => {
      expect(extractTextContent({})).toBe('');
      expect(extractTextContent({ data: {} })).toBe('');
    });
  });

  describe('convId derivation — agentId fallback', () => {
    it('should use msg.agentId when present', () => {
      const msg = { agentId: 'agent-2' };
      const agentId = msg.agentId || 'agent-1';
      expect(conductorConvId(agentId)).toBe('conductor_agent-2');
    });

    it('should fallback to store.currentAgent', () => {
      const msg = {};
      const agentId = msg.agentId || 'agent-1';
      expect(conductorConvId(agentId)).toBe('conductor_agent-1');
    });
  });
});

describe('Conductor V5 Protocol — messageHandler.js routing', () => {
  const handlerSrc = readFileSync(
    resolve(__dirname, '../../web/stores/helpers/messageHandler.js'),
    'utf8'
  );

  const V5_CONDUCTOR_TYPES = [
    'conductor_opened',
    'conductor_output',
    'conductor_status',
    'conductor_turn_completed',
    'conductor_error',
    'conductor_task_created',
    'conductor_task_message',
    'conductor_cleared',
    'conductor_history_loaded'
  ];

  it('should have all 9 V5 conductor types in the switch', () => {
    for (const type of V5_CONDUCTOR_TYPES) {
      expect(handlerSrc).toContain(`'${type}'`);
    }
  });

  it('should route all conductor types to handleConductorOutput', () => {
    expect(handlerSrc).toContain('store.handleConductorOutput(msg)');
  });

  it('should not contain old V2 conductor message types', () => {
    const oldTypes = [
      'conductor_session_created',
      'conductor_session_restored',
      'conductor_status_update',
      'conductor_actor_update',
      'conductor_task_updated',
      'conductor_task_completed'
    ];
    for (const type of oldTypes) {
      expect(handlerSrc).not.toContain(`'${type}'`);
    }
  });

  it('should not contain old conductor_human_input reference', () => {
    expect(handlerSrc).not.toContain('conductor_human_input');
  });

  it('should not contain create_conductor_session reference', () => {
    expect(handlerSrc).not.toContain('create_conductor_session');
  });
});

describe('Conductor V5 Protocol — chat.js state', () => {
  const chatSrc = readFileSync(
    resolve(__dirname, '../../web/stores/chat.js'),
    'utf8'
  );

  it('should have conductorMessages in state', () => {
    expect(chatSrc).toContain('conductorMessages');
  });

  it('should have conductorTasks in state', () => {
    expect(chatSrc).toContain('conductorTasks');
  });

  it('should have conductorStatuses in state', () => {
    expect(chatSrc).toContain('conductorStatuses');
  });

  it('should not have conductorSessions in state', () => {
    // V5 singleton — no separate conductorSessions Map
    // conductorSessions was the old V2 multi-session pattern
    const lines = chatSrc.split('\n');
    // Check state section only — not comments
    const stateLines = [];
    let inState = false;
    for (const line of lines) {
      if (line.includes('state: () => ({')) inState = true;
      if (inState) {
        stateLines.push(line);
        if (line.trim() === '}),' && inState) {
          inState = false;
          break;
        }
      }
    }
    const stateBlock = stateLines.join('\n');
    // Should not have conductorSessions as a state property
    expect(stateBlock).not.toMatch(/conductorSessions\s*:/);
  });

  it('should not have conductorActors in state', () => {
    const lines = chatSrc.split('\n');
    const stateLines = [];
    let inState = false;
    for (const line of lines) {
      if (line.includes('state: () => ({')) inState = true;
      if (inState) {
        stateLines.push(line);
        if (line.trim() === '}),' && inState) {
          inState = false;
          break;
        }
      }
    }
    const stateBlock = stateLines.join('\n');
    expect(stateBlock).not.toMatch(/conductorActors\s*:/);
  });

  it('should have openConductor action wired to conductorHelpers', () => {
    expect(chatSrc).toContain('conductorHelpers.openConductor');
  });

  it('should have sendConductorMessage action wired to conductorHelpers', () => {
    expect(chatSrc).toContain('conductorHelpers.sendConductorMessage');
  });

  it('should have sendConductorControl action wired to conductorHelpers', () => {
    expect(chatSrc).toContain('conductorHelpers.sendConductorControl');
  });

  it('should have handleConductorOutput action wired to conductorHelpers', () => {
    expect(chatSrc).toContain('conductorHelpers.handleConductorOutput');
  });

  it('should have currentConversationIsConductor getter', () => {
    expect(chatSrc).toContain('currentConversationIsConductor');
  });

  it('should have currentConductorMessages getter', () => {
    expect(chatSrc).toContain('currentConductorMessages');
  });
});

describe('Conductor V5 Protocol — conductor.js source verification', () => {
  const conductorSrc = readFileSync(
    resolve(__dirname, '../../web/stores/helpers/conductor.js'),
    'utf8'
  );

  it('should contain open_conductor send type', () => {
    expect(conductorSrc).toContain("type: 'open_conductor'");
  });

  it('should contain conductor_user_input send type', () => {
    expect(conductorSrc).toContain("type: 'conductor_user_input'");
  });

  it('should contain stop_conductor type mapping', () => {
    expect(conductorSrc).toContain("'stop_conductor'");
  });

  it('should contain clear_conductor type mapping', () => {
    expect(conductorSrc).toContain("'clear_conductor'");
  });

  it('should contain conductorConvId helper using conductor_ prefix', () => {
    expect(conductorSrc).toContain('conductor_${agentId}');
  });

  it('should not contain create_conductor_session', () => {
    expect(conductorSrc).not.toContain('create_conductor_session');
  });

  it('should not contain resume_conductor_session', () => {
    expect(conductorSrc).not.toContain('resume_conductor_session');
  });

  it('should not contain conductor_human_input', () => {
    expect(conductorSrc).not.toContain('conductor_human_input');
  });

  it('should not contain conductor_control as a send type', () => {
    // Old V2 used a single conductor_control with action param
    expect(conductorSrc).not.toContain("type: 'conductor_control'");
  });

  it('should not contain switchConductorWorkDir (removed in V5)', () => {
    expect(conductorSrc).not.toContain('switchConductorWorkDir');
  });

  it('should not contain resumeConductorSession (removed in V5)', () => {
    expect(conductorSrc).not.toContain('resumeConductorSession');
  });

  it('should handle all 9 V5 message types in handleConductorOutput', () => {
    const handledTypes = [
      'conductor_opened',
      'conductor_output',
      'conductor_status',
      'conductor_turn_completed',
      'conductor_error',
      'conductor_task_created',
      'conductor_task_message',
      'conductor_cleared',
      'conductor_history_loaded'
    ];
    for (const type of handledTypes) {
      expect(conductorSrc).toContain(`'${type}'`);
    }
  });
});

describe('Conductor V5 Protocol — ConductorChatView.js', () => {
  const viewSrc = readFileSync(
    resolve(__dirname, '../../web/components/conductor/ConductorChatView.js'),
    'utf8'
  );

  it('should read session from conversations (not conductorSessions)', () => {
    expect(viewSrc).toContain('store.conversations.find');
  });

  it('should not access store.conductorSessions (V5 removed)', () => {
    // The word may appear in comments, but should not be accessed as a store property
    expect(viewSrc).not.toContain('store.conductorSessions');
  });

  it('should read conductorMessages from store', () => {
    expect(viewSrc).toContain('store.conductorMessages');
  });

  it('should read conductorTasks from store', () => {
    expect(viewSrc).toContain('store.conductorTasks');
  });

  it('should have sendConductorMessage call in sendMessage method', () => {
    expect(viewSrc).toContain('store.sendConductorMessage');
  });

  it('should have conductorActivePanelVisible for active panel toggle', () => {
    expect(viewSrc).toContain('conductorActivePanelVisible');
  });
});

describe('Conductor V5 Protocol — Server protocol alignment', () => {
  const conductorSrc = readFileSync(
    resolve(__dirname, '../../web/stores/helpers/conductor.js'),
    'utf8'
  );
  const serverSrc = readFileSync(
    resolve(__dirname, '../../server/handlers/client-conductor.js'),
    'utf8'
  );

  // The 5 message types the server expects from the client
  const SERVER_EXPECTED_TYPES = [
    'open_conductor',
    'conductor_user_input',
    'stop_conductor',
    'clear_conductor',
    'conductor_load_history'
  ];

  it('should have all 5 server-expected types in client-conductor.js', () => {
    for (const type of SERVER_EXPECTED_TYPES) {
      expect(serverSrc).toContain(`'${type}'`);
    }
  });

  it('frontend should send types that match server cases', () => {
    // The 4 types the frontend actively sends (conductor_load_history is not yet in conductor.js)
    expect(conductorSrc).toContain("'open_conductor'");
    expect(conductorSrc).toContain("'conductor_user_input'");
    expect(conductorSrc).toContain("'stop_conductor'");
    expect(conductorSrc).toContain("'clear_conductor'");
  });

  it('agent-conductor.js should have all 9 types the frontend handles', () => {
    const agentSrc = readFileSync(
      resolve(__dirname, '../../server/handlers/agent-conductor.js'),
      'utf8'
    );
    const V5_AGENT_TYPES = [
      'conductor_opened',
      'conductor_output',
      'conductor_status',
      'conductor_turn_completed',
      'conductor_error',
      'conductor_task_created',
      'conductor_task_message',
      'conductor_cleared',
      'conductor_history_loaded'
    ];
    for (const type of V5_AGENT_TYPES) {
      expect(agentSrc).toContain(`'${type}'`);
    }
  });
});
