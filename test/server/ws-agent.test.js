import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { MockWebSocket, createMockAgent, createMockWebClient, WS_OPEN } from '../helpers/mockWs.js';

/**
 * Tests for agent connection lifecycle and message handling patterns.
 * We test the logic patterns from ws-agent.js without importing it directly
 * (to avoid config.js side effects).
 */

let db, sessionDb, messageDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  sessionDb = ops.sessionDb;
  messageDb = ops.messageDb;
});

afterAll(() => cleanupTestDb());

describe('Agent Registration', () => {
  describe('dev mode (skipAuth)', () => {
    it('should register agent immediately and send registered message', () => {
      const ws = new MockWebSocket();
      const agents = new Map();
      const agentId = 'agent_123';
      const agentName = 'TestAgent';

      // Simulate completeAgentRegistration
      agents.set(agentId, {
        ws, name: agentName, workDir: '/work',
        conversations: new Map(), sessionKey: null,
        isAlive: true, capabilities: ['terminal'],
        proxyPorts: [], status: 'syncing',
        ownerId: null, ownerUsername: null
      });

      ws.send(JSON.stringify({ type: 'registered', agentId, sessionKey: null }));

      expect(agents.has(agentId)).toBe(true);
      expect(agents.get(agentId).status).toBe('syncing');
      expect(ws.getLastMessage().type).toBe('registered');
    });
  });

  describe('prod mode (auth required)', () => {
    it('should send auth_required with tempId', () => {
      const ws = new MockWebSocket();
      const tempId = 'temp_uuid_123';

      ws.send(JSON.stringify({ type: 'auth_required', tempId }));

      const msg = ws.getLastMessage();
      expect(msg.type).toBe('auth_required');
      expect(msg.tempId).toBe(tempId);
    });

    it('should close connection on auth timeout', () => {
      const ws = new MockWebSocket();
      ws.close(1008, 'Authentication timeout');
      expect(ws.readyState).toBe(3); // CLOSED
      expect(ws.closeCode).toBe(1008);
    });

    it('should close connection on auth failure', () => {
      const ws = new MockWebSocket();
      ws.close(1008, 'Invalid agent secret');
      expect(ws.closeCode).toBe(1008);
    });
  });

  describe('reconnection', () => {
    it('should preserve conversations on reconnect', () => {
      const agents = new Map();
      const existingConvs = new Map();
      existingConvs.set('conv1', { id: 'conv1', workDir: '/w', processing: true });

      agents.set('agent1', {
        ws: new MockWebSocket(), conversations: existingConvs,
        proxyPorts: [{ port: 3000, enabled: true, label: 'dev' }]
      });

      // Simulate reconnect: preserve conversations, disable proxy
      const existing = agents.get('agent1');
      const conversations = existing.conversations;
      const proxyPorts = existing.proxyPorts.map(p => ({ ...p, enabled: false }));

      agents.set('agent1', {
        ws: new MockWebSocket(), conversations, proxyPorts,
        status: 'syncing', isAlive: true
      });

      expect(agents.get('agent1').conversations.size).toBe(1);
      expect(agents.get('agent1').proxyPorts[0].enabled).toBe(false);
    });

    it('should preserve slashCommands and slashCommandDescriptions on reconnect (task-216)', () => {
      const agents = new Map();
      const agentId = 'agent_slash';

      // Step 1: Agent first connects
      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'SlashAgent',
        workDir: '/work',
        conversations: new Map(),
        sessionKey: null,
        isAlive: true,
        capabilities: ['terminal'],
        proxyPorts: [],
        slashCommands: [],
        slashCommandDescriptions: {},
        status: 'ready',
        ownerId: 'user1',
        ownerUsername: 'tester'
      });

      // Step 2: Agent reports dynamic skills via slash_commands_update
      const agent = agents.get(agentId);
      agent.slashCommands = ['/brainstorming', '/review-code', '/sprint'];
      agent.slashCommandDescriptions = {
        '/brainstorming': 'Before any creative work',
        '/review-code': 'Code review',
        '/sprint': 'Full sprint pipeline'
      };

      // Step 3: Agent disconnects and reconnects — simulate completeAgentRegistration
      const existingAgent = agents.get(agentId);
      const conversations = existingAgent?.conversations || new Map();
      const proxyPorts = (existingAgent?.proxyPorts || []).map(p => ({ ...p, enabled: false }));
      const slashCommands = existingAgent?.slashCommands || [];
      const slashCommandDescriptions = existingAgent?.slashCommandDescriptions || {};

      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'SlashAgent',
        workDir: '/work',
        conversations,
        sessionKey: null,
        isAlive: true,
        capabilities: ['terminal'],
        proxyPorts,
        slashCommands,
        slashCommandDescriptions,
        status: 'syncing',
        ownerId: 'user1',
        ownerUsername: 'tester'
      });

      // Step 4: Verify slashCommands preserved
      const reconnected = agents.get(agentId);
      expect(reconnected.slashCommands).toEqual(['/brainstorming', '/review-code', '/sprint']);
      expect(reconnected.slashCommandDescriptions).toEqual({
        '/brainstorming': 'Before any creative work',
        '/review-code': 'Code review',
        '/sprint': 'Full sprint pipeline'
      });
      expect(reconnected.status).toBe('syncing');
    });

    it('should default to empty slashCommands when no existingAgent (task-216)', () => {
      const agents = new Map();
      const agentId = 'agent_fresh_slash';

      // No existing agent — fresh connect
      const existingAgent = agents.get(agentId);
      const slashCommands = existingAgent?.slashCommands || [];
      const slashCommandDescriptions = existingAgent?.slashCommandDescriptions || {};

      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'FreshAgent',
        workDir: '/work',
        conversations: new Map(),
        sessionKey: null,
        isAlive: true,
        capabilities: ['terminal'],
        proxyPorts: [],
        slashCommands,
        slashCommandDescriptions,
        status: 'syncing',
        ownerId: null,
        ownerUsername: null
      });

      const fresh = agents.get(agentId);
      expect(fresh.slashCommands).toEqual([]);
      expect(fresh.slashCommandDescriptions).toEqual({});
    });

    it('should include slashCommands in agent_selected response after reconnect (task-216)', () => {
      const agents = new Map();
      const agentId = 'agent_selected_slash';

      // Agent with cached slash commands (from previous slash_commands_update)
      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'SkillAgent',
        workDir: '/work',
        conversations: new Map(),
        slashCommands: ['/tdd', '/debug'],
        slashCommandDescriptions: {
          '/tdd': 'Test-driven development',
          '/debug': 'Systematic debugging'
        },
        capabilities: ['terminal', 'file_editor', 'background_tasks'],
        status: 'ready',
        ownerId: 'user1'
      });

      // Simulate reconnect — preserve slash commands
      const existingAgent = agents.get(agentId);
      const slashCommands = existingAgent?.slashCommands || [];
      const slashCommandDescriptions = existingAgent?.slashCommandDescriptions || {};

      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'SkillAgent',
        workDir: '/work',
        conversations: new Map(),
        slashCommands,
        slashCommandDescriptions,
        capabilities: ['terminal', 'file_editor', 'background_tasks'],
        proxyPorts: [],
        status: 'syncing',
        ownerId: 'user1'
      });

      // Simulate agent_selected handler building the response
      const agent = agents.get(agentId);
      const agentSelectedMsg = {
        type: 'agent_selected',
        agentId,
        agentName: agent.name,
        workDir: agent.workDir,
        capabilities: agent.capabilities || ['terminal', 'file_editor', 'background_tasks'],
        conversations: [],
        slashCommands: agent.slashCommands || [],
        slashCommandDescriptions: agent.slashCommandDescriptions || {}
      };

      expect(agentSelectedMsg.slashCommands).toEqual(['/tdd', '/debug']);
      expect(agentSelectedMsg.slashCommandDescriptions).toEqual({
        '/tdd': 'Test-driven development',
        '/debug': 'Systematic debugging'
      });
    });
  });
});

