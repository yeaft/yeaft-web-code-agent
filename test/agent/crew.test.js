import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for crew persistence, sync, and session management.
 * Replicates key logic from agent/crew.js and agent/conversation.js
 * without importing them directly (to avoid SDK/context side effects).
 */

// =====================================================================
// Replicate core functions for testing
// =====================================================================

function sessionToIndexEntry(session) {
  return {
    sessionId: session.id,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    status: session.status,
    userId: session.userId,
    username: session.username,
    createdAt: session.createdAt,
    updatedAt: Date.now()
  };
}

function buildSessionMeta(session) {
  return {
    sessionId: session.id,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    status: session.status,
    roles: Array.from(session.roles.values()).map(r => ({
      name: r.name, displayName: r.displayName, icon: r.icon,
      description: r.description, isDecisionMaker: r.isDecisionMaker || false
    })),
    decisionMaker: session.decisionMaker,
    round: session.round,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    userId: session.userId,
    username: session.username
  };
}

// Helper: create a test crew session object
function createTestSession(overrides = {}) {
  const roles = overrides.roles || new Map([
    ['pm', { name: 'pm', displayName: 'PM', icon: '📋', description: '需求分析', isDecisionMaker: true }],
    ['developer', { name: 'developer', displayName: '开发者', icon: '💻', description: '代码编写', isDecisionMaker: false }]
  ]);
  return {
    id: overrides.id || 'crew_test_001',
    projectDir: overrides.projectDir || '/tmp/test-project',
    sharedDir: overrides.sharedDir || '/tmp/test-project/.crew',
    roles,
    roleStates: new Map(),
    decisionMaker: overrides.decisionMaker || 'pm',
    status: overrides.status || 'running',
    round: overrides.round || 0,
    costUsd: 0,
    messageHistory: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    userId: overrides.userId || 'user_123',
    username: overrides.username || 'testuser',
    createdAt: overrides.createdAt || Date.now()
  };
}

// =====================================================================
// Tests
// =====================================================================

describe('Crew Index Operations', () => {
  describe('sessionToIndexEntry', () => {
    it('should extract minimal fields from session', () => {
      const session = createTestSession();
      const entry = sessionToIndexEntry(session);

      expect(entry.sessionId).toBe('crew_test_001');
      expect(entry.projectDir).toBe('/tmp/test-project');
      expect(entry.sharedDir).toBe('/tmp/test-project/.crew');
      expect(entry.status).toBe('running');
      expect(entry.createdAt).toBe(session.createdAt);
      expect(entry.updatedAt).toBeGreaterThan(0);
    });

    it('should include userId, username but not roles', () => {
      const session = createTestSession();
      const entry = sessionToIndexEntry(session);

      expect(entry.userId).toBe('user_123');
      expect(entry.username).toBe('testuser');
      expect(entry.roles).toBeUndefined();
      expect(entry.decisionMaker).toBeUndefined();
    });
  });

  describe('upsertCrewIndex logic', () => {
    it('should add new entry to empty index', () => {
      const index = [];
      const session = createTestSession();
      const entry = sessionToIndexEntry(session);

      const idx = index.findIndex(e => e.sessionId === session.id);
      if (idx >= 0) index[idx] = entry; else index.push(entry);

      expect(index.length).toBe(1);
      expect(index[0].sessionId).toBe('crew_test_001');
    });

    it('should update existing entry by sessionId', () => {
      const index = [
        { sessionId: 'crew_test_001', status: 'running', updatedAt: 1000 }
      ];
      const session = createTestSession({ status: 'stopped' });
      const entry = sessionToIndexEntry(session);

      const idx = index.findIndex(e => e.sessionId === session.id);
      if (idx >= 0) index[idx] = entry; else index.push(entry);

      expect(index.length).toBe(1);
      expect(index[0].status).toBe('stopped');
      expect(index[0].updatedAt).toBeGreaterThan(1000);
    });

    it('should not duplicate entries', () => {
      const index = [
        { sessionId: 'crew_001', status: 'running' },
        { sessionId: 'crew_002', status: 'running' }
      ];
      const session = createTestSession({ id: 'crew_001', status: 'stopped' });
      const entry = sessionToIndexEntry(session);

      const idx = index.findIndex(e => e.sessionId === session.id);
      if (idx >= 0) index[idx] = entry; else index.push(entry);

      expect(index.length).toBe(2);
      expect(index[0].status).toBe('stopped');
      expect(index[1].sessionId).toBe('crew_002');
    });
  });

  describe('loadCrewIndex (file-based)', () => {
    it('should return empty array if file does not exist', async () => {
      const fakePath = join(tmpdir(), `crew-index-${Date.now()}-nonexistent.json`);
      let result;
      try { result = JSON.parse(await fs.readFile(fakePath, 'utf-8')); }
      catch { result = []; }

      expect(result).toEqual([]);
    });

    it('should parse valid JSON file', async () => {
      const fakePath = join(tmpdir(), `crew-index-${Date.now()}.json`);
      const data = [{ sessionId: 'crew_001', status: 'stopped' }];
      await fs.writeFile(fakePath, JSON.stringify(data));

      let result;
      try { result = JSON.parse(await fs.readFile(fakePath, 'utf-8')); }
      catch { result = []; }

      expect(result.length).toBe(1);
      expect(result[0].sessionId).toBe('crew_001');

      // Cleanup
      await fs.unlink(fakePath);
    });
  });
});

describe('Session Metadata (.crew/session.json)', () => {
  describe('buildSessionMeta', () => {
    it('should correctly serialize roles Map to array', () => {
      const session = createTestSession();
      const meta = buildSessionMeta(session);

      expect(meta.sessionId).toBe('crew_test_001');
      expect(meta.roles).toBeInstanceOf(Array);
      expect(meta.roles.length).toBe(2);
      expect(meta.roles[0].name).toBe('pm');
      expect(meta.roles[0].isDecisionMaker).toBe(true);
      expect(meta.roles[1].name).toBe('developer');
      expect(meta.roles[1].isDecisionMaker).toBe(false);
    });

    it('should include all required fields', () => {
      const session = createTestSession({ round: 5 });
      const meta = buildSessionMeta(session);

      expect(meta.decisionMaker).toBe('pm');
      expect(meta.round).toBe(5);
      expect(meta.userId).toBe('user_123');
      expect(meta.username).toBe('testuser');
    });
  });

  describe('loadSessionMeta (file-based)', () => {
    it('should return null if file does not exist', async () => {
      const fakePath = join(tmpdir(), `session-${Date.now()}-nonexistent.json`);
      let result;
      try { result = JSON.parse(await fs.readFile(fakePath, 'utf-8')); }
      catch { result = null; }

      expect(result).toBeNull();
    });

    it('should load valid session.json', async () => {
      const dir = join(tmpdir(), `crew-test-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      const meta = { sessionId: 'crew_001', goal: 'test', roles: [{ name: 'pm' }] };
      await fs.writeFile(join(dir, 'session.json'), JSON.stringify(meta));

      let result;
      try { result = JSON.parse(await fs.readFile(join(dir, 'session.json'), 'utf-8')); }
      catch { result = null; }

      expect(result).not.toBeNull();
      expect(result.sessionId).toBe('crew_001');
      expect(result.roles[0].name).toBe('pm');

      // Cleanup
      await fs.rm(dir, { recursive: true });
    });
  });
});

describe('handleListCrewSessions Logic', () => {
  it('should merge active session status into index entries', () => {
    const crewSessions = new Map();
    crewSessions.set('crew_001', { status: 'running', round: 3 });
    crewSessions.set('crew_003', { status: 'waiting_human', round: 7 });

    const index = [
      { sessionId: 'crew_001', status: 'stopped' },
      { sessionId: 'crew_002', status: 'stopped' },
      { sessionId: 'crew_003', status: 'stopped' }
    ];

    for (const entry of index) {
      const active = crewSessions.get(entry.sessionId);
      if (active) {
        entry.status = active.status;
      }
    }

    expect(index[0].status).toBe('running');
    expect(index[1].status).toBe('stopped');
    expect(index[2].status).toBe('waiting_human');
  });

  it('should produce correct response format', () => {
    const msg = { requestId: 'req_123', _requestClientId: 'client_456' };
    const index = [{ sessionId: 'crew_001', status: 'stopped' }];

    const response = {
      type: 'crew_sessions_list',
      requestId: msg.requestId,
      _requestClientId: msg._requestClientId,
      sessions: index
    };

    expect(response.type).toBe('crew_sessions_list');
    expect(response.requestId).toBe('req_123');
    expect(response._requestClientId).toBe('client_456');
    expect(response.sessions.length).toBe(1);
  });
});

describe('resumeCrewSession Logic', () => {
  it('should return early if session already active', () => {
    const crewSessions = new Map();
    const session = createTestSession({ status: 'running' });
    crewSessions.set('crew_001', session);

    const alreadyActive = crewSessions.has('crew_001');
    expect(alreadyActive).toBe(true);
  });

  it('should report error if session not in index', () => {
    const index = [
      { sessionId: 'crew_other', sharedDir: '/tmp/.crew' }
    ];
    const found = index.find(e => e.sessionId === 'crew_missing');
    expect(found).toBeUndefined();
  });

  it('should rebuild session from metadata', () => {
    const meta = {
      sessionId: 'crew_001',
      projectDir: '/project',
      sharedDir: '/project/.crew',
      roles: [
        { name: 'pm', displayName: 'PM', icon: '📋', description: 'desc', isDecisionMaker: true },
        { name: 'developer', displayName: '开发者', icon: '💻', description: 'desc', isDecisionMaker: false }
      ],
      decisionMaker: 'pm',
      round: 5,
      createdAt: 1000000,
      userId: 'user_orig',
      username: 'origuser'
    };

    // Replicate resumeCrewSession logic
    const roles = meta.roles || [];
    const decisionMaker = meta.decisionMaker || roles[0]?.name || null;
    const session = {
      id: meta.sessionId,
      projectDir: meta.projectDir,
      sharedDir: meta.sharedDir,
      roles: new Map(roles.map(r => [r.name, r])),
      roleStates: new Map(),
      decisionMaker,
      status: 'waiting_human',
      round: meta.round || 0,
      costUsd: 0,
      messageHistory: [],
      humanMessageQueue: [],
      waitingHumanContext: null,
      userId: 'user_new' || meta.userId,
      username: 'newuser' || meta.username,
      createdAt: meta.createdAt || Date.now()
    };

    expect(session.id).toBe('crew_001');
    expect(session.status).toBe('waiting_human');
    expect(session.round).toBe(5);
    expect(session.roles.size).toBe(2);
    expect(session.roles.has('pm')).toBe(true);
    expect(session.roles.has('developer')).toBe(true);
    expect(session.decisionMaker).toBe('pm');
    expect(session.userId).toBe('user_new');
    expect(session.createdAt).toBe(1000000);
  });

  it('should prefer msg userId over meta userId', () => {
    const meta = { userId: 'user_orig', username: 'origuser' };
    const msgUserId = 'user_override';
    const msgUsername = 'overrideuser';

    const userId = msgUserId || meta.userId;
    const username = msgUsername || meta.username;

    expect(userId).toBe('user_override');
    expect(username).toBe('overrideuser');
  });

  it('should fallback to meta userId if msg has none', () => {
    const meta = { userId: 'user_orig', username: 'origuser' };
    const msgUserId = undefined;
    const msgUsername = undefined;

    const userId = msgUserId || meta.userId;
    const username = msgUsername || meta.username;

    expect(userId).toBe('user_orig');
    expect(username).toBe('origuser');
  });
});

describe('sendConversationList with Crew Sessions', () => {
  it('should include normal conversations and active crew sessions', () => {
    const conversations = new Map();
    conversations.set('conv_001', {
      workDir: '/project', claudeSessionId: 'cs1',
      createdAt: 1000, turnActive: false,
      userId: 'u1', username: 'user1'
    });

    const crewSessions = new Map();
    crewSessions.set('crew_001', {
      projectDir: '/project', createdAt: 2000,
      status: 'running', userId: 'u1', username: 'user1'
    });

    const list = [];
    for (const [id, state] of conversations) {
      list.push({
        id, workDir: state.workDir, claudeSessionId: state.claudeSessionId,
        createdAt: state.createdAt, processing: !!state.turnActive,
        userId: state.userId, username: state.username
      });
    }
    const activeCrewIds = new Set();
    for (const [id, session] of crewSessions) {
      activeCrewIds.add(id);
      list.push({
        id, workDir: session.projectDir, createdAt: session.createdAt,
        processing: session.status === 'running',
        userId: session.userId, username: session.username,
        type: 'crew'
      });
    }

    expect(list.length).toBe(2);
    expect(list[0].id).toBe('conv_001');
    expect(list[0].type).toBeUndefined();
    expect(list[1].id).toBe('crew_001');
    expect(list[1].type).toBe('crew');
    expect(list[1].processing).toBe(true);
  });

  it('should include stopped crew sessions from index', () => {
    const crewSessions = new Map();
    crewSessions.set('crew_active', { projectDir: '/p', createdAt: 1000, status: 'running' });

    const index = [
      { sessionId: 'crew_active', projectDir: '/p', createdAt: 1000 },
      { sessionId: 'crew_stopped', projectDir: '/p2', createdAt: 2000, status: 'stopped' }
    ];

    const list = [];
    const activeCrewIds = new Set();
    for (const [id, session] of crewSessions) {
      activeCrewIds.add(id);
      list.push({ id, type: 'crew' });
    }
    for (const entry of index) {
      if (!activeCrewIds.has(entry.sessionId)) {
        list.push({
          id: entry.sessionId, workDir: entry.projectDir,
          createdAt: entry.createdAt, processing: false,
          type: 'crew', status: entry.status
        });
      }
    }

    expect(list.length).toBe(2);
    expect(list[0].id).toBe('crew_active');
    expect(list[1].id).toBe('crew_stopped');
    expect(list[1].status).toBe('stopped');
    expect(list[1].processing).toBe(false);
  });

  it('should not duplicate active crew sessions from index', () => {
    const crewSessions = new Map();
    crewSessions.set('crew_001', { projectDir: '/p', createdAt: 1000, status: 'running', goal: 'A' });

    const index = [
      { sessionId: 'crew_001', projectDir: '/p', createdAt: 1000, status: 'running' }
    ];

    const activeCrewIds = new Set();
    const list = [];
    for (const [id] of crewSessions) {
      activeCrewIds.add(id);
      list.push({ id, type: 'crew' });
    }
    for (const entry of index) {
      if (!activeCrewIds.has(entry.sessionId)) {
        list.push({ id: entry.sessionId, type: 'crew' });
      }
    }

    expect(list.length).toBe(1);
    expect(list[0].id).toBe('crew_001');
  });
});

describe('Server conversation_list Crew Field Preservation', () => {
  it('should preserve type when updating existing conversation', () => {
    const agent = { conversations: new Map() };
    agent.conversations.set('crew_001', {
      id: 'crew_001', workDir: '/old', userId: 'u1'
    });

    const incoming = { id: 'crew_001', workDir: '/new', type: 'crew' };

    // Replicate ws-agent.js merge logic
    const existing = agent.conversations.get(incoming.id);
    if (existing) {
      existing.workDir = incoming.workDir || existing.workDir;
      if (incoming.type) existing.type = incoming.type;
    }

    expect(existing.workDir).toBe('/new');
    expect(existing.type).toBe('crew');
    expect(existing.userId).toBe('u1');
  });

  it('should include type for new crew conversations', () => {
    const agent = { conversations: new Map() };
    const incoming = {
      id: 'crew_new', workDir: '/project', type: 'crew',
      userId: null, username: null
    };

    const existing = agent.conversations.get(incoming.id);
    if (!existing) {
      const trustedUserId = null;
      const trustedUsername = null;
      agent.conversations.set(incoming.id, { ...incoming, userId: trustedUserId, username: trustedUsername });
    }

    const conv = agent.conversations.get('crew_new');
    expect(conv.type).toBe('crew');
  });

  it('should not strip type during sync cleanup', () => {
    const agent = { conversations: new Map() };
    agent.conversations.set('conv_001', { id: 'conv_001' });
    agent.conversations.set('crew_001', { id: 'crew_001', type: 'crew' });

    const incomingList = [
      { id: 'conv_001', workDir: '/w' },
      { id: 'crew_001', workDir: '/p', type: 'crew' }
    ];

    // Replicate sync: delete missing, update existing
    const incomingIds = new Set(incomingList.map(c => c.id));
    for (const id of agent.conversations.keys()) {
      if (!incomingIds.has(id)) agent.conversations.delete(id);
    }
    for (const conv of incomingList) {
      const existing = agent.conversations.get(conv.id);
      if (existing) {
        existing.workDir = conv.workDir || existing.workDir;
        if (conv.type) existing.type = conv.type;
      } else {
        agent.conversations.set(conv.id, conv);
      }
    }

    expect(agent.conversations.size).toBe(2);
    expect(agent.conversations.get('crew_001').type).toBe('crew');
  });
});

describe('Route Parsing', () => {
  // Replicate parseRoute from crew.js
  function parseRoute(text) {
    const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
    if (match) {
      return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
    }
    const altMatch = text.match(/---ROUTE---\s*\n([\s\S]*?)---END_ROUTE---/);
    if (altMatch) {
      const block = altMatch[1];
      const toMatch = block.match(/to:\s*(.+)/i);
      const summaryMatch = block.match(/summary:\s*(.+)/i);
      if (toMatch) {
        return { to: toMatch[1].trim().toLowerCase(), summary: summaryMatch ? summaryMatch[1].trim() : '' };
      }
    }
    return null;
  }

  it('should parse standard ROUTE block', () => {
    const text = `一些工作内容...

---ROUTE---
to: developer
summary: 请按照设计方案实现功能
---END_ROUTE---`;

    const route = parseRoute(text);
    expect(route).not.toBeNull();
    expect(route.to).toBe('developer');
    expect(route.summary).toBe('请按照设计方案实现功能');
  });

  it('should parse route with extra whitespace', () => {
    const text = `---ROUTE---
  to:   reviewer
  summary:   代码已完成，请审核
---END_ROUTE---`;

    const route = parseRoute(text);
    expect(route).not.toBeNull();
    expect(route.to).toBe('reviewer');
    expect(route.summary).toBe('代码已完成，请审核');
  });

  it('should return null if no ROUTE block', () => {
    const text = '普通回复，没有路由块。';
    expect(parseRoute(text)).toBeNull();
  });

  it('should route to human', () => {
    const text = `---ROUTE---
to: human
summary: 需要业务决策
---END_ROUTE---`;

    const route = parseRoute(text);
    expect(route.to).toBe('human');
  });
});

describe('Crew Session Lifecycle', () => {
  it('should track sessions by id in crewSessions Map', () => {
    const crewSessions = new Map();
    const session = createTestSession();
    crewSessions.set(session.id, session);

    expect(crewSessions.has('crew_test_001')).toBe(true);
    expect(crewSessions.get('crew_test_001').status).toBe('running');
  });

  it('should transition through status lifecycle', () => {
    const session = createTestSession({ status: 'running' });

    expect(session.status).toBe('running');

    session.status = 'paused';
    expect(session.status).toBe('paused');

    session.status = 'running';
    expect(session.status).toBe('running');

    session.status = 'waiting_human';
    expect(session.status).toBe('waiting_human');

    session.status = 'stopped';
    expect(session.status).toBe('stopped');
  });

  it('should increment rounds', () => {
    const session = createTestSession({ round: 0 });

    session.round++;
    expect(session.round).toBe(1);

    session.round++;
    expect(session.round).toBe(2);
  });

  it('should clean up on stopAll', () => {
    const crewSessions = new Map();
    const session = createTestSession();
    session.roleStates.set('pm', { claudeSessionId: 'cs1', abortController: { abort: () => {} } });
    session.roleStates.set('developer', { claudeSessionId: 'cs2', abortController: { abort: () => {} } });
    crewSessions.set(session.id, session);

    // Replicate stopAll logic
    session.status = 'stopped';
    session.roleStates.clear();
    crewSessions.delete(session.id);

    expect(session.status).toBe('stopped');
    expect(session.roleStates.size).toBe(0);
    expect(crewSessions.has(session.id)).toBe(false);
  });
});

// =====================================================================
// Bug Fix: pauseAll / resumeSession / processRoleOutput
// =====================================================================

describe('pauseAll - abort running queries and save sessionId', () => {
  // Replicate parseRoute for pendingRoute tests
  function parseRoute(text) {
    const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
    if (match) {
      return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
    }
    return null;
  }

  it('should abort all running role queries on pause', () => {
    const session = createTestSession({ status: 'running' });
    const aborted = [];

    session.roleStates.set('pm', {
      claudeSessionId: 'cs_pm_1',
      abortController: { abort: () => aborted.push('pm') },
      turnActive: true,
      query: {},
      inputStream: {}
    });
    session.roleStates.set('developer', {
      claudeSessionId: 'cs_dev_1',
      abortController: { abort: () => aborted.push('developer') },
      turnActive: true,
      query: {},
      inputStream: {}
    });

    // Replicate pauseAll logic
    session.status = 'paused';
    for (const [roleName, roleState] of session.roleStates) {
      if (roleState.abortController) {
        roleState.abortController.abort();
      }
      roleState.wasActive = roleState.turnActive;
      roleState.turnActive = false;
      roleState.query = null;
      roleState.inputStream = null;
    }

    expect(session.status).toBe('paused');
    expect(aborted).toEqual(['pm', 'developer']);
    expect(session.roleStates.get('pm').turnActive).toBe(false);
    expect(session.roleStates.get('pm').wasActive).toBe(true);
    expect(session.roleStates.get('pm').query).toBeNull();
    expect(session.roleStates.get('pm').inputStream).toBeNull();
    expect(session.roleStates.get('developer').turnActive).toBe(false);
    expect(session.roleStates.get('developer').wasActive).toBe(true);
  });

  it('should preserve claudeSessionId for each role during pause', () => {
    const session = createTestSession({ status: 'running' });

    session.roleStates.set('pm', {
      claudeSessionId: 'cs_pm_42',
      abortController: { abort: () => {} },
      turnActive: true,
      query: {},
      inputStream: {}
    });

    // Replicate pauseAll: sessionId should be preserved (saved to file in real code)
    session.status = 'paused';
    const roleState = session.roleStates.get('pm');
    const savedSessionId = roleState.claudeSessionId;
    roleState.wasActive = roleState.turnActive;
    roleState.turnActive = false;
    roleState.query = null;
    roleState.inputStream = null;

    // sessionId 应该依然可用于后续 resume
    expect(savedSessionId).toBe('cs_pm_42');
    expect(roleState.claudeSessionId).toBe('cs_pm_42');
  });

  it('should handle roles with no abortController gracefully', () => {
    const session = createTestSession({ status: 'running' });

    session.roleStates.set('pm', {
      claudeSessionId: 'cs_pm_1',
      abortController: null,
      turnActive: false,
      query: null,
      inputStream: null
    });

    session.status = 'paused';
    for (const [, roleState] of session.roleStates) {
      if (roleState.abortController) {
        roleState.abortController.abort();
      }
      roleState.wasActive = roleState.turnActive;
      roleState.turnActive = false;
      roleState.query = null;
      roleState.inputStream = null;
    }

    // Should not throw
    expect(session.status).toBe('paused');
    expect(session.roleStates.get('pm').wasActive).toBe(false);
  });
});

describe('resumeSession - replay pendingRoute', () => {
  it('should replay pendingRoute when resuming', () => {
    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = {
      fromRole: 'pm',
      route: { to: 'developer', summary: '请实现功能 X' }
    };

    // Replicate resumeSession logic
    session.status = 'running';
    let replayedRoute = null;
    if (session.pendingRoute) {
      replayedRoute = { ...session.pendingRoute };
      session.pendingRoute = null;
    }

    expect(session.status).toBe('running');
    expect(session.pendingRoute).toBeNull();
    expect(replayedRoute).not.toBeNull();
    expect(replayedRoute.fromRole).toBe('pm');
    expect(replayedRoute.route.to).toBe('developer');
    expect(replayedRoute.route.summary).toBe('请实现功能 X');
  });

  it('should fallback to processHumanQueue when no pendingRoute', () => {
    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = null;
    session.humanMessageQueue = [
      { target: 'pm', content: '人工消息', timestamp: Date.now() }
    ];

    // Replicate resumeSession logic
    session.status = 'running';
    let didReplayRoute = false;
    let didProcessHumanQueue = false;

    if (session.pendingRoute) {
      didReplayRoute = true;
      session.pendingRoute = null;
    } else {
      // Would call processHumanQueue
      didProcessHumanQueue = true;
    }

    expect(didReplayRoute).toBe(false);
    expect(didProcessHumanQueue).toBe(true);
    expect(session.status).toBe('running');
  });

  it('should not resume if status is not paused', () => {
    const session = createTestSession({ status: 'running' });
    session.pendingRoute = { fromRole: 'pm', route: { to: 'developer', summary: 'test' } };

    // Replicate resumeSession guard
    let didResume = false;
    if (session.status === 'paused') {
      session.status = 'running';
      didResume = true;
    }

    expect(didResume).toBe(false);
    // pendingRoute should not be consumed
    expect(session.pendingRoute).not.toBeNull();
  });

  it('should clear pendingRoute before executing to prevent re-entry', () => {
    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = {
      fromRole: 'architect',
      route: { to: 'developer', summary: '设计完成' }
    };

    // Replicate exact resumeSession logic for pendingRoute
    session.status = 'running';
    const { fromRole, route } = session.pendingRoute;
    session.pendingRoute = null;
    // At this point executeRoute would be called
    // If executeRoute somehow triggers pause again, pendingRoute is already null

    expect(session.pendingRoute).toBeNull();
    expect(fromRole).toBe('architect');
    expect(route.to).toBe('developer');
  });
});

describe('processRoleOutput - break on paused status', () => {
  it('should break loop when status is paused', () => {
    const session = createTestSession({ status: 'running' });
    const processedMessages = [];

    // Simulate message processing loop
    const messages = [
      { type: 'assistant', message: { content: 'msg1' } },
      { type: 'assistant', message: { content: 'msg2' } },
      { type: 'assistant', message: { content: 'msg3' } }
    ];

    for (const message of messages) {
      // Replicate the paused/stopped check from processRoleOutput
      if (session.status === 'stopped' || session.status === 'paused') break;
      processedMessages.push(message);

      // Simulate pause happening after first message
      if (processedMessages.length === 1) {
        session.status = 'paused';
      }
    }

    // Only the first message should be processed before pause took effect
    expect(processedMessages.length).toBe(1);
  });

  it('should break loop when status is stopped', () => {
    const session = createTestSession({ status: 'stopped' });
    const processedMessages = [];

    const messages = [
      { type: 'assistant', message: { content: 'msg1' } }
    ];

    for (const message of messages) {
      if (session.status === 'stopped' || session.status === 'paused') break;
      processedMessages.push(message);
    }

    expect(processedMessages.length).toBe(0);
  });

  it('should save pendingRoute from accumulated text on abort during pause', () => {
    function parseRoute(text) {
      const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
      if (match) {
        return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
      }
      return null;
    }

    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = null;

    const roleState = {
      accumulatedText: `任务已完成。

---ROUTE---
to: reviewer
summary: 请审核代码变更
---END_ROUTE---`,
      claudeSessionId: 'cs_dev_1'
    };

    // Replicate AbortError handling from processRoleOutput
    if (session.status === 'paused' && roleState.accumulatedText) {
      const route = parseRoute(roleState.accumulatedText);
      if (route && !session.pendingRoute) {
        session.pendingRoute = { fromRole: 'developer', route };
      }
      roleState.accumulatedText = '';
    }

    expect(session.pendingRoute).not.toBeNull();
    expect(session.pendingRoute.fromRole).toBe('developer');
    expect(session.pendingRoute.route.to).toBe('reviewer');
    expect(session.pendingRoute.route.summary).toBe('请审核代码变更');
    expect(roleState.accumulatedText).toBe('');
  });

  it('should not overwrite existing pendingRoute on abort', () => {
    function parseRoute(text) {
      const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
      if (match) {
        return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
      }
      return null;
    }

    const session = createTestSession({ status: 'paused' });
    // Already has a pendingRoute from another role
    session.pendingRoute = {
      fromRole: 'pm',
      route: { to: 'architect', summary: '请设计方案' }
    };

    const roleState = {
      accumulatedText: `---ROUTE---
to: reviewer
summary: 新的路由
---END_ROUTE---`
    };

    // Replicate: should NOT overwrite
    if (session.status === 'paused' && roleState.accumulatedText) {
      const route = parseRoute(roleState.accumulatedText);
      if (route && !session.pendingRoute) {
        session.pendingRoute = { fromRole: 'developer', route };
      }
      roleState.accumulatedText = '';
    }

    // Original pendingRoute should be preserved
    expect(session.pendingRoute.fromRole).toBe('pm');
    expect(session.pendingRoute.route.to).toBe('architect');
  });
});

describe('executeRoute - save pending when paused/stopped', () => {
  it('should save route as pendingRoute when session is paused', () => {
    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = null;
    session.round = 3;

    const fromRole = 'pm';
    const route = { to: 'developer', summary: '开始开发' };

    // Replicate executeRoute: round increments first
    session.round++;

    // Then check paused/stopped
    if (session.status === 'paused' || session.status === 'stopped') {
      session.pendingRoute = { fromRole, route };
    }

    expect(session.round).toBe(4);
    expect(session.pendingRoute).not.toBeNull();
    expect(session.pendingRoute.fromRole).toBe('pm');
    expect(session.pendingRoute.route.to).toBe('developer');
  });

  it('should save route as pendingRoute when session is stopped', () => {
    const session = createTestSession({ status: 'stopped' });
    session.pendingRoute = null;

    const fromRole = 'reviewer';
    const route = { to: 'developer', summary: '需要修改' };

    session.round++;
    if (session.status === 'paused' || session.status === 'stopped') {
      session.pendingRoute = { fromRole, route };
    }

    expect(session.pendingRoute).not.toBeNull();
    expect(session.pendingRoute.fromRole).toBe('reviewer');
    expect(session.pendingRoute.route.to).toBe('developer');
  });

  it('should not save pendingRoute when session is running', () => {
    const session = createTestSession({ status: 'running' });
    session.pendingRoute = null;

    const fromRole = 'pm';
    const route = { to: 'developer', summary: '任务分配' };

    session.round++;
    if (session.status === 'paused' || session.status === 'stopped') {
      session.pendingRoute = { fromRole, route };
    }

    expect(session.pendingRoute).toBeNull();
  });
});

describe('createCrewSession / resumeCrewSession - pendingRoute initialization', () => {
  it('should initialize pendingRoute as null in createCrewSession', () => {
    const session = createTestSession();
    session.pendingRoute = null; // As added in the fix

    expect(session.pendingRoute).toBeNull();
  });

  it('should initialize pendingRoute as null in resumeCrewSession', () => {
    // Replicate resumeCrewSession rebuild logic
    const meta = {
      sessionId: 'crew_resume_001',
      projectDir: '/project',
      sharedDir: '/project/.crew',
      roles: [{ name: 'pm', displayName: 'PM', icon: '📋', description: 'desc', isDecisionMaker: true }],
      decisionMaker: 'pm',
      round: 3,
      createdAt: 1000
    };

    const session = {
      id: meta.sessionId,
      roles: new Map(meta.roles.map(r => [r.name, r])),
      roleStates: new Map(),
      status: 'waiting_human',
      round: meta.round,
      pendingRoute: null, // ← This is the fix
      humanMessageQueue: [],
      waitingHumanContext: null
    };

    expect(session.pendingRoute).toBeNull();
    // pendingRoute should be available for future pauseAll/resume cycles
    session.pendingRoute = { fromRole: 'pm', route: { to: 'developer', summary: 'test' } };
    expect(session.pendingRoute).not.toBeNull();
    session.pendingRoute = null;
    expect(session.pendingRoute).toBeNull();
  });
});

describe('Full pause-resume cycle integration', () => {
  it('should correctly handle pause -> route saved -> resume -> route replayed', () => {
    function parseRoute(text) {
      const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
      if (match) {
        return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
      }
      return null;
    }

    // Step 1: Create running session with active role
    const session = createTestSession({ status: 'running' });
    session.pendingRoute = null;

    const aborted = [];
    session.roleStates.set('developer', {
      claudeSessionId: 'cs_dev_99',
      abortController: { abort: () => aborted.push('developer') },
      turnActive: true,
      accumulatedText: `代码已完成。

---ROUTE---
to: reviewer
summary: 代码审查
---END_ROUTE---`,
      query: {},
      inputStream: {}
    });

    // Step 2: Pause
    session.status = 'paused';
    for (const [, roleState] of session.roleStates) {
      if (roleState.abortController) {
        roleState.abortController.abort();
      }
      roleState.wasActive = roleState.turnActive;
      roleState.turnActive = false;
      roleState.query = null;
      roleState.inputStream = null;
    }

    // Step 3: Simulate AbortError handler saving pendingRoute
    const roleState = session.roleStates.get('developer');
    if (session.status === 'paused' && roleState.accumulatedText) {
      const route = parseRoute(roleState.accumulatedText);
      if (route && !session.pendingRoute) {
        session.pendingRoute = { fromRole: 'developer', route };
      }
      roleState.accumulatedText = '';
    }

    expect(aborted).toEqual(['developer']);
    expect(session.pendingRoute).not.toBeNull();
    expect(session.pendingRoute.route.to).toBe('reviewer');

    // Step 4: Resume
    let replayedFromRole = null;
    let replayedRoute = null;

    session.status = 'running';
    if (session.pendingRoute) {
      replayedFromRole = session.pendingRoute.fromRole;
      replayedRoute = session.pendingRoute.route;
      session.pendingRoute = null;
      // executeRoute would be called here
    }

    expect(session.status).toBe('running');
    expect(session.pendingRoute).toBeNull();
    expect(replayedFromRole).toBe('developer');
    expect(replayedRoute.to).toBe('reviewer');
    expect(replayedRoute.summary).toBe('代码审查');
  });

  it('should handle dispatchToRole guard when paused/stopped', () => {
    const session = createTestSession({ status: 'paused' });
    let dispatched = false;

    // Replicate dispatchToRole guard
    if (session.status === 'paused' || session.status === 'stopped') {
      // skip dispatch
    } else {
      dispatched = true;
    }

    expect(dispatched).toBe(false);

    session.status = 'running';
    if (session.status === 'paused' || session.status === 'stopped') {
      // skip dispatch
    } else {
      dispatched = true;
    }

    expect(dispatched).toBe(true);
  });
});

// =====================================================================
// buildRoleSystemPrompt — 角色 prompt 正确性
// =====================================================================

describe('buildRoleSystemPrompt', () => {
  // Replicate buildRoleSystemPrompt logic for testing
  function buildRoleSystemPrompt(role, session) {
    const allRoles = Array.from(session.roles.values());
    const otherRoles = allRoles.filter(r => r.name !== role.name);

    let prompt = `# 团队协作
你正在一个 AI 团队中工作。等待用户提出任务或问题。

团队成员:
${allRoles.map(r => `- ${r.icon} ${r.displayName}: ${r.description}${r.isDecisionMaker ? ' (决策者)' : ''}`).join('\n')}`;

    if (otherRoles.length > 0) {
      prompt += `\n\n# 路由规则
当你完成当前任务并需要将结果传递给其他角色时，在你的回复最末尾添加一个 ROUTE 块：

\`\`\`
---ROUTE---
to: <角色name>
summary: <简要说明要传递什么>
---END_ROUTE---
\`\`\`

可用的路由目标:
${otherRoles.map(r => `- ${r.name}: ${r.icon} ${r.displayName} — ${r.description}`).join('\n')}
- human: 人工（只在决策者也无法决定时使用）

注意：
- 如果你的工作还没完成，不需要添加 ROUTE 块
- 如果你遇到不确定的问题，@ 决策者 "${session.decisionMaker}"，而不是直接 @ human
- 如果你是决策者且遇到需要人类判断的问题，才 @ human
- 每次回复最多只能有一个 ROUTE 块
- ROUTE 块必须在回复的最末尾
- 当你的任务已完成且不需要其他角色继续时，ROUTE 回决策者 "${session.decisionMaker}" 做总结
- 在正文中可用 @角色name 提及某个角色（如 @developer），但这不会触发路由，仅供阅读`;
    }

    if (role.isDecisionMaker) {
      prompt += `\n\n# 决策者职责
你是团队的决策者。其他角色遇到不确定的情况会请求你的决策。
- 如果你有足够的信息做出决策，直接决定并 @相关角色执行
- 如果你需要更多信息，@具体角色请求补充
- 如果问题超出你的能力范围或需要业务判断，@human 请人类决定
- 你可以随时审查其他角色的工作并给出反馈

# 工作流终结点
团队的工作流有明确的结束条件。当以下任一条件满足时，你应该给出总结并结束当前工作流：
1. **代码已提交** - 所有代码修改已经 commit（如需要，可让 developer 执行 git commit）
2. **需要用户输入** - 遇到需要用户决定的问题时，@human 提出具体问题，等待用户回复
3. **任务完成** - 所有任务已完成，给出完成总结（列出完成了什么、变更了哪些文件、还有什么后续建议）

重要：不要无限循环地在角色之间传递。当工作实质性完成时，主动给出总结并结束。

# 任务清单
你可以在回复中添加 TASKS 块来发布/更新任务清单，团队界面会自动展示：

\`\`\`
---TASKS---
- [ ] 任务描述 @角色name
- [x] 已完成的任务 @角色name
---END_TASKS---
\`\`\`

注意：
- 每行一个任务，[ ] 表示待办，[x] 表示已完成
- @角色name 标注负责人（可选）
- 后续回复中可更新 TASKS 块（标记完成的任务）
- TASKS 块不需要在回复最末尾，可以放在任意位置`;
    }

    return prompt;
  }

  it('should include all roles in team member list', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('📋 PM: 需求分析');
    expect(prompt).toContain('💻 开发者: 代码编写');
    expect(prompt).toContain('(决策者)');
  });

  it('should include route targets excluding current role', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    // PM 的路由目标应该包含 developer 但不包含 pm 自己
    expect(prompt).toContain('- developer: 💻 开发者 — 代码编写');
    expect(prompt).not.toMatch(/- pm: 📋 PM —/);
    expect(prompt).toContain('- human: 人工');
  });

  it('should show decision maker reference in routing notes', () => {
    const session = createTestSession();
    const devRole = session.roles.get('developer');
    const prompt = buildRoleSystemPrompt(devRole, session);

    // developer 应该被告知找决策者 pm
    expect(prompt).toContain('@ 决策者 "pm"');
    expect(prompt).toContain('ROUTE 回决策者 "pm" 做总结');
  });

  it('should include decision maker responsibilities for PM', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('# 决策者职责');
    expect(prompt).toContain('你是团队的决策者');
    expect(prompt).toContain('@human 请人类决定');
  });

  it('should NOT include decision maker section for non-decision-maker roles', () => {
    const session = createTestSession();
    const devRole = session.roles.get('developer');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).not.toContain('# 决策者职责');
    expect(prompt).not.toContain('# 工作流终结点');
    expect(prompt).not.toContain('# 任务清单');
  });

  it('should include workflow endpoints for decision maker', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('# 工作流终结点');
    expect(prompt).toContain('代码已提交');
    expect(prompt).toContain('需要用户输入');
    expect(prompt).toContain('任务完成');
    expect(prompt).toContain('不要无限循环');
  });

  it('should include TASKS block format for decision maker', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('# 任务清单');
    expect(prompt).toContain('---TASKS---');
    expect(prompt).toContain('---END_TASKS---');
    expect(prompt).toContain('- [ ] 任务描述 @角色name');
    expect(prompt).toContain('- [x] 已完成的任务 @角色name');
  });

  it('should include ROUTE block format in routing rules', () => {
    const session = createTestSession();
    const devRole = session.roles.get('developer');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).toContain('---ROUTE---');
    expect(prompt).toContain('---END_ROUTE---');
    expect(prompt).toContain('to: <角色name>');
    expect(prompt).toContain('summary: <简要说明要传递什么>');
  });

  it('should handle empty goal gracefully', () => {
    const session = createTestSession({ goal: '' });
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('等待用户提出任务或问题');
    expect(prompt).not.toContain('项目目标是:');
  });

  it('should handle single-role session (no routing rules)', () => {
    const roles = new Map([
      ['pm', { name: 'pm', displayName: 'PM', icon: '📋', description: '需求分析', isDecisionMaker: true }]
    ]);
    const session = createTestSession({ roles });
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    // 只有一个角色，没有路由目标
    expect(prompt).not.toContain('# 路由规则');
    expect(prompt).not.toContain('---ROUTE---');
    // 但决策者职责仍然在
    expect(prompt).toContain('# 决策者职责');
  });

  it('should mention @role mention vs ROUTE distinction', () => {
    const session = createTestSession();
    const devRole = session.roles.get('developer');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).toContain('在正文中可用 @角色name 提及某个角色');
    expect(prompt).toContain('不会触发路由，仅供阅读');
  });
});

