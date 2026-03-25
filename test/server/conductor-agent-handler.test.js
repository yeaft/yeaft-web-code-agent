import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for agent-conductor.js WebSocket message handler.
 *
 * Replicates the handleAgentConductor switch logic to test all
 * message type branches without importing server dependencies.
 */

// =====================================================================
// Replicate handler logic for isolated testing
// =====================================================================

function createMockAgent(overrides = {}) {
  return {
    ownerId: overrides.ownerId || 'owner-1',
    ownerUsername: overrides.ownerUsername || 'owner',
    name: overrides.name || 'test-agent',
    conversations: new Map()
  };
}

function createMockSessionDb() {
  const store = new Map();
  return {
    exists: (id) => store.has(id),
    create: (id, agentId, agentName, workDir, _null, name, userId) => {
      store.set(id, { id, agentId, agentName, workDir, name, userId });
    },
    _store: store
  };
}

// Track calls to ws-utils functions
function createCallTracker() {
  const calls = [];
  return {
    forwardToClients: async (agentId, sessionId, msg) => {
      calls.push({ fn: 'forwardToClients', agentId, sessionId, msg });
    },
    broadcastAgentList: async () => {
      calls.push({ fn: 'broadcastAgentList' });
    },
    notifyConversationUpdate: async (agentId, msg) => {
      calls.push({ fn: 'notifyConversationUpdate', agentId, msg });
    },
    calls
  };
}

async function handleAgentConductor(agentId, agent, msg, sessionDb, tracker) {
  switch (msg.type) {
    case 'conductor_session_created': {
      const userId = msg.userId || agent.ownerId || null;
      const username = msg.username || agent.ownerUsername || null;
      agent.conversations.set(msg.sessionId, {
        id: msg.sessionId,
        workDir: msg.workDir || null,
        userId,
        username,
        createdAt: Date.now(),
        processing: true,
        type: 'conductor'
      });
      try {
        if (!sessionDb.exists(msg.sessionId)) {
          sessionDb.create(msg.sessionId, agentId, agent.name, msg.workDir || '', null, msg.name || null, userId);
        }
      } catch (e) {
        // swallow
      }
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      await tracker.broadcastAgentList();
      break;
    }

    case 'conductor_session_restored': {
      const restoreUserId = msg.userId || agent.ownerId || null;
      const restoreUsername = msg.username || agent.ownerUsername || null;
      if (!agent.conversations.has(msg.sessionId)) {
        agent.conversations.set(msg.sessionId, {
          id: msg.sessionId,
          workDir: msg.workDir || null,
          userId: restoreUserId,
          username: restoreUsername,
          createdAt: Date.now(),
          processing: true,
          type: 'conductor'
        });
      }
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;
    }

    case 'conductor_output':
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_status': {
      const conv = agent.conversations.get(msg.sessionId);
      if (conv && (msg.status === 'stopped')) {
        conv.processing = false;
      }
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;
    }

    case 'conductor_turn_completed':
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_error':
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_task_created':
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_task_message':
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_workdir_updated':
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_sessions_list':
      await tracker.notifyConversationUpdate(agentId, msg);
      break;

    case 'conductor_session_cleared':
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_history_loaded':
      await tracker.forwardToClients(agentId, msg.sessionId, msg);
      break;

    default:
      return false;
  }
  return true;
}

// =====================================================================
// Tests
// =====================================================================