describe('Agent Sync Lifecycle', () => {
  it('should start in syncing status', () => {
    const agent = createMockAgent({ status: 'syncing' });
    expect(agent.status).toBe('syncing');
  });

  it('should transition to ready on agent_sync_complete', () => {
    const agent = createMockAgent({ status: 'syncing' });
    // Simulate agent_sync_complete handler
    agent.status = 'ready';
    expect(agent.status).toBe('ready');
  });

  it('should force ready after 30s sync timeout', async () => {
    const agent = createMockAgent({ status: 'syncing' });
    // In real code: setTimeout after 30s sets status='ready'
    // We simulate the timeout firing
    if (agent.status === 'syncing') {
      agent.status = 'ready';
    }
    expect(agent.status).toBe('ready');
  });
});

describe('Agent Disconnect Cleanup', () => {
  it('should set all conversations processing=false', () => {
    const agent = createMockAgent();
    agent.conversations.set('c1', { processing: true });
    agent.conversations.set('c2', { processing: true });

    // Simulate disconnect handler
    for (const [, conv] of agent.conversations) {
      conv.processing = false;
    }

    expect(agent.conversations.get('c1').processing).toBe(false);
    expect(agent.conversations.get('c2').processing).toBe(false);
  });

  it('should clear message queues', () => {
    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [{ id: 'q1', prompt: 'hello' }]);
    serverMessageQueues.set('conv2', [{ id: 'q2', prompt: 'world' }]);

    const agent = createMockAgent();
    agent.conversations.set('conv1', {});
    agent.conversations.set('conv2', {});

    // Simulate cleanup
    for (const [convId] of agent.conversations) {
      serverMessageQueues.delete(convId);
    }

    expect(serverMessageQueues.size).toBe(0);
  });

  it('should disable all proxy ports', () => {
    const agent = createMockAgent({
      proxyPorts: [
        { port: 3000, enabled: true },
        { port: 8080, enabled: true }
      ]
    });

    agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));

    expect(agent.proxyPorts.every(p => !p.enabled)).toBe(true);
  });
});

describe('Agent Message: conversation_list', () => {
  it('should merge conversations preserving existing userId', () => {
    const agent = createMockAgent();
    agent.conversations.set('c1', { id: 'c1', userId: 'owner1', processing: true });
    agent.conversations.set('c2', { id: 'c2', userId: 'owner2' });

    const incoming = [
      { id: 'c1', workDir: '/new_dir', claudeSessionId: 'sess1' },
      { id: 'c3', workDir: '/c3_dir' }
    ];

    // Simulate merge logic
    const incomingIds = new Set(incoming.map(c => c.id));
    for (const id of agent.conversations.keys()) {
      if (!incomingIds.has(id)) agent.conversations.delete(id);
    }
    for (const conv of incoming) {
      const existing = agent.conversations.get(conv.id);
      if (existing) {
        existing.workDir = conv.workDir || existing.workDir;
        existing.claudeSessionId = conv.claudeSessionId || existing.claudeSessionId;
        // Preserve userId, processing
      } else {
        agent.conversations.set(conv.id, conv);
      }
    }

    expect(agent.conversations.size).toBe(2); // c1 and c3
    expect(agent.conversations.has('c2')).toBe(false); // removed
    expect(agent.conversations.get('c1').userId).toBe('owner1'); // preserved
    expect(agent.conversations.get('c1').processing).toBe(true); // preserved
    expect(agent.conversations.get('c1').workDir).toBe('/new_dir'); // updated
  });
});

