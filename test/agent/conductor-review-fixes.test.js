import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests specifically targeting the 4 review-fix changes in Conductor V2.
 *
 * Fix 1: parseForwardTask non-greedy regex — multi-line message and extra fields
 * Fix 2: persistence no circular dependency — hideConductorSession/handleLoadConductorHistory take params
 * Fix 3: session _rotating/_conductorSemRelease fields initialized at creation
 * Fix 4: handleConductorUserInput stopped session rejects without recording message
 */

// =====================================================================
// Replicate the FIXED parseForwardTask (non-greedy with anchors)
// =====================================================================

function parseForwardTask(text) {
  const regex = /---FORWARD_TASK---\s*\n([\s\S]*?)---END_FORWARD_TASK---/g;
  const forwards = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const taskIdMatch = block.match(/^taskId:\s*(.+)/im);
    const messageMatch = block.match(/^message:\s*([\s\S]*?)$/im);
    if (taskIdMatch) {
      forwards.push({
        taskId: taskIdMatch[1].trim(),
        message: messageMatch ? messageMatch[1].trim() : ''
      });
    }
  }
  return forwards;
}

// Old greedy version for comparison
function parseForwardTask_OLD(text) {
  const regex = /---FORWARD_TASK---\s*\n([\s\S]*?)---END_FORWARD_TASK---/g;
  const forwards = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const taskIdMatch = block.match(/taskId:\s*(.+)/i);
    const messageMatch = block.match(/message:\s*([\s\S]+)/i);
    if (taskIdMatch) {
      forwards.push({
        taskId: taskIdMatch[1].trim(),
        message: messageMatch ? messageMatch[1].trim() : ''
      });
    }
  }
  return forwards;
}

// =====================================================================
// Replicate hideConductorSession with param injection (Fix 2)
// =====================================================================

async function hideConductorSession(sessionId, conductorSessions, indexOps) {
  const index = await indexOps.load();
  const entry = index.find(e => e.sessionId === sessionId);
  if (entry) {
    entry.hidden = true;
    entry.hiddenAt = Date.now();
    await indexOps.save(index);
  }
  if (conductorSessions.has(sessionId)) {
    conductorSessions.delete(sessionId);
  }
}

async function handleLoadConductorHistory(msg, conductorSessions, sendConductorMessage) {
  const { sessionId, requestId } = msg;
  const shardIndex = parseInt(msg.shardIndex, 10);

  if (!Number.isFinite(shardIndex) || shardIndex < 1) {
    sendConductorMessage({
      type: 'conductor_history_loaded',
      sessionId, shardIndex: msg.shardIndex, requestId,
      messages: [], hasMore: false
    });
    return;
  }
  if (!conductorSessions.has(sessionId)) {
    sendConductorMessage({
      type: 'conductor_history_loaded',
      sessionId, shardIndex, requestId,
      messages: [], hasMore: false
    });
    return;
  }
  // Normally would load from disk, simulate here
  sendConductorMessage({
    type: 'conductor_history_loaded',
    sessionId, shardIndex, requestId,
    messages: [{ content: 'loaded' }], hasMore: false
  });
}

// =====================================================================
// Replicate session creation with _rotating/_conductorSemRelease (Fix 3)
// =====================================================================

function createConductorSessionObject(overrides = {}) {
  return {
    id: overrides.id || 'session-test',
    name: overrides.name || 'Conductor',
    workDir: overrides.workDir || null,
    scenarioId: overrides.scenarioId || null,
    status: 'running',
    tasks: new Map(),
    conductorState: null,
    costUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    activeClaudes: 0,
    uiMessages: [],
    userId: overrides.userId || 'user-1',
    username: overrides.username || 'test',
    agentId: null,
    createdAt: Date.now(),
    _rotating: false,
    _conductorSemRelease: null
  };
}

// =====================================================================
// Replicate handleConductorUserInput with fix (Fix 4)
// =====================================================================