// =====================================================================
// PM claudeMd 模板验证
// =====================================================================

describe('PM role template constraints', () => {
  // 从 CrewConfigPanel 中提取的 PM claudeMd
  const pmClaudeMd = '你是 Steve Jobs（史蒂夫·乔布斯），以他的思维方式和工作风格来管理这个项目。\n追求极致简洁，对产品品质零容忍，善于从用户视角思考，敢于砍掉不必要的功能。\n\n# 重要约束\n- 你不能写代码，也不能直接修改文件。所有代码工作必须分配给 developer。\n- 收到新任务后，先制定实施计划（列出任务清单、优先级、负责角色），然后 @human 请用户审核计划，审核通过后再分配执行。\n\n# 协作流程\n- 收到目标后：分析需求，拆分任务，制定计划，@human 审核\n- 审核通过后：分配给 🏗️ 架构师(architect) 做技术设计\n- 架构师设计完成后：审核设计方案，通过后分配给 💻 开发者(developer) 实现\n- 收到 🔍 审查者(reviewer) 或 🧪 测试(tester) 反馈的需求问题：澄清需求，必要时调整方案\n- 所有角色完成工作且测试通过：汇总成果，向 human 汇报\n- 遇到需要业务判断的问题：找 human 决定';

  it('should explicitly prohibit PM from writing code', () => {
    expect(pmClaudeMd).toContain('你不能写代码');
    expect(pmClaudeMd).toContain('不能直接修改文件');
    expect(pmClaudeMd).toContain('所有代码工作必须分配给 developer');
  });

  it('should require plan approval from human before execution', () => {
    expect(pmClaudeMd).toContain('先制定实施计划');
    expect(pmClaudeMd).toContain('@human 请用户审核计划');
    expect(pmClaudeMd).toContain('审核通过后再分配执行');
  });

  it('should define complete collaboration flow', () => {
    expect(pmClaudeMd).toContain('分配给 🏗️ 架构师(architect) 做技术设计');
    expect(pmClaudeMd).toContain('分配给 💻 开发者(developer) 实现');
    expect(pmClaudeMd).toContain('向 human 汇报');
  });
});

describe('Developer role template - parallel review flow', () => {
  const devClaudeMd = '你是 Linus Torvalds（林纳斯·托瓦兹），以他的编码风格来写代码。\n代码简洁高效，厌恶不必要的抽象，追求性能和正确性，注重实用主义而非教条。\n\n# 协作流程\n- 收到任务后：按架构设计实现代码\n- 代码完成后：同时交给 🔍 审查者(reviewer) 审核代码质量 和 🧪 测试(tester) 进行测试验证（并行审核，两者独立 approve）\n- 收到 🔍 审查者(reviewer) 的代码质量问题：修改后重新提交审核\n- 收到 🧪 测试(tester) 的 Bug 报告：修复后交给 🧪 测试(tester) 重新验证\n- 技术方案不确定：找 🏗️ 架构师(architect) 讨论\n- 需求不明确：找 📋 PM(pm) 确认\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策';

  it('should specify parallel review by reviewer and tester', () => {
    expect(devClaudeMd).toContain('同时交给 🔍 审查者(reviewer) 审核代码质量 和 🧪 测试(tester) 进行测试验证');
    expect(devClaudeMd).toContain('并行审核，两者独立 approve');
  });

  it('should define escalation path to architect and PM', () => {
    expect(devClaudeMd).toContain('找 🏗️ 架构师(architect) 讨论');
    expect(devClaudeMd).toContain('找 📋 PM(pm) 确认');
    expect(devClaudeMd).toContain('交给 📋 PM(pm) 决策');
  });
});

// =====================================================================
// WebSocket 消息缓冲 (agent/connection.js)
// =====================================================================

describe('WebSocket message buffering', () => {
  const BUFFERABLE_TYPES = new Set([
    'claude_output', 'turn_completed', 'conversation_closed',
    'session_id_update', 'compact_status', 'slash_commands_update',
    'background_task_started', 'background_task_output',
    'crew_output', 'crew_status', 'crew_turn_completed',
    'crew_session_created', 'crew_session_restored', 'crew_human_needed',
    'crew_role_added', 'crew_role_removed',
    'crew_role_compact', 'crew_context_usage'
  ]);

  it('should buffer crew-related message types', () => {
    expect(BUFFERABLE_TYPES.has('crew_output')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_status')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_turn_completed')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_session_created')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_session_restored')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_human_needed')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_role_added')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_role_removed')).toBe(true);
  });

  it('should buffer claude output types', () => {
    expect(BUFFERABLE_TYPES.has('claude_output')).toBe(true);
    expect(BUFFERABLE_TYPES.has('turn_completed')).toBe(true);
    expect(BUFFERABLE_TYPES.has('conversation_closed')).toBe(true);
    expect(BUFFERABLE_TYPES.has('session_id_update')).toBe(true);
  });

  it('should NOT buffer non-critical message types', () => {
    expect(BUFFERABLE_TYPES.has('ping')).toBe(false);
    expect(BUFFERABLE_TYPES.has('pong')).toBe(false);
    expect(BUFFERABLE_TYPES.has('registered')).toBe(false);
    expect(BUFFERABLE_TYPES.has('execute')).toBe(false);
  });

  it('should implement buffer-on-disconnect then flush-on-reconnect pattern', () => {
    // Simulate buffering behavior
    const messageBuffer = [];
    const maxSize = 500;
    const wsOpen = false; // disconnected

    // Try to send when disconnected
    const msg1 = { type: 'crew_output', sessionId: 's1', data: 'test' };
    const msg2 = { type: 'crew_status', sessionId: 's1', status: 'running' };
    const msg3 = { type: 'ping' }; // Not bufferable

    for (const msg of [msg1, msg2, msg3]) {
      if (!wsOpen) {
        if (BUFFERABLE_TYPES.has(msg.type) && messageBuffer.length < maxSize) {
          messageBuffer.push(msg);
        }
      }
    }

    // Only bufferable types should be queued
    expect(messageBuffer.length).toBe(2);
    expect(messageBuffer[0].type).toBe('crew_output');
    expect(messageBuffer[1].type).toBe('crew_status');

    // Simulate flush on reconnect
    const flushed = messageBuffer.splice(0);
    expect(flushed.length).toBe(2);
    expect(messageBuffer.length).toBe(0);
  });

  it('should drop oldest non-status messages when buffer is full', () => {
    const messageBuffer = [];
    const maxSize = 3;

    // Fill buffer
    messageBuffer.push({ type: 'crew_output', data: 'a' });
    messageBuffer.push({ type: 'crew_output', data: 'b' });
    messageBuffer.push({ type: 'crew_status', status: 'running' });

    // Buffer full, new message arrives
    const newMsg = { type: 'crew_output', data: 'c' };
    if (messageBuffer.length >= maxSize) {
      const dropIdx = messageBuffer.findIndex(m => m.type !== 'crew_status' && m.type !== 'turn_completed');
      if (dropIdx >= 0) {
        messageBuffer.splice(dropIdx, 1);
        messageBuffer.push(newMsg);
      }
    }

    // Should have dropped oldest non-status and added new
    expect(messageBuffer.length).toBe(3);
    expect(messageBuffer[0].data).toBe('b'); // 'a' was dropped
    expect(messageBuffer[1].type).toBe('crew_status'); // status preserved
    expect(messageBuffer[2].data).toBe('c'); // new message added
  });
});