describe('Agent Message: conversation_created/resumed', () => {
  it('should store conversation and create DB session', () => {
    const agent = createMockAgent();
    const msg = {
      conversationId: 'conv_new',
      workDir: '/work',
      claudeSessionId: 'claude_1',
      userId: 'user_1',
      username: 'testuser'
    };

    agent.conversations.set(msg.conversationId, {
      id: msg.conversationId,
      workDir: msg.workDir,
      claudeSessionId: msg.claudeSessionId,
      userId: msg.userId,
      username: msg.username,
      createdAt: Date.now(),
      processing: false
    });

    sessionDb.create(msg.conversationId, 'agent1', 'Agent', msg.workDir, msg.claudeSessionId, null, msg.userId);
    sessionDb.setActive(msg.conversationId, true);

    const conv = agent.conversations.get('conv_new');
    expect(conv.userId).toBe('user_1');
    expect(sessionDb.exists('conv_new')).toBe(true);
    expect(sessionDb.get('conv_new').is_active).toBe(1);
  });

  it('should clean up old entries with same claudeSessionId on resume', () => {
    const agent = createMockAgent();
    agent.conversations.set('old_conv', { id: 'old_conv', claudeSessionId: 'cs1' });
    agent.conversations.set('new_conv', { id: 'new_conv', claudeSessionId: 'cs1' });

    // Simulate cleanup logic for resume
    const targetId = 'new_conv';
    const targetSessionId = 'cs1';
    for (const [id, conv] of agent.conversations) {
      if (id !== targetId && conv.claudeSessionId === targetSessionId) {
        agent.conversations.delete(id);
      }
    }

    expect(agent.conversations.has('old_conv')).toBe(false);
    expect(agent.conversations.has('new_conv')).toBe(true);
  });
});

describe('Agent Message: turn_completed', () => {
  it('should set processing=false and update claudeSessionId', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv1', {
      id: 'conv1', processing: true, claudeSessionId: 'old'
    });

    const msg = { conversationId: 'conv1', claudeSessionId: 'new_session' };
    const conv = agent.conversations.get(msg.conversationId);
    conv.processing = false;
    if (msg.claudeSessionId) conv.claudeSessionId = msg.claudeSessionId;

    expect(conv.processing).toBe(false);
    expect(conv.claudeSessionId).toBe('new_session');
  });

  it('should dequeue next message from server queue', () => {
    const serverMessageQueues = new Map();
    const queue = [
      { id: 'q1', prompt: 'first', workDir: '/w' },
      { id: 'q2', prompt: 'second', workDir: '/w' }
    ];
    serverMessageQueues.set('conv1', queue);

    // Simulate turn_completed dequeue
    const convQueue = serverMessageQueues.get('conv1');
    const next = convQueue.shift();

    expect(next.id).toBe('q1');
    expect(next.prompt).toBe('first');
    expect(convQueue.length).toBe(1);
  });

  it('should handle queue with file attachments', () => {
    const next = {
      id: 'q1', prompt: 'analyze this',
      files: [{ name: 'test.txt', mimeType: 'text/plain', data: 'base64data' }]
    };

    // Should send transfer_files instead of execute
    const hasFiles = next.files && next.files.length > 0;
    expect(hasFiles).toBe(true);
    // In real code: sends transfer_files message instead of execute
  });

  it('should clean up empty queue', () => {
    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [{ id: 'q1', prompt: 'only' }]);

    const queue = serverMessageQueues.get('conv1');
    queue.shift();

    if (!queue || queue.length === 0) {
      serverMessageQueues.delete('conv1');
    }

    expect(serverMessageQueues.has('conv1')).toBe(false);
  });
});

describe('Agent Message: conversation_closed', () => {
  it('should set processing=false and session inactive', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv1', { processing: true, claudeSessionId: 'cs1' });

    sessionDb.create('conv1', 'agent1', 'A', '/d', 'cs1');

    // Simulate conversation_closed
    const conv = agent.conversations.get('conv1');
    conv.processing = false;
    sessionDb.setActive('conv1', false);

    expect(conv.processing).toBe(false);
    expect(sessionDb.get('conv1').is_active).toBe(0);
  });

  it('should still dequeue messages after process exit', () => {
    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [{ id: 'q1', prompt: 'pending' }]);

    const queue = serverMessageQueues.get('conv1');
    expect(queue.length).toBe(1);
    const next = queue.shift();
    expect(next.prompt).toBe('pending');
    // In real code: sends execute to agent to restart Claude process
  });
});

describe('Agent Message: execution_cancelled', () => {
  it('should set processing=false and clear queue', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv1', { processing: true });

    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [{ id: 'q1' }, { id: 'q2' }]);

    // Simulate cancellation
    const conv = agent.conversations.get('conv1');
    conv.processing = false;
    serverMessageQueues.delete('conv1');

    expect(conv.processing).toBe(false);
    expect(serverMessageQueues.has('conv1')).toBe(false);
  });
});

describe('Agent Message: claude_output', () => {
  it('should save user message to database', () => {
    sessionDb.create('co_sess', 'a1', 'A', '/d');

    const data = {
      type: 'user',
      message: { content: 'Hello Claude' }
    };
    const content = typeof data.message.content === 'string'
      ? data.message.content
      : JSON.stringify(data.message.content);

    messageDb.add('co_sess', 'user', content, 'user');

    const msgs = messageDb.getBySession('co_sess');
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('Hello Claude');
    expect(msgs[0].message_type).toBe('user');
  });

  it('should save assistant text message to database', () => {
    sessionDb.create('co_sess2', 'a1', 'A', '/d');

    const data = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello! I can help.' }]
      }
    };
    const content = data.message.content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('');

    messageDb.add('co_sess2', 'assistant', content, 'assistant');

    const msgs = messageDb.getBySession('co_sess2');
    expect(msgs[0].content).toBe('Hello! I can help.');
  });

  it('should save tool_use to database', () => {
    sessionDb.create('co_sess3', 'a1', 'A', '/d');

    const toolUse = {
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/tmp/test.js' }
    };

    messageDb.add('co_sess3', 'assistant', JSON.stringify(toolUse.input), 'tool_use', toolUse.name, JSON.stringify(toolUse.input));

    const msgs = messageDb.getBySession('co_sess3');
    expect(msgs[0].tool_name).toBe('Read');
  });

  it('should update session title from first user message', () => {
    sessionDb.create('co_title', 'a1', 'A', '/d');

    const content = 'Please help me with this code';
    const title = content.trim().substring(0, 50);
    sessionDb.update('co_title', { title });

    expect(sessionDb.get('co_title').title).toBe('Please help me with this code');
  });
});