describe('handleAgentConductor', () => {
  let agent, sessionDb, tracker;
  const agentId = 'agent-test-1';

  beforeEach(() => {
    agent = createMockAgent();
    sessionDb = createMockSessionDb();
    tracker = createCallTracker();
  });

  describe('conductor_session_created', () => {
    it('should register conversation and save to db', async () => {
      const msg = {
        type: 'conductor_session_created',
        sessionId: 'cs-001',
        workDir: '/project',
        userId: 'user-1',
        username: 'alice',
        name: 'My Conductor'
      };

      const result = await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(result).toBe(true);

      // Conversation registered
      expect(agent.conversations.has('cs-001')).toBe(true);
      const conv = agent.conversations.get('cs-001');
      expect(conv.type).toBe('conductor');
      expect(conv.processing).toBe(true);
      expect(conv.workDir).toBe('/project');
      expect(conv.userId).toBe('user-1');

      // DB entry created
      expect(sessionDb._store.has('cs-001')).toBe(true);

      // Forward + broadcast
      expect(tracker.calls).toHaveLength(2);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
      expect(tracker.calls[1].fn).toBe('broadcastAgentList');
    });

    it('should use agent owner if userId not in message', async () => {
      const msg = {
        type: 'conductor_session_created',
        sessionId: 'cs-002'
      };

      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      const conv = agent.conversations.get('cs-002');
      expect(conv.userId).toBe('owner-1');
      expect(conv.username).toBe('owner');
    });

    it('should not duplicate db entry for existing session', async () => {
      sessionDb.create('cs-dup', agentId, 'a', '', null, null, 'u1');
      const msg = {
        type: 'conductor_session_created',
        sessionId: 'cs-dup'
      };

      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      // exists() returns true, so create() is NOT called again
      expect(sessionDb._store.size).toBe(1);
    });
  });

  describe('conductor_session_restored', () => {
    it('should register conversation if not already present', async () => {
      const msg = {
        type: 'conductor_session_restored',
        sessionId: 'cs-restore',
        workDir: '/project',
        userId: 'user-2',
        username: 'bob'
      };

      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(agent.conversations.has('cs-restore')).toBe(true);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
    });

    it('should not overwrite existing conversation', async () => {
      agent.conversations.set('cs-existing', {
        id: 'cs-existing', workDir: '/old', userId: 'old-user',
        username: 'old', createdAt: 1000, processing: true, type: 'conductor'
      });

      const msg = {
        type: 'conductor_session_restored',
        sessionId: 'cs-existing',
        userId: 'new-user'
      };

      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      // Should keep old values
      expect(agent.conversations.get('cs-existing').userId).toBe('old-user');
    });
  });

  describe('conductor_output', () => {
    it('should forward to clients', async () => {
      const msg = { type: 'conductor_output', sessionId: 'cs-1', outputType: 'text', data: {} };
      const result = await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(result).toBe(true);
      expect(tracker.calls).toHaveLength(1);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
      expect(tracker.calls[0].sessionId).toBe('cs-1');
    });
  });

  describe('conductor_status', () => {
    it('should set processing=false when status is stopped', async () => {
      agent.conversations.set('cs-status', {
        id: 'cs-status', processing: true, type: 'conductor'
      });

      const msg = { type: 'conductor_status', sessionId: 'cs-status', status: 'stopped' };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);

      expect(agent.conversations.get('cs-status').processing).toBe(false);
    });

    it('should not change processing for running status', async () => {
      agent.conversations.set('cs-running', {
        id: 'cs-running', processing: true, type: 'conductor'
      });

      const msg = { type: 'conductor_status', sessionId: 'cs-running', status: 'running' };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);

      expect(agent.conversations.get('cs-running').processing).toBe(true);
    });

    it('should handle status for non-existent conversation', async () => {
      const msg = { type: 'conductor_status', sessionId: 'cs-none', status: 'stopped' };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      // Should not throw, just forward
      expect(tracker.calls[0].fn).toBe('forwardToClients');
    });
  });

  describe('conductor_turn_completed', () => {
    it('should forward to clients', async () => {
      const msg = { type: 'conductor_turn_completed', sessionId: 'cs-1' };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
    });
  });

  describe('conductor_error', () => {
    it('should forward to clients', async () => {
      const msg = { type: 'conductor_error', sessionId: 'cs-1', error: 'Something failed' };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
      expect(tracker.calls[0].msg.error).toBe('Something failed');
    });
  });

  describe('conductor_task_created', () => {
    it('should forward to clients', async () => {
      const msg = { type: 'conductor_task_created', sessionId: 'cs-1', task: { taskId: 't1' } };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
    });
  });

  describe('conductor_task_message', () => {
    it('should forward to clients', async () => {
      const msg = { type: 'conductor_task_message', sessionId: 'cs-1', taskId: 't1', message: 'test' };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
    });
  });

  describe('conductor_workdir_updated', () => {
    it('should forward to clients', async () => {
      const msg = { type: 'conductor_workdir_updated', sessionId: 'cs-1', workDir: '/new/path' };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
    });
  });

  describe('conductor_sessions_list', () => {
    it('should use notifyConversationUpdate instead of forwardToClients', async () => {
      const msg = { type: 'conductor_sessions_list', sessions: [] };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(tracker.calls).toHaveLength(1);
      expect(tracker.calls[0].fn).toBe('notifyConversationUpdate');
    });
  });

  describe('conductor_session_cleared', () => {
    it('should forward to clients', async () => {
      const msg = { type: 'conductor_session_cleared', sessionId: 'cs-1' };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
    });
  });

  describe('conductor_history_loaded', () => {
    it('should forward to clients', async () => {
      const msg = { type: 'conductor_history_loaded', sessionId: 'cs-1', messages: [], hasMore: false };
      await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(tracker.calls[0].fn).toBe('forwardToClients');
    });
  });

  describe('unknown message type', () => {
    it('should return false for unhandled type', async () => {
      const msg = { type: 'unknown_type' };
      const result = await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
      expect(result).toBe(false);
      expect(tracker.calls).toHaveLength(0);
    });
  });

  describe('all message types are handled', () => {
    const expectedTypes = [
      'conductor_session_created',
      'conductor_session_restored',
      'conductor_output',
      'conductor_status',
      'conductor_turn_completed',
      'conductor_error',
      'conductor_task_created',
      'conductor_task_message',
      'conductor_workdir_updated',
      'conductor_sessions_list',
      'conductor_session_cleared',
      'conductor_history_loaded'
    ];

    for (const type of expectedTypes) {
      it(`should handle ${type}`, async () => {
        const msg = { type, sessionId: 'test-session' };
        const result = await handleAgentConductor(agentId, agent, msg, sessionDb, tracker);
        expect(result).toBe(true);
      });
    }
  });
});