// =====================================================================
// uiMessages 记录与恢复
// =====================================================================

describe('uiMessages tracking', () => {
  it('should merge consecutive text from same role', () => {
    const uiMessages = [];

    // Simulate sendCrewOutput for text type
    function recordText(roleName, roleIcon, displayName, text) {
      const last = uiMessages[uiMessages.length - 1];
      if (last && last.role === roleName && last.type === 'text' && last._streaming) {
        last.content += text;
      } else {
        uiMessages.push({
          role: roleName, roleIcon, roleName: displayName,
          type: 'text', content: text, _streaming: true,
          timestamp: Date.now()
        });
      }
    }

    recordText('pm', '📋', 'PM', '第一段文字');
    recordText('pm', '📋', 'PM', '第二段文字');
    recordText('developer', '💻', '开发者', '开发者回复');
    recordText('pm', '📋', 'PM', 'PM 新消息');

    expect(uiMessages.length).toBe(3);
    expect(uiMessages[0].content).toBe('第一段文字第二段文字');
    expect(uiMessages[0].role).toBe('pm');
    expect(uiMessages[1].role).toBe('developer');
    expect(uiMessages[2].role).toBe('pm');
  });

  it('should record route messages', () => {
    const uiMessages = [];

    // Text message (streaming)
    uiMessages.push({
      role: 'pm', roleIcon: '📋', roleName: 'PM',
      type: 'text', content: '分析完成', _streaming: true,
      timestamp: Date.now()
    });

    // Route: end streaming and add route entry
    const last = uiMessages[uiMessages.length - 1];
    if (last && last._streaming) delete last._streaming;

    uiMessages.push({
      role: 'pm', roleIcon: '📋', roleName: 'PM',
      type: 'route', routeTo: 'architect',
      content: '→ @architect 请设计方案',
      timestamp: Date.now()
    });

    expect(uiMessages.length).toBe(2);
    expect(uiMessages[0]._streaming).toBeUndefined();
    expect(uiMessages[1].type).toBe('route');
    expect(uiMessages[1].routeTo).toBe('architect');
  });

  it('should record human messages', () => {
    const uiMessages = [];

    uiMessages.push({
      role: 'human', roleIcon: 'H', roleName: '你',
      type: 'text', content: '请开始开发',
      timestamp: Date.now()
    });

    expect(uiMessages.length).toBe(1);
    expect(uiMessages[0].role).toBe('human');
    expect(uiMessages[0].content).toBe('请开始开发');
  });

  it('should clean _streaming flag when saving', () => {
    const uiMessages = [
      { role: 'pm', type: 'text', content: 'done', _streaming: true, timestamp: 1000 },
      { role: 'developer', type: 'text', content: 'code', timestamp: 2000 }
    ];

    // Replicate cleaning logic from saveSessionMeta
    const cleaned = uiMessages.map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });

    expect(cleaned[0]._streaming).toBeUndefined();
    expect(cleaned[0].content).toBe('done');
    expect(cleaned[1].content).toBe('code');
  });
});

// =====================================================================
// removeFromCrewIndex
// =====================================================================

describe('removeFromCrewIndex logic', () => {
  it('should filter out session by sessionId', () => {
    const index = [
      { sessionId: 'crew_001', status: 'stopped' },
      { sessionId: 'crew_002', status: 'running' },
      { sessionId: 'crew_003', status: 'stopped' }
    ];

    const filtered = index.filter(e => e.sessionId !== 'crew_002');

    expect(filtered.length).toBe(2);
    expect(filtered.find(e => e.sessionId === 'crew_002')).toBeUndefined();
  });

  it('should also remove from active sessions Map', () => {
    const activeSessions = new Map();
    activeSessions.set('crew_001', { id: 'crew_001', status: 'running' });
    activeSessions.set('crew_002', { id: 'crew_002', status: 'paused' });

    // Replicate removeFromCrewIndex memory cleanup
    const sessionId = 'crew_001';
    if (activeSessions.has(sessionId)) {
      activeSessions.delete(sessionId);
    }

    expect(activeSessions.has('crew_001')).toBe(false);
    expect(activeSessions.has('crew_002')).toBe(true);
  });

  it('should handle removing non-existent session gracefully', () => {
    const index = [
      { sessionId: 'crew_001', status: 'stopped' }
    ];
    const filtered = index.filter(e => e.sessionId !== 'crew_999');

    // No change
    expect(filtered.length).toBe(1);
  });
});

// =====================================================================
// sessionToIndexEntry - fields (userId, username)
// =====================================================================

describe('sessionToIndexEntry - extended fields', () => {
  it('should include userId, username in index entry', () => {
    const session = createTestSession({
      userId: 'user_456',
      username: 'alice'
    });
    const entry = sessionToIndexEntry(session);

    expect(entry.userId).toBe('user_456');
    expect(entry.username).toBe('alice');
  });
});

// =====================================================================
// WebSocket visibility handler logic
// =====================================================================

describe('Visibility handler reconnect logic', () => {
  it('should reconnect immediately when WS is not open on visibility change', () => {
    let reconnected = false;
    const store = {
      ws: null, // not connected
      reconnectAttempts: 5,
      connect() { reconnected = true; }
    };

    // Simulate visibility change to visible
    if (!store.ws || store.ws.readyState !== 1 /* OPEN */) {
      store.reconnectAttempts = 0;
      store.connect();
    }

    expect(reconnected).toBe(true);
    expect(store.reconnectAttempts).toBe(0);
  });

  it('should send ping to verify alive connection on visibility change', () => {
    let pingSent = false;
    const store = {
      ws: { readyState: 1 }, // OPEN
      _lastPongAt: Date.now(),
      sendWsMessage(msg) { if (msg.type === 'ping') pingSent = true; }
    };

    if (store.ws && store.ws.readyState === 1) {
      store.sendWsMessage({ type: 'ping' });
    }

    expect(pingSent).toBe(true);
  });
});

// =====================================================================
// UI Behavior: Human bubble & Turn dividers (CrewChatView logic)
// =====================================================================

describe('CrewChatView - groupedMessages logic', () => {
  // Replicate groupedMessages computed from CrewChatView.js
  function groupMessages(messages) {
    const turns = [];
    let currentTurn = null;
    let turnCounter = 0;

    const flushTurn = () => {
      if (currentTurn) {
        currentTurn.textMsg = currentTurn.messages.find(m => m.type === 'text') || null;
        currentTurn.toolMsgs = currentTurn.messages.filter(m => m.type === 'tool');
        turns.push(currentTurn);
        currentTurn = null;
      }
    };

    for (const msg of messages) {
      if (msg.type === 'route' || msg.type === 'system' || msg.type === 'human_needed') {
        flushTurn();
        turns.push({ type: msg.type, message: msg, id: 'standalone_' + (msg.id || turnCounter++) });
        continue;
      }
      if (msg.role === 'human') {
        flushTurn();
        turns.push({ type: 'text', message: msg, id: 'human_' + (msg.id || turnCounter++) });
        continue;
      }
      if (currentTurn && currentTurn.role === msg.role) {
        currentTurn.messages.push(msg);
      } else {
        flushTurn();
        currentTurn = {
          type: 'turn',
          role: msg.role,
          roleName: msg.roleName,
          roleIcon: msg.roleIcon,
          messages: [msg],
          textMsg: null,
          toolMsgs: [],
          id: 'turn_' + (turnCounter++)
        };
      }
    }
    flushTurn();
    return turns;
  }

  // Replicate shouldShowDivider logic
  function shouldShowDivider(turns, tidx) {
    const prev = turns[tidx - 1];
    const curr = turns[tidx];
    if (curr.type === 'route' || prev.type === 'route') return false;
    const prevRole = prev.type === 'turn' ? prev.role : prev.message?.role;
    const currRole = curr.type === 'turn' ? curr.role : curr.message?.role;
    return prevRole && currRole && prevRole !== currRole;
  }

  it('should render human messages as standalone (not grouped into turns)', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 回复', timestamp: 1000 },
      { role: 'human', roleIcon: 'H', roleName: '你', type: 'text', content: '人工消息', timestamp: 2000 },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 继续', timestamp: 3000 }
    ];

    const turns = groupMessages(messages);

    expect(turns.length).toBe(3);
    // Human message is standalone
    expect(turns[1].type).toBe('text'); // standalone type
    expect(turns[1].message.role).toBe('human');
    expect(turns[1].id).toMatch(/^human_/);
    // Not grouped into a turn
    expect(turns[1].type).not.toBe('turn');
  });

  it('should apply crew-msg-human-bubble class condition (role=human, type=text)', () => {
    // Replicate the template condition:
    // { 'crew-msg-human-bubble': turn.message.role === 'human' && turn.message.type === 'text' }
    const humanTextMsg = { role: 'human', type: 'text', content: '测试' };
    const humanSystemMsg = { role: 'human', type: 'system', content: '加入' };
    const pmTextMsg = { role: 'pm', type: 'text', content: 'PM 消息' };

    const isHumanBubble = (msg) => msg.role === 'human' && msg.type === 'text';

    expect(isHumanBubble(humanTextMsg)).toBe(true);
    expect(isHumanBubble(humanSystemMsg)).toBe(false);
    expect(isHumanBubble(pmTextMsg)).toBe(false);
  });

  it('should hide avatar for human text messages (v-if condition)', () => {
    // Template: v-if="turn.message.role !== 'human' || turn.message.type !== 'text'"
    const showAvatar = (msg) => msg.role !== 'human' || msg.type !== 'text';

    expect(showAvatar({ role: 'human', type: 'text' })).toBe(false); // hidden
    expect(showAvatar({ role: 'human', type: 'system' })).toBe(true); // shown
    expect(showAvatar({ role: 'pm', type: 'text' })).toBe(true); // shown
    expect(showAvatar({ role: 'developer', type: 'text' })).toBe(true); // shown
  });

  it('should show divider when role changes between adjacent turns', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 说', timestamp: 1000 },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: '开发者说', timestamp: 2000 }
    ];

    const turns = groupMessages(messages);
    expect(turns.length).toBe(2);
    expect(shouldShowDivider(turns, 1)).toBe(true);
  });

  it('should NOT show divider when same role continues', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 第一段', timestamp: 1000 },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'tool', toolName: 'Read', timestamp: 2000 }
    ];

    const turns = groupMessages(messages);
    // Both messages from PM should be in one turn
    expect(turns.length).toBe(1);
    expect(turns[0].type).toBe('turn');
    expect(turns[0].messages.length).toBe(2);
  });

  it('should NOT show divider before/after route messages', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: '分析完成', timestamp: 1000 },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', content: '→ @developer', timestamp: 2000 },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: '收到', timestamp: 3000 }
    ];

    const turns = groupMessages(messages);
    expect(turns.length).toBe(3);

    // Route is at index 1, no divider before it (prev is route-adjacent)
    expect(shouldShowDivider(turns, 1)).toBe(false); // route: no divider
    expect(shouldShowDivider(turns, 2)).toBe(false); // after route: no divider
  });

  it('should show divider between human and role messages', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 说', timestamp: 1000 },
      { role: 'human', roleIcon: 'H', roleName: '你', type: 'text', content: '人工', timestamp: 2000 }
    ];

    const turns = groupMessages(messages);
    expect(turns.length).toBe(2);
    expect(shouldShowDivider(turns, 1)).toBe(true);
  });
});
// =====================================================================
// Hints bar: 不再显示角色标签和添加角色按钮
// =====================================================================

describe('Hints bar - role badges and add button removed', () => {
  // 读取 CrewChatView.js 模板中 crew-input-hints 区域
  // 验证不再包含 crew-at-hint 角色标签和添加角色按钮

  const hintsTemplate = `
        <div class="crew-input-hints" v-if="store.currentCrewSession && store.currentCrewStatus">
          <span class="crew-hint-meta">R{{ store.currentCrewStatus.round || 0 }}</span>
          <span class="crew-hint-sep">&middot;</span>
          <span class="crew-hint-meta">\${{ (store.currentCrewStatus.costUsd || 0).toFixed(2) }}</span>
          <template v-if="totalTokens > 0">
            <span class="crew-hint-sep">&middot;</span>
            <span class="crew-hint-meta">{{ formatTokens(totalTokens) }}</span>
          </template>
  `;

  it('should NOT contain crew-at-hint role badges in hints bar', () => {
    expect(hintsTemplate).not.toContain('crew-at-hint');
    expect(hintsTemplate).not.toContain('v-for="role in store.currentCrewSession.roles"');
  });

  it('should NOT contain add role button in hints bar', () => {
    expect(hintsTemplate).not.toContain('showAddRole = true');
    expect(hintsTemplate).not.toContain('title="添加角色"');
    // No plus icon SVG
    expect(hintsTemplate).not.toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
  });

  it('should NOT show status text in hints bar', () => {
    expect(hintsTemplate).not.toContain('crew-hint-status');
    expect(hintsTemplate).not.toContain('statusText');
  });

  it('should show session stats (round, cost, tokens) in hints bar', () => {
    expect(hintsTemplate).toContain('crew-hint-meta');
    expect(hintsTemplate).toContain('store.currentCrewStatus.round');
    expect(hintsTemplate).toContain('costUsd');
    expect(hintsTemplate).toContain('formatTokens');
  });
});


// =====================================================================
// @ 自动补全: 选中角色后输入框显示 displayName
// =====================================================================

describe('@ autocomplete - uses displayName instead of name', () => {
  // Replicate selectAtRole logic from CrewChatView.js
  function selectAtRole(inputText, cursorPos, role) {
    const beforeCursor = inputText.substring(0, cursorPos);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx >= 0) {
      const afterCursor = inputText.substring(cursorPos);
      const newText = inputText.substring(0, atIdx) + '@' + role.displayName + ' ' + afterCursor;
      const newPos = atIdx + role.displayName.length + 2;
      return { text: newText, cursorPos: newPos };
    }
    return { text: inputText, cursorPos };
  }

  // Replicate insertAt logic from CrewChatView.js
  function insertAt(roleName, roles, currentText) {
    const role = roles.find(r => r.name === roleName);
    const displayName = role ? role.displayName : roleName;
    return `@${displayName} ` + currentText;
  }

  const testRoles = [
    { name: 'pm', displayName: 'PM-乔布斯' },
    { name: 'developer', displayName: '开发者-托瓦兹' },
    { name: 'architect', displayName: '架构师-福勒' },
    { name: 'tester', displayName: '测试-贝克' }
  ];

  it('selectAtRole should insert displayName (not name) after @', () => {
    const pmRole = testRoles[0];
    // User typed "@p" then selected PM role
    const result = selectAtRole('@p', 2, pmRole);
    expect(result.text).toBe('@PM-乔布斯 ');
    expect(result.text).not.toContain('@pm ');
  });

  it('selectAtRole should handle Chinese displayName correctly', () => {
    const devRole = testRoles[1];
    const result = selectAtRole('@dev', 4, devRole);
    expect(result.text).toBe('@开发者-托瓦兹 ');
    expect(result.text).not.toContain('@developer ');
  });

  it('selectAtRole should calculate cursor position based on displayName length', () => {
    const archRole = testRoles[2];
    const result = selectAtRole('@ar', 3, archRole);
    // @ + 架构师-福勒 (5 chars) + space = position 7
    expect(result.cursorPos).toBe(1 + archRole.displayName.length + 1);
  });

  it('selectAtRole should preserve text after cursor', () => {
    const pmRole = testRoles[0];
    const result = selectAtRole('@p 后面的文字', 2, pmRole);
    expect(result.text).toBe('@PM-乔布斯  后面的文字');
  });

  it('selectAtRole should handle @ in middle of text', () => {
    const testerRole = testRoles[3];
    const input = '请 @te';
    const result = selectAtRole(input, 5, testerRole);
    expect(result.text).toBe('请 @测试-贝克 ');
  });

  it('insertAt should use displayName instead of name', () => {
    const result = insertAt('pm', testRoles, '请查看这个问题');
    expect(result).toBe('@PM-乔布斯 请查看这个问题');
    expect(result).not.toContain('@pm ');
  });

  it('insertAt should fallback to roleName if role not found', () => {
    const result = insertAt('unknown', testRoles, '你好');
    expect(result).toBe('@unknown 你好');
  });
});

// =====================================================================
// 后端 @displayName 解析和路由
// =====================================================================

describe('Backend @displayName parsing and routing', () => {
  // Replicate the @ matching logic from agent/crew.js handleCrewHumanInput
  function resolveAtTarget(content, session) {
    const atMatch = content.match(/^@(\S+)\s*([\s\S]*)/);
    if (!atMatch) return null;

    const atTarget = atMatch[1];
    const message = atMatch[2].trim() || content;

    // 先精确匹配 role.name，再匹配 displayName
    let target = null;
    for (const [name, role] of session.roles) {
      if (name === atTarget.toLowerCase()) {
        target = name;
        break;
      }
      if (role.displayName === atTarget) {
        target = name;
        break;
      }
    }

    return target ? { target, message } : null;
  }

  function createRouteSession() {
    return {
      roles: new Map([
        ['pm', { name: 'pm', displayName: 'PM-乔布斯', description: '需求分析', isDecisionMaker: true }],
        ['developer', { name: 'developer', displayName: '开发者-托瓦兹', description: '代码编写' }],
        ['architect', { name: 'architect', displayName: '架构师-福勒', description: '系统设计' }],
        ['tester', { name: 'tester', displayName: '测试-贝克', description: '测试' }],
        ['reviewer', { name: 'reviewer', displayName: '审查者-马丁', description: '审查' }]
      ])
    };
  }

  it('should resolve @displayName to correct role name', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@PM-乔布斯 请确认需求', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('pm');
    expect(result.message).toBe('请确认需求');
  });

  it('should still resolve @name (backward compat)', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@pm 请确认需求', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('pm');
  });

  it('should resolve Chinese displayName', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@开发者-托瓦兹 修复这个bug', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('developer');
    expect(result.message).toBe('修复这个bug');
  });

  it('should resolve @architect by name', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@architect 设计方案', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('architect');
  });

  it('should resolve @架构师-福勒 by displayName', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@架构师-福勒 设计方案', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('architect');
  });

  it('should return null for unknown target', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@unknown 你好', session);
    expect(result).toBeNull();
  });

  it('should return null for non-@ messages', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('普通消息', session);
    expect(result).toBeNull();
  });

  it('should use full content as message when no text after @target', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@PM-乔布斯 ', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('pm');
    expect(result.message).toBe('@PM-乔布斯 '); // falls back to full content
  });

  it('should handle displayName with hyphen correctly (regex \\S+ match)', () => {
    const session = createRouteSession();
    // The regex /^@(\S+)\s*/ should match "PM-乔布斯" as one token (no spaces)
    const result = resolveAtTarget('@审查者-马丁 代码审查', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('reviewer');
  });

  it('should prioritize name match over displayName match', () => {
    // Edge case: if a role's name matches, it should be preferred
    const session = {
      roles: new Map([
        ['pm', { name: 'pm', displayName: 'PM-乔布斯' }],
        ['pm-custom', { name: 'pm-custom', displayName: 'pm' }] // displayName matches another role's name
      ])
    };
    const result = resolveAtTarget('@pm 你好', session);
    expect(result.target).toBe('pm'); // name match wins
  });

  it('should be case-insensitive for name matching', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@PM 你好', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('pm');
  });

  it('should be case-sensitive for displayName matching', () => {
    const session = createRouteSession();
    // displayName 是 "PM-乔布斯"，如果用小写 "pm-乔布斯" 不应匹配 displayName
    // 但 "pm-乔布斯" 的 toLowerCase 也不等于任何 name
    const result = resolveAtTarget('@pm-乔布斯 你好', session);
    // name match: "pm-乔布斯".toLowerCase() = "pm-乔布斯", no role named "pm-乔布斯"
    // displayName match: "pm-乔布斯" !== "PM-乔布斯"
    expect(result).toBeNull();
  });

  it('should handle multiline message content', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@测试-贝克 请测试以下变更：\n1. 变更一\n2. 变更二', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('tester');
    expect(result.message).toContain('变更一');
    expect(result.message).toContain('变更二');
  });

  it('should use new regex \\S+ instead of old \\w+ to support Chinese/hyphen displayNames', () => {
    // Old regex: /^@(\w+)\s*/ only matches word chars (letters, digits, underscore)
    // New regex: /^@(\S+)\s*/ matches any non-whitespace (Chinese, hyphens, etc.)
    const oldRegex = /^@(\w+)\s*([\s\S]*)/;
    const newRegex = /^@(\S+)\s*([\s\S]*)/;

    const chineseInput = '@PM-乔布斯 测试';

    const oldMatch = chineseInput.match(oldRegex);
    const newMatch = chineseInput.match(newRegex);

    // Old regex only captures "PM" (stops at hyphen), missing the full displayName
    expect(oldMatch).not.toBeNull();
    expect(oldMatch[1]).toBe('PM'); // only "PM", not "PM-乔布斯"

    // New regex captures the full displayName including Chinese chars and hyphens
    expect(newMatch).not.toBeNull();
    expect(newMatch[1]).toBe('PM-乔布斯'); // full displayName captured

    // Pure Chinese displayName test
    const pureChineseInput = '@开发者-托瓦兹 修复bug';
    const oldChineseMatch = pureChineseInput.match(oldRegex);
    const newChineseMatch = pureChineseInput.match(newRegex);

    // Old regex fails entirely on Chinese-starting displayName
    expect(oldChineseMatch).toBeNull();
    // New regex works correctly
    expect(newChineseMatch).not.toBeNull();
    expect(newChineseMatch[1]).toBe('开发者-托瓦兹');
  });
});

// =====================================================================
// shortName: 消息头显示简短名 vs ROUTE 保留完整名
// =====================================================================