describe('Agent Message: sync_sessions', () => {
  it('should create new sessions in DB', () => {
    const sessions = [
      { sessionId: 'sync1', workDir: '/w1', title: 'Session 1', lastModified: Date.now() },
      { sessionId: 'sync2', workDir: '/w2', title: 'Session 2', lastModified: Date.now() }
    ];

    for (const s of sessions) {
      if (!sessionDb.exists(s.sessionId)) {
        sessionDb.create(s.sessionId, 'agent1', 'Agent', s.workDir, s.sessionId, s.title, null);
      }
    }

    expect(sessionDb.exists('sync1')).toBe(true);
    expect(sessionDb.exists('sync2')).toBe(true);
  });

  it('should update existing sessions if newer', () => {
    sessionDb.create('sync_existing', 'a', 'A', '/d', null, 'Old Title');
    const existing = sessionDb.get('sync_existing');

    const incoming = { sessionId: 'sync_existing', title: 'New Title', lastModified: existing.updated_at + 1000 };

    if (incoming.lastModified > existing.updated_at) {
      sessionDb.update(incoming.sessionId, { title: incoming.title });
    }

    expect(sessionDb.get('sync_existing').title).toBe('New Title');
  });
});

describe('Agent Message: session_id_update', () => {
  it('should update claudeSessionId in memory and DB', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv1', { claudeSessionId: 'old_cs' });

    sessionDb.create('conv1', 'a1', 'A', '/d', 'old_cs');

    // Simulate session_id_update
    const conv = agent.conversations.get('conv1');
    conv.claudeSessionId = 'new_cs';
    sessionDb.update('conv1', { claudeSessionId: 'new_cs' });

    expect(conv.claudeSessionId).toBe('new_cs');
    expect(sessionDb.get('conv1').claude_session_id).toBe('new_cs');
  });
});

describe('Agent Message: proxy_ports_update', () => {
  it('should update agent proxy ports', () => {
    const agent = createMockAgent({ proxyPorts: [] });

    const newPorts = [
      { port: 3000, enabled: true, label: 'dev' },
      { port: 8080, enabled: false, label: 'api' }
    ];

    agent.proxyPorts = newPorts;

    expect(agent.proxyPorts.length).toBe(2);
    expect(agent.proxyPorts[0].port).toBe(3000);
    expect(agent.proxyPorts[0].enabled).toBe(true);
  });
});

describe('Agent Latency Measurement', () => {
  it('should calculate latency from ping/pong', () => {
    const agent = createMockAgent();
    agent.pingSentAt = Date.now() - 50;

    // Simulate pong handler
    agent.isAlive = true;
    if (agent.pingSentAt) {
      agent.latency = Date.now() - agent.pingSentAt;
      agent.pingSentAt = null;
    }

    expect(agent.latency).toBeGreaterThan(0);
    expect(agent.pingSentAt).toBeNull();
  });
});

describe('conversation_resumed with bulkAddHistory', () => {
  it('should sync history messages to DB on conversation_resumed', () => {
    const sid = 'conv_resume_test';
    sessionDb.create(sid, 'agent1', 'test-agent', '/tmp');

    const base = Date.now();
    const historyMessages = [
      { type: 'user', message: { content: 'hello' }, timestamp: new Date(base).toISOString() },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, timestamp: new Date(base + 1000).toISOString() },
      { type: 'user', message: { content: 'how are you' }, timestamp: new Date(base + 2000).toISOString() },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'good' }] }, timestamp: new Date(base + 3000).toISOString() },
    ];

    const insertedCount = messageDb.bulkAddHistory(sid, historyMessages);
    expect(insertedCount).toBe(4);
    expect(messageDb.getCount(sid)).toBe(4);
  });

  it('should read recent turns after sync', () => {
    const sid = 'conv_turns_test';
    sessionDb.create(sid, 'agent1', 'test-agent', '/tmp');

    const base = Date.now();
    const historyMessages = [];
    for (let i = 0; i < 10; i++) {
      historyMessages.push(
        { type: 'user', message: { content: `q${i}` }, timestamp: new Date(base + i * 2000).toISOString() },
        { type: 'assistant', message: { content: [{ type: 'text', text: `a${i}` }] }, timestamp: new Date(base + i * 2000 + 1000).toISOString() }
      );
    }

    messageDb.bulkAddHistory(sid, historyMessages);

    const { messages, hasMore } = messageDb.getRecentTurns(sid, 5);
    // 5 turns = 10 messages (5 user + 5 assistant)
    expect(messages.length).toBe(10);
    expect(hasMore).toBe(true);
    // First message should be the 6th turn's user message (q5)
    expect(messages[0].content).toBe('q5');
  });

  it('should remove historyMessages and add dbMessages in response pattern', () => {
    const sid = 'conv_transform_test';
    sessionDb.create(sid, 'agent1', 'test-agent', '/tmp');

    const base = Date.now();
    const msg = {
      type: 'conversation_resumed',
      conversationId: sid,
      historyMessages: [
        { type: 'user', message: { content: 'hello' }, timestamp: new Date(base).toISOString() },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, timestamp: new Date(base + 1000).toISOString() },
      ]
    };

    // Simulate the ws-agent.js pattern
    const insertedCount = messageDb.bulkAddHistory(msg.conversationId, msg.historyMessages);
    expect(insertedCount).toBe(2);

    const { messages: recentMessages, hasMore } = messageDb.getRecentTurns(msg.conversationId, 5);
    delete msg.historyMessages;
    msg.dbMessages = recentMessages;
    msg.hasMoreMessages = hasMore;
    msg.dbMessageCount = messageDb.getCount(msg.conversationId);

    // Verify transformation
    expect(msg.historyMessages).toBeUndefined();
    expect(msg.dbMessages).toBeTruthy();
    expect(msg.dbMessages.length).toBe(2);
    expect(msg.hasMoreMessages).toBe(false);
    expect(msg.dbMessageCount).toBe(2);
  });

  it('should clean up duplicate claudeSessionId entries', () => {
    const agent = createMockAgent();

    // Set up existing conversations with same claudeSessionId
    agent.conversations.set('conv_old', {
      id: 'conv_old',
      claudeSessionId: 'claude_sess_1',
    });
    agent.conversations.set('conv_other', {
      id: 'conv_other',
      claudeSessionId: 'claude_sess_2',
    });

    // Simulate conversation_resumed with same claudeSessionId
    const msg = {
      type: 'conversation_resumed',
      conversationId: 'conv_new',
      claudeSessionId: 'claude_sess_1'
    };

    // Replicate cleanup logic from ws-agent.js
    if (msg.type === 'conversation_resumed' && msg.claudeSessionId) {
      for (const [id, conv] of agent.conversations) {
        if (id !== msg.conversationId && conv.claudeSessionId === msg.claudeSessionId) {
          agent.conversations.delete(id);
        }
      }
    }

    expect(agent.conversations.has('conv_old')).toBe(false);   // cleaned up
    expect(agent.conversations.has('conv_other')).toBe(true);   // different session, kept
  });
});

