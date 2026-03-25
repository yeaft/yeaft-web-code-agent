import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for Conductor Session lifecycle management.
 *
 * Replicates core session data structures and logic from
 * agent/conductor/session.js to avoid SDK/context side effects.
 */

// =====================================================================
// Replicate session helpers for isolated testing
// =====================================================================

function createTestSession(overrides = {}) {
  return {
    id: overrides.id || 'conductor-session-001',
    name: (overrides.name !== undefined ? overrides.name : 'Conductor') || 'Conductor',
    workDir: overrides.workDir || null,
    scenarioId: overrides.scenarioId || null,
    status: overrides.status || 'running',
    tasks: overrides.tasks || new Map(),
    conductorState: overrides.conductorState || null,
    costUsd: overrides.costUsd || 0,
    totalInputTokens: overrides.totalInputTokens || 0,
    totalOutputTokens: overrides.totalOutputTokens || 0,
    activeClaudes: overrides.activeClaudes || 0,
    uiMessages: overrides.uiMessages || [],
    userId: overrides.userId || 'user-123',
    username: overrides.username || 'testuser',
    agentId: overrides.agentId || null,
    createdAt: overrides.createdAt || Date.now()
  };
}

function sessionToIndexEntry(session) {
  return {
    sessionId: session.id,
    status: session.status,
    name: session.name || '',
    workDir: session.workDir || null,
    userId: session.userId,
    username: session.username,
    agentId: session.agentId || null,
    scenarioId: session.scenarioId || null,
    createdAt: session.createdAt,
    updatedAt: Date.now()
  };
}

function buildSessionMeta(session) {
  return {
    sessionId: session.id,
    name: session.name || '',
    status: session.status,
    workDir: session.workDir || null,
    scenarioId: session.scenarioId || null,
    tasks: Array.from(session.tasks.values()).map(t => ({
      taskId: t.taskId,
      title: t.title,
      workDir: t.workDir,
      status: t.status,
      phase: t.phase,
      progress: t.progress,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    })),
    costUsd: session.costUsd,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    userId: session.userId,
    username: session.username,
    agentId: session.agentId || null,
    createdAt: session.createdAt,
    updatedAt: Date.now()
  };
}

// Simulate conductorSessions Map
let conductorSessions;

// =====================================================================
// Tests
// =====================================================================