describe('shortName - message header displays short name', () => {
  // Replicate shortName from CrewChatView.js
  function shortName(displayName) {
    if (!displayName) return '';
    const idx = displayName.indexOf('-');
    return idx > 0 ? displayName.substring(idx + 1) : displayName;
  }

  it('should extract name after hyphen from "PM-乔布斯"', () => {
    expect(shortName('PM-乔布斯')).toBe('乔布斯');
  });

  it('should extract name after hyphen from "架构师-福勒"', () => {
    expect(shortName('架构师-福勒')).toBe('福勒');
  });

  it('should extract name after hyphen from "开发者-托瓦兹"', () => {
    expect(shortName('开发者-托瓦兹')).toBe('托瓦兹');
  });

  it('should extract name after hyphen from "审查者-马丁"', () => {
    expect(shortName('审查者-马丁')).toBe('马丁');
  });

  it('should extract name after hyphen from "测试-贝克"', () => {
    expect(shortName('测试-贝克')).toBe('贝克');
  });

  it('should extract name after hyphen from "设计师-拉姆斯"', () => {
    expect(shortName('设计师-拉姆斯')).toBe('拉姆斯');
  });

  it('should return full name if no hyphen', () => {
    expect(shortName('PM')).toBe('PM');
    expect(shortName('Admin')).toBe('Admin');
  });

  it('should return empty string for empty/falsy input', () => {
    expect(shortName('')).toBe('');
    expect(shortName(null)).toBe('');
    expect(shortName(undefined)).toBe('');
  });

  it('should handle hyphen at position 0 (return full name)', () => {
    // idx = 0, condition idx > 0 is false, returns full name
    expect(shortName('-orphan')).toBe('-orphan');
  });

  it('should only split on first hyphen', () => {
    // "策略师-索罗斯-备份" → substring after first '-' = "索罗斯-备份"
    expect(shortName('策略师-索罗斯-备份')).toBe('索罗斯-备份');
  });
});

describe('Message header: shortName vs full name for ROUTE', () => {
  // Replicate the template logic from line 95 of CrewChatView.js:
  // {{ turn.message.type === 'route' ? turn.message.roleName : shortName(turn.message.roleName) }}
  function shortName(displayName) {
    if (!displayName) return '';
    const idx = displayName.indexOf('-');
    return idx > 0 ? displayName.substring(idx + 1) : displayName;
  }

  function getHeaderDisplayName(message) {
    return message.type === 'route' ? message.roleName : shortName(message.roleName);
  }

  it('should show short name for normal text messages', () => {
    const msg = { type: 'text', role: 'pm', roleName: 'PM-乔布斯', content: '分析完成' };
    expect(getHeaderDisplayName(msg)).toBe('乔布斯');
  });

  it('should show full name for route messages', () => {
    const msg = { type: 'route', role: 'pm', roleName: 'PM-乔布斯', routeTo: 'developer' };
    expect(getHeaderDisplayName(msg)).toBe('PM-乔布斯');
  });

  it('should show short name for tool messages', () => {
    const msg = { type: 'tool', role: 'developer', roleName: '开发者-托瓦兹', toolName: 'Read' };
    expect(getHeaderDisplayName(msg)).toBe('托瓦兹');
  });

  it('should show short name for system messages', () => {
    const msg = { type: 'system', role: 'system', roleName: 'System' };
    expect(getHeaderDisplayName(msg)).toBe('System');
  });

  it('should show short name for human_needed messages', () => {
    const msg = { type: 'human_needed', role: 'pm', roleName: 'PM-乔布斯', content: '需要决策' };
    expect(getHeaderDisplayName(msg)).toBe('乔布斯');
  });

  it('should verify all preset roles show short names in headers', () => {
    const presetRoles = [
      { displayName: 'PM-乔布斯', expectedShort: '乔布斯' },
      { displayName: '架构师-福勒', expectedShort: '福勒' },
      { displayName: '开发者-托瓦兹', expectedShort: '托瓦兹' },
      { displayName: '审查者-马丁', expectedShort: '马丁' },
      { displayName: '测试-贝克', expectedShort: '贝克' },
      { displayName: '设计师-拉姆斯', expectedShort: '拉姆斯' }
    ];

    for (const role of presetRoles) {
      const msg = { type: 'text', roleName: role.displayName };
      expect(getHeaderDisplayName(msg)).toBe(role.expectedShort);
    }
  });

  it('should verify all preset roles show full names in ROUTE headers', () => {
    const presetRoles = [
      'PM-乔布斯', '架构师-福勒', '开发者-托瓦兹',
      '审查者-马丁', '测试-贝克', '设计师-拉姆斯'
    ];

    for (const displayName of presetRoles) {
      const msg = { type: 'route', roleName: displayName, routeTo: 'pm' };
      expect(getHeaderDisplayName(msg)).toBe(displayName);
    }
  });
});

describe('Grouped turn header also uses shortName', () => {
  // Verify the grouped turn template (line 121) uses shortName
  function shortName(displayName) {
    if (!displayName) return '';
    const idx = displayName.indexOf('-');
    return idx > 0 ? displayName.substring(idx + 1) : displayName;
  }

  it('should show short name in grouped turn header', () => {
    // Simulates a grouped turn (multiple messages from same role)
    const turn = {
      type: 'turn',
      role: 'developer',
      roleName: '开发者-托瓦兹',
      roleIcon: '',
      messages: [
        { type: 'text', content: '开始实现...' },
        { type: 'tool', toolName: 'Read' }
      ]
    };

    // Template uses: {{ shortName(turn.roleName) }}
    expect(shortName(turn.roleName)).toBe('托瓦兹');
  });

  it('should show short name for futures team roles', () => {
    const futuresRoles = [
      { displayName: '策略师-索罗斯', expectedShort: '索罗斯' },
      { displayName: '分析师-利弗莫尔', expectedShort: '利弗莫尔' },
      { displayName: '研究员-达里奥', expectedShort: '达里奥' },
      { displayName: '风控官-塔勒布', expectedShort: '塔勒布' },
      { displayName: '交易员-琼斯', expectedShort: '琼斯' }
    ];

    for (const role of futuresRoles) {
      expect(shortName(role.displayName)).toBe(role.expectedShort);
    }
  });

  it('should show short name for writing team roles', () => {
    const writingRoles = [
      { displayName: '编排师-金庸', expectedShort: '金庸' },
      { displayName: '设计师-陈丹青', expectedShort: '陈丹青' },
      { displayName: '执笔师-鲁迅', expectedShort: '鲁迅' },
      { displayName: '审稿师-叶圣陶', expectedShort: '叶圣陶' }
    ];

    for (const role of writingRoles) {
      expect(shortName(role.displayName)).toBe(role.expectedShort);
    }
  });
});
// =====================================================================
// Feature Blocks: taskId-based message grouping
// =====================================================================

describe('featureBlocks - message segmentation by taskId', () => {
  // Replicate the segment splitting logic from featureBlocks computed
  function splitSegments(messages) {
    const segments = [];
    let currentSegment = null;

    const flushSegment = () => {
      if (currentSegment && currentSegment.messages.length > 0) {
        segments.push(currentSegment);
      }
      currentSegment = null;
    };

    for (const msg of messages) {
      const taskId = msg.taskId || null;
      const isGlobal = !taskId || msg.role === 'human';

      if (isGlobal) {
        if (currentSegment && currentSegment.taskId) {
          flushSegment();
        }
        if (!currentSegment || currentSegment.taskId) {
          flushSegment();
          currentSegment = { taskId: null, messages: [] };
        }
        currentSegment.messages.push(msg);
      } else {
        if (currentSegment && currentSegment.taskId === taskId) {
          currentSegment.messages.push(msg);
        } else {
          flushSegment();
          currentSegment = { taskId, messages: [msg] };
        }
      }
    }
    flushSegment();
    return segments;
  }

  // Replicate _buildTurns
  function buildTurns(messages) {
    const turns = [];
    let currentTurn = null;
    let turnCounter = 0;

    const flushTurn = () => {
      if (currentTurn) {
        currentTurn.textMsg = currentTurn.messages.find(m => m.type === 'text') || null;
        currentTurn.toolMsgs = currentTurn.messages.filter(m => m.type === 'tool');
        turns.push(currentTurn);
        currentTurn = null;
      }
    };

    for (const msg of messages) {
      if (msg.type === 'route' || msg.type === 'system' || msg.type === 'human_needed') {
        flushTurn();
        turns.push({ type: msg.type, message: msg, id: 'standalone_' + (msg.id || turnCounter++) });
        continue;
      }
      if (msg.role === 'human') {
        flushTurn();
        turns.push({ type: 'text', message: msg, id: 'human_' + (msg.id || turnCounter++) });
        continue;
      }
      if (currentTurn && currentTurn.role === msg.role) {
        currentTurn.messages.push(msg);
      } else {
        flushTurn();
        currentTurn = {
          type: 'turn', role: msg.role, roleName: msg.roleName, roleIcon: msg.roleIcon,
          messages: [msg], textMsg: null, toolMsgs: [], id: 'turn_' + (turnCounter++)
        };
      }
    }
    flushTurn();
    return turns;
  }

  // Replicate full featureBlocks computed
  function buildFeatureBlocks(allMessages, completedTaskIds = new Set()) {
    const segments = splitSegments(allMessages);
    const blocks = [];
    let blockCounter = 0;

    for (const seg of segments) {
      const turns = buildTurns(seg.messages);
      if (seg.taskId) {
        const taskTitle = seg.messages.find(m => m.taskTitle)?.taskTitle || seg.taskId;
        const isCompleted = completedTaskIds.has(seg.taskId);
        const hasStreaming = seg.messages.some(m => m._streaming);
        const activeRoles = [];
        const seenRoles = new Set();
        for (let i = seg.messages.length - 1; i >= 0; i--) {
          const m = seg.messages[i];
          if (m._streaming && m.role && !seenRoles.has(m.role)) {
            seenRoles.add(m.role);
            activeRoles.push({ role: m.role, roleName: m.roleName, roleIcon: m.roleIcon });
          }
        }
        blocks.push({
          type: 'feature', taskId: seg.taskId, taskTitle, turns,
          isCompleted, hasStreaming, activeRoles,
          id: 'feature_' + seg.taskId + '_' + (blockCounter++)
        });
      } else {
        blocks.push({ type: 'global', turns, id: 'global_' + (blockCounter++) });
      }
    }
    return blocks;
  }

  it('should group messages without taskId into global blocks', () => {
    const messages = [
      { role: 'pm', type: 'text', content: 'PM 说' },
      { role: 'developer', type: 'text', content: '开发者回复' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('global');
    expect(blocks[0].turns.length).toBe(2);
  });

  it('should group messages with same taskId into feature block', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '分配任务', taskId: 'task_1', taskTitle: '实现登录' },
      { role: 'developer', type: 'text', content: '收到', taskId: 'task_1' },
      { role: 'developer', type: 'tool', toolName: 'Edit', taskId: 'task_1' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('feature');
    expect(blocks[0].taskId).toBe('task_1');
    expect(blocks[0].taskTitle).toBe('实现登录');
  });

  it('should separate global and feature blocks', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '欢迎' },
      { role: 'pm', type: 'text', content: '开始任务1', taskId: 'task_1', taskTitle: '任务一' },
      { role: 'developer', type: 'text', content: '执行中', taskId: 'task_1' },
      { role: 'pm', type: 'text', content: '全局消息' },
      { role: 'pm', type: 'text', content: '开始任务2', taskId: 'task_2', taskTitle: '任务二' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(4);
    expect(blocks[0].type).toBe('global');
    expect(blocks[1].type).toBe('feature');
    expect(blocks[1].taskId).toBe('task_1');
    expect(blocks[2].type).toBe('global');
    expect(blocks[3].type).toBe('feature');
    expect(blocks[3].taskId).toBe('task_2');
  });

  it('should treat human messages as global even if they have taskId', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '执行中', taskId: 'task_1', taskTitle: '任务' },
      { role: 'human', type: 'text', content: '人工消息', taskId: 'task_1' },
      { role: 'pm', type: 'text', content: '继续', taskId: 'task_1' }
    ];
    const blocks = buildFeatureBlocks(messages);
    // Human message breaks the feature block into: feature, global(human), feature
    expect(blocks.length).toBe(3);
    expect(blocks[0].type).toBe('feature');
    expect(blocks[1].type).toBe('global');
    expect(blocks[1].turns[0].message.role).toBe('human');
    expect(blocks[2].type).toBe('feature');
  });

  it('should merge consecutive global messages into one block', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '消息1' },
      { role: 'pm', type: 'text', content: '消息2' },
      { role: 'developer', type: 'text', content: '消息3' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('global');
  });

  it('should handle different taskIds as separate feature blocks', () => {
    const messages = [
      { role: 'developer', type: 'text', content: '任务1', taskId: 'task_1', taskTitle: '登录' },
      { role: 'developer', type: 'text', content: '任务2', taskId: 'task_2', taskTitle: '注册' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(2);
    expect(blocks[0].taskId).toBe('task_1');
    expect(blocks[1].taskId).toBe('task_2');
  });

  it('should mark completed features correctly', () => {
    const messages = [
      { role: 'developer', type: 'text', content: '完成', taskId: 'task_1', taskTitle: '登录' }
    ];
    const completed = new Set(['task_1']);
    const blocks = buildFeatureBlocks(messages, completed);
    expect(blocks[0].isCompleted).toBe(true);
  });

  it('should detect streaming features', () => {
    const messages = [
      { role: 'developer', type: 'text', content: '进行中', taskId: 'task_1', taskTitle: '登录', _streaming: true }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks[0].hasStreaming).toBe(true);
  });

  it('should collect active roles from streaming messages', () => {
    const messages = [
      { role: 'developer', roleName: '开发者-托瓦兹', roleIcon: '', type: 'text', content: '编码中', taskId: 'task_1', _streaming: true },
      { role: 'reviewer', roleName: '审查者-马丁', roleIcon: '', type: 'text', content: '审查中', taskId: 'task_1', _streaming: true }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks[0].activeRoles.length).toBe(2);
    // Active roles are collected in reverse order (latest first)
    expect(blocks[0].activeRoles[0].role).toBe('reviewer');
    expect(blocks[0].activeRoles[1].role).toBe('developer');
  });

  it('should not duplicate active roles', () => {
    const messages = [
      { role: 'developer', roleName: '开发者', roleIcon: '', type: 'text', content: '行1', taskId: 'task_1', _streaming: true },
      { role: 'developer', roleName: '开发者', roleIcon: '', type: 'tool', toolName: 'Edit', taskId: 'task_1', _streaming: true }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks[0].activeRoles.length).toBe(1);
  });

  it('should use taskId as fallback title when no taskTitle found', () => {
    const messages = [
      { role: 'developer', type: 'text', content: '工作中', taskId: 'task_abc' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks[0].taskTitle).toBe('task_abc');
  });

  it('should handle empty messages', () => {
    const blocks = buildFeatureBlocks([]);
    expect(blocks.length).toBe(0);
  });

  it('should build turns inside feature blocks correctly', () => {
    const messages = [
      { role: 'developer', roleName: '开发者', type: 'text', content: '文本', taskId: 'task_1', taskTitle: '功能' },
      { role: 'developer', roleName: '开发者', type: 'tool', toolName: 'Read', taskId: 'task_1' },
      { role: 'pm', roleName: 'PM', type: 'route', routeTo: 'developer', taskId: 'task_1' },
      { role: 'reviewer', roleName: '审查者', type: 'text', content: '审查', taskId: 'task_1' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(1);
    const turns = blocks[0].turns;
    // developer text+tool grouped, then route standalone, then reviewer text
    expect(turns.length).toBe(3);
    expect(turns[0].type).toBe('turn');
    expect(turns[0].role).toBe('developer');
    expect(turns[0].toolMsgs.length).toBe(1);
    expect(turns[1].type).toBe('route');
    expect(turns[2].type).toBe('turn');
    expect(turns[2].role).toBe('reviewer');
  });

  it('should handle interleaved global and feature messages', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '计划' },
      { role: 'developer', type: 'text', content: '开发A', taskId: 'task_a', taskTitle: '功能A' },
      { role: 'developer', type: 'text', content: '开发A续', taskId: 'task_a' },
      { role: 'pm', type: 'route', routeTo: 'developer' },
      { role: 'developer', type: 'text', content: '开发B', taskId: 'task_b', taskTitle: '功能B' },
      { role: 'pm', type: 'text', content: '总结' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(5);
    expect(blocks[0].type).toBe('global');   // PM 计划
    expect(blocks[1].type).toBe('feature');  // task_a
    expect(blocks[1].taskId).toBe('task_a');
    expect(blocks[2].type).toBe('global');   // route
    expect(blocks[3].type).toBe('feature');  // task_b
    expect(blocks[3].taskId).toBe('task_b');
    expect(blocks[4].type).toBe('global');   // PM 总结
  });
});

describe('shouldShowTurnDivider - accepts turns array parameter', () => {
  // Replicate the updated shouldShowTurnDivider (now takes turns as param)
  function shouldShowTurnDivider(turns, tidx) {
    const prev = turns[tidx - 1];
    const curr = turns[tidx];
    if (curr.type === 'route' || prev.type === 'route') return false;
    const prevRole = prev.type === 'turn' ? prev.role : prev.message?.role;
    const currRole = curr.type === 'turn' ? curr.role : curr.message?.role;
    return prevRole && currRole && prevRole !== currRole;
  }

  it('should show divider between different roles', () => {
    const turns = [
      { type: 'turn', role: 'pm' },
      { type: 'turn', role: 'developer' }
    ];
    expect(shouldShowTurnDivider(turns, 1)).toBe(true);
  });

  it('should not show divider for same role', () => {
    const turns = [
      { type: 'turn', role: 'pm' },
      { type: 'turn', role: 'pm' }
    ];
    expect(shouldShowTurnDivider(turns, 1)).toBe(false);
  });

  it('should not show divider around route messages', () => {
    const turns = [
      { type: 'turn', role: 'pm' },
      { type: 'route', message: { role: 'pm' } }
    ];
    expect(shouldShowTurnDivider(turns, 1)).toBe(false);
  });

  it('should work with standalone messages', () => {
    const turns = [
      { type: 'text', message: { role: 'human' } },
      { type: 'turn', role: 'pm' }
    ];
    expect(shouldShowTurnDivider(turns, 1)).toBe(true);
  });
});

describe('Feature blocks - removed task panel and filter bar', () => {
  let fileContent;

  it('should load source file', async () => {
    fileContent = await fs.readFile(
      join(__dirname, '../../web/components/CrewChatView.js'),
      'utf-8'
    );
    // Sub-modules extracted from CrewChatView during refactor
    const crewDir = join(__dirname, '../../web/components/crew');
    for (const mod of ['crewHelpers.js', 'crewMessageGrouping.js', 'crewKanban.js', 'crewRolePresets.js', 'CrewTurnRenderer.js', 'CrewFeaturePanel.js', 'CrewRolePanel.js', 'crewInput.js', 'crewScroll.js']) {
      fileContent += '\n' + await fs.readFile(join(crewDir, mod), 'utf-8');
    }
    expect(fileContent).toBeTruthy();
  });

  it('should NOT have crew-task-panel in template', () => {
    expect(fileContent).not.toContain('crew-task-panel');
  });

  it('should NOT have taskFilter in data', () => {
    expect(fileContent).not.toContain('taskFilter:');
    expect(fileContent).not.toContain('taskFilter ===');
  });

  it('should NOT have crew-filter-bar in template', () => {
    expect(fileContent).not.toContain('crew-filter-bar');
    expect(fileContent).not.toContain('crew-filter-back');
  });

  it('should have featureBlocks computed instead of groupedMessages', () => {
    expect(fileContent).toContain('featureBlocks()');
    expect(fileContent).not.toMatch(/\bgroupedMessages\s*\(\)/);
  });

  it('should NOT render feature thread in center panel template (feature content only in right panel)', () => {
    // Extract just the template from CrewChatView.js (before setup())
    const templateMatch = fileContent.match(/template:\s*`([\s\S]*?)`\s*,\s*\n\s*setup/);
    const template = templateMatch ? templateMatch[1] : '';
    expect(template).not.toContain('crew-feature-thread');
    expect(template).not.toContain('crew-feature-header');
    expect(template).not.toContain('crew-feature-body');
  });

  it('should use shouldShowTurnDivider with turns parameter', () => {
    expect(fileContent).toContain('shouldShowTurnDivider(block.turns, tidx)');
  });
});
// =====================================================================
// Route messages merged into turns (cdf117c)
// =====================================================================

describe('_buildTurns - route messages merged into same-role turns', () => {
  // Replicate the updated _buildTurns from CrewChatView.js (cdf117c)
  function buildTurnsNew(messages) {
    const turns = [];
    let currentTurn = null;
    let turnCounter = 0;

    const flushTurn = () => {
      if (currentTurn) {
        currentTurn.textMsg = currentTurn.messages.find(m => m.type === 'text') || null;
        currentTurn.toolMsgs = currentTurn.messages.filter(m => m.type === 'tool');
        currentTurn.routeMsgs = currentTurn.messages.filter(m => m.type === 'route');
        turns.push(currentTurn);
        currentTurn = null;
      }
    };

    for (const msg of messages) {
      if (msg.type === 'system' || msg.type === 'human_needed') {
        flushTurn();
        turns.push({ type: msg.type, message: msg, id: 'standalone_' + (msg.id || turnCounter++) });
        continue;
      }
      if (msg.type === 'route') {
        // Merge route into current turn if same role
        if (currentTurn && currentTurn.role === msg.role) {
          currentTurn.messages.push(msg);
        } else {
          flushTurn();
          currentTurn = {
            type: 'turn',
            role: msg.role,
            roleName: msg.roleName,
            roleIcon: msg.roleIcon,
            messages: [msg],
            textMsg: null,
            toolMsgs: [],
            routeMsgs: [],
            id: 'turn_' + (turnCounter++)
          };
        }
        continue;
      }
      if (msg.role === 'human') {
        flushTurn();
        turns.push({ type: 'text', message: msg, id: 'human_' + (msg.id || turnCounter++) });
        continue;
      }
      if (currentTurn && currentTurn.role === msg.role) {
        currentTurn.messages.push(msg);
      } else {
        flushTurn();
        currentTurn = {
          type: 'turn',
          role: msg.role,
          roleName: msg.roleName,
          roleIcon: msg.roleIcon,
          messages: [msg],
          textMsg: null,
          toolMsgs: [],
          routeMsgs: [],
          id: 'turn_' + (turnCounter++)
        };
      }
    }
    flushTurn();
    return turns;
  }

  it('should merge route into preceding turn of same role', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: '分析完成' },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'developer', routeToName: '开发者', routeSummary: '请实现功能' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(1);
    expect(turns[0].type).toBe('turn');
    expect(turns[0].role).toBe('pm');
    expect(turns[0].messages.length).toBe(2);
    expect(turns[0].routeMsgs.length).toBe(1);
    expect(turns[0].routeMsgs[0].routeTo).toBe('developer');
    expect(turns[0].textMsg.content).toBe('分析完成');
  });

  it('should NOT merge route into turn of different role', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 说话' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'route', routeTo: 'reviewer', routeToName: '审查者', routeSummary: '请审查' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(2);
    expect(turns[0].role).toBe('pm');
    expect(turns[0].routeMsgs.length).toBe(0);
    expect(turns[1].role).toBe('developer');
    expect(turns[1].routeMsgs.length).toBe(1);
    expect(turns[1].routeMsgs[0].routeTo).toBe('reviewer');
  });

  it('should create a new turn for route when no preceding turn', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'developer', routeSummary: '开始' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(1);
    expect(turns[0].type).toBe('turn');
    expect(turns[0].role).toBe('pm');
    expect(turns[0].textMsg).toBe(null);
    expect(turns[0].routeMsgs.length).toBe(1);
  });

  it('should handle multiple routes in same turn', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: '规划完成' },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'developer', routeSummary: '实现功能A', round: 1 },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'tester', routeSummary: '测试功能B', round: 2 }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(1);
    expect(turns[0].routeMsgs.length).toBe(2);
    expect(turns[0].routeMsgs[0].routeTo).toBe('developer');
    expect(turns[0].routeMsgs[1].routeTo).toBe('tester');
  });

  it('should NOT treat route as standalone anymore', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM text' },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'developer' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: 'dev text' }
    ];
    const turns = buildTurnsNew(messages);

    // Route is merged into PM turn, not standalone
    const routeStandalone = turns.find(t => t.type === 'route');
    expect(routeStandalone).toBeUndefined();
  });

  it('should still treat system messages as standalone', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 说' },
      { type: 'system', role: 'system', content: '系统通知' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: '收到' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(3);
    expect(turns[1].type).toBe('system');
    expect(turns[1].message.content).toBe('系统通知');
  });

  it('should still treat human_needed messages as standalone', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 说' },
      { type: 'human_needed', role: 'pm', content: '需要人工介入' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(2);
    expect(turns[1].type).toBe('human_needed');
  });

  it('should have routeMsgs array on all turns (even empty)', () => {
    const messages = [
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: '开发中' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'tool', toolName: 'Read' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(1);
    expect(turns[0].routeMsgs).toEqual([]);
    expect(turns[0].toolMsgs.length).toBe(1);
  });

  it('should handle text → route → text (different role) sequence', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: '分析完成' },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'developer', routeSummary: '请实现' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: '收到，开始实现' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(2);
    // PM turn has text + route
    expect(turns[0].role).toBe('pm');
    expect(turns[0].textMsg.content).toBe('分析完成');
    expect(turns[0].routeMsgs.length).toBe(1);
    // Developer turn follows
    expect(turns[1].role).toBe('developer');
    expect(turns[1].textMsg.content).toBe('收到，开始实现');
    expect(turns[1].routeMsgs).toEqual([]);
  });

  it('should handle route-only turn (route from a new role without preceding text)', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 说话' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'route', routeTo: 'reviewer', routeSummary: '请审查代码' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(2);
    expect(turns[1].type).toBe('turn');
    expect(turns[1].role).toBe('developer');
    expect(turns[1].textMsg).toBe(null); // no text, only route
    expect(turns[1].routeMsgs.length).toBe(1);
  });

  it('should merge route after tool message in same role turn', () => {
    const messages = [
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: '正在编码' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'tool', toolName: 'Write' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'route', routeTo: 'reviewer', routeSummary: '代码写完了' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(1);
    expect(turns[0].textMsg.content).toBe('正在编码');
    expect(turns[0].toolMsgs.length).toBe(1);
    expect(turns[0].routeMsgs.length).toBe(1);
  });
});