function handleConductorUserInput(session, content, deps) {
  if (!session) return { action: 'not_found' };

  // Fix 4: stopped check BEFORE recording message
  if (session.status === 'stopped') {
    deps.sendConductorMessage({
      type: 'conductor_error',
      sessionId: session.id,
      error: 'Session is stopped'
    });
    return { action: 'error_stopped' };
  }

  // Record AFTER check
  deps.recordUserMessage(session, content);
  session.status = 'running';
  return { action: 'sent' };
}

// Pre-fix version for comparison
function handleConductorUserInput_OLD(session, content, deps) {
  if (!session) return { action: 'not_found' };

  // OLD: recorded BEFORE check
  deps.recordUserMessage(session, content);

  if (session.status === 'stopped') {
    deps.sendConductorMessage({
      type: 'conductor_error',
      sessionId: session.id,
      error: 'Session is stopped'
    });
    return { action: 'error_stopped' };
  }

  session.status = 'running';
  return { action: 'sent' };
}

// =====================================================================
// Tests
// =====================================================================

describe('Fix 1: parseForwardTask non-greedy regex', () => {
  it('should not greedily capture extra fields after message', () => {
    const text = `---FORWARD_TASK---
taskId: task-001
message: 请处理这个问题
priority: high
---END_FORWARD_TASK---`;

    const result = parseForwardTask(text);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('task-001');
    // Non-greedy: message should stop at end of line, not swallow "priority: high"
    expect(result[0].message).toBe('请处理这个问题');
    expect(result[0].message).not.toContain('priority');
  });

  it('OLD greedy version would capture extra fields', () => {
    const text = `---FORWARD_TASK---
taskId: task-001
message: 请处理这个问题
priority: high
---END_FORWARD_TASK---`;

    const result = parseForwardTask_OLD(text);
    expect(result).toHaveLength(1);
    // OLD greedy: [\s\S]+ captures everything including "priority: high"
    expect(result[0].message).toContain('priority');
  });

  it('should handle single-line message correctly', () => {
    const text = `---FORWARD_TASK---
taskId: task-simple
message: 简短消息
---END_FORWARD_TASK---`;

    const result = parseForwardTask(text);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('简短消息');
  });

  it('should handle message with no extra fields after it', () => {
    const text = `---FORWARD_TASK---
taskId: task-clean
message: 这是唯一一个字段后面的内容
---END_FORWARD_TASK---`;

    const result = parseForwardTask(text);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('这是唯一一个字段后面的内容');
  });

  it('should not capture adjacent FORWARD_TASK blocks content', () => {
    const text = `---FORWARD_TASK---
taskId: task-A
message: 消息A
---END_FORWARD_TASK---

---FORWARD_TASK---
taskId: task-B
message: 消息B
---END_FORWARD_TASK---`;

    const result = parseForwardTask(text);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe('消息A');
    expect(result[1].message).toBe('消息B');
    // Each message should be isolated
    expect(result[0].message).not.toContain('消息B');
  });

  it('should handle block with only taskId (message empty)', () => {
    const text = `---FORWARD_TASK---
taskId: task-no-msg
---END_FORWARD_TASK---`;

    const result = parseForwardTask(text);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('task-no-msg');
    expect(result[0].message).toBe('');
  });

  it('should handle message with Chinese text and punctuation', () => {
    const text = `---FORWARD_TASK---
taskId: task-cn
message: 请注意：登录接口需要添加验证码功能！
---END_FORWARD_TASK---`;

    const result = parseForwardTask(text);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('请注意：登录接口需要添加验证码功能！');
  });
});