describe('Conductor Session Data Structures', () => {
  beforeEach(() => {
    conductorSessions = new Map();
  });

  describe('createTestSession', () => {
    it('should create session with default values', () => {
      const session = createTestSession();
      expect(session.id).toBe('conductor-session-001');
      expect(session.name).toBe('Conductor');
      expect(session.workDir).toBeNull();
      expect(session.scenarioId).toBeNull();
      expect(session.status).toBe('running');
      expect(session.tasks).toBeInstanceOf(Map);
      expect(session.tasks.size).toBe(0);
      expect(session.conductorState).toBeNull();
      expect(session.costUsd).toBe(0);
      expect(session.totalInputTokens).toBe(0);
      expect(session.totalOutputTokens).toBe(0);
      expect(session.activeClaudes).toBe(0);
      expect(session.uiMessages).toEqual([]);
    });

    it('should accept overrides', () => {
      const session = createTestSession({
        id: 'custom-id',
        name: 'My Session',
        workDir: '/home/user/project',
        scenarioId: 'feature-dev',
        status: 'stopped',
        costUsd: 0.05
      });
      expect(session.id).toBe('custom-id');
      expect(session.name).toBe('My Session');
      expect(session.workDir).toBe('/home/user/project');
      expect(session.scenarioId).toBe('feature-dev');
      expect(session.status).toBe('stopped');
      expect(session.costUsd).toBe(0.05);
    });
  });

  describe('Session lifecycle simulation', () => {
    it('should simulate create session', () => {
      const session = createTestSession({ id: 'session-new' });
      conductorSessions.set(session.id, session);

      expect(conductorSessions.has('session-new')).toBe(true);
      expect(conductorSessions.get('session-new').status).toBe('running');
    });

    it('should simulate resume session from memory', () => {
      const session = createTestSession({ id: 'session-resume', status: 'running' });
      conductorSessions.set(session.id, session);

      // Simulate resume: session already in memory
      const existing = conductorSessions.get('session-resume');
      expect(existing).toBeDefined();
      expect(existing.status).toBe('running');
    });

    it('should simulate resume session from disk metadata', () => {
      // Simulate metadata loaded from disk
      const meta = {
        name: 'Restored Session',
        workDir: '/project',
        scenarioId: 'bugfix',
        tasks: [
          { taskId: 'task-1', title: '修复 Bug', workDir: '/project', status: 'running', phase: 'dev', progress: 50 }
        ],
        costUsd: 0.02,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        userId: 'user-456',
        username: 'restoreduser',
        agentId: 'agent-1',
        createdAt: Date.now() - 3600000
      };

      const session = {
        id: 'session-disk',
        name: meta.name || '',
        workDir: meta.workDir || null,
        scenarioId: meta.scenarioId || null,
        status: 'running',
        tasks: new Map((meta.tasks || []).map(t => [t.taskId, t])),
        conductorState: null,
        costUsd: meta.costUsd || 0,
        totalInputTokens: meta.totalInputTokens || 0,
        totalOutputTokens: meta.totalOutputTokens || 0,
        activeClaudes: 0,
        uiMessages: [],
        userId: meta.userId,
        username: meta.username,
        agentId: meta.agentId || null,
        createdAt: meta.createdAt || Date.now()
      };

      conductorSessions.set(session.id, session);

      expect(conductorSessions.get('session-disk').name).toBe('Restored Session');
      expect(conductorSessions.get('session-disk').tasks.size).toBe(1);
      expect(conductorSessions.get('session-disk').tasks.get('task-1').title).toBe('修复 Bug');
      expect(conductorSessions.get('session-disk').costUsd).toBe(0.02);
    });

    it('should simulate stop session', () => {
      const session = createTestSession({ id: 'session-stop' });
      conductorSessions.set(session.id, session);

      // Simulate stop
      session.status = 'stopped';
      session.conductorState = null;

      expect(session.status).toBe('stopped');
      expect(session.conductorState).toBeNull();

      // Remove from active sessions (like stopConductorSession does)
      conductorSessions.delete(session.id);
      expect(conductorSessions.has('session-stop')).toBe(false);
    });

    it('should simulate clear session', () => {
      const session = createTestSession({
        id: 'session-clear',
        costUsd: 0.1,
        totalInputTokens: 5000,
        totalOutputTokens: 2000
      });
      session.tasks.set('task-1', { taskId: 'task-1', title: 'Old Task' });
      session.uiMessages.push({ source: 'user', type: 'text', content: 'hello' });
      conductorSessions.set(session.id, session);

      // Simulate clear
      session.tasks.clear();
      session.uiMessages = [];
      session.costUsd = 0;
      session.totalInputTokens = 0;
      session.totalOutputTokens = 0;
      session.status = 'running';

      expect(session.tasks.size).toBe(0);
      expect(session.uiMessages).toHaveLength(0);
      expect(session.costUsd).toBe(0);
      expect(session.totalInputTokens).toBe(0);
      expect(session.totalOutputTokens).toBe(0);
      expect(session.status).toBe('running');
      // Session remains in map (unlike stop)
      expect(conductorSessions.has('session-clear')).toBe(true);
    });
  });

  describe('Task management within session', () => {
    it('should add tasks to session', () => {
      const session = createTestSession();
      const task = {
        taskId: 'task-new-1',
        title: '实现搜索功能',
        workDir: '/project',
        status: 'pending',
        phase: 'created',
        progress: 0,
        activeActors: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      session.tasks.set(task.taskId, task);
      expect(session.tasks.size).toBe(1);
      expect(session.tasks.get('task-new-1').title).toBe('实现搜索功能');
    });

    it('should handle multiple tasks', () => {
      const session = createTestSession();
      for (let i = 0; i < 5; i++) {
        session.tasks.set(`task-${i}`, {
          taskId: `task-${i}`,
          title: `Task ${i}`,
          workDir: '/project',
          status: 'pending',
          phase: 'created',
          progress: 0
        });
      }
      expect(session.tasks.size).toBe(5);
    });

    it('should manage task inbox for forwarded messages', () => {
      const session = createTestSession();
      const task = {
        taskId: 'task-inbox',
        title: 'Test Task',
        inbox: []
      };
      session.tasks.set(task.taskId, task);

      // Simulate FORWARD_TASK
      task.inbox.push({
        from: 'conductor',
        content: '请优先处理这个问题',
        timestamp: Date.now()
      });

      expect(task.inbox).toHaveLength(1);
      expect(task.inbox[0].from).toBe('conductor');
      expect(task.inbox[0].content).toBe('请优先处理这个问题');
    });

    it('should handle task with missing inbox (lazy init)', () => {
      const session = createTestSession();
      const task = {
        taskId: 'task-no-inbox',
        title: 'No Inbox Task'
      };
      session.tasks.set(task.taskId, task);

      // Simulate the code: if (!task.inbox) task.inbox = [];
      if (!task.inbox) task.inbox = [];
      task.inbox.push({ from: 'conductor', content: 'msg', timestamp: Date.now() });

      expect(task.inbox).toHaveLength(1);
    });
  });

  describe('sessionToIndexEntry', () => {
    it('should extract minimal fields from session', () => {
      const session = createTestSession({
        id: 'idx-test',
        name: 'Index Test',
        workDir: '/project',
        userId: 'u1',
        username: 'alice',
        agentId: 'agent-1',
        scenarioId: 'dev'
      });

      const entry = sessionToIndexEntry(session);
      expect(entry.sessionId).toBe('idx-test');
      expect(entry.status).toBe('running');
      expect(entry.name).toBe('Index Test');
      expect(entry.workDir).toBe('/project');
      expect(entry.userId).toBe('u1');
      expect(entry.username).toBe('alice');
      expect(entry.agentId).toBe('agent-1');
      expect(entry.scenarioId).toBe('dev');
      expect(entry.createdAt).toBeDefined();
      expect(entry.updatedAt).toBeDefined();
    });

    it('should handle null optional fields', () => {
      const session = createTestSession({ agentId: null, scenarioId: null, workDir: null });
      const entry = sessionToIndexEntry(session);
      expect(entry.workDir).toBeNull();
      expect(entry.agentId).toBeNull();
      expect(entry.scenarioId).toBeNull();
    });

    it('should handle empty name (defaults to Conductor)', () => {
      // Source code: name: name || 'Conductor' — empty string defaults to 'Conductor'
      const session = createTestSession({ name: '' });
      const entry = sessionToIndexEntry(session);
      expect(entry.name).toBe('Conductor');
    });
  });

  describe('buildSessionMeta', () => {
    it('should serialize session with tasks', () => {
      const session = createTestSession({ id: 'meta-test' });
      session.tasks.set('task-1', {
        taskId: 'task-1', title: 'Task A', workDir: '/p',
        status: 'running', phase: 'dev', progress: 30,
        createdAt: 1000, updatedAt: 2000
      });

      const meta = buildSessionMeta(session);
      expect(meta.sessionId).toBe('meta-test');
      expect(meta.tasks).toHaveLength(1);
      expect(meta.tasks[0].taskId).toBe('task-1');
      expect(meta.tasks[0].title).toBe('Task A');
      expect(meta.tasks[0].phase).toBe('dev');
      expect(meta.tasks[0].progress).toBe(30);
    });

    it('should handle empty tasks', () => {
      const session = createTestSession();
      const meta = buildSessionMeta(session);
      expect(meta.tasks).toHaveLength(0);
    });

    it('should include cost and token fields', () => {
      const session = createTestSession({
        costUsd: 0.15,
        totalInputTokens: 10000,
        totalOutputTokens: 5000
      });
      const meta = buildSessionMeta(session);
      expect(meta.costUsd).toBe(0.15);
      expect(meta.totalInputTokens).toBe(10000);
      expect(meta.totalOutputTokens).toBe(5000);
    });
  });

  describe('Dynamic workDir', () => {
    it('should allow workDir to be updated dynamically', () => {
      const session = createTestSession({ workDir: '/old/path' });
      expect(session.workDir).toBe('/old/path');
      session.workDir = '/new/path';
      expect(session.workDir).toBe('/new/path');
    });

    it('should allow workDir to be set from null', () => {
      const session = createTestSession({ workDir: null });
      expect(session.workDir).toBeNull();
      session.workDir = '/project';
      expect(session.workDir).toBe('/project');
    });

    it('should allow workDir to be cleared to null', () => {
      const session = createTestSession({ workDir: '/project' });
      session.workDir = null;
      expect(session.workDir).toBeNull();
    });
  });

  describe('Session update logic', () => {
    it('should update name when provided', () => {
      const session = createTestSession({ name: 'Old Name' });
      const msg = { name: 'New Name' };
      if (msg.name !== undefined) session.name = msg.name;
      expect(session.name).toBe('New Name');
    });

    it('should not update name when undefined', () => {
      const session = createTestSession({ name: 'Keep This' });
      const msg = {};
      if (msg.name !== undefined) session.name = msg.name;
      expect(session.name).toBe('Keep This');
    });

    it('should update workDir independently of name', () => {
      const session = createTestSession({ name: 'Session', workDir: '/old' });
      const msg = { workDir: '/new' };
      if (msg.name !== undefined) session.name = msg.name;
      if (msg.workDir !== undefined) session.workDir = msg.workDir;
      expect(session.name).toBe('Session');
      expect(session.workDir).toBe('/new');
    });
  });

  describe('Cost tracking', () => {
    it('should accumulate cost from turn results', () => {
      const state = {
        lastCostUsd: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0
      };
      const session = createTestSession();

      // Simulate first turn result
      const result1 = { total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 50 } };
      const costDelta1 = result1.total_cost_usd - state.lastCostUsd;
      if (costDelta1 > 0) session.costUsd += costDelta1;
      state.lastCostUsd = result1.total_cost_usd;

      expect(session.costUsd).toBeCloseTo(0.01);

      // Simulate second turn result
      const result2 = { total_cost_usd: 0.03, usage: { input_tokens: 300, output_tokens: 150 } };
      const costDelta2 = result2.total_cost_usd - state.lastCostUsd;
      if (costDelta2 > 0) session.costUsd += costDelta2;
      state.lastCostUsd = result2.total_cost_usd;

      expect(session.costUsd).toBeCloseTo(0.03);
    });

    it('should accumulate tokens from turn results', () => {
      const state = { lastInputTokens: 0, lastOutputTokens: 0 };
      const session = createTestSession();

      // First turn
      const r1 = { usage: { input_tokens: 100, output_tokens: 50 } };
      const inputDelta1 = (r1.usage.input_tokens || 0) - (state.lastInputTokens || 0);
      const outputDelta1 = (r1.usage.output_tokens || 0) - (state.lastOutputTokens || 0);
      if (inputDelta1 > 0) session.totalInputTokens += inputDelta1;
      if (outputDelta1 > 0) session.totalOutputTokens += outputDelta1;
      state.lastInputTokens = r1.usage.input_tokens;
      state.lastOutputTokens = r1.usage.output_tokens;

      expect(session.totalInputTokens).toBe(100);
      expect(session.totalOutputTokens).toBe(50);

      // Second turn
      const r2 = { usage: { input_tokens: 400, output_tokens: 200 } };
      const inputDelta2 = (r2.usage.input_tokens || 0) - (state.lastInputTokens || 0);
      const outputDelta2 = (r2.usage.output_tokens || 0) - (state.lastOutputTokens || 0);
      if (inputDelta2 > 0) session.totalInputTokens += inputDelta2;
      if (outputDelta2 > 0) session.totalOutputTokens += outputDelta2;
      state.lastInputTokens = r2.usage.input_tokens;
      state.lastOutputTokens = r2.usage.output_tokens;

      expect(session.totalInputTokens).toBe(400);
      expect(session.totalOutputTokens).toBe(200);
    });

    it('should not decrease cost if total_cost_usd decreases', () => {
      const state = { lastCostUsd: 0.05 };
      const session = createTestSession({ costUsd: 0.05 });

      // Simulate a result with lower cost (shouldn't happen, but test safety)
      const result = { total_cost_usd: 0.03 };
      const costDelta = result.total_cost_usd - state.lastCostUsd;
      if (costDelta > 0) session.costUsd += costDelta;
      state.lastCostUsd = result.total_cost_usd;

      // Cost should not increase (delta is negative)
      expect(session.costUsd).toBe(0.05);
    });
  });

  describe('Session list filtering', () => {
    it('should filter sessions by agentId', () => {
      const index = [
        { sessionId: 's1', agentId: 'agent-1', hidden: false },
        { sessionId: 's2', agentId: 'agent-2', hidden: false },
        { sessionId: 's3', agentId: null, hidden: false },
        { sessionId: 's4', agentId: 'agent-1', hidden: false }
      ];

      const agentId = 'agent-1';
      const filtered = agentId
        ? index.filter(e => !e.agentId || e.agentId === agentId)
        : index;

      // Should include: s1 (matches), s3 (no agentId), s4 (matches)
      expect(filtered).toHaveLength(3);
      expect(filtered.map(e => e.sessionId)).toEqual(['s1', 's3', 's4']);
    });

    it('should exclude hidden sessions', () => {
      const index = [
        { sessionId: 's1', hidden: false },
        { sessionId: 's2', hidden: true },
        { sessionId: 's3' }
      ];

      const visible = index.filter(e => !e.hidden);
      expect(visible).toHaveLength(2);
      expect(visible.map(e => e.sessionId)).toEqual(['s1', 's3']);
    });

    it('should update active session status in index', () => {
      const index = [
        { sessionId: 's1', status: 'stopped' },
        { sessionId: 's2', status: 'stopped' }
      ];

      conductorSessions.set('s1', { status: 'running' });

      for (const entry of index) {
        const active = conductorSessions.get(entry.sessionId);
        if (active) {
          entry.status = active.status;
        }
      }

      expect(index[0].status).toBe('running');
      expect(index[1].status).toBe('stopped');
    });
  });
});