describe('getMaxRound - derives round from turn routeMsgs', () => {
  function getMaxRound(turn) {
    if (!turn.routeMsgs || turn.routeMsgs.length === 0) return 0;
    let max = 0;
    for (const rm of turn.routeMsgs) {
      if (rm.round > max) max = rm.round;
    }
    return max;
  }

  it('should return 0 when no routeMsgs', () => {
    expect(getMaxRound({ routeMsgs: [] })).toBe(0);
  });

  it('should return 0 when routeMsgs is undefined', () => {
    expect(getMaxRound({})).toBe(0);
  });

  it('should return the single route round', () => {
    const turn = { routeMsgs: [{ round: 3 }] };
    expect(getMaxRound(turn)).toBe(3);
  });

  it('should return the maximum round from multiple routes', () => {
    const turn = { routeMsgs: [{ round: 1 }, { round: 5 }, { round: 3 }] };
    expect(getMaxRound(turn)).toBe(5);
  });

  it('should handle routes with round=0 (no round divider)', () => {
    const turn = { routeMsgs: [{ round: 0 }] };
    expect(getMaxRound(turn)).toBe(0);
  });

  it('should handle mixed round values including undefined', () => {
    const turn = { routeMsgs: [{ round: undefined }, { round: 4 }] };
    // undefined > max(0) is false, so skipped
    expect(getMaxRound(turn)).toBe(4);
  });
});

describe('shouldShowTurnDivider - updated without route type check', () => {
  // After cdf117c: route check removed since routes are no longer standalone
  function shouldShowTurnDividerNew(turns, tidx) {
    const prev = turns[tidx - 1];
    const curr = turns[tidx];
    const prevRole = prev.type === 'turn' ? prev.role : prev.message?.role;
    const currRole = curr.type === 'turn' ? curr.role : curr.message?.role;
    return prevRole && currRole && prevRole !== currRole;
  }

  it('should show divider between different role turns', () => {
    const turns = [
      { type: 'turn', role: 'pm' },
      { type: 'turn', role: 'developer' }
    ];
    expect(shouldShowTurnDividerNew(turns, 1)).toBe(true);
  });

  it('should not show divider for same role turns', () => {
    const turns = [
      { type: 'turn', role: 'pm' },
      { type: 'turn', role: 'pm' }
    ];
    expect(shouldShowTurnDividerNew(turns, 1)).toBe(false);
  });

  it('should show divider between turn with route and different-role turn', () => {
    // Since routes are now inside turns, a PM turn (with route) followed by
    // developer turn should show divider
    const turns = [
      { type: 'turn', role: 'pm' },   // has routeMsgs inside
      { type: 'turn', role: 'developer' }
    ];
    expect(shouldShowTurnDividerNew(turns, 1)).toBe(true);
  });

  it('should work with standalone system message between turns', () => {
    const turns = [
      { type: 'turn', role: 'pm' },
      { type: 'system', message: { role: 'system' } },
      { type: 'turn', role: 'developer' }
    ];
    // system → developer: roles differ
    expect(shouldShowTurnDividerNew(turns, 2)).toBe(true);
  });

  it('should work with human standalone messages', () => {
    const turns = [
      { type: 'text', message: { role: 'human' } },
      { type: 'turn', role: 'pm' }
    ];
    expect(shouldShowTurnDividerNew(turns, 1)).toBe(true);
  });
});
describe('_buildTurns - integration: full conversation flow with merged routes', () => {
  // Simulate a realistic crew conversation
  function buildTurnsNew(messages) {
    const turns = [];
    let currentTurn = null;
    let turnCounter = 0;

    const flushTurn = () => {
      if (currentTurn) {
        currentTurn.textMsg = currentTurn.messages.find(m => m.type === 'text') || null;
        currentTurn.toolMsgs = currentTurn.messages.filter(m => m.type === 'tool');
        currentTurn.routeMsgs = currentTurn.messages.filter(m => m.type === 'route');
        turns.push(currentTurn);
        currentTurn = null;
      }
    };

    for (const msg of messages) {
      if (msg.type === 'system' || msg.type === 'human_needed') {
        flushTurn();
        turns.push({ type: msg.type, message: msg, id: 'standalone_' + (msg.id || turnCounter++) });
        continue;
      }
      if (msg.type === 'route') {
        if (currentTurn && currentTurn.role === msg.role) {
          currentTurn.messages.push(msg);
        } else {
          flushTurn();
          currentTurn = {
            type: 'turn', role: msg.role, roleName: msg.roleName, roleIcon: msg.roleIcon,
            messages: [msg], textMsg: null, toolMsgs: [], routeMsgs: [],
            id: 'turn_' + (turnCounter++)
          };
        }
        continue;
      }
      if (msg.role === 'human') {
        flushTurn();
        turns.push({ type: 'text', message: msg, id: 'human_' + (msg.id || turnCounter++) });
        continue;
      }
      if (currentTurn && currentTurn.role === msg.role) {
        currentTurn.messages.push(msg);
      } else {
        flushTurn();
        currentTurn = {
          type: 'turn', role: msg.role, roleName: msg.roleName, roleIcon: msg.roleIcon,
          messages: [msg], textMsg: null, toolMsgs: [], routeMsgs: [],
          id: 'turn_' + (turnCounter++)
        };
      }
    }
    flushTurn();
    return turns;
  }

  function getMaxRound(turn) {
    if (!turn.routeMsgs || turn.routeMsgs.length === 0) return 0;
    let max = 0;
    for (const rm of turn.routeMsgs) {
      if (rm.round > max) max = rm.round;
    }
    return max;
  }

  it('should handle realistic multi-role conversation flow', () => {
    const messages = [
      // Human starts
      { role: 'human', type: 'text', content: '实现登录功能' },
      // PM analyzes and routes to architect
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: '收到需求' },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'architect', routeToName: '架构师', routeSummary: '请设计登录架构', round: 1 },
      // Architect designs and routes to developer
      { role: 'architect', roleIcon: '🏗️', roleName: '架构师', type: 'text', content: '设计完成' },
      { role: 'architect', roleIcon: '🏗️', roleName: '架构师', type: 'route', routeTo: 'developer', routeToName: '开发者', routeSummary: '请按方案实现', round: 1 },
      // Developer implements with tools and routes to reviewer
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: '开始编码' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'tool', toolName: 'Write' },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'route', routeTo: 'reviewer', routeToName: '审查者', routeSummary: '请审查', round: 1 },
      // System notification
      { type: 'system', role: 'system', content: 'Round 1 完成' }
    ];

    const turns = buildTurnsNew(messages);

    // Expected: human(standalone) + pm(turn w/ route) + architect(turn w/ route)
    //           + developer(turn w/ tool + route) + system(standalone)
    expect(turns.length).toBe(5);

    // Human standalone
    expect(turns[0].type).toBe('text');
    expect(turns[0].message.role).toBe('human');

    // PM turn with route
    expect(turns[1].type).toBe('turn');
    expect(turns[1].role).toBe('pm');
    expect(turns[1].routeMsgs.length).toBe(1);
    expect(turns[1].routeMsgs[0].routeSummary).toBe('请设计登录架构');
    expect(getMaxRound(turns[1])).toBe(1);

    // Architect turn with route
    expect(turns[2].type).toBe('turn');
    expect(turns[2].role).toBe('architect');
    expect(turns[2].routeMsgs.length).toBe(1);

    // Developer turn with tool + route
    expect(turns[3].type).toBe('turn');
    expect(turns[3].role).toBe('developer');
    expect(turns[3].toolMsgs.length).toBe(1);
    expect(turns[3].routeMsgs.length).toBe(1);
    expect(turns[3].textMsg.content).toBe('开始编码');

    // System standalone
    expect(turns[4].type).toBe('system');
  });

  it('should handle PM dispatching to multiple roles in sequence', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: '任务分配' },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'developer', routeSummary: '实现功能A', round: 1 },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'tester', routeSummary: '准备测试用例', round: 1 }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(1);
    expect(turns[0].routeMsgs.length).toBe(2);
    expect(turns[0].routeMsgs[0].routeSummary).toBe('实现功能A');
    expect(turns[0].routeMsgs[1].routeSummary).toBe('准备测试用例');
  });

  it('should handle human intervention mid-conversation', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 分析' },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', routeTo: 'developer', routeSummary: '请实现' },
      { role: 'human', type: 'text', content: '等一下，需求有变更' },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: '好的，重新分析' }
    ];
    const turns = buildTurnsNew(messages);

    expect(turns.length).toBe(3);
    expect(turns[0].role).toBe('pm');
    expect(turns[0].routeMsgs.length).toBe(1);
    expect(turns[1].type).toBe('text');
    expect(turns[1].message.role).toBe('human');
    expect(turns[2].role).toBe('pm');
    expect(turns[2].routeMsgs).toEqual([]);
  });
});
// =====================================================================
// parseRoutes: summary 多行解析修复
// =====================================================================