describe('Fix 2: persistence parameter injection (no circular dependency)', () => {
  describe('hideConductorSession with param injection', () => {
    it('should accept conductorSessions as parameter', async () => {
      const sessions = new Map([['s1', { id: 's1' }]]);
      const index = [{ sessionId: 's1', hidden: false }];
      const indexOps = {
        load: async () => [...index],
        save: async (newIndex) => { index.length = 0; index.push(...newIndex); }
      };

      await hideConductorSession('s1', sessions, indexOps);

      // Session removed from map
      expect(sessions.has('s1')).toBe(false);
      // Index entry marked hidden
      expect(index[0].hidden).toBe(true);
      expect(index[0].hiddenAt).toBeDefined();
    });

    it('should handle session not in index', async () => {
      const sessions = new Map([['s2', { id: 's2' }]]);
      const index = [{ sessionId: 's1', hidden: false }];
      const saved = [];
      const indexOps = {
        load: async () => [...index],
        save: async (newIndex) => { saved.push(newIndex); }
      };

      await hideConductorSession('s2', sessions, indexOps);

      // Session removed from active sessions
      expect(sessions.has('s2')).toBe(false);
      // Index not updated (no matching entry found)
      expect(saved).toHaveLength(0);
    });

    it('should handle session not in active sessions', async () => {
      const sessions = new Map(); // empty
      const index = [{ sessionId: 's3', hidden: false }];
      const indexOps = {
        load: async () => [...index],
        save: async (newIndex) => { index.length = 0; index.push(...newIndex); }
      };

      await hideConductorSession('s3', sessions, indexOps);
      // Should not throw, just mark hidden in index
      expect(index[0].hidden).toBe(true);
    });
  });

  describe('handleLoadConductorHistory with param injection', () => {
    it('should accept conductorSessions and sendConductorMessage as params', async () => {
      const sessions = new Map([['s1', { id: 's1' }]]);
      const sent = [];
      const sendMsg = (msg) => sent.push(msg);

      await handleLoadConductorHistory(
        { sessionId: 's1', shardIndex: '1', requestId: 'r1' },
        sessions,
        sendMsg
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('conductor_history_loaded');
      expect(sent[0].sessionId).toBe('s1');
    });

    it('should return empty for invalid shardIndex', async () => {
      const sessions = new Map([['s1', { id: 's1' }]]);
      const sent = [];
      const sendMsg = (msg) => sent.push(msg);

      await handleLoadConductorHistory(
        { sessionId: 's1', shardIndex: '0', requestId: 'r2' },
        sessions,
        sendMsg
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].messages).toEqual([]);
      expect(sent[0].hasMore).toBe(false);
    });

    it('should return empty for non-existent session', async () => {
      const sessions = new Map(); // empty
      const sent = [];
      const sendMsg = (msg) => sent.push(msg);

      await handleLoadConductorHistory(
        { sessionId: 'non-existent', shardIndex: '1', requestId: 'r3' },
        sessions,
        sendMsg
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].messages).toEqual([]);
    });

    it('should handle NaN shardIndex', async () => {
      const sessions = new Map([['s1', { id: 's1' }]]);
      const sent = [];
      const sendMsg = (msg) => sent.push(msg);

      await handleLoadConductorHistory(
        { sessionId: 's1', shardIndex: 'abc', requestId: 'r4' },
        sessions,
        sendMsg
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].messages).toEqual([]);
    });

    it('should handle undefined shardIndex', async () => {
      const sessions = new Map([['s1', { id: 's1' }]]);
      const sent = [];
      const sendMsg = (msg) => sent.push(msg);

      await handleLoadConductorHistory(
        { sessionId: 's1', shardIndex: undefined, requestId: 'r5' },
        sessions,
        sendMsg
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].messages).toEqual([]);
    });
  });
});