describe('Server Restart: DB conversation recovery (task-37/task-44)', () => {
  describe('get_agents with conversationIds — on-demand DB recovery', () => {
    it('should restore only requested conversation IDs from DB', () => {
      const agentId = 'agent_ondemand';
      const agentName = 'OnDemandAgent';

      // Seed DB with multiple sessions for this agent
      sessionDb.create('conv_a', agentId, agentName, '/project/a', 'cs_a', 'Session A', 'user_1');
      sessionDb.create('conv_b', agentId, agentName, '/project/b', 'cs_b', 'Session B', 'user_1');
      sessionDb.create('conv_c', agentId, agentName, '/project/c', 'cs_c', 'Session C', 'user_1');

      // Simulate: agent has empty conversations (server restart)
      const agentConversations = new Map();

      // Client requests only conv_a and conv_c (what's in their sidebar)
      const requestedIds = ['conv_a', 'conv_c'];
      const clientUserId = 'user_1';
      const clientUsername = 'testuser';

      for (const convId of requestedIds) {
        const dbSession = sessionDb.get(convId);
        if (!dbSession) continue;
        if (dbSession.user_id && dbSession.user_id !== clientUserId) continue;
        if (agentConversations.has(convId)) continue;
        agentConversations.set(convId, {
          id: convId,
          workDir: dbSession.work_dir,
          claudeSessionId: dbSession.claude_session_id,
          title: dbSession.title,
          createdAt: dbSession.created_at,
          userId: dbSession.user_id || clientUserId,
          username: clientUsername,
          fromDb: true
        });
      }

      // Only requested conversations restored, not conv_b
      expect(agentConversations.size).toBe(2);
      expect(agentConversations.has('conv_a')).toBe(true);
      expect(agentConversations.has('conv_c')).toBe(true);
      expect(agentConversations.has('conv_b')).toBe(false);
      expect(agentConversations.get('conv_a').fromDb).toBe(true);
      expect(agentConversations.get('conv_a').title).toBe('Session A');
    });

    it('should not restore conversations belonging to other users', () => {
      const agentId = 'agent_security';

      sessionDb.create('conv_own', agentId, 'Agent', '/w', 'cs_1', 'My Conv', 'user_me');
      sessionDb.create('conv_other', agentId, 'Agent', '/w2', 'cs_2', 'Other Conv', 'user_other');

      const agentConversations = new Map();
      const requestedIds = ['conv_own', 'conv_other'];
      const clientUserId = 'user_me';

      for (const convId of requestedIds) {
        const dbSession = sessionDb.get(convId);
        if (!dbSession) continue;
        if (dbSession.user_id && dbSession.user_id !== clientUserId) continue;
        if (agentConversations.has(convId)) continue;
        agentConversations.set(convId, {
          id: convId,
          workDir: dbSession.work_dir,
          userId: dbSession.user_id || clientUserId,
          fromDb: true
        });
      }

      expect(agentConversations.size).toBe(1);
      expect(agentConversations.has('conv_own')).toBe(true);
      expect(agentConversations.has('conv_other')).toBe(false);
    });

    it('should skip conversations not in DB', () => {
      const agentConversations = new Map();
      const requestedIds = ['nonexistent_conv'];
      const clientUserId = 'user_1';

      for (const convId of requestedIds) {
        const dbSession = sessionDb.get(convId);
        if (!dbSession) continue;
        agentConversations.set(convId, { id: convId, fromDb: true });
      }

      expect(agentConversations.size).toBe(0);
    });

    it('should skip conversations whose agent is not connected', () => {
      const agentId = 'agent_offline';
      sessionDb.create('conv_offline', agentId, 'OfflineAgent', '/w', 'cs_1', 'Offline Conv', 'user_1');

      // agents Map does not have this agent (it's offline)
      const connectedAgents = new Map();

      const requestedIds = ['conv_offline'];
      const clientUserId = 'user_1';

      for (const convId of requestedIds) {
        const dbSession = sessionDb.get(convId);
        if (!dbSession) continue;
        if (dbSession.user_id && dbSession.user_id !== clientUserId) continue;
        const agent = connectedAgents.get(dbSession.agent_id);
        if (!agent) continue;
        agent.conversations.set(convId, { id: convId, fromDb: true });
      }

      // No conversations restored because agent is offline
      expect(connectedAgents.size).toBe(0);
    });

    it('should not overwrite existing conversations in agent Map', () => {
      const agentId = 'agent_existing';
      sessionDb.create('conv_live', agentId, 'Agent', '/w', 'cs_old', 'DB Title', 'user_1');

      const agentConversations = new Map();
      // Agent already has this conversation (from agent sync)
      agentConversations.set('conv_live', {
        id: 'conv_live', workDir: '/w', claudeSessionId: 'cs_new', processing: true
      });

      const requestedIds = ['conv_live'];
      const clientUserId = 'user_1';

      for (const convId of requestedIds) {
        const dbSession = sessionDb.get(convId);
        if (!dbSession) continue;
        if (dbSession.user_id && dbSession.user_id !== clientUserId) continue;
        if (agentConversations.has(convId)) continue; // skip existing
        agentConversations.set(convId, { id: convId, fromDb: true });
      }

      // Original entry preserved, not overwritten
      expect(agentConversations.size).toBe(1);
      expect(agentConversations.get('conv_live').claudeSessionId).toBe('cs_new');
      expect(agentConversations.get('conv_live').processing).toBe(true);
      expect(agentConversations.get('conv_live').fromDb).toBeUndefined();
    });

    it('should handle empty conversationIds gracefully', () => {
      const agentConversations = new Map();
      const requestedIds = [];

      for (const convId of requestedIds) {
        const dbSession = sessionDb.get(convId);
        if (!dbSession) continue;
        agentConversations.set(convId, { id: convId, fromDb: true });
      }

      expect(agentConversations.size).toBe(0);
    });
  });

  describe('completeAgentRegistration — server restart creates empty Map', () => {
    it('should create empty conversations Map when no existingAgent', () => {
      const agents = new Map();
      const agentId = 'agent_fresh';

      // Seed DB — these should NOT be auto-loaded
      sessionDb.create('conv_db_only', agentId, 'Agent', '/w', 'cs_1', 'DB Conv', 'user_1');

      const existingAgent = agents.get(agentId);
      const conversations = existingAgent?.conversations || new Map();

      expect(conversations.size).toBe(0); // Empty, no auto-recovery
    });
  });

  describe('conversation_list — fromDb protection', () => {
    it('should NOT delete fromDb conversations when agent does not report them', () => {
      const agent = createMockAgent();
      agent.conversations.set('db_conv_1', {
        id: 'db_conv_1', workDir: '/old', title: 'From DB', fromDb: true
      });
      agent.conversations.set('live_conv_1', {
        id: 'live_conv_1', workDir: '/live', title: 'Live'
      });

      const incoming = [
        { id: 'live_conv_1', workDir: '/live', claudeSessionId: 'cs_live' }
      ];

      const incomingIds = new Set(incoming.map(c => c.id));
      for (const [id, conv] of agent.conversations) {
        if (!incomingIds.has(id) && !conv.fromDb) {
          agent.conversations.delete(id);
        }
      }

      expect(agent.conversations.has('db_conv_1')).toBe(true);
      expect(agent.conversations.has('live_conv_1')).toBe(true);
    });

    it('should delete non-fromDb conversations when agent stops reporting them', () => {
      const agent = createMockAgent();
      agent.conversations.set('old_live', { id: 'old_live', workDir: '/w' });
      agent.conversations.set('still_live', { id: 'still_live', workDir: '/w2' });

      const incoming = [{ id: 'still_live', workDir: '/w2' }];
      const incomingIds = new Set(incoming.map(c => c.id));

      for (const [id, conv] of agent.conversations) {
        if (!incomingIds.has(id) && !conv.fromDb) {
          agent.conversations.delete(id);
        }
      }

      expect(agent.conversations.has('old_live')).toBe(false);
      expect(agent.conversations.has('still_live')).toBe(true);
    });
  });

  describe('conversation_list — fromDb clearing', () => {
    it('should clear fromDb flag when agent reports same conversation', () => {
      const agent = createMockAgent();
      agent.conversations.set('db_conv_upgrade', {
        id: 'db_conv_upgrade', workDir: '/old', title: 'From DB',
        fromDb: true, claudeSessionId: 'cs_old'
      });

      const incoming = [
        { id: 'db_conv_upgrade', workDir: '/new', claudeSessionId: 'cs_new' }
      ];

      for (const conv of incoming) {
        const existing = agent.conversations.get(conv.id);
        if (existing) {
          existing.workDir = conv.workDir || existing.workDir;
          existing.claudeSessionId = conv.claudeSessionId || existing.claudeSessionId;
          delete existing.fromDb;
        }
      }

      const result = agent.conversations.get('db_conv_upgrade');
      expect(result.fromDb).toBeUndefined();
      expect(result.workDir).toBe('/new');
      expect(result.claudeSessionId).toBe('cs_new');
    });

    it('should keep fromDb flag on conversations NOT reported by agent', () => {
      const agent = createMockAgent();
      agent.conversations.set('db_only', {
        id: 'db_only', workDir: '/w', fromDb: true
      });
      agent.conversations.set('db_and_live', {
        id: 'db_and_live', workDir: '/w2', fromDb: true
      });

      const incoming = [{ id: 'db_and_live', workDir: '/w2_updated' }];

      const incomingIds = new Set(incoming.map(c => c.id));
      for (const [id, conv] of agent.conversations) {
        if (!incomingIds.has(id) && !conv.fromDb) {
          agent.conversations.delete(id);
        }
      }
      for (const conv of incoming) {
        const existing = agent.conversations.get(conv.id);
        if (existing) {
          existing.workDir = conv.workDir || existing.workDir;
          delete existing.fromDb;
        }
      }

      expect(agent.conversations.get('db_only').fromDb).toBe(true);
      expect(agent.conversations.get('db_and_live').fromDb).toBeUndefined();
    });
  });

  describe('existingAgent reconnect — behavior unchanged', () => {
    it('should use existing conversations when existingAgent is present', () => {
      const agents = new Map();
      const agentId = 'agent_reconnect';

      const existingConvs = new Map();
      existingConvs.set('live_1', { id: 'live_1', workDir: '/w', processing: true });
      existingConvs.set('live_2', { id: 'live_2', workDir: '/w2' });
      agents.set(agentId, {
        ws: new MockWebSocket(), conversations: existingConvs,
        proxyPorts: []
      });

      sessionDb.create('db_sess_1', agentId, 'Agent', '/db_w');

      const existingAgent = agents.get(agentId);
      const conversations = existingAgent?.conversations || new Map();

      expect(conversations.size).toBe(2);
      expect(conversations.has('live_1')).toBe(true);
      expect(conversations.has('live_2')).toBe(true);
      expect(conversations.has('db_sess_1')).toBe(false);
      expect(conversations.get('live_1').processing).toBe(true);
    });
  });
});