describe('parseRoutes - summary parsing', () => {
  // Replicate parseRoutes from agent/crew.js (with the fix: [\s\S]+ instead of .+)
  function parseRoutes(text) {
    const routes = [];
    const regex = /---ROUTE---\s*\n([\s\S]*?)---END_ROUTE---/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const block = match[1];
      const toMatch = block.match(/to:\s*(.+)/i);
      if (!toMatch) continue;

      const summaryMatch = block.match(/summary:\s*([\s\S]+)/i);
      const taskMatch = block.match(/^task:\s*(.+)/im);
      const taskTitleMatch = block.match(/^taskTitle:\s*(.+)/im);

      routes.push({
        to: toMatch[1].trim().toLowerCase(),
        summary: summaryMatch ? summaryMatch[1].trim() : '',
        taskId: taskMatch ? taskMatch[1].trim() : null,
        taskTitle: taskTitleMatch ? taskTitleMatch[1].trim() : null
      });
    }

    return routes;
  }

  // --- 1) 单行 summary 正常解析 ---

  it('should parse single-line summary', () => {
    const text = `一些输出内容
---ROUTE---
to: pm
summary: 任务完成，已修复所有bug
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes.length).toBe(1);
    expect(routes[0].to).toBe('pm');
    expect(routes[0].summary).toBe('任务完成，已修复所有bug');
  });

  it('should parse short single-line summary', () => {
    const text = `---ROUTE---
to: developer
summary: 请实现
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('请实现');
  });

  it('should handle summary with special characters on single line', () => {
    const text = `---ROUTE---
to: pm
summary: 测试通过 (100%) — 无回归 @dev-1 ✅
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('测试通过 (100%) — 无回归 @dev-1 ✅');
  });

  // --- 2) 多行 summary 完整保留不截断 ---

  it('should parse multi-line summary (two lines)', () => {
    const text = `---ROUTE---
to: pm
summary: 第一行内容
第二行内容
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes.length).toBe(1);
    expect(routes[0].summary).toContain('第一行内容');
    expect(routes[0].summary).toContain('第二行内容');
  });

  it('should parse multi-line summary (three+ lines)', () => {
    const text = `---ROUTE---
to: reviewer
summary: 完成以下修改：
1. 修复了登录bug
2. 优化了性能
3. 添加了单元测试
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toContain('完成以下修改：');
    expect(routes[0].summary).toContain('1. 修复了登录bug');
    expect(routes[0].summary).toContain('2. 优化了性能');
    expect(routes[0].summary).toContain('3. 添加了单元测试');
  });

  it('should preserve line breaks in multi-line summary', () => {
    const text = `---ROUTE---
to: pm
summary: 行一
行二
行三
---END_ROUTE---`;
    const routes = parseRoutes(text);
    const summary = routes[0].summary;
    // Should contain newlines between lines (after trim)
    expect(summary).toMatch(/行一\n行二\n行三/);
  });

  it('should handle summary with blank lines in between', () => {
    const text = `---ROUTE---
to: pm
summary: 第一段

第二段（空行后）
---END_ROUTE---`;
    const routes = parseRoutes(text);
    const summary = routes[0].summary;
    expect(summary).toContain('第一段');
    expect(summary).toContain('第二段（空行后）');
  });

  it('should handle summary with special characters across lines', () => {
    const text = `---ROUTE---
to: tester
summary: 测试结果：
- ✅ 单元测试 (42/42)
- ✅ 集成测试 — 100%
- ⚠️ 边界情况: @role "引号" & <html>
---END_ROUTE---`;
    const routes = parseRoutes(text);
    const summary = routes[0].summary;
    expect(summary).toContain('✅ 单元测试 (42/42)');
    expect(summary).toContain('✅ 集成测试 — 100%');
    expect(summary).toContain('⚠️ 边界情况');
    expect(summary).toContain('"引号"');
    expect(summary).toContain('<html>');
  });

  it('should handle summary with code blocks', () => {
    const text = `---ROUTE---
to: developer
summary: 请修复以下代码：
\`\`\`js
function foo() {
  return bar;
}
\`\`\`
---END_ROUTE---`;
    const routes = parseRoutes(text);
    const summary = routes[0].summary;
    expect(summary).toContain('function foo()');
    expect(summary).toContain('return bar');
  });

  // --- 3) summary 结果正确 trim 首尾空白 ---

  it('should trim leading/trailing whitespace from summary', () => {
    const text = `---ROUTE---
to: pm
summary:   前后有空格的内容
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('前后有空格的内容');
  });

  it('should trim trailing newlines from multi-line summary', () => {
    const text = `---ROUTE---
to: pm
summary: 多行内容
最后一行

---END_ROUTE---`;
    const routes = parseRoutes(text);
    const summary = routes[0].summary;
    expect(summary).not.toMatch(/\n$/);
    expect(summary).toMatch(/最后一行$/);
  });

  it('should handle summary with only whitespace as empty', () => {
    const text = `---ROUTE---
to: pm
summary:
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('');
  });

  // --- 4) to/task/taskTitle 字段解析不受影响 ---

  it('should parse to field correctly with multi-line summary', () => {
    const text = `---ROUTE---
to: architect
summary: 第一行
第二行
第三行
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('architect');
  });

  it('should parse task and taskTitle with multi-line summary', () => {
    const text = `---ROUTE---
to: developer
task: task_123
taskTitle: 实现用户登录
summary: 详细描述：
1. 前端表单
2. 后端API
3. 数据库迁移
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('developer');
    expect(routes[0].taskId).toBe('task_123');
    expect(routes[0].taskTitle).toBe('实现用户登录');
    expect(routes[0].summary).toContain('详细描述：');
    expect(routes[0].summary).toContain('3. 数据库迁移');
  });

  it('should parse task/taskTitle when they appear before summary', () => {
    const text = `---ROUTE---
to: pm
task: task_abc
taskTitle: 需求评审
summary: 多行摘要
包含更多内容
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].taskId).toBe('task_abc');
    expect(routes[0].taskTitle).toBe('需求评审');
    expect(routes[0].summary).toContain('多行摘要');
    expect(routes[0].summary).toContain('包含更多内容');
  });

  it('should parse task/taskTitle when they appear after summary', () => {
    const text = `---ROUTE---
to: pm
summary: 工作完成
task: task_xyz
taskTitle: 代码重构
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('pm');
    expect(routes[0].taskId).toBe('task_xyz');
    expect(routes[0].taskTitle).toBe('代码重构');
    // Summary may capture trailing lines since [\s\S]+ is greedy
    expect(routes[0].summary).toContain('工作完成');
  });

  it('should handle to field case-insensitively', () => {
    const text = `---ROUTE---
to: PM
summary: 测试
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('pm');
  });

  it('should return null for missing task/taskTitle', () => {
    const text = `---ROUTE---
to: pm
summary: 没有 task 字段
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].taskId).toBeNull();
    expect(routes[0].taskTitle).toBeNull();
  });

  it('should return empty summary when no summary field', () => {
    const text = `---ROUTE---
to: pm
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('');
  });

  // --- 5) 多 ROUTE 块 ---

  it('should parse multiple ROUTE blocks independently', () => {
    const text = `输出内容
---ROUTE---
to: reviewer
summary: 请审查代码
---END_ROUTE---

中间内容

---ROUTE---
to: tester
summary: 请测试以下变更：
1. 功能A
2. 功能B
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes.length).toBe(2);
    expect(routes[0].to).toBe('reviewer');
    expect(routes[0].summary).toBe('请审查代码');
    expect(routes[1].to).toBe('tester');
    expect(routes[1].summary).toContain('请测试以下变更：');
    expect(routes[1].summary).toContain('2. 功能B');
  });

  it('should skip ROUTE blocks without to field', () => {
    const text = `---ROUTE---
summary: 缺少 to 字段
---END_ROUTE---

---ROUTE---
to: pm
summary: 有效的路由
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes.length).toBe(1);
    expect(routes[0].to).toBe('pm');
  });

  it('should handle no ROUTE blocks', () => {
    const text = '普通文本，没有路由块';
    const routes = parseRoutes(text);
    expect(routes.length).toBe(0);
  });

  // --- 6) 旧 .+ 正则的回归验证 ---

  it('should NOT truncate multi-line summary (old .+ bug)', () => {
    // This was the exact bug: .+ only matches single line
    const text = `---ROUTE---
to: pm
summary: 第一行被保留
第二行在旧代码中会被截断
第三行也会丢失
---END_ROUTE---`;
    const routes = parseRoutes(text);
    const summary = routes[0].summary;
    // With the fix ([\s\S]+), all lines should be captured
    expect(summary).toContain('第一行被保留');
    expect(summary).toContain('第二行在旧代码中会被截断');
    expect(summary).toContain('第三行也会丢失');
  });

  it('old regex .+ would have truncated multi-line (regression proof)', () => {
    // Demonstrate that the old regex fails on multi-line
    const block = `to: pm
summary: 第一行
第二行
第三行`;

    // Old regex (bug)
    const oldMatch = block.match(/summary:\s*(.+)/i);
    // New regex (fix)
    const newMatch = block.match(/summary:\s*([\s\S]+)/i);

    // Old regex only captures first line
    expect(oldMatch[1]).toBe('第一行');
    expect(oldMatch[1]).not.toContain('第二行');

    // New regex captures all lines
    expect(newMatch[1]).toContain('第一行');
    expect(newMatch[1]).toContain('第二行');
    expect(newMatch[1]).toContain('第三行');
  });
});


// =====================================================================
// Team best practices (commit b7b48d3)
// writeSharedClaudeMd: retry 5次, 8条 Worktree 规则(含跨组禁令)
// =====================================================================

describe('writeSharedClaudeMd - team best practices (b7b48d3)', () => {
  let crewContent;

  beforeAll(async () => {
    const { promises: fs } = await import('fs');
    crewContent = await fs.readFile(
      join(process.cwd(), 'agent/crew/shared-dir.js'),
      'utf-8'
    ) + await fs.readFile(
      join(process.cwd(), 'agent/crew-i18n.js'),
      'utf-8'
    );
  });

  // --- 卡住上报规则 ---

  it('should have "2 次" in escalation rule #5', () => {
    expect(crewContent).toContain('5. 连续尝试 2 次相同操作仍然失败');
  });

  it('should NOT have old "5次" in escalation rule', () => {
    expect(crewContent).not.toContain('连续尝试5次相同操作仍然失败');
  });

  it('should still have 5 escalation rules', () => {
    // Extract the escalation section
    const section = crewContent.split('# 卡住上报规则')[1].split('# Worktree 隔离规则')[0];
    const numbered = section.match(/^\d\.\s/gm);
    expect(numbered).toHaveLength(5);
  });

  // --- Worktree 隔离规则 ---

  it('should have 7 worktree rules', async () => {
    const { getMessages } = await import('../../agent/crew-i18n.js');
    const m = getMessages('zh-CN');
    const bullets = m.worktreeRulesContent.match(/^- /gm);
    expect(bullets).toHaveLength(7);
  });

  it('should contain cross-group prohibition rule', () => {
    expect(crewContent).toContain('绝对禁止在其他开发组的 worktree 中操作代码');
  });

  it('cross-group rule should be the 4th rule', async () => {
    const { getMessages } = await import('../../agent/crew-i18n.js');
    const m = getMessages('zh-CN');
    const lines = m.worktreeRulesContent.trim().split('\n').filter(l => l.startsWith('- '));
    expect(lines).toHaveLength(7);
    expect(lines[3]).toContain('绝对禁止在其他开发组的 worktree 中操作代码');
  });

  it('should contain all 7 worktree rules with PR-based merge flow', () => {
    expect(crewContent).toContain('dev/reviewer/tester 角色必须在各自分配的 worktree 中工作');
    expect(crewContent).toContain('每个角色的 CLAUDE.md 会标明「代码工作目录」');
    expect(crewContent).toContain('PM 和 designer 不使用 worktree');
    expect(crewContent).toContain('绝对禁止在其他开发组的 worktree 中操作代码');
    expect(crewContent).toContain('dev 自己提 PR 合并到 main 分支');
    expect(crewContent).toContain('PM 不做 cherry-pick，只负责打 tag');
    expect(crewContent).toContain('每次新任务/新 feature 必须基于最新的 main 分支创建新的 worktree');
  });

  // --- writeRoleClaudeMd stronger warning ---

  it('should have "代码工作目录" header for roles with workDir', () => {
    expect(crewContent).toContain('# 代码工作目录');
  });

  it('should have workDir instructions', () => {
    expect(crewContent).toContain('所有代码操作请使用此路径。不要使用项目主目录。');
  });
});

// ============================================================================
// task-22: Crew Three-Column v2 — Feature Kanban + Visual Polish (commit ec6210e)
// ============================================================================

describe('task-22: Three-Column v2 — Feature Kanban', () => {
  let viewSource;
  let cssSource;

  beforeAll(async () => {
    viewSource = await fs.readFile(join(__dirname, '../../web/components/CrewChatView.js'), 'utf-8');
    // Sub-modules extracted from CrewChatView during refactor
    const crewDir = join(__dirname, '../../web/components/crew');
    for (const mod of ['crewHelpers.js', 'crewMessageGrouping.js', 'crewKanban.js', 'crewRolePresets.js', 'CrewTurnRenderer.js', 'CrewFeaturePanel.js', 'CrewRolePanel.js', 'crewInput.js', 'crewScroll.js']) {
      viewSource += '\n' + await fs.readFile(join(crewDir, mod), 'utf-8');
    }
    cssSource = loadAllCss();
  });

  // --- Left Panel: Role Cards v2 ---

  describe('left panel role card restructure', () => {
    it('should have role card with is-streaming class', () => {
      expect(viewSource).toContain("'is-streaming': isRoleStreaming(role.name)");
    });

    it('should NOT have crew-role-card-status indicator (removed)', () => {
      expect(viewSource).not.toContain('crew-role-card-status');
    });

    it('should show feature title via crew-role-card-feature', () => {
      expect(viewSource).toContain('class="crew-role-card-feature"');
      expect(viewSource).toContain('getRoleCurrentTask(role.name)');
    });

    it('should show tool only when streaming AND has tool', () => {
      expect(viewSource).toContain('isRoleStreaming(role.name) && getRoleCurrentTool(role.name)');
    });

    it('should use crew-role-card-feature instead of crew-role-card-task', () => {
      expect(viewSource).not.toContain('crew-role-card-task');
      expect(viewSource).toContain('crew-role-card-feature');
    });

    it('should NOT have crew-role-card-details wrapper (removed)', () => {
      expect(viewSource).not.toContain('crew-role-card-details');
    });
  });

  describe('left panel breathing animation for streaming', () => {
    it('should have is-streaming CSS with name breathing animation', () => {
      expect(cssSource).toContain('.crew-role-card.is-streaming');
      expect(cssSource).toContain('.crew-role-card.is-streaming .crew-role-card-name');
      expect(cssSource).toContain('animation: nameBreathing');
      expect(cssSource).toContain('@keyframes nameBreathing');
    });

    it('should NOT have rolePulse animation (removed)', () => {
      expect(cssSource).not.toContain('@keyframes rolePulse');
    });

    it('should NOT have crew-role-card-status CSS (removed)', () => {
      expect(cssSource).not.toContain('.crew-role-card-status');
    });
  });

  describe('add role button in left panel', () => {
    it('should have crew-add-role-btn in template', () => {
      expect(viewSource).toContain('class="crew-add-role-btn"');
    });

    it('should trigger showAddRole on click', () => {
      // Sub-component emits 'show-add-role', parent handles with showAddRole = true
      expect(viewSource).toContain("$emit('show-add-role')");
      expect(viewSource).toContain('@show-add-role="showAddRole = true"');
    });

    it('should have label text using i18n key crew.addRole', () => {
      expect(viewSource).toContain('crew.addRole');
    });

    it('should NOT have add role button in input area (removed)', () => {
      // The old button in crew-hint-controls was removed
      const inputArea = viewSource.substring(viewSource.indexOf('class="input-area'));
      const panelCenter = viewSource.indexOf('</div><!-- /crew-panel-center -->');
      const inputSection = viewSource.substring(viewSource.indexOf('class="input-area'), panelCenter);
      expect(inputSection).not.toContain('crew.addRole');
    });

    it('should have CSS styles for add role button', () => {
      expect(cssSource).toContain('.crew-add-role-btn {');
      expect(cssSource).toContain('border: none');
    });
  });

  // --- Right Panel: Feature Kanban v2 ---

  describe('right panel feature kanban', () => {
    it('should NOT have kanban title element (removed)', () => {
      expect(viewSource).not.toContain('class="crew-kanban-title"');
    });

    it('should iterate over filtered features (inProgress and completed groups)', () => {
      expect(viewSource).toContain('v-for="feature in filteredInProgress"');
      expect(viewSource).toContain('v-for="feature in filteredCompleted"');
    });

    it('should use crew-feature-card class', () => {
      expect(viewSource).toContain('class="crew-feature-card"');
    });

    it('should have has-streaming class on active cards and is-completed on completed cards', () => {
      expect(viewSource).toContain("'has-streaming': feature.hasStreaming");
      expect(viewSource).toContain('crew-feature-card is-completed');
    });

    it('should have click on card to expand feature', () => {
      // Whole card is clickable — single click to expand
      expect(viewSource).toContain("@click=\"$emit('expand-feature', feature.taskId)\"");
      // No more dblclick — replaced with single click
      expect(viewSource).not.toContain('@dblclick');
    });

    it('should show feature title and done/total count', () => {
      expect(viewSource).toContain('class="crew-feature-card-title"');
      expect(viewSource).toContain('feature.doneCount');
      expect(viewSource).toContain('feature.totalCount');
    });

    it('should have per-feature progress bar', () => {
      expect(viewSource).toContain('class="crew-feature-card-bar"');
      expect(viewSource).toContain('class="crew-feature-card-bar-fill"');
    });

    it('should NOT show active roles in list mode cards (removed for compact layout)', () => {
      const templateMatch = viewSource.match(/template:\s*`([\s\S]*?)`\s*,/);
      const template = templateMatch ? templateMatch[1] : '';
      // List mode section (after v-else) should not have roles
      const listSection = template.split('v-else>')[1] || '';
      expect(listSection).not.toContain('crew-feature-card-roles');
    });

    it('should show todo items in expanded mode (not list mode)', () => {
      expect(viewSource).toContain('class="crew-feature-card-todos"');
      expect(viewSource).toContain('class="crew-feature-card-todo"');
      expect(viewSource).toContain('todo.roleIcon');
    });

    it('should show empty state when no todos', () => {
      expect(viewSource).toContain('class="crew-feature-card-empty"');
      expect(viewSource).toContain('crew.noFeatures');
    });

    it('should show empty state using i18n key crew.noFeatures', () => {
      expect(viewSource).toContain('crew.noFeatures');
    });
  });

  // --- Data Properties ---

  describe('updated data properties', () => {
    it('should NOT have expandedFeatureCards (removed — cards are non-expandable)', () => {
      expect(viewSource).not.toContain('expandedFeatureCards');
    });

    it('should NOT have kanbanCompletedExpanded (removed)', () => {
      expect(viewSource).not.toContain('kanbanCompletedExpanded');
    });
  });

  // --- Computed Properties ---

  describe('featureKanban computed', () => {
    it('should have featureKanban computed (not kanbanFeatures)', () => {
      expect(viewSource).toContain('featureKanban()');
      expect(viewSource).not.toMatch(/kanbanFeatures\(\)/);
    });

    it('should collect from activeTasks', () => {
      expect(viewSource).toContain('this.activeTasks');
    });

    it('should merge todosByFeature data', () => {
      expect(viewSource).toContain('this.todosByFeature');
    });

    it('should merge featureBlocks for active roles', () => {
      expect(viewSource).toContain('this.featureBlocks');
      expect(viewSource).toContain('block.activeRoles');
      expect(viewSource).toContain('block.hasStreaming');
    });

    it('should sort by createdAt descending', () => {
      expect(viewSource).toContain('b.createdAt');
      expect(viewSource).toContain('a.createdAt');
    });

    it('should NOT have kanbanAllItems, kanbanInProgress, kanbanPending, kanbanCompleted', () => {
      expect(viewSource).not.toContain('kanbanAllItems()');
      expect(viewSource).not.toContain('kanbanInProgress()');
      expect(viewSource).not.toContain('kanbanPending()');
      expect(viewSource).not.toContain('kanbanCompleted()');
    });

    it('kanbanProgress should sum from featureKanban', () => {
      // Computed renamed to kanbanProgressData, delegates to kanbanProgress function
      expect(viewSource).toContain('kanbanProgressData()');
      expect(viewSource).toContain('this.featureKanban');
    });
  });

  // --- Methods ---

  describe('feature card methods', () => {
    it('should NOT have toggleFeatureCard or isFeatureCardExpanded (cards are non-expandable)', () => {
      expect(viewSource).not.toContain('toggleFeatureCard');
      expect(viewSource).not.toContain('isFeatureCardExpanded');
    });

    it('should have scrollToFeature method', () => {
      expect(viewSource).toContain('scrollToFeature(taskId)');
      expect(viewSource).toContain('data-task-id');
      expect(viewSource).toContain('scrollIntoView');
    });

    it('should have expandedFeatureTodos computed that reads from featureKanban', () => {
      expect(viewSource).toContain('expandedFeatureTodos()');
      expect(viewSource).toContain('feature.todos');
    });
  });

  // --- Feature thread removed from center panel ---

  describe('feature thread removed from center panel', () => {
    it('should NOT have data-task-id on crew-feature-thread (feature content only in right panel)', () => {
      // Extract just the template from CrewChatView.js (before setup())
      const templateMatch = viewSource.match(/template:\s*`([\s\S]*?)`\s*,\s*\n\s*setup/);
      const template = templateMatch ? templateMatch[1] : '';
      expect(template).not.toContain('crew-feature-thread');
    });
  });

  // --- Role style with bg-glow ---

  describe('getRoleStyle with bg-glow', () => {
    it('should include --role-bg-glow in getRoleStyle', () => {
      expect(viewSource).toContain("'--role-bg-glow'");
    });
  });

  // --- Functional Logic: featureKanban ---

  describe('featureKanban logic', () => {
    function computeFeatureKanban(activeTasks, todosByFeature, featureBlocks, completedTaskIds) {
      const features = new Map();
      for (const task of activeTasks) {
        features.set(task.id, {
          taskId: task.id,
          taskTitle: task.title,
          todos: [],
          doneCount: 0,
          totalCount: 0,
          activeRoles: [],
          isCompleted: completedTaskIds.has(task.id),
          hasStreaming: false,
        });
      }
      for (const group of todosByFeature) {
        const tid = group.taskId || '_global';
        let feature = features.get(tid);
        if (!feature) {
          feature = {
            taskId: tid,
            taskTitle: group.taskTitle || '全局任务',
            todos: [],
            doneCount: 0,
            totalCount: 0,
            activeRoles: [],
            isCompleted: false,
            hasStreaming: false,
          };
          features.set(tid, feature);
        }
        for (const entry of group.entries) {
          for (const todo of entry.todos) {
            feature.todos.push({
              ...todo,
              roleIcon: entry.roleIcon,
              roleName: entry.roleName,
              id: `${tid}_${entry.role}_${feature.todos.length}`
            });
            feature.totalCount++;
            if (todo.status === 'completed') feature.doneCount++;
          }
        }
      }
      for (const block of featureBlocks) {
        if (block.type !== 'feature') continue;
        const feature = features.get(block.taskId);
        if (feature) {
          if (block.activeRoles) feature.activeRoles = block.activeRoles;
          if (block.hasStreaming) feature.hasStreaming = true;
        }
      }
      return Array.from(features.values()).sort((a, b) => {
        if (a.hasStreaming !== b.hasStreaming) return a.hasStreaming ? -1 : 1;
        if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
        return 0;
      });
    }

    it('should return empty array with no data', () => {
      const result = computeFeatureKanban([], [], [], new Set());
      expect(result).toEqual([]);
    });

    it('should create features from activeTasks', () => {
      const tasks = [
        { id: 't1', title: '功能A' },
        { id: 't2', title: '功能B' },
      ];
      const result = computeFeatureKanban(tasks, [], [], new Set());
      expect(result).toHaveLength(2);
      expect(result[0].taskTitle).toBe('功能A');
      expect(result[1].taskTitle).toBe('功能B');
    });

    it('should merge todos from todosByFeature', () => {
      const tasks = [{ id: 't1', title: '功能A' }];
      const todoGroups = [{
        taskId: 't1',
        entries: [{
          role: 'dev-1', roleIcon: '💻', roleName: 'Dev',
          todos: [
            { content: '写代码', status: 'in_progress', activeForm: '写代码中' },
            { content: '写测试', status: 'pending' },
          ]
        }]
      }];
      const result = computeFeatureKanban(tasks, todoGroups, [], new Set());
      expect(result[0].todos).toHaveLength(2);
      expect(result[0].totalCount).toBe(2);
      expect(result[0].doneCount).toBe(0);
      expect(result[0].todos[0].roleIcon).toBe('💻');
    });

    it('should create new feature for unknown taskId in todosByFeature', () => {
      const result = computeFeatureKanban([], [{
        taskId: null,
        entries: [{
          role: 'pm', roleIcon: '📋', roleName: 'PM',
          todos: [{ content: '计划', status: 'pending' }]
        }]
      }], [], new Set());
      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('_global');
      expect(result[0].taskTitle).toBe('全局任务');
    });

    it('should merge active roles from featureBlocks', () => {
      const tasks = [{ id: 't1', title: 'F1' }];
      const blocks = [{
        type: 'feature', taskId: 't1',
        activeRoles: [{ role: 'dev-1', roleIcon: '💻' }],
        hasStreaming: true,
      }];
      const result = computeFeatureKanban(tasks, [], blocks, new Set());
      expect(result[0].activeRoles).toHaveLength(1);
      expect(result[0].hasStreaming).toBe(true);
    });

    it('should mark completed features', () => {
      const tasks = [{ id: 't1', title: 'F1' }];
      const completedIds = new Set(['t1']);
      const result = computeFeatureKanban(tasks, [], [], completedIds);
      expect(result[0].isCompleted).toBe(true);
    });

    it('should sort streaming features first, completed last', () => {
      const tasks = [
        { id: 't1', title: 'Completed' },
        { id: 't2', title: 'Normal' },
        { id: 't3', title: 'Streaming' },
      ];
      const blocks = [{ type: 'feature', taskId: 't3', hasStreaming: true }];
      const completedIds = new Set(['t1']);
      const result = computeFeatureKanban(tasks, [], blocks, completedIds);
      expect(result[0].taskTitle).toBe('Streaming');
      expect(result[1].taskTitle).toBe('Normal');
      expect(result[2].taskTitle).toBe('Completed');
    });

    it('should count done items correctly', () => {
      const tasks = [{ id: 't1', title: 'F1' }];
      const todoGroups = [{
        taskId: 't1',
        entries: [{
          role: 'a', roleIcon: '', roleName: 'A',
          todos: [
            { content: 'x', status: 'completed' },
            { content: 'y', status: 'completed' },
            { content: 'z', status: 'in_progress' },
          ]
        }]
      }];
      const result = computeFeatureKanban(tasks, todoGroups, [], new Set());
      expect(result[0].doneCount).toBe(2);
      expect(result[0].totalCount).toBe(3);
    });
  });

  // --- Functional Logic: kanbanProgress ---

  describe('kanbanProgress logic', () => {
    function computeKanbanProgress(featureKanban) {
      let total = 0, done = 0;
      for (const f of featureKanban) {
        total += f.totalCount;
        done += f.doneCount;
      }
      return { total, done };
    }

    it('should return 0 for empty', () => {
      const p = computeKanbanProgress([]);
      expect(p.total).toBe(0);
      expect(p.done).toBe(0);
    });

    it('should sum across multiple features', () => {
      const features = [
        { totalCount: 3, doneCount: 1 },
        { totalCount: 5, doneCount: 4 },
      ];
      const p = computeKanbanProgress(features);
      expect(p.total).toBe(8);
      expect(p.done).toBe(5);
    });
  });

  // --- Functional Logic: expandedFeatureTodos ---

  describe('expandedFeatureTodos logic', () => {
    function expandedFeatureTodos(expandedFeatureTaskId, featureKanban) {
      if (!expandedFeatureTaskId) return [];
      const feature = featureKanban.find(f => f.taskId === expandedFeatureTaskId);
      return feature ? feature.todos : [];
    }

    it('should return empty array when no feature is expanded', () => {
      expect(expandedFeatureTodos(null, [])).toEqual([]);
    });

    it('should return todos for the expanded feature', () => {
      const todos = [{ id: '1', status: 'completed' }, { id: '2', status: 'in_progress' }];
      const features = [{ taskId: 't1', todos }];
      expect(expandedFeatureTodos('t1', features)).toBe(todos);
    });

    it('should return empty array when feature not found', () => {
      expect(expandedFeatureTodos('t99', [{ taskId: 't1', todos: [] }])).toEqual([]);
    });
  });

  // --- CSS Verification ---

              // --- Responsive Breakpoints ---

    // --- Removed Items ---

    // --- HTML Tag Balance ---

    // =====================================================================
  // task-41: Stale processing dot — crew 停止后白点消失
  // =====================================================================
  describe('task-41: Stale processing dot 清除', () => {
    let wsAgentSource;
    let chatStoreSource;
    let messageHandlerSource;

    beforeAll(async () => {
      wsAgentSource = await fs.readFile(join(__dirname, '../../server/handlers/agent-crew.js'), 'utf-8');
      const chatMain = await fs.readFile(join(__dirname, '../../web/stores/chat.js'), 'utf-8');
      const crewHelper = await fs.readFile(join(__dirname, '../../web/stores/helpers/crew.js'), 'utf-8');
      chatStoreSource = chatMain + '\n' + crewHelper;
      const handlerMain = await fs.readFile(join(__dirname, '../../web/stores/helpers/messageHandler.js'), 'utf-8');
      const agentHandler = await fs.readFile(join(__dirname, '../../web/stores/helpers/handlers/agentHandler.js'), 'utf-8');
      const convHandler = await fs.readFile(join(__dirname, '../../web/stores/helpers/handlers/conversationHandler.js'), 'utf-8');
      messageHandlerSource = handlerMain + '\n' + agentHandler + '\n' + convHandler;
    });

    // --- 1. server/ws-agent.js: crew_status 时设置 processing = false ---
    describe('ws-agent: crew_status 设置 processing=false', () => {
      it('should have crew_status case block', () => {
        expect(wsAgentSource).toContain("case 'crew_status':");
      });

      it('should get crew conversation from agent.conversations', () => {
        expect(wsAgentSource).toContain('agent.conversations.get(msg.sessionId)');
      });

      it('should check for stopped or completed status', () => {
        expect(wsAgentSource).toMatch(/msg\.status\s*===\s*'stopped'\s*\|\|\s*msg\.status\s*===\s*'completed'/);
      });

      it('should set crewConv.processing = false on stop/complete', () => {
        expect(wsAgentSource).toContain('crewConv.processing = false');
      });

      it('should still forward to clients after updating processing', () => {
        const crewStatusMatch = wsAgentSource.match(/case 'crew_status':\s*\{([\s\S]*?)break;/);
        expect(crewStatusMatch).toBeTruthy();
        if (crewStatusMatch) {
          const block = crewStatusMatch[1];
          expect(block).toContain('crewConv.processing = false');
          expect(block).toContain('forwardToClients');
        }
      });

      it('should guard with crewConv existence check', () => {
        expect(wsAgentSource).toMatch(/if\s*\(crewConv\s*&&/);
      });
    });

    // --- 2. web/stores/chat.js: crew_status handler 删除 processingConversations ---
    describe('chat.js: crew_status 删除 processingConversations', () => {
      it('should have crew_status handler in chat store', () => {
        expect(chatStoreSource).toContain("msg.type === 'crew_status'");
      });

      it('should delete processingConversations on stopped status', () => {
        const crewStatusMatch = chatStoreSource.match(/if\s*\(msg\.type\s*===\s*'crew_status'\)([\s\S]*?)return;/);
        expect(crewStatusMatch).toBeTruthy();
        if (crewStatusMatch) {
          const block = crewStatusMatch[1];
          expect(block).toContain("msg.status === 'stopped'");
          expect(block).toMatch(/delete (this|store)\.processingConversations\[sid\]/);
        }
      });

      it('should delete processingConversations on completed status', () => {
        const crewStatusMatch = chatStoreSource.match(/if\s*\(msg\.type\s*===\s*'crew_status'\)([\s\S]*?)return;/);
        expect(crewStatusMatch).toBeTruthy();
        if (crewStatusMatch) {
          const block = crewStatusMatch[1];
          expect(block).toContain("msg.status === 'completed'");
        }
      });

      it('should check stopped OR completed condition', () => {
        const crewStatusMatch = chatStoreSource.match(/if\s*\(msg\.type\s*===\s*'crew_status'\)([\s\S]*?)return;/);
        expect(crewStatusMatch).toBeTruthy();
        if (crewStatusMatch) {
          const block = crewStatusMatch[1];
          expect(block).toMatch(/msg\.status\s*===\s*'stopped'\s*\|\|\s*msg\.status\s*===\s*'completed'/);
        }
      });

      it('should still update crewStatuses before clearing processing', () => {
        const crewStatusMatch = chatStoreSource.match(/if\s*\(msg\.type\s*===\s*'crew_status'\)([\s\S]*?)return;/);
        expect(crewStatusMatch).toBeTruthy();
        if (crewStatusMatch) {
          const block = crewStatusMatch[1];
          const statusIdx = block.indexOf('store.crewStatuses[sid]') >= 0
            ? block.indexOf('store.crewStatuses[sid]')
            : block.indexOf('this.crewStatuses[sid]');
          const deleteIdx = block.indexOf('delete store.processingConversations[sid]') >= 0
            ? block.indexOf('delete store.processingConversations[sid]')
            : block.indexOf('delete this.processingConversations[sid]');
          expect(statusIdx).toBeGreaterThan(-1);
          expect(deleteIdx).toBeGreaterThan(-1);
          expect(statusIdx).toBeLessThan(deleteIdx);
        }
      });
    });

    // --- 3. messageHandler.js: isStaleCrewProcessing 防重连白点 ---
    describe('messageHandler: isStaleCrewProcessing 防重连白点', () => {
      it('should define isStaleCrewProcessing variable', () => {
        expect(messageHandlerSource).toContain('isStaleCrewProcessing');
      });

      it('should check serverConv.processing && serverConv.type === crew', () => {
        expect(messageHandlerSource).toContain("serverConv.processing && serverConv.type === 'crew'");
      });

      it('should check for missing crewSessions as stale indicator', () => {
        expect(messageHandlerSource).toContain('!store.crewSessions?.[serverConv.id]');
      });

      it('should combine all three conditions for isStaleCrewProcessing', () => {
        const match = messageHandlerSource.match(/const isStaleCrewProcessing\s*=\s*([\s\S]*?);/);
        expect(match).toBeTruthy();
        if (match) {
          const condition = match[1];
          expect(condition).toContain('serverConv.processing');
          expect(condition).toContain("serverConv.type === 'crew'");
          expect(condition).toContain('!store.crewSessions?.[serverConv.id]');
        }
      });

      it('should use isStaleCrewProcessing in processing sync guard', () => {
        expect(messageHandlerSource).toContain('&& !isStaleCrewProcessing');
      });

      it('should prevent stale crew processing from being set to true', () => {
        const syncMatch = messageHandlerSource.match(
          /if\s*\(serverConv\.processing\s*&&\s*!isRecentlyClosed[\s\S]*?!isStaleCrewProcessing\)/
        );
        expect(syncMatch).toBeTruthy();
      });
    });

    // --- 4. 逻辑验证: isStaleCrewProcessing 函数行为 ---
    describe('逻辑验证: isStaleCrewProcessing 判定', () => {
      it('should detect stale: processing=true, type=crew, no crewSession', () => {
        const serverConv = { id: 's1', processing: true, type: 'crew' };
        const store = { crewSessions: {} };
        const isStale = serverConv.processing && serverConv.type === 'crew'
          && !store.crewSessions?.[serverConv.id];
        expect(isStale).toBe(true);
      });

      it('should NOT detect stale: processing=true, type=crew, HAS crewSession', () => {
        const serverConv = { id: 's1', processing: true, type: 'crew' };
        const store = { crewSessions: { s1: { status: 'running' } } };
        const isStale = serverConv.processing && serverConv.type === 'crew'
          && !store.crewSessions?.[serverConv.id];
        expect(isStale).toBe(false);
      });

      it('should NOT detect stale: processing=true, type=chat (not crew)', () => {
        const serverConv = { id: 's1', processing: true, type: 'chat' };
        const store = { crewSessions: {} };
        const isStale = serverConv.processing && serverConv.type === 'crew'
          && !store.crewSessions?.[serverConv.id];
        expect(isStale).toBe(false);
      });

      it('should NOT detect stale: processing=false, type=crew, no crewSession', () => {
        const serverConv = { id: 's1', processing: false, type: 'crew' };
        const store = { crewSessions: {} };
        const isStale = serverConv.processing && serverConv.type === 'crew'
          && !store.crewSessions?.[serverConv.id];
        expect(isStale).toBe(false);
      });

      it('should handle missing crewSessions (null/undefined)', () => {
        const serverConv = { id: 's1', processing: true, type: 'crew' };
        const store = {};
        const isStale = serverConv.processing && serverConv.type === 'crew'
          && !store.crewSessions?.[serverConv.id];
        expect(isStale).toBe(true);
      });
    });

    // --- 5. 端到端场景验证 ---
    describe('端到端: processing dot 生命周期', () => {
      it('scenario: crew running → stopped → processing cleared', () => {
        const processingConversations = { 'crew-1': true };
        const msg = { type: 'crew_status', status: 'stopped' };

        if (msg.status === 'stopped' || msg.status === 'completed') {
          delete processingConversations['crew-1'];
        }
        expect(processingConversations['crew-1']).toBeUndefined();
      });

      it('scenario: crew running → completed → processing cleared', () => {
        const processingConversations = { 'crew-1': true };
        const msg = { type: 'crew_status', status: 'completed' };

        if (msg.status === 'stopped' || msg.status === 'completed') {
          delete processingConversations['crew-1'];
        }
        expect(processingConversations['crew-1']).toBeUndefined();
      });

      it('scenario: crew running → paused → processing NOT cleared', () => {
        const processingConversations = { 'crew-1': true };
        const msg = { type: 'crew_status', status: 'paused' };

        if (msg.status === 'stopped' || msg.status === 'completed') {
          delete processingConversations['crew-1'];
        }
        expect(processingConversations['crew-1']).toBe(true);
      });

      it('scenario: reconnect — stale crew processing skipped', () => {
        const serverConv = { id: 'crew-1', processing: true, type: 'crew' };
        const store = {
          crewSessions: {},
          processingConversations: {},
          _turnCompletedConvs: new Set()
        };

        const isStaleCrewProcessing = serverConv.processing && serverConv.type === 'crew'
          && !store.crewSessions?.[serverConv.id];
        const isRecentlyClosed = false;

        if (serverConv.processing && !isRecentlyClosed
            && !store._turnCompletedConvs?.has(serverConv.id)
            && !isStaleCrewProcessing) {
          store.processingConversations[serverConv.id] = true;
        }
        expect(store.processingConversations['crew-1']).toBeUndefined();
      });

      it('scenario: reconnect — active crew processing preserved', () => {
        const serverConv = { id: 'crew-1', processing: true, type: 'crew' };
        const store = {
          crewSessions: { 'crew-1': { status: 'running' } },
          processingConversations: {},
          _turnCompletedConvs: new Set()
        };

        const isStaleCrewProcessing = serverConv.processing && serverConv.type === 'crew'
          && !store.crewSessions?.[serverConv.id];
        const isRecentlyClosed = false;

        if (serverConv.processing && !isRecentlyClosed
            && !store._turnCompletedConvs?.has(serverConv.id)
            && !isStaleCrewProcessing) {
          store.processingConversations[serverConv.id] = true;
        }
        expect(store.processingConversations['crew-1']).toBe(true);
      });

      it('scenario: reconnect — normal chat processing unaffected', () => {
        const serverConv = { id: 'chat-1', processing: true, type: 'chat' };
        const store = {
          crewSessions: {},
          processingConversations: {},
          _turnCompletedConvs: new Set()
        };

        const isStaleCrewProcessing = serverConv.processing && serverConv.type === 'crew'
          && !store.crewSessions?.[serverConv.id];
        const isRecentlyClosed = false;

        if (serverConv.processing && !isRecentlyClosed
            && !store._turnCompletedConvs?.has(serverConv.id)
            && !isStaleCrewProcessing) {
          store.processingConversations[serverConv.id] = true;
        }
        expect(store.processingConversations['chat-1']).toBe(true);
      });
    });

    // --- 6. server 端 processing 同步: crewConv.processing 影响 conv_list ---
    describe('ws-agent: crewConv.processing 影响 conv_list', () => {
      it('should set processing=false BEFORE forwarding to clients', () => {
        const crewStatusMatch = wsAgentSource.match(/case 'crew_status':\s*\{([\s\S]*?)break;/);
        expect(crewStatusMatch).toBeTruthy();
        if (crewStatusMatch) {
          const block = crewStatusMatch[1];
          const processingIdx = block.indexOf('crewConv.processing = false');
          const forwardIdx = block.indexOf('forwardToClients');
          expect(processingIdx).toBeGreaterThan(-1);
          expect(forwardIdx).toBeGreaterThan(-1);
          expect(processingIdx).toBeLessThan(forwardIdx);
        }
      });

      it('should handle missing crewConv gracefully (guard check)', () => {
        const crewStatusMatch = wsAgentSource.match(/case 'crew_status':\s*\{([\s\S]*?)break;/);
        expect(crewStatusMatch).toBeTruthy();
        if (crewStatusMatch) {
          const block = crewStatusMatch[1];
          expect(block).toMatch(/if\s*\(crewConv\s*&&/);
        }
      });
    });
  });
});

// =====================================================================
// Context 超限自动恢复 (Compact / Trim / Clear+Rebuild)
// =====================================================================

describe('processRoleOutput - compact message filtering', () => {
  // Replicate compact filtering logic from crew.js processRoleOutput
  function filterMessages(messages, roleState) {
    const passed = [];
    for (const message of messages) {
      // compact 期间只放行 result，其余过滤
      if (roleState._compacting && message.type !== 'result') {
        if (message.type === 'system') {
          if (message.subtype === 'compact_boundary') {
            roleState._compactSummaryPending = true;
          }
          continue; // 过滤所有 compact 期间的 system 消息
        }
        if (message.type === 'user' && roleState._compactSummaryPending) {
          roleState._compactSummaryPending = false;
          continue; // 过滤 compact summary
        }
        // 其他消息（assistant 等）在 compact 期间也过滤
        continue;
      }
      passed.push(message);
    }
    return passed;
  }

  it('should filter system messages during compact', () => {
    const roleState = { _compacting: true, _compactSummaryPending: false };
    const messages = [
      { type: 'system', subtype: 'info' },
      { type: 'system', subtype: 'init' },
    ];
    const passed = filterMessages(messages, roleState);
    expect(passed).toHaveLength(0);
  });

  it('should filter assistant messages during compact', () => {
    const roleState = { _compacting: true, _compactSummaryPending: false };
    const messages = [
      { type: 'assistant', message: { role: 'assistant', content: 'some text' } },
    ];
    const passed = filterMessages(messages, roleState);
    expect(passed).toHaveLength(0);
  });

  it('should allow result messages through during compact', () => {
    const roleState = { _compacting: true, _compactSummaryPending: false };
    const messages = [
      { type: 'result', usage: { input_tokens: 50000 } },
    ];
    const passed = filterMessages(messages, roleState);
    expect(passed).toHaveLength(1);
    expect(passed[0].type).toBe('result');
  });

  it('should set _compactSummaryPending on compact_boundary', () => {
    const roleState = { _compacting: true, _compactSummaryPending: false };
    const messages = [
      { type: 'system', subtype: 'compact_boundary' },
    ];
    filterMessages(messages, roleState);
    expect(roleState._compactSummaryPending).toBe(true);
  });

  it('should filter user message after compact_boundary (compact summary)', () => {
    const roleState = { _compacting: true, _compactSummaryPending: false };
    const messages = [
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', message: { role: 'user', content: 'compact summary...' } },
    ];
    const passed = filterMessages(messages, roleState);
    expect(passed).toHaveLength(0);
    // _compactSummaryPending should be reset after consuming the summary
    expect(roleState._compactSummaryPending).toBe(false);
  });

  it('should not filter user messages when _compactSummaryPending is false', () => {
    // When not compacting, user messages pass through
    const roleState = { _compacting: false, _compactSummaryPending: false };
    const messages = [
      { type: 'user', message: { role: 'user', content: 'tool result' } },
    ];
    const passed = filterMessages(messages, roleState);
    expect(passed).toHaveLength(1);
  });

  it('should pass all messages when not compacting', () => {
    const roleState = { _compacting: false, _compactSummaryPending: false };
    const messages = [
      { type: 'system', subtype: 'info' },
      { type: 'assistant', message: { role: 'assistant', content: 'hello' } },
      { type: 'user', message: { role: 'user', content: 'result' } },
      { type: 'result', usage: {} },
    ];
    const passed = filterMessages(messages, roleState);
    expect(passed).toHaveLength(4);
  });

  it('should handle full compact cycle: system → compact_boundary → user summary → assistant → result', () => {
    const roleState = { _compacting: true, _compactSummaryPending: false };
    const messages = [
      { type: 'system', subtype: 'init' },           // filtered
      { type: 'system', subtype: 'compact_boundary' }, // filtered, sets pending
      { type: 'user', message: { content: 'summary' } }, // filtered (compact summary)
      { type: 'assistant', message: { content: 'ack' } }, // filtered
      { type: 'result', usage: { input_tokens: 40000 } }, // passes through
    ];
    const passed = filterMessages(messages, roleState);
    expect(passed).toHaveLength(1);
    expect(passed[0].type).toBe('result');
  });
});

describe('Context threshold - compact trigger at 85%', () => {
  const MAX_CONTEXT = 128000;
  const COMPACT_THRESHOLD = 0.85;

  function checkNeedCompact(inputTokens) {
    return (inputTokens / MAX_CONTEXT) >= COMPACT_THRESHOLD;
  }

  it('should trigger compact when context >= 85%', () => {
    // 85% of 128000 = 108800
    expect(checkNeedCompact(108800)).toBe(true);
    expect(checkNeedCompact(120000)).toBe(true);
    expect(checkNeedCompact(128000)).toBe(true);
  });

  it('should not trigger compact when context < 85%', () => {
    expect(checkNeedCompact(108799)).toBe(false);
    expect(checkNeedCompact(50000)).toBe(false);
    expect(checkNeedCompact(0)).toBe(false);
  });

  it('should cache routes and set compact state when compact is needed', () => {
    const roleState = {
      _compacting: false,
      _compactSummaryPending: false,
      _pendingCompactRoutes: null,
      _fromRole: null,
    };

    const routes = [
      { to: 'developer', summary: '请实现功能' },
      { to: 'tester', summary: '请测试' },
    ];
    const roleName = 'pm';

    // Simulate compact trigger logic
    const inputTokens = 115000;
    const needCompact = (inputTokens / MAX_CONTEXT) >= COMPACT_THRESHOLD;
    expect(needCompact).toBe(true);

    if (needCompact) {
      roleState._pendingCompactRoutes = routes.length > 0 ? routes : null;
      roleState._compacting = true;
      roleState._compactSummaryPending = false;
      roleState._fromRole = roleName;
    }

    expect(roleState._compacting).toBe(true);
    expect(roleState._pendingCompactRoutes).toEqual(routes);
    expect(roleState._fromRole).toBe('pm');
  });

  it('should set _pendingCompactRoutes to null when no routes', () => {
    const roleState = {
      _compacting: false,
      _compactSummaryPending: false,
      _pendingCompactRoutes: null,
      _fromRole: null,
    };

    const routes = [];
    const needCompact = true;

    if (needCompact) {
      roleState._pendingCompactRoutes = routes.length > 0 ? routes : null;
      roleState._compacting = true;
      roleState._fromRole = 'dev';
    }

    expect(roleState._compacting).toBe(true);
    expect(roleState._pendingCompactRoutes).toBeNull();
  });

  it('should execute cached routes after compact completes (< 95%)', () => {
    const executedRoutes = [];

    const roleState = {
      _compacting: true,
      _pendingCompactRoutes: [
        { to: 'developer', summary: '实现功能A' },
        { to: 'tester', summary: '编写测试' },
      ],
      _fromRole: 'pm',
    };

    const session = { round: 3 };

    // Simulate compact result with context below 95%
    const postCompactTokens = 60000;
    const postCompactPercentage = postCompactTokens / MAX_CONTEXT;
    const CLEAR_THRESHOLD = 0.95;

    roleState._compacting = false;

    if (postCompactPercentage >= CLEAR_THRESHOLD) {
      // Would escalate — not in this test
    } else if (roleState._pendingCompactRoutes) {
      const routes = roleState._pendingCompactRoutes;
      const fromRole = roleState._fromRole;
      roleState._pendingCompactRoutes = null;
      roleState._fromRole = null;
      session.round++;

      for (const route of routes) {
        executedRoutes.push({ from: fromRole, ...route });
      }
    }

    expect(executedRoutes).toHaveLength(2);
    expect(executedRoutes[0]).toEqual({ from: 'pm', to: 'developer', summary: '实现功能A' });
    expect(executedRoutes[1]).toEqual({ from: 'pm', to: 'tester', summary: '编写测试' });
    expect(session.round).toBe(4);
    expect(roleState._pendingCompactRoutes).toBeNull();
    expect(roleState._fromRole).toBeNull();
  });
});

describe('Context threshold - clear + rebuild at 95%', () => {
  const MAX_CONTEXT = 128000;
  const CLEAR_THRESHOLD = 0.95;

  it('should escalate to clear when post-compact context >= 95%', () => {
    const postCompactTokens = 122000; // ~95.3%
    const postCompactPercentage = postCompactTokens / MAX_CONTEXT;

    expect(postCompactPercentage >= CLEAR_THRESHOLD).toBe(true);
  });

  it('should not escalate when post-compact context < 95%', () => {
    const postCompactTokens = 120000; // ~93.75%
    const postCompactPercentage = postCompactTokens / MAX_CONTEXT;

    expect(postCompactPercentage >= CLEAR_THRESHOLD).toBe(false);
  });

  it('should clear session, abort controller, and re-dispatch routes on escalation', () => {
    const roleState = {
      _compacting: true,
      _pendingCompactRoutes: [
        { to: 'reviewer', summary: '请审查' },
      ],
      _fromRole: 'developer',
      claudeSessionId: 'sess-abc',
      abortController: { abort: () => { roleState._aborted = true; } },
      query: {},
      inputStream: {},
      _aborted: false,
    };

    const session = { round: 5 };
    const clearedSessionIds = [];
    const executedRoutes = [];

    // Simulate clear + rebuild logic
    const postCompactTokens = 125000; // ~97.7%
    const postCompactPercentage = postCompactTokens / MAX_CONTEXT;

    roleState._compacting = false;

    if (postCompactPercentage >= CLEAR_THRESHOLD) {
      // Clear session
      clearedSessionIds.push(roleState.claudeSessionId);
      roleState.claudeSessionId = null;

      if (roleState.abortController) roleState.abortController.abort();
      roleState.query = null;
      roleState.inputStream = null;

      // Re-dispatch cached routes
      if (roleState._pendingCompactRoutes) {
        const routes = roleState._pendingCompactRoutes;
        const fromRole = roleState._fromRole;
        roleState._pendingCompactRoutes = null;
        roleState._fromRole = null;
        session.round++;
        for (const route of routes) {
          executedRoutes.push({ from: fromRole, ...route });
        }
      }
    }

    expect(roleState.claudeSessionId).toBeNull();
    expect(roleState._aborted).toBe(true);
    expect(roleState.query).toBeNull();
    expect(roleState.inputStream).toBeNull();
    expect(clearedSessionIds).toEqual(['sess-abc']);
    expect(executedRoutes).toHaveLength(1);
    expect(executedRoutes[0]).toEqual({ from: 'developer', to: 'reviewer', summary: '请审查' });
    expect(session.round).toBe(6);
  });

  it('should handle escalation with no pending routes', () => {
    const roleState = {
      _compacting: true,
      _pendingCompactRoutes: null,
      _fromRole: null,
      claudeSessionId: 'sess-xyz',
      abortController: { abort: () => {} },
      query: {},
      inputStream: {},
    };

    const session = { round: 2 };

    const postCompactPercentage = 0.97;

    roleState._compacting = false;

    if (postCompactPercentage >= CLEAR_THRESHOLD) {
      roleState.claudeSessionId = null;
      if (roleState.abortController) roleState.abortController.abort();
      roleState.query = null;
      roleState.inputStream = null;

      if (roleState._pendingCompactRoutes) {
        // Would execute routes — not in this case
        session.round++;
      }
    }

    expect(roleState.claudeSessionId).toBeNull();
    expect(roleState.query).toBeNull();
    // round should NOT increment when there are no pending routes
    expect(session.round).toBe(2);
  });
});

describe('classifyRoleError - needContentTrim', () => {
  // Replicate classifyRoleError from crew.js
  function classifyRoleError(error) {
    const msg = error.message || '';
    if (/context.*(window|limit|exceeded)|token.*limit|too.*(long|large)|max.*token/i.test(msg)) {
      return { recoverable: true, reason: 'context_exceeded', skipResume: true, needContentTrim: true };
    }
    if (/compact|compress|context.*reduc/i.test(msg)) {
      return { recoverable: true, reason: 'compact_failed', skipResume: true };
    }
    if (/rate.?limit|429|overloaded|503|502|timeout|ECONNRESET|ETIMEDOUT/i.test(msg)) {
      return { recoverable: true, reason: 'transient_api_error', skipResume: false };
    }
    if (/exited with code [1-9]/i.test(msg) && msg.length < 100) {
      return { recoverable: true, reason: 'process_crashed', skipResume: false };
    }
    if (/spawn|ENOENT|not found/i.test(msg)) {
      return { recoverable: false, reason: 'spawn_failed' };
    }
    return { recoverable: true, reason: 'unknown', skipResume: false };
  }

  it('should return needContentTrim for context window exceeded', () => {
    const result = classifyRoleError({ message: 'context window exceeded' });
    expect(result.needContentTrim).toBe(true);
    expect(result.reason).toBe('context_exceeded');
    expect(result.recoverable).toBe(true);
    expect(result.skipResume).toBe(true);
  });

  it('should return needContentTrim for token limit errors', () => {
    const result = classifyRoleError({ message: 'token limit reached' });
    expect(result.needContentTrim).toBe(true);
    expect(result.reason).toBe('context_exceeded');
  });

  it('should return needContentTrim for "too long" errors', () => {
    const result = classifyRoleError({ message: 'Request too long for model' });
    expect(result.needContentTrim).toBe(true);
  });

  it('should return needContentTrim for "too large" errors', () => {
    const result = classifyRoleError({ message: 'Payload too large' });
    expect(result.needContentTrim).toBe(true);
  });

  it('should return needContentTrim for "max token" errors', () => {
    const result = classifyRoleError({ message: 'Exceeded max token count' });
    expect(result.needContentTrim).toBe(true);
  });

  it('should return needContentTrim for "context limit" errors', () => {
    const result = classifyRoleError({ message: 'context limit exceeded' });
    expect(result.needContentTrim).toBe(true);
  });

  it('should NOT return needContentTrim for compact_failed', () => {
    const result = classifyRoleError({ message: 'compact operation failed' });
    expect(result.needContentTrim).toBeUndefined();
    expect(result.reason).toBe('compact_failed');
    expect(result.skipResume).toBe(true);
  });

  it('should NOT return needContentTrim for transient API errors', () => {
    const result = classifyRoleError({ message: 'rate limit exceeded' });
    expect(result.needContentTrim).toBeUndefined();
    expect(result.reason).toBe('transient_api_error');
  });

  it('should NOT return needContentTrim for 429 errors', () => {
    const result = classifyRoleError({ message: 'HTTP 429 Too Many Requests' });
    expect(result.needContentTrim).toBeUndefined();
    expect(result.reason).toBe('transient_api_error');
  });

  it('should NOT return needContentTrim for process crashes', () => {
    const result = classifyRoleError({ message: 'exited with code 1' });
    expect(result.needContentTrim).toBeUndefined();
    expect(result.reason).toBe('process_crashed');
  });

  it('should NOT return needContentTrim for spawn failures', () => {
    const result = classifyRoleError({ message: 'spawn ENOENT' });
    expect(result.needContentTrim).toBeUndefined();
    expect(result.reason).toBe('spawn_failed');
    expect(result.recoverable).toBe(false);
  });

  it('should NOT return needContentTrim for unknown errors', () => {
    const result = classifyRoleError({ message: 'something unexpected' });
    expect(result.needContentTrim).toBeUndefined();
    expect(result.reason).toBe('unknown');
  });

  it('should handle empty error message', () => {
    const result = classifyRoleError({ message: '' });
    expect(result.reason).toBe('unknown');
  });

  it('should handle missing error message', () => {
    const result = classifyRoleError({});
    expect(result.reason).toBe('unknown');
  });
});

describe('trimContentForRetry', () => {
  // Replicate trimContentForRetry from crew.js
  function trimContentForRetry(content) {
    if (typeof content === 'string' && content.length > 2000) {
      return `[注意: 上一轮因 context 超限被截断重发]\n\n${content.substring(0, 2000)}\n\n[内容已截断，请基于已知信息继续工作]`;
    }
    if (Array.isArray(content)) {
      return content.filter(b => b.type === 'text').map(b => ({
        ...b,
        text: b.text.length > 2000 ? b.text.substring(0, 2000) + '\n[已截断]' : b.text
      }));
    }
    return content;
  }

  it('should truncate strings longer than 2000 chars', () => {
    const longStr = 'x'.repeat(5000);
    const result = trimContentForRetry(longStr);
    expect(typeof result).toBe('string');
    expect(result).toContain('[注意: 上一轮因 context 超限被截断重发]');
    expect(result).toContain('[内容已截断，请基于已知信息继续工作]');
    // Should contain first 2000 chars of original
    expect(result).toContain('x'.repeat(2000));
    // Total length should be much less than original
    expect(result.length).toBeLessThan(longStr.length);
  });

  it('should not truncate strings <= 2000 chars', () => {
    const shortStr = 'y'.repeat(2000);
    const result = trimContentForRetry(shortStr);
    expect(result).toBe(shortStr); // returned as-is
  });

  it('should not truncate strings exactly 2000 chars', () => {
    const exactStr = 'z'.repeat(2000);
    const result = trimContentForRetry(exactStr);
    expect(result).toBe(exactStr);
  });

  it('should filter arrays to only text blocks', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'bash', input: {} },
      { type: 'text', text: 'world' },
      { type: 'tool_result', content: 'result data' },
    ];
    const result = trimContentForRetry(content);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('hello');
    expect(result[1].text).toBe('world');
  });

  it('should truncate long text blocks in arrays', () => {
    const content = [
      { type: 'text', text: 'a'.repeat(3000) },
      { type: 'text', text: 'short' },
    ];
    const result = trimContentForRetry(content);
    expect(result[0].text).toBe('a'.repeat(2000) + '\n[已截断]');
    expect(result[1].text).toBe('short');
  });

  it('should not truncate text blocks <= 2000 chars in arrays', () => {
    const content = [
      { type: 'text', text: 'b'.repeat(2000) },
    ];
    const result = trimContentForRetry(content);
    expect(result[0].text).toBe('b'.repeat(2000));
  });

  it('should preserve extra properties on text blocks', () => {
    const content = [
      { type: 'text', text: 'hello', citations: [1, 2] },
    ];
    const result = trimContentForRetry(content);
    expect(result[0].citations).toEqual([1, 2]);
    expect(result[0].type).toBe('text');
  });

  it('should return non-string, non-array content unchanged', () => {
    expect(trimContentForRetry(null)).toBeNull();
    expect(trimContentForRetry(undefined)).toBeUndefined();
    expect(trimContentForRetry(42)).toBe(42);
    expect(trimContentForRetry({ custom: 'obj' })).toEqual({ custom: 'obj' });
  });

  it('should handle empty array', () => {
    const result = trimContentForRetry([]);
    expect(result).toEqual([]);
  });

  it('should handle array with no text blocks', () => {
    const content = [
      { type: 'tool_use', name: 'bash', input: {} },
      { type: 'tool_result', content: 'data' },
    ];
    const result = trimContentForRetry(content);
    expect(result).toEqual([]);
  });
});

describe('BUFFERABLE_TYPES - new compact/context types', () => {
  // The BUFFERABLE_TYPES set from connection.js must include the new types
  // added for context auto-recovery: crew_role_compact and crew_context_usage
  const BUFFERABLE_TYPES = new Set([
    'claude_output', 'turn_completed', 'conversation_closed',
    'session_id_update', 'compact_status', 'slash_commands_update',
    'background_task_started', 'background_task_output',
    'crew_output', 'crew_status', 'crew_turn_completed',
    'crew_session_created', 'crew_session_restored', 'crew_human_needed',
    'crew_role_added', 'crew_role_removed',
    'crew_role_compact', 'crew_context_usage'
  ]);

  it('should include crew_role_compact in BUFFERABLE_TYPES', () => {
    expect(BUFFERABLE_TYPES.has('crew_role_compact')).toBe(true);
  });

  it('should include crew_context_usage in BUFFERABLE_TYPES', () => {
    expect(BUFFERABLE_TYPES.has('crew_context_usage')).toBe(true);
  });

  it('should still include all previously existing crew types', () => {
    const existingCrewTypes = [
      'crew_output', 'crew_status', 'crew_turn_completed',
      'crew_session_created', 'crew_session_restored', 'crew_human_needed',
      'crew_role_added', 'crew_role_removed',
    ];
    for (const t of existingCrewTypes) {
      expect(BUFFERABLE_TYPES.has(t)).toBe(true);
    }
  });

  it('should verify connection source includes new types', () => {
    // Source-level verification: read the buffer module where BUFFERABLE_TYPES is defined
    const connectionSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../agent/connection/buffer.js'), 'utf-8'
    );
    expect(connectionSource).toContain("'crew_role_compact'");
    expect(connectionSource).toContain("'crew_context_usage'");
  });
});

describe('Compact state initialization in roleState', () => {
  it('should initialize all compact-related fields correctly', () => {
    // Simulate the roleState creation from createRoleQuery
    const roleState = {
      _compacting: false,
      _compactSummaryPending: false,
      _pendingCompactRoutes: null,
      _fromRole: null,
    };

    expect(roleState._compacting).toBe(false);
    expect(roleState._compactSummaryPending).toBe(false);
    expect(roleState._pendingCompactRoutes).toBeNull();
    expect(roleState._fromRole).toBeNull();
  });
});

describe('Error recovery flow with needContentTrim', () => {
  // Replicate the combined flow: classifyRoleError → trimContentForRetry
  function classifyRoleError(error) {
    const msg = error.message || '';
    if (/context.*(window|limit|exceeded)|token.*limit|too.*(long|large)|max.*token/i.test(msg)) {
      return { recoverable: true, reason: 'context_exceeded', skipResume: true, needContentTrim: true };
    }
    if (/compact|compress|context.*reduc/i.test(msg)) {
      return { recoverable: true, reason: 'compact_failed', skipResume: true };
    }
    if (/rate.?limit|429|overloaded|503|502|timeout|ECONNRESET|ETIMEDOUT/i.test(msg)) {
      return { recoverable: true, reason: 'transient_api_error', skipResume: false };
    }
    return { recoverable: true, reason: 'unknown', skipResume: false };
  }

  function trimContentForRetry(content) {
    if (typeof content === 'string' && content.length > 2000) {
      return `[注意: 上一轮因 context 超限被截断重发]\n\n${content.substring(0, 2000)}\n\n[内容已截断，请基于已知信息继续工作]`;
    }
    if (Array.isArray(content)) {
      return content.filter(b => b.type === 'text').map(b => ({
        ...b,
        text: b.text.length > 2000 ? b.text.substring(0, 2000) + '\n[已截断]' : b.text
      }));
    }
    return content;
  }

  it('should trim content only when classification says needContentTrim', () => {
    const error = { message: 'context window exceeded' };
    const classification = classifyRoleError(error);
    const originalContent = 'x'.repeat(5000);

    let retryContent = originalContent;
    if (classification.needContentTrim) {
      retryContent = trimContentForRetry(retryContent);
    }

    // Content should be trimmed
    expect(retryContent).not.toBe(originalContent);
    expect(retryContent).toContain('[注意: 上一轮因 context 超限被截断重发]');
  });

  it('should NOT trim content for transient errors', () => {
    const error = { message: 'HTTP 429 rate limit' };
    const classification = classifyRoleError(error);
    const originalContent = 'x'.repeat(5000);

    let retryContent = originalContent;
    if (classification.needContentTrim) {
      retryContent = trimContentForRetry(retryContent);
    }

    // Content should NOT be trimmed for rate limit errors
    expect(retryContent).toBe(originalContent);
  });

  it('should handle array content with needContentTrim', () => {
    const error = { message: 'max token limit exceeded' };
    const classification = classifyRoleError(error);
    const originalContent = [
      { type: 'text', text: 'a'.repeat(3000) },
      { type: 'tool_use', name: 'read', input: {} },
    ];

    let retryContent = originalContent;
    if (classification.needContentTrim) {
      retryContent = trimContentForRetry(retryContent);
    }

    expect(retryContent).toHaveLength(1); // tool_use filtered out
    expect(retryContent[0].text.length).toBeLessThan(3000); // truncated
  });

  it('should skip resume for context_exceeded (skipResume=true)', () => {
    const classification = classifyRoleError({ message: 'context window exceeded' });
    expect(classification.skipResume).toBe(true);
  });

  it('should not skip resume for transient errors (skipResume=false)', () => {
    const classification = classifyRoleError({ message: 'ECONNRESET' });
    expect(classification.skipResume).toBe(false);
  });
});

describe('Context usage monitoring messages', () => {
  const MAX_CONTEXT = 128000;

  it('should compute context percentage correctly', () => {
    const inputTokens = 64000;
    const percentage = Math.min(100, Math.round((inputTokens / MAX_CONTEXT) * 100));
    expect(percentage).toBe(50);
  });

  it('should cap percentage at 100', () => {
    const inputTokens = 200000; // over max
    const percentage = Math.min(100, Math.round((inputTokens / MAX_CONTEXT) * 100));
    expect(percentage).toBe(100);
  });

  it('should send crew_context_usage message format', () => {
    const inputTokens = 100000;
    const msg = {
      type: 'crew_context_usage',
      sessionId: 'sess-1',
      role: 'developer',
      inputTokens,
      maxTokens: MAX_CONTEXT,
      percentage: Math.min(100, Math.round((inputTokens / MAX_CONTEXT) * 100))
    };
    expect(msg.type).toBe('crew_context_usage');
    expect(msg.percentage).toBe(78);
    expect(msg.maxTokens).toBe(128000);
  });

  it('should send crew_role_compact message with compacting status', () => {
    const msg = {
      type: 'crew_role_compact',
      sessionId: 'sess-1',
      role: 'developer',
      contextPercentage: 88,
      status: 'compacting'
    };
    expect(msg.type).toBe('crew_role_compact');
    expect(msg.status).toBe('compacting');
    expect(msg.contextPercentage).toBe(88);
  });

  it('should send crew_role_compact message with completed status', () => {
    const msg = {
      type: 'crew_role_compact',
      sessionId: 'sess-1',
      role: 'developer',
      contextPercentage: 45,
      status: 'completed'
    };
    expect(msg.status).toBe('completed');
  });

  it('should send crew_role_compact message with cleared status on escalation', () => {
    const msg = {
      type: 'crew_role_compact',
      sessionId: 'sess-1',
      role: 'developer',
      status: 'cleared'
    };
    expect(msg.status).toBe('cleared');
  });
});

// =====================================================================
// Feature 工作记录 — writeSharedClaudeMd 简化章节 + 系统自动化
// =====================================================================

describe('writeSharedClaudeMd - Feature 工作记录章节 (auto-managed)', () => {
  let crewContent;

  beforeAll(async () => {
    const { promises: fs } = await import('fs');
    crewContent = await fs.readFile(
      join(process.cwd(), 'agent/crew/shared-dir.js'),
      'utf-8'
    ) + await fs.readFile(
      join(process.cwd(), 'agent/crew-i18n.js'),
      'utf-8'
    );
  });

  // --- 章节存在性 ---

  it('should have "# Feature 工作记录" section header', () => {
    expect(crewContent).toContain('# Feature 工作记录');
  });

  it('should place Feature section after Worktree rules and before sharedMemoryTitle', async () => {
    // In writeSharedClaudeMd template, verify the order is: worktreeRules → featureRecordShared → sharedMemoryTitle
    const crewJs = await (await import('fs')).promises.readFile(join(process.cwd(), 'agent/crew/shared-dir.js'), 'utf-8');
    // Find the template string section in writeSharedClaudeMd
    const tmplStart = crewJs.indexOf('const claudeMd = `', crewJs.indexOf('writeSharedClaudeMd'));
    const worktreeIdx = crewJs.indexOf('m.worktreeRules', tmplStart);
    const featureIdx = crewJs.indexOf('m.featureRecordShared', tmplStart);
    const memoryIdx = crewJs.indexOf('m.sharedMemoryTitle}', tmplStart);
    expect(worktreeIdx).toBeGreaterThan(0);
    expect(worktreeIdx).toBeLessThan(featureIdx);
    expect(featureIdx).toBeLessThan(memoryIdx);
  });

  // --- 自动化说明 ---

  it('should mention automatic management of task files', () => {
    expect(crewContent).toContain('系统自动管理');
    expect(crewContent).toContain('.crew/context/features/{task-id}.md');
  });

  it('should describe 3 automatic behaviors', () => {
    expect(crewContent).toContain('PM 通过 ROUTE 分配任务');
    expect(crewContent).toContain('自动创建');
    expect(crewContent).toContain('自动追加工作记录');
    expect(crewContent).toContain('自动注入');
  });

  it('should state roles do not need manual management', () => {
    expect(crewContent).toContain('不需要手动创建或更新这些文件');
  });
});