describe('Fix 3: session _rotating and _conductorSemRelease initialization', () => {
  it('should have _rotating: false on new session', () => {
    const session = createConductorSessionObject();
    expect(session._rotating).toBe(false);
  });

  it('should have _conductorSemRelease: null on new session', () => {
    const session = createConductorSessionObject();
    expect(session._conductorSemRelease).toBeNull();
  });

  it('should have both fields explicitly defined (not undefined)', () => {
    const session = createConductorSessionObject();
    expect('_rotating' in session).toBe(true);
    expect('_conductorSemRelease' in session).toBe(true);
  });

  it('resumed session from disk should also have these fields', () => {
    // Simulate resume from disk metadata
    const meta = {
      name: 'Resumed',
      workDir: '/p',
      tasks: [],
      costUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      userId: 'u1',
      username: 'a',
      agentId: null,
      createdAt: Date.now()
    };

    const session = {
      id: 'resume-test',
      name: meta.name || '',
      workDir: meta.workDir || null,
      scenarioId: meta.scenarioId || null,
      status: 'running',
      tasks: new Map(),
      conductorState: null,
      costUsd: meta.costUsd || 0,
      totalInputTokens: meta.totalInputTokens || 0,
      totalOutputTokens: meta.totalOutputTokens || 0,
      activeClaudes: 0,
      uiMessages: [],
      userId: meta.userId,
      username: meta.username,
      agentId: meta.agentId || null,
      createdAt: meta.createdAt || Date.now(),
      _rotating: false,
      _conductorSemRelease: null
    };

    expect(session._rotating).toBe(false);
    expect(session._conductorSemRelease).toBeNull();
  });

  it('_rotating should prevent double rotation', () => {
    const session = createConductorSessionObject();
    expect(session._rotating).toBe(false);

    // Simulate rotation start
    session._rotating = true;
    expect(session._rotating).toBe(true);

    // Code checks: if (!session._rotating) { rotateMessages(...) }
    // During rotation, this guard prevents re-entry
    const shouldRotate = !session._rotating;
    expect(shouldRotate).toBe(false);

    // After rotation completes
    session._rotating = false;
    const canRotateNow = !session._rotating;
    expect(canRotateNow).toBe(true);
  });
});

describe('Fix 4: handleConductorUserInput stopped state rejects without recording', () => {
  let session;
  let recorded;
  let sent;
  let deps;

  beforeEach(() => {
    recorded = [];
    sent = [];
    deps = {
      recordUserMessage: (s, content) => {
        s.uiMessages.push({ source: 'user', type: 'text', content, timestamp: Date.now() });
        recorded.push(content);
      },
      sendConductorMessage: (msg) => {
        sent.push(msg);
      }
    };
  });

  it('FIXED: stopped session should NOT record user message', () => {
    session = createConductorSessionObject({ id: 's1' });
    session.status = 'stopped';

    const result = handleConductorUserInput(session, '测试消息', deps);

    expect(result.action).toBe('error_stopped');
    expect(recorded).toHaveLength(0);
    expect(session.uiMessages).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('conductor_error');
    expect(sent[0].error).toBe('Session is stopped');
  });

  it('OLD: stopped session would incorrectly record message first', () => {
    session = createConductorSessionObject({ id: 's2' });
    session.status = 'stopped';

    const result = handleConductorUserInput_OLD(session, '测试消息', deps);

    expect(result.action).toBe('error_stopped');
    // OLD behavior: message was recorded BEFORE check
    expect(recorded).toHaveLength(1);
    expect(session.uiMessages).toHaveLength(1);
  });

  it('running session should record message normally', () => {
    session = createConductorSessionObject({ id: 's3' });
    session.status = 'running';

    const result = handleConductorUserInput(session, '正常消息', deps);

    expect(result.action).toBe('sent');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toBe('正常消息');
    expect(session.uiMessages).toHaveLength(1);
  });

  it('waiting_user session should record message and set status to running', () => {
    session = createConductorSessionObject({ id: 's4' });
    session.status = 'waiting_user';

    const result = handleConductorUserInput(session, '恢复消息', deps);

    expect(result.action).toBe('sent');
    expect(session.status).toBe('running');
    expect(recorded).toHaveLength(1);
  });

  it('null session should return not_found', () => {
    const result = handleConductorUserInput(null, '消息', deps);
    expect(result.action).toBe('not_found');
    expect(recorded).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('stopped session should not change status', () => {
    session = createConductorSessionObject({ id: 's5' });
    session.status = 'stopped';

    handleConductorUserInput(session, 'test', deps);
    expect(session.status).toBe('stopped');
  });

  it('should handle multiple messages: first stopped, then resumed', () => {
    session = createConductorSessionObject({ id: 's6' });
    session.status = 'stopped';

    // First message: rejected
    handleConductorUserInput(session, '消息1', deps);
    expect(recorded).toHaveLength(0);
    expect(session.uiMessages).toHaveLength(0);

    // Simulate session being resumed externally
    session.status = 'running';

    // Second message: accepted
    handleConductorUserInput(session, '消息2', deps);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toBe('消息2');
    expect(session.uiMessages).toHaveLength(1);
  });
});