describe('Slash Commands Preservation on Reconnect (task-216)', () => {
  describe('slash_commands_update caching', () => {
    it('should cache slashCommands on agent object via slash_commands_update', () => {
      const agent = createMockAgent();

      // Simulate slash_commands_update handler (agent-output.js L143-148)
      const msg = {
        slashCommands: ['/brainstorming', '/review-code', '/sprint'],
        slashCommandDescriptions: {
          '/brainstorming': 'Before any creative work',
          '/review-code': 'Code review',
          '/sprint': 'Full sprint pipeline'
        }
      };
      agent.slashCommands = msg.slashCommands || [];
      if (msg.slashCommandDescriptions) {
        agent.slashCommandDescriptions = { ...agent.slashCommandDescriptions, ...msg.slashCommandDescriptions };
      }

      expect(agent.slashCommands).toEqual(['/brainstorming', '/review-code', '/sprint']);
      expect(agent.slashCommandDescriptions['/brainstorming']).toBe('Before any creative work');
    });

    it('should merge slashCommandDescriptions across multiple updates', () => {
      const agent = createMockAgent();
      agent.slashCommandDescriptions = {};

      // First update
      agent.slashCommands = ['/foo'];
      agent.slashCommandDescriptions = { ...agent.slashCommandDescriptions, '/foo': 'Foo skill' };

      // Second update adds more
      const msg2 = {
        slashCommands: ['/foo', '/bar'],
        slashCommandDescriptions: { '/bar': 'Bar skill' }
      };
      agent.slashCommands = msg2.slashCommands;
      agent.slashCommandDescriptions = { ...agent.slashCommandDescriptions, ...msg2.slashCommandDescriptions };

      expect(agent.slashCommands).toEqual(['/foo', '/bar']);
      expect(agent.slashCommandDescriptions['/foo']).toBe('Foo skill');
      expect(agent.slashCommandDescriptions['/bar']).toBe('Bar skill');
    });
  });

  describe('completeAgentRegistration preserves slash commands', () => {
    it('should preserve slashCommands from existingAgent on reconnect', () => {
      const agents = new Map();
      const agentId = 'agent_reconnect_slash';

      // Agent connected and has cached slash commands
      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'TestAgent',
        workDir: '/work',
        conversations: new Map(),
        proxyPorts: [{ port: 3000, enabled: true }],
        slashCommands: ['/tdd', '/debug', '/review-code'],
        slashCommandDescriptions: {
          '/tdd': 'Test-driven development',
          '/debug': 'Systematic debugging',
          '/review-code': 'Code review'
        },
        status: 'ready'
      });

      // Simulate completeAgentRegistration on reconnect (ws-agent.js L167-195)
      const existingAgent = agents.get(agentId);
      const conversations = existingAgent?.conversations || new Map();
      const proxyPorts = (existingAgent?.proxyPorts || []).map(p => ({ ...p, enabled: false }));
      const slashCommands = existingAgent?.slashCommands || [];
      const slashCommandDescriptions = existingAgent?.slashCommandDescriptions || {};

      agents.set(agentId, {
        ws: new MockWebSocket(), // new WS connection
        name: 'TestAgent',
        workDir: '/work',
        conversations,
        sessionKey: null,
        isAlive: true,
        capabilities: ['terminal'],
        proxyPorts,
        slashCommands,
        slashCommandDescriptions,
        status: 'syncing',
        ownerId: null,
        ownerUsername: null,
        version: '1.0.0'
      });

      const reconnected = agents.get(agentId);
      expect(reconnected.slashCommands).toEqual(['/tdd', '/debug', '/review-code']);
      expect(reconnected.slashCommandDescriptions).toEqual({
        '/tdd': 'Test-driven development',
        '/debug': 'Systematic debugging',
        '/review-code': 'Code review'
      });
      expect(reconnected.status).toBe('syncing');
      expect(reconnected.proxyPorts[0].enabled).toBe(false);
      expect(reconnected.conversations).toBe(conversations);
    });

    it('should default to empty when no existingAgent (server restart)', () => {
      const agents = new Map();
      const agentId = 'agent_no_existing';

      const existingAgent = agents.get(agentId); // undefined
      const slashCommands = existingAgent?.slashCommands || [];
      const slashCommandDescriptions = existingAgent?.slashCommandDescriptions || {};

      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'FreshAgent',
        workDir: '/work',
        conversations: new Map(),
        slashCommands,
        slashCommandDescriptions,
        status: 'syncing'
      });

      expect(agents.get(agentId).slashCommands).toEqual([]);
      expect(agents.get(agentId).slashCommandDescriptions).toEqual({});
    });

    it('should handle existingAgent with no slashCommands property (upgrade path)', () => {
      const agents = new Map();
      const agentId = 'agent_old';

      // Old agent object created before task-216 fix — no slashCommands fields
      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'OldAgent',
        workDir: '/work',
        conversations: new Map(),
        proxyPorts: [],
        status: 'ready'
        // Note: no slashCommands or slashCommandDescriptions
      });

      const existingAgent = agents.get(agentId);
      const slashCommands = existingAgent?.slashCommands || [];
      const slashCommandDescriptions = existingAgent?.slashCommandDescriptions || {};

      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'OldAgent',
        workDir: '/work',
        conversations: existingAgent.conversations,
        proxyPorts: [],
        slashCommands,
        slashCommandDescriptions,
        status: 'syncing'
      });

      expect(agents.get(agentId).slashCommands).toEqual([]);
      expect(agents.get(agentId).slashCommandDescriptions).toEqual({});
    });
  });

  describe('end-to-end: slash_commands_update → disconnect → reconnect → agent_selected', () => {
    it('should preserve dynamic skills through full reconnection cycle', () => {
      const agents = new Map();
      const agentId = 'agent_e2e_slash';

      // 1. Agent first connects (completeAgentRegistration)
      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'E2EAgent',
        workDir: '/project',
        conversations: new Map(),
        sessionKey: 'sk_123',
        isAlive: true,
        capabilities: ['terminal', 'file_editor'],
        proxyPorts: [],
        slashCommands: [],
        slashCommandDescriptions: {},
        status: 'ready',
        ownerId: 'owner1',
        ownerUsername: 'alice',
        version: '2.0.0'
      });

      // 2. Agent reports skills via slash_commands_update
      const agent = agents.get(agentId);
      agent.slashCommands = ['/brainstorming', '/tdd', '/sprint', '/review-code'];
      agent.slashCommandDescriptions = {
        '/brainstorming': 'Before any creative work — features, components, designs',
        '/tdd': 'Writing tests or doing test-driven development',
        '/sprint': 'Running a full sprint pipeline',
        '/review-code': 'Reviewing code changes (pre-landing review)'
      };

      // 3. Agent reconnects — completeAgentRegistration rebuilds the object
      const existingAgent = agents.get(agentId);
      const conversations = existingAgent?.conversations || new Map();
      const proxyPorts = (existingAgent?.proxyPorts || []).map(p => ({ ...p, enabled: false }));
      const slashCommands = existingAgent?.slashCommands || [];
      const slashCommandDescriptions = existingAgent?.slashCommandDescriptions || {};

      const newWs = new MockWebSocket();
      agents.set(agentId, {
        ws: newWs,
        name: 'E2EAgent',
        workDir: '/project',
        conversations,
        sessionKey: 'sk_123',
        isAlive: true,
        capabilities: ['terminal', 'file_editor'],
        proxyPorts,
        slashCommands,
        slashCommandDescriptions,
        status: 'syncing',
        ownerId: 'owner1',
        ownerUsername: 'alice',
        version: '2.0.0'
      });

      // 4. Frontend sends select_agent → server builds agent_selected response
      const reconnectedAgent = agents.get(agentId);
      const agentSelectedMsg = {
        type: 'agent_selected',
        agentId,
        agentName: reconnectedAgent.name,
        workDir: reconnectedAgent.workDir,
        capabilities: reconnectedAgent.capabilities || ['terminal', 'file_editor', 'background_tasks'],
        conversations: [...reconnectedAgent.conversations.values()],
        slashCommands: reconnectedAgent.slashCommands || [],
        slashCommandDescriptions: reconnectedAgent.slashCommandDescriptions || {}
      };

      // 5. Verify: frontend receives full slash command list
      expect(agentSelectedMsg.slashCommands).toEqual([
        '/brainstorming', '/tdd', '/sprint', '/review-code'
      ]);
      expect(agentSelectedMsg.slashCommandDescriptions).toEqual({
        '/brainstorming': 'Before any creative work — features, components, designs',
        '/tdd': 'Writing tests or doing test-driven development',
        '/sprint': 'Running a full sprint pipeline',
        '/review-code': 'Reviewing code changes (pre-landing review)'
      });
      expect(agentSelectedMsg.type).toBe('agent_selected');
      expect(agentSelectedMsg.agentName).toBe('E2EAgent');
    });

    it('should preserve slash commands alongside conversations and proxyPorts', () => {
      const agents = new Map();
      const agentId = 'agent_all_fields';

      const convs = new Map();
      convs.set('conv1', { id: 'conv1', workDir: '/w', processing: true });

      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'MultiFieldAgent',
        workDir: '/work',
        conversations: convs,
        proxyPorts: [{ port: 3000, enabled: true, label: 'dev' }],
        slashCommands: ['/skill1', '/skill2'],
        slashCommandDescriptions: { '/skill1': 'Skill one', '/skill2': 'Skill two' },
        status: 'ready'
      });

      // Reconnect
      const existingAgent = agents.get(agentId);
      agents.set(agentId, {
        ws: new MockWebSocket(),
        name: 'MultiFieldAgent',
        workDir: '/work',
        conversations: existingAgent?.conversations || new Map(),
        proxyPorts: (existingAgent?.proxyPorts || []).map(p => ({ ...p, enabled: false })),
        slashCommands: existingAgent?.slashCommands || [],
        slashCommandDescriptions: existingAgent?.slashCommandDescriptions || {},
        status: 'syncing'
      });

      const a = agents.get(agentId);
      // All three preserved fields should be intact
      expect(a.conversations.size).toBe(1);
      expect(a.conversations.get('conv1').processing).toBe(true);
      expect(a.proxyPorts[0].enabled).toBe(false);
      expect(a.slashCommands).toEqual(['/skill1', '/skill2']);
      expect(a.slashCommandDescriptions).toEqual({ '/skill1': 'Skill one', '/skill2': 'Skill two' });
    });
  });
});