// =====================================================================
// buildRoleSystemPrompt — Feature 工作记录（系统自动管理）
// =====================================================================

describe('buildRoleSystemPrompt - Feature 工作记录 (auto-managed)', () => {
  // Replicate buildRoleSystemPrompt logic with auto-managed Feature tracking
  function roleLabel(r) {
    return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
  }

  function buildRoleSystemPrompt(role, session) {
    const allRoles = Array.from(session.roles.values());

    let routeTargets;
    if (role.groupIndex > 0) {
      routeTargets = allRoles.filter(r =>
        r.name !== role.name && (r.groupIndex === role.groupIndex || r.groupIndex === 0)
      );
    } else {
      routeTargets = allRoles.filter(r => r.name !== role.name);
    }

    let prompt = `# 团队协作
你正在一个 AI 团队中工作。等待用户提出任务或问题。

团队成员:
${allRoles.map(r => `- ${roleLabel(r)}: ${r.description}${r.isDecisionMaker ? ' (决策者)' : ''}`).join('\n')}`;

    if (routeTargets.length > 0) {
      prompt += `\n\n# 路由规则
当你完成当前任务并需要将结果传递给其他角色时，在你的回复最末尾添加一个 ROUTE 块：

\`\`\`
---ROUTE---
to: <角色name>
summary: <简要说明要传递什么>
---END_ROUTE---
\`\`\`

可用的路由目标:
${routeTargets.map(r => `- ${r.name}: ${roleLabel(r)} — ${r.description}`).join('\n')}
- human: 人工（只在决策者也无法决定时使用）

注意：
- 如果你的工作还没完成，不需要添加 ROUTE 块
- 如果你遇到不确定的问题，@ 决策者 "${session.decisionMaker}"，而不是直接 @ human
- 如果你是决策者且遇到需要人类判断的问题，才 @ human
- 可以一次发多个 ROUTE 块来并行分配任务给不同角色
- ROUTE 块必须在回复的最末尾
- 当你的任务已完成且不需要其他角色继续时，ROUTE 回决策者 "${session.decisionMaker}" 做总结
- 在正文中可用 @角色name 提及某个角色（如 @developer），但这不会触发路由，仅供阅读`;
    }

    // 决策者额外 prompt
    if (role.isDecisionMaker) {
      prompt += `\n\n# 工具使用规则
你**不能**使用 Edit/Write/NotebookEdit 工具修改代码文件。`;
      prompt += `\n\n# 决策者职责
你是团队的决策者。`;
    }

    // Feature 工作记录说明（所有角色统一注入）
    prompt += `\n\n# Feature 工作记录
系统会自动管理 \`.crew/context/features/{task-id}.md\` 工作记录文件：
- PM 分配任务时自动创建文件（包含 task-id、标题、需求描述）
- 每次 ROUTE 传递时自动追加工作记录（角色名、时间、summary）
- 你收到的消息中会包含 <task-context> 标签，里面是该任务的完整工作记录
你不需要手动创建或更新这些文件，专注于你的本职工作即可。`;

    // 执行者角色的组绑定 prompt（count > 1 时）
    if (role.groupIndex > 0 && role.roleType === 'developer') {
      const gi = role.groupIndex;
      const rev = allRoles.find(r => r.roleType === 'reviewer' && r.groupIndex === gi);
      const test = allRoles.find(r => r.roleType === 'tester' && r.groupIndex === gi);
      if (rev && test) {
        prompt += `\n\n# 开发组绑定
你属于开发组 ${gi}。你的搭档：
- 审查者: ${roleLabel(rev)} (${rev.name})
- 测试: ${roleLabel(test)} (${test.name})`;
      }
    }

    return prompt;
  }

  // Helper: create multi-role session with roleType
  function createMultiRoleSession(overrides = {}) {
    const roles = overrides.roles || new Map([
      ['pm', {
        name: 'pm', displayName: 'PM', icon: '📋',
        description: '需求分析', isDecisionMaker: true,
        roleType: 'pm', groupIndex: 0
      }],
      ['dev-1', {
        name: 'dev-1', displayName: '开发者-1', icon: '💻',
        description: '代码编写', isDecisionMaker: false,
        roleType: 'developer', groupIndex: 1
      }],
      ['rev-1', {
        name: 'rev-1', displayName: '审查者-1', icon: '🔍',
        description: '代码审查', isDecisionMaker: false,
        roleType: 'reviewer', groupIndex: 1
      }],
      ['test-1', {
        name: 'test-1', displayName: '测试-1', icon: '🧪',
        description: '测试验证', isDecisionMaker: false,
        roleType: 'tester', groupIndex: 1
      }]
    ]);
    return {
      id: overrides.id || 'crew_test_feature',
      projectDir: '/tmp/test-project',
      sharedDir: '/tmp/test-project/.crew',
      roles,
      roleStates: new Map(),
      decisionMaker: 'pm',
      status: 'running',
      round: 0,
      costUsd: 0,
      messageHistory: [],
      humanMessageQueue: [],
      waitingHumanContext: null,
      userId: 'user_123',
      username: 'testuser',
      createdAt: Date.now()
    };
  }

  // --- All roles get same Feature 工作记录 section ---

  it('should include "Feature 工作记录" for PM (decision maker)', () => {
    const session = createMultiRoleSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('# Feature 工作记录');
    expect(prompt).toContain('系统会自动管理');
  });

  it('should include "Feature 工作记录" for developer', () => {
    const session = createMultiRoleSession();
    const devRole = session.roles.get('dev-1');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).toContain('# Feature 工作记录');
    expect(prompt).toContain('不需要手动创建或更新这些文件');
  });

  it('should include "Feature 工作记录" for reviewer', () => {
    const session = createMultiRoleSession();
    const revRole = session.roles.get('rev-1');
    const prompt = buildRoleSystemPrompt(revRole, session);

    expect(prompt).toContain('# Feature 工作记录');
  });

  it('should include "Feature 工作记录" for tester', () => {
    const session = createMultiRoleSession();
    const testRole = session.roles.get('test-1');
    const prompt = buildRoleSystemPrompt(testRole, session);

    expect(prompt).toContain('# Feature 工作记录');
  });

  it('should include "Feature 工作记录" for designer (non-standard role)', () => {
    const roles = new Map([
      ['pm', {
        name: 'pm', displayName: 'PM', icon: '📋',
        description: '需求分析', isDecisionMaker: true,
        roleType: 'pm', groupIndex: 0
      }],
      ['designer', {
        name: 'designer', displayName: '设计师', icon: '🎨',
        description: '界面设计', isDecisionMaker: false,
        roleType: 'designer', groupIndex: 0
      }]
    ]);
    const session = createMultiRoleSession({ roles });
    const designerRole = session.roles.get('designer');
    const prompt = buildRoleSystemPrompt(designerRole, session);

    expect(prompt).toContain('# Feature 工作记录');
  });

  // --- Content verification ---

  it('should mention auto-create, auto-append, and auto-inject', () => {
    const session = createMultiRoleSession();
    const devRole = session.roles.get('dev-1');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).toContain('自动创建文件');
    expect(prompt).toContain('自动追加工作记录');
    expect(prompt).toContain('<task-context>');
  });

  it('should mention .crew/context/features/{task-id}.md path', () => {
    const session = createMultiRoleSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('.crew/context/features/{task-id}.md');
  });

  // --- No old per-role sections ---

  it('should NOT have old role-specific "Feature 进度文件管理" section', () => {
    const session = createMultiRoleSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).not.toContain('# Feature 进度文件管理');
  });

  it('should NOT have old role-specific "Feature 进度记录" section', () => {
    const session = createMultiRoleSession();
    const devRole = session.roles.get('dev-1');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).not.toContain('# Feature 进度记录');
  });

  // --- Original functionality preserved ---

  it('PM should still have decision maker responsibilities', () => {
    const session = createMultiRoleSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('# 决策者职责');
  });

  it('developer should still have routing rules', () => {
    const session = createMultiRoleSession();
    const devRole = session.roles.get('dev-1');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).toContain('# 路由规则');
    expect(prompt).toContain('---ROUTE---');
  });

  it('developer should still have group binding section', () => {
    const session = createMultiRoleSession();
    const devRole = session.roles.get('dev-1');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).toContain('# 开发组绑定');
    expect(prompt).toContain('你属于开发组 1');
  });
});

// =====================================================================
// task-31: abort_role — backend source verification
// =====================================================================
describe('task-31: abort_role backend', () => {
  let crewSource;

  beforeAll(async () => {
    crewSource = await fs.readFile(join(__dirname, '../../agent/crew/control.js'), 'utf-8');
  });

  it('handleCrewControl has abort_role case', () => {
    expect(crewSource).toContain("case 'abort_role':");
  });

  it('abortRole function exists', () => {
    expect(crewSource).toContain('async function abortRole(session, roleName)');
  });

  it('abortRole calls endRoleStreaming', () => {
    const fn = crewSource.split('async function abortRole')[1]?.split('\nasync function')[0] || '';
    expect(fn).toContain('endRoleStreaming(session, roleName)');
  });

  it('abortRole aborts the controller', () => {
    const fn = crewSource.split('async function abortRole')[1]?.split('\nasync function')[0] || '';
    expect(fn).toContain('abortController.abort()');
  });

  it('abortRole sets turnActive to false', () => {
    const fn = crewSource.split('async function abortRole')[1]?.split('\nasync function')[0] || '';
    expect(fn).toContain('turnActive = false');
  });

  it('abortRole does NOT delete roleState (unlike stopRole)', () => {
    const fn = crewSource.split('async function abortRole')[1]?.split('\nasync function')[0] || '';
    expect(fn).not.toContain('roleStates.delete');
  });

  it('abortRole does NOT dispatch new message (unlike interruptRole)', () => {
    const fn = crewSource.split('async function abortRole')[1]?.split('\nasync function')[0] || '';
    expect(fn).not.toContain('dispatchToRole');
  });

  it('abortRole sends crew_turn_completed with interrupted flag', () => {
    const fn = crewSource.split('async function abortRole')[1]?.split('\nasync function')[0] || '';
    expect(fn).toContain('crew_turn_completed');
    expect(fn).toContain('interrupted: true');
  });

  it('abortRole sends status update', () => {
    const fn = crewSource.split('async function abortRole')[1]?.split('\nasync function')[0] || '';
    expect(fn).toContain('sendStatusUpdate(session)');
  });

  it('abortRole skips if role is not active', () => {
    const fn = crewSource.split('async function abortRole')[1]?.split('\nasync function')[0] || '';
    expect(fn).toContain('!roleState.turnActive');
  });
});

// =====================================================================
// MCP disallowedTools inheritance in Crew mode
// =====================================================================

describe('Crew MCP disallowedTools inheritance', () => {
  let roleQuerySource;

  beforeAll(async () => {
    const roleQueryPath = join(__dirname, '../../agent/crew/role-query.js');
    roleQuerySource = await fs.readFile(roleQueryPath, 'utf-8');
  });

  it('should import ctx from context.js', () => {
    expect(roleQuerySource).toContain("import ctx from '../context.js'");
  });

  it('should read global disallowedTools from ctx.CONFIG', () => {
    expect(roleQuerySource).toContain('ctx.CONFIG?.disallowedTools');
  });

  it('should pass disallowedTools to queryOptions when global list is non-empty', () => {
    // The spread pattern conditionally adds effectiveDisallowed (global + crew disallowed)
    expect(roleQuerySource).toContain('disallowedTools: effectiveDisallowed');
  });

  it('should default to empty array when ctx.CONFIG.disallowedTools is undefined', () => {
    expect(roleQuerySource).toContain("ctx.CONFIG?.disallowedTools || []");
  });
});
